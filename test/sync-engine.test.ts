import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrbitDB, db } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import type { Entity } from '@/lib/repository'
import type { SyncEntity } from '@/lib/sync-entities'
import { reconcileNaturalKeys } from '@/lib/sync/natural-keys'
import {
  backoffDelay,
  classifySyncError,
  createSyncEngine,
  getSyncEngine,
  requestSync,
  startSyncEngine,
  toIsoTimestamp,
  type SyncDeps,
  type SyncEngineHandle,
  type SyncEventSource,
  type SyncVisibilitySource,
} from '@/lib/sync-engine'
import { readOutbox } from '@/lib/outbox'
import { SYNC_KEYS, getSyncCursor, getSyncValue } from '@/lib/sync-store'
import { getSyncAppliedSeq } from '@/lib/sync-applied'
import { listQuarantine } from '@/lib/sync-quarantine'
import { emitLocalWrite } from '@/lib/sync-triggers'
import type { Goal } from '@/lib/types'

/**
 * Phase 19 / plan 19-06 — spy on the natural-key projection so the bounded
 * re-push guard can be asserted deterministically (`>0` ⇒ exactly one extra
 * push, `0` ⇒ none). The default implementation stays the real one, so the
 * duplicate-habit integration test still exercises the true reconciliation.
 */
vi.mock('@/lib/sync/natural-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sync/natural-keys')>()
  return {
    ...actual,
    reconcileNaturalKeys: vi.fn(actual.reconcileNaturalKeys),
  }
})

/**
 * Phase 18 / plan 18-03 — sync engine core.
 *
 * Every test drives `createSyncEngine` with a fake fetch, fake channel, and a
 * manual timer scheduler against a fresh, uniquely named fake-indexeddb
 * database. Nothing touches the module singleton or a real network.
 */

const createdNames: string[] = []
const opened: OrbitDB[] = []
const cleanups: Array<() => void> = []

function newName(): string {
  const name = `orbit-sync-engine-${Date.now()}-${Math.random().toString(36).slice(2)}`
  createdNames.push(name)
  return name
}

function open(): { database: OrbitDB; repo: LocalRepository } {
  const database = new OrbitDB(newName())
  opened.push(database)
  return { database, repo: new LocalRepository(database) }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
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
})

interface PushBodyChange {
  entity: string
  id: string
  op?: string
  updated_at?: string
  deleted_at?: string | null
  data?: unknown
}

interface FetchLog {
  method: string
  path: string
  body:
    | {
        device_id?: string
        changes?: PushBodyChange[]
        allow_bulk_delete?: boolean
        declared_delete_total?: number
      }
    | undefined
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
  const changes = entry.body?.changes ?? []
  return jsonResponse(200, {
    version: 1,
    results: changes.map((c) => ({
      entity: c.entity,
      id: c.id,
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
      const id = next += 1
      map.set(id, { fn, ms })
      return id
    },
    clearTimer: (handle) => {
      map.delete(handle as number)
    },
  }
}

interface Harness {
  engine: SyncEngineHandle
  messages: Array<Record<string, unknown>>
  timers: ManualTimers
}

function harness(
  database: OrbitDB,
  repo: LocalRepository,
  fetchFn: SyncDeps['fetch'],
  overrides: Partial<SyncDeps> = {},
): Harness {
  const messages: Array<Record<string, unknown>> = []
  const timers = manualTimers()
  const engine = createSyncEngine({
    db: database,
    repo,
    fetch: fetchFn,
    session: () => ({ accessToken: 'test-token' }),
    locks: null,
    channel: { postMessage: (message: unknown) => messages.push(message as Record<string, unknown>) },
    online: () => true,
    now: () => Date.UTC(2026, 10, 1, 12, 0, 0),
    random: () => 0.5,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    win: null,
    doc: null,
    ...overrides,
  })
  return { engine, messages, timers }
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

async function seed(database: OrbitDB, entity: Entity, rows: unknown[]): Promise<void> {
  await database.table(entity).bulkPut(rows)
}

async function queue(
  database: OrbitDB,
  entity: SyncEntity,
  ids: string[],
  updatedAt = '2026-10-02T00:00:00.000Z',
): Promise<void> {
  await database.syncOutbox.bulkPut(
    ids.map((id) => ({ entity, row_id: id, op: 'upsert' as const, updated_at: updatedAt })),
  )
}

describe('sync engine core', () => {
  it('skips without a session and performs no fetch', async () => {
    const { database, repo } = open()
    const log: FetchLog[] = []
    const { engine } = harness(database, repo, makeFetch(log, () => emptyPull()), {
      session: () => null,
    })

    await expect(engine.run('auto')).resolves.toEqual({ ok: true, skipped: 'no-session' })
    expect(log).toHaveLength(0)
  })

  it('pushes the outbox before it pulls', async () => {
    const { database, repo } = open()
    await seed(database, 'goals', [goal()])
    await queue(database, 'goals', ['goal-1'])

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => (isPush(entry) ? appliedAll(entry) : emptyPull())),
    )

    await engine.run('auto')

    expect(log).toHaveLength(2)
    expect(log[0].method).toBe('POST')
    expect(log[0].path).toBe('/v1/sync/push')
    expect(log[1].method).toBe('GET')
    expect(log[1].path.startsWith('/v1/sync/pull')).toBe(true)
  })

  it('chunks 201 changes into 200 + 1 and keeps a mid-run append', async () => {
    const { database, repo } = open()
    const rows = Array.from({ length: 201 }, (_, i) => goal({ id: `goal-${i}` }))
    await seed(database, 'goals', rows)
    await queue(database, 'goals', rows.map((row) => row.id))

    const log: FetchLog[] = []
    let pushes = 0
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, async (entry) => {
        if (isPush(entry)) {
          pushes += 1
          if (pushes === 1) {
            // A write that lands while the run is in flight gets a fresh seq
            // that the current snapshot does not know about.
            await database.syncOutbox.put({
              entity: 'goals',
              row_id: 'goal-appended',
              op: 'upsert',
              updated_at: '2026-10-05T00:00:00.000Z',
            })
          }
          return appliedAll(entry)
        }
        return emptyPull()
      }),
    )

    await engine.run('auto')

    const pushLog = log.filter(isPush)
    expect(pushLog).toHaveLength(2)
    expect(pushLog[0].body!.changes).toHaveLength(200)
    expect(pushLog[1].body!.changes).toHaveLength(1)

    const remaining = await readOutbox(database)
    expect(remaining.map((entry) => entry.row_id)).toEqual(['goal-appended'])
  })

  it('handles applied / lost / rejected per result and quarantines after 3 rejections', async () => {
    const { database, repo } = open()
    await seed(database, 'goals', [
      goal({ id: 'goal-a' }),
      goal({ id: 'goal-b' }),
      goal({ id: 'goal-c' }),
    ])
    // Two coalesced entries for goal-a prove all seqs of a key are acked.
    await queue(database, 'goals', ['goal-a', 'goal-a', 'goal-b', 'goal-c'])

    const log: FetchLog[] = []
    // A realistic `lost`: the server winner is strictly newer than the local
    // row. A tie could never be reported as lost by the server's comparator.
    const serverWinner = goal({
      id: 'goal-b',
      name: '服务端版本',
      updated_at: '2026-10-09T00:00:00.000Z',
    })
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => {
        if (isPull(entry)) return emptyPull()
        const changes = entry.body!.changes ?? []
        return jsonResponse(200, {
          version: 1,
          results: changes.map((c) => {
            if (c.id === 'goal-a') return { entity: c.entity, id: c.id, status: 'applied', server_seq: 1 }
            if (c.id === 'goal-b') {
              return {
                entity: c.entity,
                id: c.id,
                status: 'lost',
                current: {
                  entity: 'goals',
                  id: 'goal-b',
                  server_seq: 12,
                  updated_at: serverWinner.updated_at,
                  deleted_at: null,
                  device_id: 'device-b',
                  data: serverWinner,
                },
              }
            }
            return { entity: c.entity, id: c.id, status: 'rejected', error: 'write_failed' }
          }),
        })
      }),
    )

    await engine.run('auto')
    expect((await readOutbox(database)).map((e) => e.row_id)).toEqual(['goal-c'])
    expect(await database.goals.get('goal-b')).toMatchObject({ name: '服务端版本' })
    expect(await getSyncCursor(database)).toBe(0)

    await engine.run('auto')
    expect((await readOutbox(database)).map((e) => e.row_id)).toEqual(['goal-c'])

    await engine.run('auto')
    expect(await readOutbox(database)).toHaveLength(0)
    expect(await getSyncValue(database, SYNC_KEYS.lastError, null)).toBe('write_failed')
    const quarantined = await listQuarantine(database)
    expect(quarantined.some((q) => q.kind === 'push-rejected' && q.id === 'goal-c')).toBe(true)
  })

  it('applies lost.current without advancing the pull cursor', async () => {
    const { database, repo } = open()
    await seed(database, 'goals', [goal({ id: 'goal-b' })])
    await queue(database, 'goals', ['goal-b'])

    const winner = goal({ id: 'goal-b', name: '云端赢了', updated_at: '2026-10-09T00:00:00.000Z' })
    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => {
        if (isPull(entry)) return emptyPull()
        return jsonResponse(200, {
          version: 1,
          results: (entry.body!.changes ?? []).map((c) => ({
            entity: c.entity,
            id: c.id,
            status: 'lost',
            current: {
              entity: 'goals',
              id: c.id,
              server_seq: 7,
              updated_at: winner.updated_at,
              deleted_at: null,
              data: winner,
            },
          })),
        })
      }),
    )

    await engine.run('auto')

    expect(await database.goals.get('goal-b')).toEqual(winner)
    expect(await getSyncCursor(database)).toBe(0)
  })

  it('quarantines an invalid pulled row but still advances the cursor', async () => {
    const { database, repo } = open()
    const valid1 = goal({ id: 'goal-1' })
    const invalid = { id: 'goal-2', category_id: 'cat-1' } // missing many fields
    const valid3 = goal({ id: 'goal-3' })

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => {
        if (isPush(entry)) return appliedAll(entry)
        return jsonResponse(200, {
          version: 1,
          changes: [
            { entity: 'goals', id: 'goal-1', server_seq: 1, updated_at: valid1.updated_at, deleted_at: null, data: valid1 },
            { entity: 'goals', id: 'goal-2', server_seq: 2, updated_at: '2026-10-02T00:00:00.000Z', deleted_at: null, data: invalid },
            { entity: 'goals', id: 'goal-3', server_seq: 3, updated_at: valid3.updated_at, deleted_at: null, data: valid3 },
          ],
          next_cursor: 5,
          has_more: false,
        })
      }),
    )

    await engine.run('auto')

    expect(await database.goals.get('goal-1')).toEqual(valid1)
    expect(await database.goals.get('goal-3')).toEqual(valid3)
    expect(await database.goals.get('goal-2')).toBeUndefined()
    expect(await getSyncCursor(database)).toBe(5)
    const quarantined = await listQuarantine(database)
    expect(quarantined).toEqual([
      expect.objectContaining({ kind: 'pull-invalid', entity: 'goals', id: 'goal-2', serverSeq: 2 }),
    ])
  })

  it('applies pulled rows verbatim through applyRemote and emits the applied signal', async () => {
    const { database, repo } = open()
    const remote = goal({ id: 'goal-remote', name: '远端', updated_at: '2026-10-08T00:00:00.000Z' })
    const before = getSyncAppliedSeq()

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => {
        if (isPush(entry)) return appliedAll(entry)
        return jsonResponse(200, {
          version: 1,
          changes: [
            { entity: 'goals', id: 'goal-remote', server_seq: 3, updated_at: remote.updated_at, deleted_at: null, data: remote },
          ],
          next_cursor: 3,
          has_more: false,
        })
      }),
    )

    await engine.run('auto')

    expect(await database.goals.get('goal-remote')).toEqual(remote)
    expect(await database.syncOutbox.count()).toBe(0)
    expect(await getSyncCursor(database)).toBe(3)
    expect(getSyncAppliedSeq()).toBe(before + 1)
  })

  it('pages through has_more and emits once per applied page', async () => {
    const { database, repo } = open()
    const before = getSyncAppliedSeq()

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => {
        if (isPush(entry)) return appliedAll(entry)
        if (entry.path.includes('since=0')) {
          const row = goal({ id: 'goal-page-1' })
          return jsonResponse(200, {
            version: 1,
            changes: [
              { entity: 'goals', id: 'goal-page-1', server_seq: 3, updated_at: row.updated_at, deleted_at: null, data: row },
            ],
            next_cursor: 3,
            has_more: true,
          })
        }
        const row = goal({ id: 'goal-page-2' })
        return jsonResponse(200, {
          version: 1,
          changes: [
            { entity: 'goals', id: 'goal-page-2', server_seq: 6, updated_at: row.updated_at, deleted_at: null, data: row },
          ],
          next_cursor: 6,
          has_more: false,
        })
      }),
    )

    await engine.run('auto')

    expect(await database.goals.get('goal-page-1')).toBeTruthy()
    expect(await database.goals.get('goal-page-2')).toBeTruthy()
    expect(await getSyncCursor(database)).toBe(6)
    expect(log.filter(isPull)).toHaveLength(2)
    expect(getSyncAppliedSeq()).toBe(before + 2)
  })

  it('transfers zero rows on an idle second cycle', async () => {
    const { database, repo } = open()
    await seed(database, 'goals', [goal()])
    await queue(database, 'goals', ['goal-1'])

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => (isPush(entry) ? appliedAll(entry) : emptyPull())),
    )

    await engine.run('auto')
    log.length = 0

    const result = await engine.run('auto')
    expect(result).toEqual({ ok: true, rowsTransferred: 0 })
    const pushes = log.filter(isPush)
    expect(pushes).toHaveLength(1)
    expect(pushes[0].body!.changes).toHaveLength(0)
    expect(log.filter(isPull)).toHaveLength(1)
  })

  it('quarantines an oversized row without sending it', async () => {
    const { database, repo } = open()
    const huge = goal({ id: 'goal-huge', name: 'x'.repeat(300 * 1024) })
    const normal = goal({ id: 'goal-normal' })
    await seed(database, 'goals', [huge, normal])
    await queue(database, 'goals', ['goal-huge', 'goal-normal'])

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => (isPush(entry) ? appliedAll(entry) : emptyPull())),
    )

    await engine.run('auto')

    const pushes = log.filter(isPush)
    expect(pushes).toHaveLength(1)
    expect(pushes[0].body!.changes!.map((c) => c.id)).toEqual(['goal-normal'])
    const quarantined = await listQuarantine(database)
    expect(quarantined.some((q) => q.kind === 'push-oversize' && q.id === 'goal-huge')).toBe(true)
    expect(await readOutbox(database)).toHaveLength(0)
  })

  it('bisects a 4xx chunk without scheduling backoff', async () => {
    const { database, repo } = open()
    const ids = ['goal-a', 'goal-bad', 'goal-c', 'goal-d']
    await seed(database, 'goals', ids.map((id) => goal({ id })))
    await queue(database, 'goals', ids)

    const log: FetchLog[] = []
    const { engine, timers } = harness(
      database,
      repo,
      makeFetch(log, (entry) => {
        if (isPull(entry)) return emptyPull()
        const changes = entry.body!.changes ?? []
        if (changes.length > 1) return jsonResponse(400, { version: 1, error: 'invalid_changes' })
        if (changes[0]?.id === 'goal-bad') return jsonResponse(400, { version: 1, error: 'invalid_row' })
        return appliedAll(entry)
      }),
    )

    await engine.run('auto')

    const quarantined = await listQuarantine(database)
    expect(quarantined.some((q) => q.kind === 'push-http-4xx' && q.id === 'goal-bad')).toBe(true)
    // The three good rows applied; only the poison row was quarantined.
    expect(await database.syncOutbox.count()).toBe(0)
    // No exponential backoff for a non-retryable rejection.
    expect(timers.map.size).toBe(0)
  })

  it('schedules backoff on a 5xx failure', async () => {
    const { database, repo } = open()
    await seed(database, 'goals', [goal()])
    await queue(database, 'goals', ['goal-1'])

    const log: FetchLog[] = []
    const { engine, timers } = harness(
      database,
      repo,
      makeFetch(log, () => jsonResponse(500, { version: 1, error: 'boom' })),
    )

    const result = await engine.run('auto')
    expect(result).toEqual({ ok: false, error: 'server' })
    expect(timers.map.size).toBe(1)
    // The outbox is intact — a retryable failure loses nothing.
    expect(await database.syncOutbox.count()).toBe(1)
  })

  it('quarantines a malformed outbox row and never sends it', async () => {
    const { database, repo } = open()
    const valid = goal({ id: 'goal-valid' })
    const malformed = { id: 'goal-bad', name: '缺少字段' }
    await seed(database, 'goals', [valid, malformed])
    await queue(database, 'goals', ['goal-bad', 'goal-valid'])

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => (isPush(entry) ? appliedAll(entry) : emptyPull())),
    )

    await engine.run('auto')

    const sent = log.filter(isPush).flatMap((entry) => entry.body!.changes ?? [])
    expect(sent.map((c) => c.id)).toEqual(['goal-valid'])
    const quarantined = await listQuarantine(database)
    expect(quarantined.some((q) => q.kind === 'push-invalid' && q.id === 'goal-bad')).toBe(true)
    expect(await database.syncOutbox.count()).toBe(0)
  })

  it('reports an unsupported repository instead of crashing', async () => {
    const { database } = open()
    const log: FetchLog[] = []
    const { engine } = harness(database, {} as LocalRepository, makeFetch(log, () => emptyPull()))

    await expect(engine.run('auto')).resolves.toEqual({ ok: true, skipped: 'unsupported-repo' })
    expect(log).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Phase 19 / plan 19-06 — purge, merge-aware lost, device id, reconciliation
// ---------------------------------------------------------------------------

const purgeChange = (entity: string, id: string, serverSeq: number) => ({
  entity,
  id,
  server_seq: serverSeq,
  op: 'purge' as const,
  updated_at: null,
  deleted_at: null,
  device_id: 'device-b',
  data: null,
})

describe('sync engine merge and purge wiring', () => {
  it('pushes a queued purge even though its row no longer exists locally', async () => {
    const { database, repo } = open()
    await database.syncOutbox.put({
      entity: 'goals',
      row_id: 'goal-purged',
      op: 'purge',
      updated_at: '2026-10-03T00:00:00.000Z',
    })

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => (isPush(entry) ? appliedAll(entry) : emptyPull())),
    )

    await engine.run('auto')

    const sent = log.filter(isPush).flatMap((entry) => entry.body!.changes ?? [])
    expect(sent).toContainEqual({
      entity: 'goals',
      id: 'goal-purged',
      op: 'purge',
      updated_at: '2026-10-03T00:00:00.000Z',
      deleted_at: null,
      data: null,
    })
    // Acknowledged ⇒ the intent is not retried forever.
    expect(await database.syncOutbox.count()).toBe(0)
    expect((await listQuarantine(database)).some((q) => q.id === 'goal-purged')).toBe(false)
  })

  it('physically deletes a pulled purge marker and advances the cursor', async () => {
    const { database, repo } = open()
    await database.goals.bulkPut([goal({ id: 'goal-dead' })])

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => {
        if (isPush(entry)) return appliedAll(entry)
        return jsonResponse(200, {
          version: 1,
          changes: [purgeChange('goals', 'goal-dead', 4)],
          next_cursor: 4,
          has_more: false,
        })
      }),
    )

    await engine.run('auto')

    expect(await database.goals.get('goal-dead')).toBeUndefined()
    expect(await database.goals.count()).toBe(0)
    // A purge is not a tombstone: no resurrectable row remains.
    expect((await listQuarantine(database)).some((q) => q.id === 'goal-dead')).toBe(false)
    expect(await getSyncCursor(database)).toBe(4)
  })

  it('applies a lost current through applyRemote without advancing the cursor', async () => {
    const { database, repo } = open()
    await seed(database, 'goals', [goal({ id: 'goal-b', name: '本地', updated_at: '2026-10-02T00:00:00.000Z' })])
    await queue(database, 'goals', ['goal-b'])

    const winner = goal({
      id: 'goal-b',
      name: '云端赢了',
      updated_at: '2026-10-09T00:00:00.000Z',
    })
    const log: FetchLog[] = []
    const applySpy = vi.spyOn(repo, 'applyRemote')
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => {
        if (isPull(entry)) return emptyPull()
        return jsonResponse(200, {
          version: 1,
          results: (entry.body!.changes ?? []).map((c) => ({
            entity: c.entity,
            id: c.id,
            status: 'lost',
            current: {
              entity: 'goals',
              id: c.id,
              server_seq: 7,
              op: 'upsert',
              updated_at: winner.updated_at,
              deleted_at: null,
              device_id: 'device-z',
              data: winner,
            },
          })),
        })
      }),
    )

    await engine.run('auto')

    expect(await database.goals.get('goal-b')).toEqual(winner)
    expect(await getSyncCursor(database)).toBe(0)
    // The merge-aware path was used with the cursor frozen (never bulkLoadAll).
    const lostCall = applySpy.mock.calls.find((call) => call[3]?.advanceCursor === false)
    expect(lostCall).toBeDefined()
    expect(lostCall![1]).toBe(0)
    applySpy.mockRestore()
  })

  it('uses the injected device id in the push body', async () => {
    const { database, repo } = open()
    await seed(database, 'goals', [goal()])
    await queue(database, 'goals', ['goal-1'])

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => (isPush(entry) ? appliedAll(entry) : emptyPull())),
      { deviceId: () => 'device-a' },
    )

    await engine.run('auto')

    const pushes = log.filter(isPush)
    expect(pushes.length).toBeGreaterThan(0)
    for (const push of pushes) expect(push.body!.device_id).toBe('device-a')
  })

  it('reconciles duplicate habit completions once per cycle and pushes the tombstone', async () => {
    const { database, repo } = open()
    await database.habitCompletions.bulkPut([
      {
        id: 'hc-a',
        habit_id: 'habit-1',
        date: '2026-10-31',
        note: 'a',
        completed_at: '2026-10-31T09:00:00.000Z',
        updated_at: '2026-10-31T09:00:00.000Z',
        deleted_at: null,
      },
      {
        id: 'hc-b',
        habit_id: 'habit-1',
        date: '2026-10-31',
        note: 'b',
        completed_at: '2026-10-31T09:00:00.000Z',
        updated_at: '2026-10-31T10:00:00.000Z',
        deleted_at: null,
      },
    ])

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => (isPush(entry) ? appliedAll(entry) : emptyPull())),
    )

    await engine.run('auto')

    const all = await database.habitCompletions.toArray()
    const live = all.filter((row) => row.deleted_at == null)
    const tombstones = all.filter((row) => row.deleted_at != null)
    expect(live.map((row) => row.id)).toEqual(['hc-b'])
    expect(tombstones.map((row) => row.id)).toEqual(['hc-a'])

    // push (empty) -> pull -> reconcile -> exactly one post-pull push.
    const pushes = log.filter(isPush)
    expect(pushes).toHaveLength(2)
    expect(pushes[1].body!.changes ?? []).toContainEqual(
      expect.objectContaining({ entity: 'habitCompletions', id: 'hc-a', op: 'delete' }),
    )
    expect(await readOutbox(database)).toHaveLength(0)
  })

  it('runs exactly one extra push when reconciliation reports tombstones', async () => {
    const { database, repo } = open()
    vi.mocked(reconcileNaturalKeys).mockResolvedValueOnce(2)

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => (isPush(entry) ? appliedAll(entry) : emptyPull())),
    )

    await engine.run('auto')

    expect(log.filter(isPush)).toHaveLength(2)
  })

  it('does not re-push when reconciliation reports no tombstones', async () => {
    const { database, repo } = open()
    vi.mocked(reconcileNaturalKeys).mockResolvedValueOnce(0)

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => (isPush(entry) ? appliedAll(entry) : emptyPull())),
    )

    await engine.run('auto')

    expect(log.filter(isPush)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Scheduling & leadership (Task 3)
// ---------------------------------------------------------------------------

class FakeTarget implements SyncEventSource {
  private readonly listeners = new Map<string, Set<() => void>>()

  addEventListener(type: string, fn: () => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(fn)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn)
  }

  emit(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn()
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
}

class FakeDoc extends FakeTarget implements SyncVisibilitySource {
  visibilityState = 'visible'
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function started(engine: SyncEngineHandle): () => void {
  const cleanup = engine.start()
  cleanups.push(cleanup)
  return cleanup
}

const runCount = (messages: Array<Record<string, unknown>>) =>
  messages.filter((message) => message.type === 'sync-start').length

describe('sync engine scheduling and leadership', () => {
  it('skips the run when another tab holds the lock', async () => {
    const { database, repo } = open()
    const log: FetchLog[] = []
    const locks = {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: unknown) => Promise<unknown>,
      ) => callback(null),
    }

    const { engine } = harness(database, repo, makeFetch(log, () => emptyPull()), {
      locks: locks as unknown as Pick<LockManager, 'request'>,
    })

    await expect(engine.run('auto')).resolves.toEqual({ ok: true, skipped: 'leader' })
    expect(log).toHaveLength(0)
  })

  it('debounces a local write by 3000 ms', async () => {
    const { database, repo } = open()
    const log: FetchLog[] = []
    const win = new FakeTarget()
    const doc = new FakeDoc()
    const { engine, messages, timers } = harness(database, repo, makeFetch(log, () => emptyPull()), {
      win,
      doc,
    })

    started(engine)
    await flush()
    expect(runCount(messages)).toBe(1) // app-start trigger

    emitLocalWrite()
    await flush()
    expect(runCount(messages)).toBe(1) // debounced, not immediate
    const pending = [...timers.map.entries()]
    expect(pending).toHaveLength(1)
    expect(pending[0][1].ms).toBe(3000)

    pending[0][1].fn()
    await flush()
    expect(runCount(messages)).toBe(2)
  })

  it('runs immediately on online and cancels the pending debounce', async () => {
    const { database, repo } = open()
    const log: FetchLog[] = []
    const win = new FakeTarget()
    const doc = new FakeDoc()
    const { engine, messages, timers } = harness(database, repo, makeFetch(log, () => emptyPull()), {
      win,
      doc,
    })

    started(engine)
    await flush()

    emitLocalWrite()
    expect(timers.map.size).toBe(1)

    win.emit('online')
    await flush()

    expect(runCount(messages)).toBe(2)
    expect(timers.map.size).toBe(0)
  })

  it('runs immediately when the document becomes visible, and does nothing when hidden', async () => {
    const { database, repo } = open()
    const log: FetchLog[] = []
    const win = new FakeTarget()
    const doc = new FakeDoc()
    const { engine, messages } = harness(database, repo, makeFetch(log, () => emptyPull()), {
      win,
      doc,
    })

    started(engine)
    await flush()
    expect(runCount(messages)).toBe(1)

    doc.visibilityState = 'hidden'
    doc.emit('visibilitychange')
    await flush()
    expect(runCount(messages)).toBe(1)

    doc.visibilityState = 'visible'
    doc.emit('visibilitychange')
    await flush()
    expect(runCount(messages)).toBe(2)
  })

  it('kicks one immediate app-start run', async () => {
    const { database, repo } = open()
    const log: FetchLog[] = []
    const win = new FakeTarget()
    const doc = new FakeDoc()
    const { engine, messages } = harness(database, repo, makeFetch(log, () => emptyPull()), {
      win,
      doc,
    })

    started(engine)
    await flush()

    expect(messages.filter((message) => message.type === 'sync-start')).toEqual([
      { type: 'sync-start', reason: 'auto' },
    ])
  })

  it('broadcasts sync-start, sync-applied and sync-complete once each', async () => {
    const { database, repo } = open()
    const row = goal({ id: 'goal-live' })
    const log: FetchLog[] = []
    const win = new FakeTarget()
    const doc = new FakeDoc()
    const { engine, messages } = harness(
      database,
      repo,
      makeFetch(log, (entry) => {
        if (isPush(entry)) return appliedAll(entry)
        return jsonResponse(200, {
          version: 1,
          changes: [
            {
              entity: 'goals',
              id: 'goal-live',
              server_seq: 1,
              updated_at: row.updated_at,
              deleted_at: null,
              data: row,
            },
          ],
          next_cursor: 1,
          has_more: false,
        })
      }),
      { win, doc },
    )

    await engine.run('auto')

    expect(messages[0]).toMatchObject({ type: 'sync-start' })
    const applied = messages.find((message) => message.type === 'sync-applied')
    expect(applied).toBeDefined()
    expect(applied!.seq).toBe(getSyncAppliedSeq())
    const complete = messages.find((message) => message.type === 'sync-complete')
    expect(complete).toMatchObject({ type: 'sync-complete' })
    expect(typeof complete!.lastSyncedAt).toBe('string')
  })

  it('cleans up timers and listeners and is restartable', async () => {
    const { database, repo } = open()
    const log: FetchLog[] = []
    const win = new FakeTarget()
    const doc = new FakeDoc()
    // Always-500: the initial run schedules a backoff timer.
    const { engine, messages, timers } = harness(
      database,
      repo,
      makeFetch(log, () => jsonResponse(500, { version: 1, error: 'boom' })),
      { win, doc },
    )

    const cleanup = started(engine)
    await flush()
    expect(timers.map.size).toBe(1)

    emitLocalWrite()
    expect(timers.map.size).toBe(2) // debounce + backoff

    cleanup()
    cleanup() // idempotent

    expect(timers.map.size).toBe(0)
    expect(win.listenerCount('online')).toBe(0)
    expect(doc.listenerCount('visibilitychange')).toBe(0)

    const before = runCount(messages)
    emitLocalWrite()
    await flush()
    expect(runCount(messages)).toBe(before)

    // Restart after the logout/teardown cycle resumes scheduling.
    started(engine)
    await flush()
    expect(runCount(messages)).toBe(before + 1)
    expect(win.listenerCount('online')).toBe(1)
    expect(doc.listenerCount('visibilitychange')).toBe(1)
  })

  it('is a no-op in Node with no injected event targets', async () => {
    const { database, repo } = open()
    const log: FetchLog[] = []
    const { engine } = harness(database, repo, makeFetch(log, () => emptyPull()))

    const cleanup = started(engine)
    await flush()

    expect(log).toHaveLength(0)
    expect(database.isOpen()).toBe(false)
    cleanup()
  })

  it('backoff grows monotonically and is capped at 300000 ms', () => {
    const delays = [0, 1, 2, 3, 4, 5, 10].map((attempt) => backoffDelay(attempt, () => 0.5))
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1])
    }
    expect(backoffDelay(20, () => 1)).toBe(300000)
    expect(backoffDelay(20, () => 0)).toBeLessThanOrEqual(300000)
    expect(classifySyncError(new TypeError('failed to fetch'))).toBe('offline')
    expect(classifySyncError(new Error('boom'))).toBe('unknown')
  })

  it('schedules jittered backoff on 5xx but never retries auth failures', async () => {
    const { database, repo } = open()
    await seed(database, 'goals', [goal()])
    await queue(database, 'goals', ['goal-1'])

    const log: FetchLog[] = []
    const timerState = manualTimers()
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, () => jsonResponse(500, { version: 1, error: 'boom' })),
      { setTimer: timerState.setTimer, clearTimer: timerState.clearTimer },
    )

    await engine.run('auto')
    const firstEntry = [...timerState.map.entries()][0]
    expect(firstEntry[1].ms).toBe(backoffDelay(0, () => 0.5))

    // Fire it: the next failure backs off further.
    timerState.map.delete(firstEntry[0])
    firstEntry[1].fn()
    await flush()
    const second = [...timerState.map.values()]
    expect(second).toHaveLength(1)
    expect(second[0].ms).toBeGreaterThan(firstEntry[1].ms)

    // 401 is an auth gate: classified, stored, and never auto-retried.
    const authLog: FetchLog[] = []
    const authTimers = manualTimers()
    const { engine: authEngine } = harness(
      database,
      repo,
      makeFetch(authLog, () => jsonResponse(401, { version: 1, error: 'unauthorized' })),
      { setTimer: authTimers.setTimer, clearTimer: authTimers.clearTimer },
    )
    const result = await authEngine.run('auto')
    expect(result).toEqual({ ok: false, error: 'auth' })
    expect(authTimers.map.size).toBe(0)
    expect(await getSyncValue(database, SYNC_KEYS.lastError, null)).toBe('auth')
  })
})

// ---------------------------------------------------------------------------
// Lazy production singleton (Task 4)
// ---------------------------------------------------------------------------

describe('sync engine singleton', () => {
  it('requestSync is a Node-safe no-op that opens no database', async () => {
    await expect(requestSync('manual')).resolves.toEqual({ ok: true, skipped: 'no-session' })
    expect(db.isOpen()).toBe(false)
  })

  it('getSyncEngine returns the same handle on every call', () => {
    expect(getSyncEngine()).toBe(getSyncEngine())
  })

  it('startSyncEngine returns a safe no-op cleanup in Node', () => {
    const cleanup = startSyncEngine()
    expect(typeof cleanup).toBe('function')
    expect(() => cleanup()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Phase 20 / plan 20-05 — SyncRunOptions, bootstrap gate, push-only, totals,
// and an option-preserving single-flight trail (BOOT-04 client half).
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function flushOnce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('sync engine run options', () => {
  it('skips a requireBootstrap engine until bootstrap completes', async () => {
    const { database, repo } = open()
    const log: FetchLog[] = []
    const { engine } = harness(database, repo, makeFetch(log, () => emptyPull()), {
      requireBootstrap: true,
    })

    await expect(engine.run('auto')).resolves.toEqual({
      ok: true,
      skipped: 'not-bootstrapped',
    })
    expect(log).toHaveLength(0)
  })

  it('runs a requireBootstrap engine when the caller passes bootstrap:true', async () => {
    const { database, repo } = open()
    await seed(database, 'goals', [goal()])
    await queue(database, 'goals', ['goal-1'])

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => (isPush(entry) ? appliedAll(entry) : emptyPull())),
      { requireBootstrap: true },
    )

    await engine.run('manual', { bootstrap: true })

    expect(log.filter(isPush)).toHaveLength(1)
    expect(log.filter(isPull)).toHaveLength(1)
  })

  it('pushes without pulling in a pushOnly run', async () => {
    const { database, repo } = open()
    await seed(database, 'goals', [goal()])
    await queue(database, 'goals', ['goal-1'])

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => (isPush(entry) ? appliedAll(entry) : emptyPull())),
    )

    await engine.run('manual', { pushOnly: true })

    expect(log.filter(isPush).length).toBeGreaterThan(0)
    expect(log.filter(isPull)).toHaveLength(0)
  })

  it('sends declared_delete_total on every chunk and allow_bulk_delete only when permitted', async () => {
    const { database, repo } = open()
    const rows = Array.from({ length: 201 }, (_, i) => goal({ id: `goal-${i}` }))
    await seed(database, 'goals', rows)
    await queue(database, 'goals', rows.map((row) => row.id))

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => (isPush(entry) ? appliedAll(entry) : emptyPull())),
    )

    // Below the 25-row pre-flight threshold so this test isolates the wire
    // contract; the confirmation gate is covered in bulk-delete-client.test.ts.
    await engine.run('manual', { declaredDeleteTotal: 20 })

    const pushes = log.filter(isPush)
    expect(pushes).toHaveLength(2)
    for (const push of pushes) {
      expect(push.body!.declared_delete_total).toBe(20)
      expect(push.body!.allow_bulk_delete).toBeUndefined()
    }

    log.length = 0
    await engine.run('manual', { allowBulkDelete: true, declaredDeleteTotal: 30 })
    const permitted = log.filter(isPush)
    expect(permitted.length).toBeGreaterThan(0)
    for (const push of permitted) {
      expect(push.body!.allow_bulk_delete).toBe(true)
      expect(push.body!.declared_delete_total).toBe(30)
    }
  })

  it('coalesces a guarded request issued mid-run into the trailing cycle', async () => {
    const { database, repo } = open()
    await seed(database, 'goals', [goal()])
    await queue(database, 'goals', ['goal-1'])

    const log: FetchLog[] = []
    const gate = deferred<Response>()
    let pushCount = 0
    const { engine, messages } = harness(
      database,
      repo,
      makeFetch(log, (entry) => {
        if (isPush(entry)) {
          pushCount += 1
          if (pushCount === 1) return gate.promise
          return appliedAll(entry)
        }
        return emptyPull()
      }),
    )

    const auto = engine.run('auto')
    while (pushCount === 0) await flushOnce()

    let manualResolved = false
    const manual = engine.requestSync('manual', {
      allowBulkDelete: true,
      declaredDeleteTotal: 9,
    })
    void manual.then(() => {
      manualResolved = true
    })

    await flushOnce()
    expect(manualResolved).toBe(false)

    gate.resolve(appliedAll(log.find(isPush)!))
    const [autoResult, manualResult] = await Promise.all([auto, manual])

    expect(manualResolved).toBe(true)
    expect(manualResult.ok).toBe(true)
    expect(manualResult).toEqual(autoResult)

    const pushes = log.filter(isPush)
    expect(pushes.length).toBeGreaterThanOrEqual(2)
    for (const push of pushes.slice(1)) {
      expect(push.body!.allow_bulk_delete).toBe(true)
      expect(push.body!.declared_delete_total).toBe(9)
    }
    expect(messages.filter((message) => message.type === 'sync-start')).toHaveLength(2)
  })

  it('clears consumed pending options so a later plain run sends no stale flag', async () => {
    const { database, repo } = open()
    await seed(database, 'goals', [goal()])
    await queue(database, 'goals', ['goal-1'])

    const log: FetchLog[] = []
    const gate = deferred<Response>()
    let pushCount = 0
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => {
        if (isPush(entry)) {
          pushCount += 1
          if (pushCount === 1) return gate.promise
          return appliedAll(entry)
        }
        return emptyPull()
      }),
    )

    const auto = engine.run('auto')
    while (pushCount === 0) await flushOnce()

    const manual = engine.requestSync('manual', {
      allowBulkDelete: true,
      declaredDeleteTotal: 9,
    })
    gate.resolve(appliedAll(log.find(isPush)!))
    await Promise.all([auto, manual])

    log.length = 0
    await engine.run('manual')

    const later = log.filter(isPush)
    expect(later.length).toBeGreaterThan(0)
    for (const push of later) {
      expect(push.body!.allow_bulk_delete).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Phase 21 / OPS-02 — a later pulled change wins for the same (entity,id)
// ---------------------------------------------------------------------------

const pulledRow = <T extends { updated_at: string }>(
  entity: string,
  id: string,
  serverSeq: number,
  data: T,
  deviceId = 'device-a',
) => ({
  entity,
  id,
  server_seq: serverSeq,
  op: 'upsert' as const,
  updated_at: data.updated_at,
  deleted_at: null,
  device_id: deviceId,
  data,
})

describe('sync engine pull-page supersession', () => {
  it('keeps the row live when a purge is followed by a newer row in the same page', async () => {
    const { database, repo } = open()
    const row = goal({
      id: 'goal-mixed',
      name: 'newer',
      updated_at: '2026-10-09T00:00:00.000Z',
    })

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => {
        if (isPush(entry)) return appliedAll(entry)
        return jsonResponse(200, {
          version: 1,
          // applyRemote puts every row before every purge, so an unfiltered
          // purge would delete this row even though the row is newer.
          changes: [
            purgeChange('goals', 'goal-mixed', 4),
            pulledRow('goals', 'goal-mixed', 5, row),
          ],
          next_cursor: 5,
          has_more: false,
        })
      }),
    )

    await engine.run('auto')

    expect(await database.goals.get('goal-mixed')).toEqual(row)
    expect(await getSyncCursor(database)).toBe(5)
  })

  it('deletes the row when a purge is newer than the row in the same page', async () => {
    const { database, repo } = open()
    const row = goal({ id: 'goal-later-purge' })

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => {
        if (isPush(entry)) return appliedAll(entry)
        return jsonResponse(200, {
          version: 1,
          changes: [
            pulledRow('goals', 'goal-later-purge', 4, row),
            purgeChange('goals', 'goal-later-purge', 5),
          ],
          next_cursor: 5,
          has_more: false,
        })
      }),
    )

    await engine.run('auto')

    expect(await database.goals.get('goal-later-purge')).toBeUndefined()
    expect(await getSyncCursor(database)).toBe(5)
  })

  it('does not suppress an earlier purge with a quarantined row', async () => {
    const { database, repo } = open()
    const invalid = {
      id: 'goal-bad',
      category_id: 'cat-1',
      updated_at: '2026-10-02T00:00:00.000Z',
    }

    const log: FetchLog[] = []
    const { engine } = harness(
      database,
      repo,
      makeFetch(log, (entry) => {
        if (isPush(entry)) return appliedAll(entry)
        return jsonResponse(200, {
          version: 1,
          changes: [
            purgeChange('goals', 'goal-bad', 4),
            pulledRow('goals', 'goal-bad', 5, invalid),
          ],
          next_cursor: 5,
          has_more: false,
        })
      }),
    )

    await engine.run('auto')

    expect(await database.goals.get('goal-bad')).toBeUndefined()
    expect(await getSyncCursor(database)).toBe(5)
    expect(await listQuarantine(database)).toEqual([
      expect.objectContaining({
        kind: 'pull-invalid',
        entity: 'goals',
        id: 'goal-bad',
        serverSeq: 5,
      }),
    ])
  })
})

describe('toIsoTimestamp', () => {
  it('normalizes legacy Python datetime.isoformat to the server ISO form', () => {
    expect(toIsoTimestamp('2026-06-17T00:20:58.404298+00:00')).toBe('2026-06-17T00:20:58.404Z')
    expect(toIsoTimestamp('2026-06-13T00:29:36+00:00')).toBe('2026-06-13T00:29:36.000Z')
    expect(toIsoTimestamp('2026-10-02T00:00:00.000Z')).toBe('2026-10-02T00:00:00.000Z')
    expect(toIsoTimestamp(null)).toBeNull()
    expect(toIsoTimestamp(undefined)).toBeNull()
  })
})
