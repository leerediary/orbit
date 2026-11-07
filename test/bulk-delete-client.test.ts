import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import { readOutbox } from '@/lib/outbox'
import {
  countCoalescedDeleteIntents,
  getBulkDeleteSnapshot,
  needsBulkDeleteConfirm,
  publishBulkDeleteRequired,
  resolveBulkDelete,
  subscribeBulkDelete,
} from '@/lib/sync-bulk-delete'
import { createSyncEngine, type SyncDeps } from '@/lib/sync-engine'
import type { Goal } from '@/lib/types'

/**
 * Phase 20 / plan 20-05 — BOOT-04 client half.
 *
 * The server 409 guard is authoritative; these tests prove the client warns
 * before a destructive drain, classifies `bulk_delete_required` explicitly, and
 * never quarantines, bisects, or silently retries the guarded chunk.
 */

const createdNames: string[] = []
const opened: OrbitDB[] = []

function open(): { database: OrbitDB; repo: LocalRepository } {
  const name = `orbit-bulk-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`
  createdNames.push(name)
  const database = new OrbitDB(name)
  opened.push(database)
  return { database, repo: new LocalRepository(database) }
}

afterEach(async () => {
  for (const database of opened.splice(0)) {
    try {
      database.close()
    } catch {
      // Already closed.
    }
  }
  for (const name of createdNames.splice(0)) {
    await Dexie.delete(name).catch(() => {})
  }
})

beforeEach(() => {
  resolveBulkDelete()
})

interface FetchLog {
  method: string
  path: string
  body: { device_id?: string; changes?: unknown[] } | undefined
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeFetch(
  log: FetchLog[],
  handler: (entry: FetchLog) => Response | Promise<Response>,
): SyncDeps['fetch'] {
  return async (path, init) => {
    const entry: FetchLog = {
      method: init?.method ?? 'GET',
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    log.push(entry)
    return handler(entry)
  }
}

const isPush = (entry: FetchLog) => entry.path.startsWith('/v1/sync/push')
const isPull = (entry: FetchLog) => entry.path.startsWith('/v1/sync/pull')

function appliedAll(entry: FetchLog): Response {
  const changes = (entry.body?.changes ?? []) as Array<{ entity: string; id: string }>
  return jsonResponse(200, {
    version: 1,
    results: changes.map((change) => ({
      entity: change.entity,
      id: change.id,
      status: 'applied',
      server_seq: 1,
    })),
  })
}

function emptyPull(): Response {
  return jsonResponse(200, { version: 1, changes: [], next_cursor: 0, has_more: false })
}

interface ManualTimers {
  map: Map<number, { fn: () => void; ms: number }>
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

function manualTimers(): ManualTimers {
  let next = 1
  const map = new Map<number, { fn: () => void; ms: number }>()
  return {
    map,
    setTimer: (fn, ms) => {
      const id = (next += 1)
      map.set(id, { fn, ms })
      return id
    },
    clearTimer: (handle) => {
      map.delete(handle as number)
    },
  }
}

function harness(
  database: OrbitDB,
  repo: LocalRepository,
  fetchFn: SyncDeps['fetch'],
): { engine: ReturnType<typeof createSyncEngine>; timers: ManualTimers } {
  const timers = manualTimers()
  const engine = createSyncEngine({
    db: database,
    repo,
    fetch: fetchFn,
    session: () => ({ accessToken: 'test-token' }),
    locks: null,
    channel: null,
    online: () => true,
    now: () => Date.UTC(2026, 10, 1, 12, 0, 0),
    random: () => 0.5,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    win: null,
    doc: null,
  })
  return { engine, timers }
}

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    category_id: 'cat-1',
    name: '目标',
    created_at: '2026-10-01T00:00:00.000Z',
    sort_order: 0,
    updated_at: '2026-10-02T00:00:00.000Z',
    deleted_at: null,
    ...over,
  }
}

describe('bulk-delete threshold', () => {
  it('triggers at 25 rows AND 90% of live rows', () => {
    expect(needsBulkDeleteConfirm(25, 25)).toBe(true)
    expect(needsBulkDeleteConfirm(24, 24)).toBe(false)
    expect(needsBulkDeleteConfirm(25, 100)).toBe(false)
    expect(needsBulkDeleteConfirm(90, 100)).toBe(true)
    expect(needsBulkDeleteConfirm(0, 0)).toBe(false)
    // Empty cloud has nothing to protect — propagating local tombstones to an
    // empty dataset must never trip the bulk-delete guard (Phase 21 fix).
    expect(needsBulkDeleteConfirm(30, 0)).toBe(false)
  })
})

describe('coalesced delete intents', () => {
  it('counts only the latest op per entity:id', () => {
    expect(
      countCoalescedDeleteIntents([
        { entity: 'goals', row_id: 'g1', op: 'upsert' },
        { entity: 'goals', row_id: 'g1', op: 'delete' },
      ]),
    ).toBe(1)

    expect(
      countCoalescedDeleteIntents([
        { entity: 'goals', row_id: 'g1', op: 'delete' },
        { entity: 'goals', row_id: 'g1', op: 'upsert' },
      ]),
    ).toBe(0)

    expect(
      countCoalescedDeleteIntents([{ entity: 'goals', row_id: 'g1', op: 'purge' }]),
    ).toBe(1)

    expect(
      countCoalescedDeleteIntents([
        { entity: 'goals', row_id: 'g1', op: 'delete' },
        { entity: 'tasks', row_id: 'g1', op: 'delete' },
        { entity: 'tasks', row_id: 'g2', op: 'upsert' },
      ]),
    ).toBe(2)
  })
})

describe('pending confirmation store', () => {
  it('publishes, notifies immediately, and clears', () => {
    const seen: Array<{ deletes: number; total: number } | null> = []
    const unsubscribe = subscribeBulkDelete((req) => seen.push(req))
    expect(seen).toEqual([null])
    expect(getBulkDeleteSnapshot()).toBeNull()

    publishBulkDeleteRequired({ deletes: 30, total: 30 })
    expect(seen[seen.length - 1]).toEqual({ deletes: 30, total: 30 })
    expect(getBulkDeleteSnapshot()).toEqual({ deletes: 30, total: 30 })

    resolveBulkDelete()
    expect(seen[seen.length - 1]).toBeNull()
    expect(getBulkDeleteSnapshot()).toBeNull()

    unsubscribe()
  })
})

describe('engine 409 bulk_delete_required', () => {
  it('publishes, keeps the outbox, yields bulk, and schedules no retry', async () => {
    const { database, repo } = open()
    await database.goals.bulkPut([goal({ id: 'goal-1' })])
    await database.syncOutbox.put({
      entity: 'goals',
      row_id: 'goal-1',
      op: 'upsert',
      updated_at: '2026-10-02T00:00:00.000Z',
    })

    const log: FetchLog[] = []
    const { engine, timers } = harness(
      database,
      repo,
      makeFetch(log, (entry) => {
        if (isPush(entry)) {
          return jsonResponse(409, {
            version: 1,
            error: 'bulk_delete_required',
            deletes: 30,
            total: 30,
          })
        }
        return emptyPull()
      }),
    )

    const result = await engine.run('auto')

    expect(result).toEqual({ ok: false, error: 'bulk' })
    // The guarded chunk was never bisected, quarantined, or dropped.
    expect(await database.syncOutbox.count()).toBe(1)
    expect(getBulkDeleteSnapshot()).toEqual({ deletes: 30, total: 30 })
    // 'bulk' is not retryable: no backoff timer was armed.
    expect(timers.map.size).toBe(0)
  })
})

describe('engine pre-flight confirmation', () => {
  async function seedDrain(database: OrbitDB, count: number): Promise<void> {
    const live = Array.from({ length: count }, (_, i) =>
      goal({ id: `live-${i}` }),
    )
    const tombstones = Array.from({ length: count }, (_, i) =>
      goal({
        id: `tomb-${i}`,
        deleted_at: '2026-10-03T00:00:00.000Z',
        updated_at: '2026-10-03T00:00:00.000Z',
      }),
    )
    await database.goals.bulkPut([...live, ...tombstones])
    await database.syncOutbox.bulkPut(
      tombstones.map((row) => ({
        entity: 'goals' as const,
        row_id: row.id,
        op: 'delete' as const,
        updated_at: row.updated_at,
      })),
    )
  }

  it('holds the drain and makes zero push calls until the user confirms', async () => {
    const { database, repo } = open()
    await seedDrain(database, 30)

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => (isPush(entry) ? appliedAll(entry) : emptyPull())),
    )

    const result = await engine.run('manual')

    expect(result).toEqual({ ok: false, error: 'bulk' })
    expect(log.filter(isPush)).toHaveLength(0)
    expect(log).toHaveLength(0)
    expect(getBulkDeleteSnapshot()).toEqual({ deletes: 30, total: 30 })
    expect(await readOutbox(database)).toHaveLength(30)

    const confirmedLog: FetchLog[] = []
    const { engine: confirmed } = harness(
      database,
      repo,
      makeFetch(confirmedLog, (entry) => (isPush(entry) ? appliedAll(entry) : emptyPull())),
    )
    const confirmedResult = await confirmed.run('manual', {
      allowBulkDelete: true,
      declaredDeleteTotal: 30,
    })

    expect(confirmedResult.ok).toBe(true)
    expect(confirmedLog.filter(isPush).length).toBeGreaterThan(0)
    expect(await readOutbox(database)).toHaveLength(0)
  })
})
