import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import type { Entity } from '@/lib/repository'
import { SYNC_ENTITIES, type SyncEntity } from '@/lib/sync-entities'
import { createSyncEngine, type SyncEngineHandle } from '@/lib/sync-engine'
import { countOutbox } from '@/lib/outbox'
import { getSyncCursor } from '@/lib/sync-store'
import type { PullChange, PushChange } from '@/lib/sync-protocol'
import { wins, type LwwMeta } from '@/lib/sync/conflict'
import {
  mergeJournalBodies,
  mergeQuantity,
  type ConflictCopy,
  type JournalBody,
} from '@/lib/sync/merge'

/**
 * Phase 18 / 19 — two-device end-to-end integration proof.
 *
 * Two independent Dexie stores (two "devices") drive the REAL sync engine
 * against ONE in-memory fake server that mirrors the Phase 19 wire semantics:
 * the full `(updated_at, tombstone, device_id)` comparator, server-authoritative
 * journal same-day merge, quantity max on both LWW paths, durable purge
 * markers, and a UNION pull carrying `op` + `device_id`. Everything is
 * deterministic: `Date` is faked so `repo.upsert`'s stamp and the engine's
 * `now()` come from a controllable clock, and the session is injected —
 * without it every run would skip as `no-session` under Node.
 *
 * T-19-01: the fake server imports the REAL comparator and merge functions, so
 * these end-to-end assertions cannot pass while the rule drifts from the app.
 */

const BASE = Date.parse('2026-11-01T00:00:00.000Z')
const USER_A = 'user-a'
const USER_OTHER = 'user-other'

const createdNames: string[] = []
const opened: OrbitDB[] = []

let clockTick = 0
let deviceSeq = 0

/** Advance the fake clock by one second and return the resulting ISO stamp. */
function tick(): string {
  clockTick += 1
  const at = new Date(BASE + clockTick * 1000)
  vi.setSystemTime(at)
  return at.toISOString()
}

/** A fixed ISO stamp offset from BASE (used for controlled `updated_at` values). */
function iso(seconds: number): string {
  return new Date(BASE + seconds * 1000).toISOString()
}

function newName(): string {
  const name = `orbit-sync-int-${Date.now()}-${Math.random().toString(36).slice(2)}`
  createdNames.push(name)
  return name
}

function nextDeviceId(): string {
  deviceSeq += 1
  return `device-default-${deviceSeq}`
}

beforeEach(() => {
  clockTick = 0
  deviceSeq = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(BASE))
})

afterEach(async () => {
  vi.useRealTimers()
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

// ---------------------------------------------------------------------------
// In-memory sync server (mirrors server/src/sync.ts + server/src/db.ts)
// ---------------------------------------------------------------------------

interface ServerRow {
  user: string
  entity: SyncEntity
  id: string
  data: Record<string, unknown>
  updated_at: string
  deleted_at: string | null
  device_id: string | null
  server_seq: number
}

interface PurgeMarker {
  user: string
  entity: SyncEntity
  id: string
  device_id: string | null
  purged_at: string
  server_seq: number
}

interface PushBody {
  device_id?: string
  changes?: unknown[]
}

const isQuantity = (data: Record<string, unknown> | null | undefined): boolean =>
  !!data && data.progress_type === 'quantity'

const finiteOrZero = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

function journalBodyOf(row: ServerRow): JournalBody {
  const copies = Array.isArray(row.data.conflict_copies)
    ? (row.data.conflict_copies as ConflictCopy[])
    : []
  return {
    content: typeof row.data.content === 'string' ? row.data.content : '',
    updated_at: row.updated_at,
    device_id: row.device_id,
    conflict_copies: copies,
  }
}

class FakeSyncServer {
  private readonly rows = new Map<string, ServerRow>()
  private readonly purges = new Map<string, PurgeMarker>()
  private seq = 0

  pushRequests = 0
  pullRequests = 0
  rowsPushed = 0
  rowsPulled = 0
  requestLog: Array<'push' | 'pull'> = []

  private key(user: string, entity: string, id: string): string {
    return `${user}:${entity}:${id}`
  }

  resetCounters(): void {
    this.pushRequests = 0
    this.pullRequests = 0
    this.rowsPushed = 0
    this.rowsPulled = 0
    this.requestLog = []
  }

  /** Highest server_seq ever assigned (the cursor a converged device should hold). */
  highestSeq(): number {
    return this.seq
  }

  rowsForUser(user: string): ServerRow[] {
    return [...this.rows.values()].filter((row) => row.user === user)
  }

  purgesForUser(user: string): PurgeMarker[] {
    return [...this.purges.values()].filter((marker) => marker.user === user)
  }

  rowFor(user: string, entity: SyncEntity, id: string): ServerRow | undefined {
    return this.rows.get(this.key(user, entity, id))
  }

  private nextSeq(): number {
    this.seq += 1
    return this.seq
  }

  private metaOf(row: { updated_at: string; deleted_at: string | null; device_id: string | null }): LwwMeta {
    return { updated_at: row.updated_at, deleted_at: row.deleted_at, device_id: row.device_id }
  }

  /** Project a stored row onto the pull/lost wire envelope (op + device_id). */
  private wireChange(row: ServerRow): PullChange {
    return {
      entity: row.entity,
      id: row.id,
      server_seq: row.server_seq,
      op: row.deleted_at !== null ? 'delete' : 'upsert',
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
      device_id: row.device_id,
      data: row.data,
    }
  }

  /** Same-day journal rows with a different id (tombstones included — §3a). */
  private dayRows(user: string, dayKey: string, excludeId: string): ServerRow[] {
    return [...this.rows.values()].filter(
      (row) =>
        row.user === user &&
        row.entity === 'journalEntries' &&
        row.id !== excludeId &&
        typeof row.data.day_key === 'string' &&
        row.data.day_key === dayKey,
    )
  }

  /** Deterministic comparator winner; the id tie-break matches the server. */
  private bestRow(rows: readonly ServerRow[]): ServerRow {
    let best = rows[0]
    for (const row of rows.slice(1)) {
      if (wins(this.metaOf(row), this.metaOf(best))) best = row
      else if (!wins(this.metaOf(best), this.metaOf(row)) && row.id > best.id) best = row
    }
    return best
  }

  /**
   * Winning-path field merge: quantity max and same-id journal body copy.
   * Mirrors `mergedWinningData` in server/src/db.ts.
   */
  private mergedWinningData(
    entity: SyncEntity,
    incoming: Record<string, unknown>,
    updatedAt: string,
    deviceId: string | null,
    stored: ServerRow | undefined,
  ): Record<string, unknown> {
    const data = { ...incoming }
    if (entity === 'tasks' && stored && isQuantity(data) && isQuantity(stored.data)) {
      data.current_value = mergeQuantity(
        finiteOrZero(data.current_value),
        finiteOrZero(stored.data.current_value),
      )
    }
    if (
      entity === 'journalEntries' &&
      stored &&
      stored.deleted_at === null &&
      (data.deleted_at ?? null) === null
    ) {
      const incomingContent = typeof data.content === 'string' ? data.content : null
      const storedContent =
        typeof stored.data.content === 'string' ? stored.data.content : null
      if (
        incomingContent !== null &&
        storedContent !== null &&
        incomingContent !== storedContent
      ) {
        const merged = mergeJournalBodies(
          {
            content: incomingContent,
            updated_at: updatedAt,
            device_id: deviceId,
            conflict_copies: Array.isArray(data.conflict_copies)
              ? (data.conflict_copies as ConflictCopy[])
              : [],
          },
          journalBodyOf(stored),
        )
        data.content = merged.content
        data.conflict_copies = merged.conflict_copies
      }
    }
    return data
  }

  private applyChange(user: string, deviceId: string | null, change: PushChange): unknown {
    const entity = change.entity
    const id = change.id
    const key = this.key(user, entity, id)

    // MERGE-04: an unconditional physical delete + durable marker.
    if (change.op === 'purge') {
      this.rows.delete(key)
      const seq = this.nextSeq()
      this.purges.set(key, {
        user,
        entity,
        id,
        device_id: deviceId,
        purged_at: change.updated_at,
        server_seq: seq,
      })
      return { entity, id, status: 'applied', server_seq: seq }
    }

    // Anti-resurrection: a purge marker consumes later writes without storing.
    if (this.purges.has(key)) {
      return { entity, id, status: 'applied', server_seq: this.nextSeq() }
    }

    const incomingMeta: LwwMeta = {
      updated_at: change.updated_at,
      deleted_at: change.deleted_at ?? null,
      device_id: deviceId,
    }
    const incomingData = change.data ?? {}

    // MERGE-02 / D-04: a live journal row whose day is held by a different id
    // converges into the canonical stored row instead of creating a second id.
    if (
      entity === 'journalEntries' &&
      (change.deleted_at ?? null) === null &&
      typeof incomingData.day_key === 'string'
    ) {
      const sameDay = this.dayRows(user, incomingData.day_key, id)
      if (sameDay.length > 0) {
        const canonical = this.bestRow(sameDay)
        const incomingWins = wins(incomingMeta, this.metaOf(canonical))
        if (!incomingWins && canonical.deleted_at !== null) {
          // A tombstoned day wins: consume the incoming row, never resurrect.
          return { entity, id, status: 'applied', server_seq: this.nextSeq() }
        }
        const incomingBody: JournalBody = {
          content: typeof incomingData.content === 'string' ? incomingData.content : '',
          updated_at: change.updated_at,
          device_id: deviceId,
          conflict_copies: Array.isArray(incomingData.conflict_copies)
            ? (incomingData.conflict_copies as ConflictCopy[])
            : [],
        }
        const winnerBody = incomingWins ? incomingBody : journalBodyOf(canonical)
        const loserBody = incomingWins ? journalBodyOf(canonical) : incomingBody
        const mergedBodies = mergeJournalBodies(winnerBody, loserBody)
        const mergedData = {
          ...canonical.data,
          id: canonical.id,
          content: mergedBodies.content,
          conflict_copies: mergedBodies.conflict_copies,
          deleted_at: null,
        }
        const seq = this.nextSeq()
        this.rows.set(this.key(user, entity, canonical.id), {
          user,
          entity,
          id: canonical.id,
          data: mergedData,
          updated_at:
            change.updated_at > canonical.updated_at
              ? change.updated_at
              : canonical.updated_at,
          deleted_at: null,
          device_id: incomingWins ? deviceId : canonical.device_id,
          server_seq: seq,
        })
        return { entity, id, status: 'applied', server_seq: seq, merged_into: canonical.id }
      }
    }

    const existing = this.rows.get(key)
    const incomingWins = !existing || wins(incomingMeta, this.metaOf(existing))

    if (incomingWins) {
      const data =
        entity === 'journalEntries' || entity === 'tasks'
          ? this.mergedWinningData(entity, incomingData, change.updated_at, deviceId, existing)
          : { ...incomingData }
      const seq = this.nextSeq()
      this.rows.set(key, {
        user,
        entity,
        id,
        data,
        updated_at: change.updated_at,
        deleted_at: change.deleted_at ?? null,
        device_id: deviceId,
        server_seq: seq,
      })
      return { entity, id, status: 'applied', server_seq: seq }
    }

    if (existing) {
      // MERGE-03 / D-01: a losing quantity write with higher progress raises the
      // stored value instead of discarding it — on the losing path, not only the
      // winning one.
      if (entity === 'tasks' && isQuantity(incomingData) && isQuantity(existing.data)) {
        const storedValue = finiteOrZero(existing.data.current_value)
        const merged = mergeQuantity(finiteOrZero(incomingData.current_value), storedValue)
        if (merged > storedValue) {
          const seq = this.nextSeq()
          const raised: ServerRow = {
            ...existing,
            data: { ...existing.data, current_value: merged },
            server_seq: seq,
          }
          this.rows.set(key, raised)
          return { entity, id, status: 'lost', current: this.wireChange(raised) }
        }
      }

      // MERGE-03 / D-02: a losing live journal body is retained as a copy.
      if (
        entity === 'journalEntries' &&
        (change.deleted_at ?? null) === null &&
        existing.deleted_at === null
      ) {
        const incomingContent =
          typeof incomingData.content === 'string' ? incomingData.content : ''
        const storedContent =
          typeof existing.data.content === 'string' ? existing.data.content : ''
        if (
          incomingContent !== '' &&
          storedContent !== '' &&
          incomingContent !== storedContent
        ) {
          const merged = mergeJournalBodies(journalBodyOf(existing), {
            content: incomingContent,
            updated_at: change.updated_at,
            device_id: deviceId,
            conflict_copies: Array.isArray(incomingData.conflict_copies)
              ? (incomingData.conflict_copies as ConflictCopy[])
              : [],
          })
          const seq = this.nextSeq()
          const appended: ServerRow = {
            ...existing,
            data: { ...existing.data, conflict_copies: merged.conflict_copies },
            server_seq: seq,
          }
          this.rows.set(key, appended)
          return { entity, id, status: 'lost', current: this.wireChange(appended) }
        }
      }

      return { entity, id, status: 'lost', current: this.wireChange(existing) }
    }

    return { entity, id, status: 'lost', current: null }
  }

  push(user: string, body: PushBody): { version: 1; results: unknown[] } {
    const changes = Array.isArray(body.changes) ? body.changes : []
    this.rowsPushed += changes.length
    const deviceId = typeof body.device_id === 'string' ? body.device_id : null

    const results = changes.map((raw) => this.applyChange(user, deviceId, raw as PushChange))
    return { version: 1, results }
  }

  /** Mirror GET /v1/sync/pull: owner-scoped UNION of rows + purge markers. */
  pull(
    user: string,
    since: number,
    limit: number,
  ): { version: 1; changes: PullChange[]; next_cursor: number; has_more: boolean } {
    const rowChanges: PullChange[] = [...this.rows.values()]
      .filter((row) => row.user === user && row.server_seq > since)
      .map((row) => this.wireChange(row))

    const purgeChanges: PullChange[] = [...this.purges.values()]
      .filter((marker) => marker.user === user && marker.server_seq > since)
      .map((marker) => ({
        entity: marker.entity,
        id: marker.id,
        server_seq: marker.server_seq,
        op: 'purge' as const,
        updated_at: null,
        deleted_at: null,
        device_id: marker.device_id,
        data: null,
      }))

    const changes = [...rowChanges, ...purgeChanges]
      .sort((a, b) => a.server_seq - b.server_seq)
      .slice(0, limit)

    this.rowsPulled += changes.length

    return {
      version: 1,
      changes,
      next_cursor: changes.length > 0 ? changes[changes.length - 1].server_seq : since,
      has_more: changes.length === limit,
    }
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Route one device's fetch calls. The `online` box is per-device: a false flag
 * throws a TypeError, which the engine classifies as `offline` — the same thing
 * a real browser fetch does on a dropped connection.
 */
async function routeFetch(
  server: FakeSyncServer,
  user: string,
  online: { value: boolean },
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (!online.value) throw new TypeError('Failed to fetch')

  if (path.startsWith('/v1/sync/push')) {
    server.pushRequests += 1
    server.requestLog.push('push')
    const body = init?.body ? (JSON.parse(String(init.body)) as PushBody) : { changes: [] }
    return jsonResponse(200, server.push(user, body))
  }

  if (path.startsWith('/v1/sync/pull')) {
    server.pullRequests += 1
    server.requestLog.push('pull')
    const query = new URLSearchParams(path.slice(path.indexOf('?') + 1))
    const since = Number(query.get('since') ?? '0')
    const limit = Number(query.get('limit') ?? '500')
    return jsonResponse(200, server.pull(user, since, limit))
  }

  return jsonResponse(404, { version: 1, error: 'not_found' })
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

interface Device {
  db: OrbitDB
  repo: LocalRepository
  engine: SyncEngineHandle
  /** Mutable per-device connectivity flag. */
  online: { value: boolean }
}

/**
 * Build one device. The third parameter is OPTIONAL and defaults to a stable
 * per-call id, so every existing two-arg call site keeps compiling while the
 * LWW tie-break tests can pin two meaningful writer identities (Landmine 12 —
 * `readDeviceId()` mints a fresh UUID per call under Node).
 */
function makeDevice(server: FakeSyncServer, user: string, deviceId?: string): Device {
  const resolvedDeviceId = deviceId ?? nextDeviceId()
  const database = new OrbitDB(newName())
  opened.push(database)
  const repo = new LocalRepository(database, () => resolvedDeviceId)
  const online = { value: true }

  const engine = createSyncEngine({
    db: database,
    repo,
    fetch: (path, init) => routeFetch(server, user, online, path, init),
    // W5: the session MUST be injected; readSession() is null under Node and
    // every run would silently skip as `no-session`.
    session: () => ({ accessToken: 'test-token' }),
    deviceId: () => resolvedDeviceId,
    locks: null,
    channel: null,
    online: () => online.value,
    now: () => Date.now(),
    random: () => 0.5,
    // Never let a scheduled backoff hold the process open or fire later.
    setTimer: () => Symbol('sync-timer'),
    clearTimer: () => {},
    win: null,
    doc: null,
  })

  return { db: database, repo, engine, online }
}

type LooseUpsert = (entity: Entity, row: Record<string, unknown>) => Promise<void>

/** Write one row through the REAL repository path (stamps updated_at, queues outbox). */
async function write(
  repo: LocalRepository,
  entity: SyncEntity,
  row: Record<string, unknown>,
): Promise<void> {
  await (repo.upsert as unknown as LooseUpsert)(entity, row)
}

/** Overwrite a row's LWW metadata after a real write, keeping its outbox entry. */
async function stampRow(
  device: Device,
  entity: SyncEntity,
  id: string,
  updatedAt: string,
): Promise<void> {
  await device.db.table<Record<string, unknown>, string>(entity).update(id, {
    updated_at: updatedAt,
  })
}

async function runAll(devices: readonly Device[]): Promise<void> {
  for (const device of devices) await device.engine.run('auto')
}

// ---------------------------------------------------------------------------
// Fixtures — one sample row per SYNC_ENTITIES table
// ---------------------------------------------------------------------------

function sampleRows(): Record<SyncEntity, Record<string, unknown>> {
  return {
    categories: { id: 'cat-1', name: '分类', created_at: iso(0), sort_order: 0 },
    goals: { id: 'goal-1', category_id: 'cat-1', name: '目标', created_at: iso(0), sort_order: 0 },
    milestones: {
      id: 'ms-1',
      goal_id: 'goal-1',
      name: '里程碑',
      created_at: iso(0),
      sort_order: 0,
    },
    tasks: {
      id: 'task-1',
      milestone_id: 'ms-1',
      goal_id: null,
      parent_id: null,
      name: '勾选任务',
      progress_type: 'checkbox',
      completed: false,
      completed_at: null,
      unit: null,
      target_value: null,
      current_value: null,
      created_at: iso(0),
      sort_order: 0,
    },
    dailyTodos: {
      id: 'todo-1',
      task_id: null,
      name: '今日待办',
      completed: false,
      completed_at: null,
      added_at: iso(0),
    },
    journalEntries: { id: 'journal-1', day_key: '2026-11-01', content: '今天' },
    habits: { id: 'habit-1', name: '每天跑步', short_name: '跑步', sort_order: 0 },
    habitCompletions: {
      id: 'hc-1',
      habit_id: 'habit-1',
      date: '2026-11-01',
      note: null,
      completed_at: iso(0),
    },
    pomodoroSessions: {
      id: 'pomo-1',
      started_at: iso(0),
      duration_sec: 1500,
      notes: [],
      habit_id: null,
      task_id: null,
      daily_todo_id: null,
      marked_task_complete: false,
      progress_amount: null,
      shared_indices: [],
    },
  }
}

function quantityTask(id: string, current: number): Record<string, unknown> {
  return {
    id,
    milestone_id: null,
    goal_id: null,
    parent_id: null,
    name: '读书',
    progress_type: 'quantity',
    completed: false,
    completed_at: null,
    unit: '页',
    target_value: 100,
    current_value: current,
    created_at: iso(0),
    sort_order: 0,
  }
}

function linkedTodo(id: string): Record<string, unknown> {
  return {
    id,
    task_id: 'task-1',
    name: null,
    completed: null,
    completed_at: null,
    added_at: iso(0),
  }
}

/** Seed all nine tables on one device, one second apart (W7 determinism). */
async function seedAll(device: Device): Promise<Record<SyncEntity, Record<string, unknown>>> {
  const rows = sampleRows()
  for (const entity of SYNC_ENTITIES) {
    tick()
    await write(device.repo, entity, rows[entity])
  }
  return rows
}

async function listAll(device: Device, entity: SyncEntity): Promise<Record<string, unknown>[]> {
  return (await device.repo.list(entity, { includeDeleted: true })) as Record<string, unknown>[]
}

async function liveRows(
  device: Device,
  entity: SyncEntity,
): Promise<Record<string, unknown>[]> {
  return (await device.repo.list(entity)) as Record<string, unknown>[]
}

/**
 * Deterministic live-row snapshot for the order-independence proof (Landmine
 * 16). Live rows only (tombstone timestamps are wall-clock) and conflict-copy
 * arrays are canonicalized so the comparison is order-stable.
 *
 * Copies are projected to `{ content, at }`: a body that a device wrote itself
 * is re-added from its local row on the losing path with no writer id, so the
 * deduped copy's `device_id` can legitimately be null on the originating device
 * while the peer keeps the server's id. Content and timestamp are the D-02
 * contract; writer attribution is diagnostic only.
 */
async function liveSnapshot(device: Device): Promise<Record<string, unknown>[]> {
  const snapshot: Record<string, unknown>[] = []
  for (const entity of SYNC_ENTITIES) {
    const rows = await liveRows(device, entity)
    rows.sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
    for (const row of rows) {
      const copies = Array.isArray(row.conflict_copies)
        ? ([...row.conflict_copies] as ConflictCopy[])
            .map((copy) => ({ content: copy.content, at: copy.at }))
            .sort((x, y) => {
              if (x.at !== y.at) return x.at < y.at ? -1 : 1
              return x.content < y.content ? -1 : x.content > y.content ? 1 : 0
            })
        : []
      snapshot.push({
        entity,
        ...row,
        ...(copies.length > 0 ? { conflict_copies: copies } : {}),
      })
    }
  }
  return snapshot
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sync engine end to end (two devices, one in-memory server)', () => {
  it('Test 1: device A pushes exactly nine rows into the server', async () => {
    const server = new FakeSyncServer()
    const a = makeDevice(server, USER_A)
    const rows = await seedAll(a)

    const result = await a.engine.run('auto')

    expect(result.ok).toBe(true)
    expect(server.pushRequests).toBe(1)
    expect(server.rowsForUser(USER_A)).toHaveLength(SYNC_ENTITIES.length)
    expect(server.rowsForUser(USER_A).map((row) => `${row.entity}:${row.id}`).sort()).toEqual(
      SYNC_ENTITIES.map((entity) => `${entity}:${rows[entity].id}`).sort(),
    )
  })

  it('Test 2: device B converges every table byte-for-byte through the real engine', async () => {
    const server = new FakeSyncServer()
    const a = makeDevice(server, USER_A)
    const b = makeDevice(server, USER_A)

    await seedAll(a)
    await a.engine.run('auto')
    await b.engine.run('auto')

    for (const entity of SYNC_ENTITIES) {
      const rowsA = await listAll(a, entity)
      const rowsB = await listAll(b, entity)
      expect(rowsA).toHaveLength(1)
      expect(rowsB).toHaveLength(1)
      // id / updated_at / deleted_at and every entity-specific field survive.
      expect(rowsB[0]).toEqual(rowsA[0])
      expect(rowsB[0]).toMatchObject({
        id: rowsA[0].id,
        updated_at: rowsA[0].updated_at,
        deleted_at: null,
      })
    }
  })

  it('Test 3: an edit on B flows back to A, and A leaves no queued intent', async () => {
    const server = new FakeSyncServer()
    const a = makeDevice(server, USER_A)
    const b = makeDevice(server, USER_A)

    await seedAll(a)
    await a.engine.run('auto')
    await b.engine.run('auto')

    tick()
    await write(b.repo, 'goals', {
      id: 'goal-1',
      category_id: 'cat-1',
      name: 'B 改过的目标',
      created_at: iso(0),
      sort_order: 0,
    })
    await b.engine.run('auto')
    await a.engine.run('auto')

    expect(await a.db.goals.get('goal-1')).toMatchObject({ name: 'B 改过的目标' })
    expect(await b.db.goals.get('goal-1')).toMatchObject({ name: 'B 改过的目标' })
    expect(await countOutbox(a.db)).toBe(0)
    expect(await countOutbox(b.db)).toBe(0)
  })

  it('Test 4: an offline edit queues without touching the server, then pushes on reconnect', async () => {
    const server = new FakeSyncServer()
    const a = makeDevice(server, USER_A)
    const b = makeDevice(server, USER_A)

    tick()
    await write(a.repo, 'tasks', sampleRows().tasks)
    expect(await countOutbox(a.db)).toBe(1)

    a.online.value = false
    const skipped = await a.engine.run('auto')
    expect(skipped).toEqual({ ok: true, skipped: 'offline' })
    expect(server.requestLog).toHaveLength(0)
    expect(server.rowsForUser(USER_A)).toHaveLength(0)
    expect(await countOutbox(a.db)).toBe(1)

    a.online.value = true
    await a.engine.run('auto')
    expect(await countOutbox(a.db)).toBe(0)
    expect(server.rowsForUser(USER_A)).toHaveLength(1)

    await b.engine.run('auto')
    expect(await b.db.tasks.get('task-1')).toBeTruthy()
  })

  it('Test 5: a soft delete propagates as a tombstone and is never resurrected', async () => {
    const server = new FakeSyncServer()
    const a = makeDevice(server, USER_A)
    const b = makeDevice(server, USER_A)

    tick()
    await write(a.repo, 'journalEntries', sampleRows().journalEntries)
    await a.engine.run('auto')
    await b.engine.run('auto')
    expect((await b.db.journalEntries.get('journal-1'))!.deleted_at).toBeNull()

    tick()
    await a.repo.softDelete('journalEntries', 'journal-1')
    await a.engine.run('auto')
    await b.engine.run('auto')

    const onB = await b.db.journalEntries.get('journal-1')
    expect(onB).toBeDefined()
    expect(onB!.id).toBe('journal-1')
    expect(onB!.deleted_at).not.toBeNull()

    // A second round trip must not bring the row back to life on either device.
    await a.engine.run('auto')
    await b.engine.run('auto')
    expect((await b.db.journalEntries.get('journal-1'))!.deleted_at).not.toBeNull()
    expect((await a.db.journalEntries.get('journal-1'))!.deleted_at).not.toBeNull()
  })

  it('Test 6: a converged second sync transfers zero rows and the cursor equals the highest server_seq', async () => {
    const server = new FakeSyncServer()
    const a = makeDevice(server, USER_A)
    const b = makeDevice(server, USER_A)

    await seedAll(a)
    await a.engine.run('auto')
    await b.engine.run('auto')

    const highest = server.highestSeq()
    expect(await getSyncCursor(a.db)).toBe(highest)
    expect(await getSyncCursor(b.db)).toBe(highest)

    server.resetCounters()
    const result = await a.engine.run('auto')

    expect(result).toEqual({ ok: true, rowsTransferred: 0 })
    expect(result.rowsTransferred).toBe(0)
    expect(server.rowsPushed).toBe(0)
    expect(server.rowsPulled).toBe(0)
    expect(await getSyncCursor(a.db)).toBe(highest)
  })

  it('Test 7: the push request always precedes the pull request', async () => {
    const server = new FakeSyncServer()
    const a = makeDevice(server, USER_A)

    await seedAll(a)
    await a.engine.run('auto')

    expect(server.requestLog).toEqual(['push', 'pull'])
    expect(server.pushRequests).toBe(1)
    expect(server.pullRequests).toBe(1)
  })

  it('Test 8: rows are isolated by user — one account never pulls another account’s data', async () => {
    const server = new FakeSyncServer()
    const a = makeDevice(server, USER_A)
    const other = makeDevice(server, USER_OTHER)

    // Direct server seeds must carry the FULL row (the engine's push sends
    // `data` as the whole entity row, so `updated_at`/`deleted_at` ride along).
    const otherGoal = {
      id: 'goal-other',
      category_id: 'cat-x',
      name: '别人的目标',
      created_at: iso(0),
      sort_order: 0,
      updated_at: iso(9),
      deleted_at: null,
    }
    // Seed the other user directly on the server (server_seq 1).
    server.push(USER_OTHER, {
      changes: [
        {
          entity: 'goals',
          id: otherGoal.id,
          op: 'upsert',
          updated_at: iso(9),
          deleted_at: null,
          data: otherGoal,
        },
      ],
    })

    tick()
    await write(a.repo, 'goals', sampleRows().goals)
    await a.engine.run('auto')
    await other.engine.run('auto')

    expect(await a.db.goals.get('goal-1')).toBeTruthy()
    expect(await a.db.goals.get('goal-other')).toBeUndefined()
    expect(await other.db.goals.get('goal-other')).toBeTruthy()
    expect(await other.db.goals.get('goal-1')).toBeUndefined()
    expect(server.rowsForUser(USER_A)).toHaveLength(1)
    expect(server.rowsForUser(USER_OTHER)).toHaveLength(1)
  })

  it('Test 9: same-day journal rows with different ids converge to one row per day', async () => {
    const server = new FakeSyncServer()
    const a = makeDevice(server, USER_A)
    const b = makeDevice(server, USER_A)

    // The server holds a DIFFERENT live journal row for the same day (newer).
    server.push(USER_A, {
      changes: [
        {
          entity: 'journalEntries',
          id: 'j-remote',
          op: 'upsert',
          updated_at: iso(10),
          deleted_at: null,
          data: {
            id: 'j-remote',
            day_key: '2026-11-01',
            content: '远端',
            updated_at: iso(10),
            deleted_at: null,
          },
        },
      ],
    })

    // Both devices already hold their own live row for that day (seeded
    // directly so they produce no outbox intent).
    const local = {
      id: 'j-local',
      day_key: '2026-11-01',
      content: '本地',
      updated_at: iso(2),
      deleted_at: null,
    }
    await a.db.journalEntries.put(local as never)
    await b.db.journalEntries.put(local as never)

    const resultA = await a.engine.run('auto')
    const resultB = await b.engine.run('auto')

    expect(resultA.ok).toBe(true)
    expect(resultB.ok).toBe(true)

    const highest = server.highestSeq()
    for (const device of [a, b]) {
      const rows = await listAll(device, 'journalEntries')
      expect(rows).toHaveLength(1)
      const row = rows[0]
      expect(row.id).toBe('j-remote')
      expect(row.day_key).toBe('2026-11-01')
      expect(row.content).toBe('远端')
      expect(row.deleted_at).toBeNull()
      const copies = row.conflict_copies as ConflictCopy[]
      expect(copies.map((copy) => copy.content)).toContain('本地')
      expect(await getSyncCursor(device.db)).toBe(highest)
    }
  })

  it('Test 10: an exact-timestamp edit-vs-delete tie converges to the tombstone in both push orders', async () => {
    const T = iso(50)

    const runOrder = async (order: readonly ['a' | 'b', 'a' | 'b', 'a' | 'b']) => {
      clockTick = 0
      vi.setSystemTime(new Date(BASE))
      const server = new FakeSyncServer()
      const a = makeDevice(server, USER_A, 'device-a')
      const b = makeDevice(server, USER_A, 'device-b')

      // A's live edit and B's tombstone share the SAME updated_at.
      tick()
      await write(a.repo, 'categories', {
        id: 'cat-tie',
        name: 'A 编辑',
        created_at: iso(0),
        sort_order: 0,
      })
      await stampRow(a, 'categories', 'cat-tie', T)

      tick()
      await write(b.repo, 'categories', {
        id: 'cat-tie',
        name: 'B 原始',
        created_at: iso(0),
        sort_order: 0,
      })
      await b.repo.softDelete('categories', 'cat-tie')
      await stampRow(b, 'categories', 'cat-tie', T)

      const byName = { a, b }
      await runAll(order.map((name) => byName[name]))

      for (const device of [a, b]) {
        const row = await device.db.categories.get('cat-tie')
        expect(row).toBeDefined()
        expect(row!.deleted_at).not.toBeNull()
      }
    }

    await runOrder(['a', 'b', 'a'])
    await runOrder(['b', 'a', 'b'])
  })

  it('Test 11: an exact-timestamp live/live tie converges to the greater device id', async () => {
    const T = iso(50)

    const runOrder = async (order: readonly ['a' | 'b', 'a' | 'b', 'a' | 'b']) => {
      clockTick = 0
      vi.setSystemTime(new Date(BASE))
      const server = new FakeSyncServer()
      // device-z > device-a lexicographically, so B's body must win.
      const a = makeDevice(server, USER_A, 'device-a')
      const b = makeDevice(server, USER_A, 'device-z')

      tick()
      await write(a.repo, 'categories', {
        id: 'cat-live',
        name: 'A 的目标',
        created_at: iso(0),
        sort_order: 0,
      })
      await stampRow(a, 'categories', 'cat-live', T)

      tick()
      await write(b.repo, 'categories', {
        id: 'cat-live',
        name: 'Z 的目标',
        created_at: iso(0),
        sort_order: 0,
      })
      await stampRow(b, 'categories', 'cat-live', T)

      const byName = { a, b }
      await runAll(order.map((name) => byName[name]))

      for (const device of [a, b]) {
        const row = await device.db.categories.get('cat-live')
        expect(row).toBeDefined()
        expect(row!.name).toBe('Z 的目标')
      }
    }

    await runOrder(['a', 'b', 'a'])
    await runOrder(['b', 'a', 'b'])
  })

  it('Test 12: concurrent quantity writes converge to the max, never the sum', async () => {
    // 10 → 15 on both devices: 15, not 20.
    {
      const server = new FakeSyncServer()
      const a = makeDevice(server, USER_A)
      const b = makeDevice(server, USER_A)

      tick()
      await write(a.repo, 'tasks', quantityTask('q-15', 10))
      await a.engine.run('auto')
      await b.engine.run('auto')
      expect((await b.db.tasks.get('q-15'))!.current_value).toBe(10)

      tick()
      await write(a.repo, 'tasks', quantityTask('q-15', 15))
      tick()
      await write(b.repo, 'tasks', quantityTask('q-15', 15))

      await runAll([a, b, a])
      expect((await a.db.tasks.get('q-15'))!.current_value).toBe(15)
      expect((await b.db.tasks.get('q-15'))!.current_value).toBe(15)
    }

    // A sets 18, B sets 17 (B newer): 18, including via the losing-write raise.
    {
      const server = new FakeSyncServer()
      const a = makeDevice(server, USER_A)
      const b = makeDevice(server, USER_A)

      tick()
      await write(a.repo, 'tasks', quantityTask('q-max', 10))
      await a.engine.run('auto')
      await b.engine.run('auto')

      tick()
      await write(a.repo, 'tasks', quantityTask('q-max', 18))
      await stampRow(a, 'tasks', 'q-max', iso(10))
      tick()
      await write(b.repo, 'tasks', quantityTask('q-max', 17))
      await stampRow(b, 'tasks', 'q-max', iso(20))

      // B pushes first (17 wins LWW), then A's older 18 loses but raises.
      await runAll([b, a, b])

      expect((await a.db.tasks.get('q-max'))!.current_value).toBe(18)
      expect((await b.db.tasks.get('q-max'))!.current_value).toBe(18)
      expect(server.rowFor(USER_A, 'tasks', 'q-max')!.data.current_value).toBe(18)
    }
  })

  it('Test 13: a hard-delete purge propagates physically and never resurrects', async () => {
    const server = new FakeSyncServer()
    const a = makeDevice(server, USER_A)
    const b = makeDevice(server, USER_A)

    await seedAll(a)
    await a.engine.run('auto')
    await b.engine.run('auto')

    const purged: Array<[SyncEntity, string]> = [
      ['categories', 'cat-1'],
      ['goals', 'goal-1'],
      ['milestones', 'ms-1'],
      ['tasks', 'task-1'],
    ]
    for (const [entity, id] of purged) {
      await a.repo.hardDelete(entity, id)
    }

    await a.engine.run('auto')
    await b.engine.run('auto')

    for (const [entity, id] of purged) {
      // Physically gone on B — no tombstone, no row.
      expect(await b.db.table(entity).get(id)).toBeUndefined()
      expect((await listAll(b, entity)).some((row) => row.id === id)).toBe(false)
      expect(server.rowFor(USER_A, entity, id)).toBeUndefined()
    }
    expect(server.purgesForUser(USER_A)).toHaveLength(purged.length)

    // A following converged sync transfers zero rows.
    server.resetCounters()
    const follow = await a.engine.run('auto')
    expect(follow.rowsTransferred).toBe(0)
    expect(server.rowsPushed).toBe(0)
    expect(server.rowsPulled).toBe(0)

    // Further cycles never bring the ids back.
    await runAll([a, b])
    for (const [entity, id] of purged) {
      expect(await b.db.table(entity).get(id)).toBeUndefined()
      expect(await a.db.table(entity).get(id)).toBeUndefined()
    }
  })

  it('Test 14: duplicate habit completions merge into one live row plus one tombstone', async () => {
    const server = new FakeSyncServer()
    const a = makeDevice(server, USER_A)
    const b = makeDevice(server, USER_A)

    // Same (habit_id, date), different ids, written offline on each device.
    tick()
    await write(b.repo, 'habitCompletions', {
      id: 'hc-b',
      habit_id: 'habit-1',
      date: '2026-11-01',
      note: 'B 的备注',
      completed_at: iso(0),
    })
    tick()
    await write(a.repo, 'habitCompletions', {
      id: 'hc-a',
      habit_id: 'habit-1',
      date: '2026-11-01',
      note: 'A 的备注',
      completed_at: iso(0),
    })

    await runAll([a, b, a, b])

    for (const device of [a, b]) {
      const live = await liveRows(device, 'habitCompletions')
      expect(live).toHaveLength(1)
      expect(live[0].id).toBe('hc-a')
      expect(live[0].note).toBe('A 的备注')
      const all = await listAll(device, 'habitCompletions')
      expect(all).toHaveLength(2)
      const tombstoned = all.find((row) => row.id === 'hc-b')
      expect(tombstoned?.deleted_at).not.toBeNull()
    }
  })

  it('Test 15: duplicate linked daily todos merge into one live row plus one tombstone', async () => {
    const server = new FakeSyncServer()
    const a = makeDevice(server, USER_A)
    const b = makeDevice(server, USER_A)

    tick()
    await write(b.repo, 'dailyTodos', linkedTodo('todo-b'))
    tick()
    await write(a.repo, 'dailyTodos', linkedTodo('todo-a'))

    await runAll([a, b, a, b])

    for (const device of [a, b]) {
      const live = await liveRows(device, 'dailyTodos')
      expect(live).toHaveLength(1)
      expect(live[0].id).toBe('todo-a')
      expect(live[0].task_id).toBe('task-1')
      const all = await listAll(device, 'dailyTodos')
      expect(all).toHaveLength(2)
      expect(all.find((row) => row.id === 'todo-b')?.deleted_at).not.toBeNull()
    }
  })

  it('Test 16: identical inputs are order-independent (live rows converge byte-for-byte)', async () => {
    const scenario = async (
      order: 'a-first' | 'b-first',
    ): Promise<{ a: Record<string, unknown>[]; b: Record<string, unknown>[] }> => {
      clockTick = 0
      vi.setSystemTime(new Date(BASE))

      const server = new FakeSyncServer()
      const a = makeDevice(server, USER_A, 'device-a')
      const b = makeDevice(server, USER_A, 'device-b')

      // Same-id journal conflict: B's body is newer, A's ends up as a copy.
      tick()
      await write(a.repo, 'journalEntries', {
        id: 'j-1',
        day_key: '2026-11-01',
        content: 'A 的正文',
      })
      await stampRow(a, 'journalEntries', 'j-1', iso(10))
      tick()
      await write(b.repo, 'journalEntries', {
        id: 'j-1',
        day_key: '2026-11-01',
        content: 'B 的正文',
      })
      await stampRow(b, 'journalEntries', 'j-1', iso(20))

      // Same-id category conflict: B's edit is newer.
      tick()
      await write(a.repo, 'categories', {
        id: 'cat-1',
        name: 'A 分类',
        created_at: iso(0),
        sort_order: 0,
      })
      await stampRow(a, 'categories', 'cat-1', iso(30))
      tick()
      await write(b.repo, 'categories', {
        id: 'cat-1',
        name: 'B 分类',
        created_at: iso(0),
        sort_order: 0,
      })
      await stampRow(b, 'categories', 'cat-1', iso(40))

      const byName = { a, b }
      await runAll(
        (order === 'a-first' ? (['a', 'b', 'a'] as const) : (['b', 'a', 'b'] as const)).map(
          (name) => byName[name],
        ),
      )

      return { a: await liveSnapshot(a), b: await liveSnapshot(b) }
    }

    const first = await scenario('a-first')
    const second = await scenario('b-first')

    // Both devices agree, and both arrival orders land on the same live rows.
    expect(first.b).toEqual(first.a)
    expect(second.b).toEqual(second.a)
    expect(second.a).toEqual(first.a)
    expect(second.b).toEqual(first.b)
  })
})
