import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import { enqueueOutbox, readOutbox } from '@/lib/outbox'
import {
  SYNC_KEYS,
  getBootstrapAccountId,
  getBootstrapComplete,
  getDatasetEpoch,
  getSyncValue,
} from '@/lib/sync-store'
import {
  resyncFromCloud,
  resyncToCloud,
  type ResyncDeps,
} from '@/lib/sync-resync'
import type { SyncRunOptions, SyncRunResult } from '@/lib/sync-engine'
import type { Habit } from '@/lib/types'

/**
 * Phase 21 / OPS-01 — the two resync orchestrations behind the escape hatch.
 *
 * Pull is non-destructive on failure; push is confirm-gated, retryable, and
 * treats a skipped run as a failure (the cloud was already emptied). Every
 * cloud-only id reported by the reset becomes a durable `op:'purge'` before the
 * re-push so other devices delete it instead of resurrecting it.
 */

const createdNames: string[] = []
const opened: OrbitDB[] = []

function newName(): string {
  const name = `orbit-sync-resync-${Date.now()}-${Math.random().toString(36).slice(2)}`
  createdNames.push(name)
  return name
}

function open(): { database: OrbitDB; repo: LocalRepository } {
  const database = new OrbitDB(newName())
  opened.push(database)
  return { database, repo: new LocalRepository(database) }
}

afterEach(async () => {
  for (const database of opened.splice(0)) {
    try {
      database.close()
    } catch {
      // Already closed by the test.
    }
  }
  for (const name of createdNames.splice(0)) {
    await Dexie.delete(name).catch(() => {})
  }
  vi.restoreAllMocks()
})

function habit(over: Partial<Habit> = {}): Habit {
  return {
    id: 'habit-1',
    name: '每天跑步',
    short_name: '跑步',
    sort_order: 0,
    updated_at: '2026-10-30T00:00:00.000Z',
    deleted_at: null,
    ...over,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function runSyncSpy(result: SyncRunResult = { ok: true, rowsTransferred: 1 }) {
  return vi.fn(async (_opts?: SyncRunOptions): Promise<SyncRunResult> => result)
}

function resetEnvelope(ids: Record<string, string[]>): unknown {
  return { version: 1, ok: true, ids }
}

describe('resyncFromCloud', () => {
  it('replaces local rows, clears the outbox, increments the epoch and stamps success', async () => {
    const { database, repo } = open()
    await database.habits.bulkPut([habit({ id: 'local-h' })])
    await database.syncState.put({ key: SYNC_KEYS.lastError, value: 'before' })
    await enqueueOutbox(database, {
      entity: 'habits',
      row_id: 'local-h',
      op: 'upsert',
      updated_at: '2026-10-30T00:00:00.000Z',
    })

    const paths: string[] = []
    const fetchFn = async (path: string): Promise<Response> => {
      paths.push(path)
      return jsonResponse({
        version: 1,
        changes: [
          {
            entity: 'habits',
            id: 'cloud-h',
            server_seq: 4,
            op: 'upsert',
            updated_at: '2026-11-01T00:00:00.000Z',
            deleted_at: null,
            data: habit({ id: 'cloud-h' }),
            device_id: null,
          },
        ],
        next_cursor: 4,
        has_more: false,
      })
    }

    const result = await resyncFromCloud({
      db: database,
      repo,
      fetchFn,
      accountId: 'acct-1',
      runSync: runSyncSpy(),
      now: () => Date.parse('2026-11-02T12:00:00.000Z'),
    })

    expect(paths).toEqual(['/v1/sync/pull?since=0&limit=500'])
    expect(result).toEqual({ ok: true, rows: 1 })
    expect((await database.habits.toArray()).map((row) => row.id)).toEqual(['cloud-h'])
    expect(await readOutbox(database)).toHaveLength(0)
    expect(await getDatasetEpoch(database)).toBe(1)
    // getSyncValue's `??` treats a stored null as absent, so read the raw row.
    expect((await database.syncState.get(SYNC_KEYS.lastError))?.value).toBe(null)
    expect(await getSyncValue(database, SYNC_KEYS.lastSyncedAt, 'MISSING')).toBe(
      '2026-11-02T12:00:00.000Z',
    )
    expect(await getSyncValue(database, SYNC_KEYS.syncPaused, true)).toBe(false)
  })

  it('leaves local rows and the outbox untouched when page 2 fails with 500', async () => {
    const { database, repo } = open()
    await database.habits.bulkPut([habit({ id: 'local-h' })])
    await database.syncState.put({ key: SYNC_KEYS.lastError, value: 'before' })
    await enqueueOutbox(database, {
      entity: 'habits',
      row_id: 'local-h',
      op: 'upsert',
      updated_at: '2026-10-30T00:00:00.000Z',
    })

    const fetchFn = async (path: string): Promise<Response> => {
      if (path.includes('since=0')) {
        return jsonResponse({ version: 1, changes: [], next_cursor: 5, has_more: true })
      }
      return jsonResponse({ error: 'down' }, 500)
    }

    const result = await resyncFromCloud({
      db: database,
      repo,
      fetchFn,
      accountId: 'acct-1',
      runSync: runSyncSpy(),
    })

    expect(result).toEqual({ ok: false, reason: 'server' })
    expect((await database.habits.toArray()).map((row) => row.id)).toEqual(['local-h'])
    expect(await readOutbox(database)).toHaveLength(1)
    expect(await getDatasetEpoch(database)).toBe(0)
    expect(await getSyncValue(database, SYNC_KEYS.lastError, 'MISSING')).toBe('before')
  })

  it('maps a thrown fetch to network and a 401 to auth', async () => {
    const { database, repo } = open()

    const network = await resyncFromCloud({
      db: database,
      repo,
      fetchFn: async () => {
        throw new TypeError('offline')
      },
      accountId: 'acct-1',
      runSync: runSyncSpy(),
    })
    expect(network).toEqual({ ok: false, reason: 'network' })

    const auth = await resyncFromCloud({
      db: database,
      repo,
      fetchFn: async () => jsonResponse({ error: 'unauthorized' }, 401),
      accountId: 'acct-1',
      runSync: runSyncSpy(),
    })
    expect(auth).toEqual({ ok: false, reason: 'auth' })
  })
})

describe('resyncToCloud', () => {
  it('sends confirm:true and never a body-supplied user id', async () => {
    const { database, repo } = open()
    await database.habits.bulkPut([habit({ id: 'B' })])

    const calls: Array<{ path: string; init?: RequestInit }> = []
    const fetchFn = async (path: string, init?: RequestInit): Promise<Response> => {
      calls.push({ path, init })
      return jsonResponse(resetEnvelope({ habits: ['A', 'B'] }))
    }

    const result = await resyncToCloud({
      db: database,
      repo,
      fetchFn,
      accountId: 'acct-1',
      runSync: runSyncSpy({ ok: true, rowsTransferred: 2 }),
    })

    expect(result).toEqual({ ok: true, rows: 2 })
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe('/v1/sync/reset')
    expect(calls[0].init?.method).toBe('POST')
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
    expect(body).toEqual({ confirm: true })
    expect(body).not.toHaveProperty('user_id')
    expect(body).not.toHaveProperty('userId')
  })

  it('aborts with zero fetch calls when the local inventory read fails', async () => {
    const stub = {
      table: () => ({
        toArray: async () => {
          throw new Error('table unavailable')
        },
      }),
    } as unknown as OrbitDB

    const fetchFn = vi.fn(async (_path: string, _init?: RequestInit): Promise<Response> =>
      jsonResponse(resetEnvelope({})),
    )

    const result = await resyncToCloud({
      db: stub,
      repo: {} as LocalRepository,
      fetchFn,
      accountId: 'acct-1',
      runSync: runSyncSpy(),
    })

    expect(result).toEqual({ ok: false, reason: 'unknown' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('purges every reset-reported id with no local live row, but never a live local row', async () => {
    const { database, repo } = open()
    await database.habits.bulkPut([habit({ id: 'B' })])

    const fetchFn = async (path: string): Promise<Response> => {
      if (path !== '/v1/sync/reset') throw new Error(`unexpected fetch ${path}`)
      // A live/absent, B live/present, C tombstone-only/absent, D purge-only/absent.
      return jsonResponse(resetEnvelope({ habits: ['A', 'B', 'C', 'D'] }))
    }
    const spy = runSyncSpy({ ok: true, rowsTransferred: 5 })

    const result = await resyncToCloud({
      db: database,
      repo,
      fetchFn,
      accountId: 'acct-1',
      runSync: spy,
    })

    expect(result).toEqual({ ok: true, rows: 5 })
    expect(spy).toHaveBeenCalledWith({ bootstrap: true, allowBulkDelete: true })

    const outbox = await readOutbox(database)
    const purges = outbox
      .filter((entry) => entry.op === 'purge')
      .map((entry) => entry.row_id)
      .sort()
    expect(purges).toEqual(['A', 'C', 'D'])
    expect(outbox.some((entry) => entry.row_id === 'B' && entry.op === 'upsert')).toBe(true)
  })

  it('treats a skipped run as a failure and keeps the rebuilt outbox for retry', async () => {
    for (const [skipped, reason] of [
      ['leader', 'unknown'],
      ['offline', 'network'],
    ] as const) {
      const { database, repo } = open()
      const fetchFn = async (): Promise<Response> =>
        jsonResponse(resetEnvelope({ habits: ['A'] }))

      const result = await resyncToCloud({
        db: database,
        repo,
        fetchFn,
        accountId: 'acct-1',
        runSync: runSyncSpy({ ok: true, skipped }),
      })

      expect(result).toEqual({ ok: false, reason })
      expect(await getBootstrapComplete(database)).toBe(false)
      const outbox = await readOutbox(database)
      expect(outbox.length).toBeGreaterThan(0)
      expect(outbox.some((entry) => entry.row_id === 'A' && entry.op === 'purge')).toBe(true)
    }
  })

  it('returns auth on a reset 401 without touching the existing outbox', async () => {
    const { database, repo } = open()
    await enqueueOutbox(database, {
      entity: 'habits',
      row_id: 'queued',
      op: 'upsert',
      updated_at: '2026-10-30T00:00:00.000Z',
    })

    const result = await resyncToCloud({
      db: database,
      repo,
      fetchFn: async () => jsonResponse({ error: 'unauthorized' }, 401),
      accountId: 'acct-1',
      runSync: runSyncSpy(),
    })

    expect(result).toEqual({ ok: false, reason: 'auth' })
    const outbox = await readOutbox(database)
    expect(outbox).toHaveLength(1)
    expect(outbox[0].row_id).toBe('queued')
  })

  it('returns malformed when the reset ids envelope is not a string-array map', async () => {
    const { database, repo } = open()
    const fetchFn = async (): Promise<Response> =>
      jsonResponse({ version: 1, ok: true, ids: { habits: 'nope' } })

    const result = await resyncToCloud({
      db: database,
      repo,
      fetchFn,
      accountId: 'acct-1',
      runSync: runSyncSpy(),
    })

    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })

  it('keeps the rebuilt outbox, including the purge, when the run fails', async () => {
    const { database, repo } = open()
    const fetchFn = async (): Promise<Response> => jsonResponse(resetEnvelope({ habits: ['A'] }))

    const result = await resyncToCloud({
      db: database,
      repo,
      fetchFn,
      accountId: 'acct-1',
      runSync: runSyncSpy({ ok: false, error: 'server' }),
    })

    expect(result).toEqual({ ok: false, reason: 'server' })
    expect(await getBootstrapComplete(database)).toBe(false)
    const outbox = await readOutbox(database)
    expect(outbox.some((entry) => entry.row_id === 'A' && entry.op === 'purge')).toBe(true)
  })

  it('sets bootstrapComplete with the passed account id on success', async () => {
    const { database, repo } = open()
    const fetchFn = async (): Promise<Response> => jsonResponse(resetEnvelope({ habits: ['B'] }))

    const result = await resyncToCloud({
      db: database,
      repo,
      fetchFn,
      accountId: 'acct-xyz',
      runSync: runSyncSpy({ ok: true, rowsTransferred: 1 }),
    })

    expect(result.ok).toBe(true)
    expect(await getBootstrapComplete(database)).toBe(true)
    expect(await getBootstrapAccountId(database)).toBe('acct-xyz')
  })

  it('propagates a push-resync purge of A to a second device on its next pull', async () => {
    // Device 1: cloud-only A is purged.
    const device1 = open()
    const server = { purged: new Set<string>() }
    const device1Fetch = async (path: string): Promise<Response> => {
      if (path !== '/v1/sync/reset') throw new Error(`unexpected fetch ${path}`)
      return jsonResponse(resetEnvelope({ habits: ['A'] }))
    }
    const pushSpy = vi.fn(async (_opts?: SyncRunOptions): Promise<SyncRunResult> => {
      for (const entry of await readOutbox(device1.database)) {
        if (entry.op === 'purge' && entry.entity === 'habits') server.purged.add(entry.row_id)
      }
      return { ok: true, rowsTransferred: 1 }
    })

    await resyncToCloud({
      db: device1.database,
      repo: device1.repo,
      fetchFn: device1Fetch,
      accountId: 'acct-1',
      runSync: pushSpy,
    })
    expect([...server.purged]).toEqual(['A'])

    // Device 2: holds A locally, pulls from cursor 0 and receives the purge.
    const device2 = open()
    await device2.database.habits.bulkPut([habit({ id: 'A' })])
    const servedPurges: string[] = []
    let pullPath = ''
    const device2Fetch = async (path: string): Promise<Response> => {
      pullPath = path
      const changes = [...server.purged].map((id, index) => {
        servedPurges.push(id)
        return {
          entity: 'habits',
          id,
          server_seq: index + 1,
          op: 'purge',
          updated_at: null,
          deleted_at: null,
          data: null,
          device_id: null,
        }
      })
      return jsonResponse({
        version: 1,
        changes,
        next_cursor: changes.length,
        has_more: false,
      })
    }

    const result = await resyncFromCloud({
      db: device2.database,
      repo: device2.repo,
      fetchFn: device2Fetch,
      accountId: 'acct-1',
      runSync: runSyncSpy(),
    })

    expect(result).toEqual({ ok: true, rows: 0 })
    expect(pullPath).toBe('/v1/sync/pull?since=0&limit=500')
    expect(servedPurges).toEqual(['A'])
    expect(await device2.database.habits.count()).toBe(0)
  })
})
