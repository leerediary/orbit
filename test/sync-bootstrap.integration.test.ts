import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import type { Entity } from '@/lib/repository'
import { SYNC_ENTITIES, type SyncEntity } from '@/lib/sync-entities'
import {
  createSyncEngine,
  type SyncEngineHandle,
  type SyncRunResult,
} from '@/lib/sync-engine'
import { countOutbox, readOutbox } from '@/lib/outbox'
import {
  getBootstrapAccountId,
  getBootstrapComplete,
  getSyncCursor,
  getSyncValue,
  needsBootstrap,
  setBootstrapAccountId,
  setBootstrapComplete,
  setSyncCursor,
  setSyncValue,
  SYNC_KEYS,
} from '@/lib/sync-store'
import {
  commitBootstrapComplete,
  downloadCloudBaseline,
  enqueuePurges,
  resetOutboxToLocalState,
  serverOnlyIdsByEntity,
} from '@/lib/bootstrap-local'
import { countCoalescedDeleteIntents } from '@/lib/sync-bulk-delete'
import {
  detectBranch,
  type BootstrapCounts,
  type BootstrapRead,
} from '@/lib/sync-bootstrap'
import type { PullChange, PushChange, PushResult } from '@/lib/sync-protocol'
import { wins, type LwwMeta } from '@/lib/sync/conflict'

/**
 * Phase 20 / plan 20-06 — end-to-end proof that the bootstrap primitives from
 * plans 20-04/20-05 compose correctly against the REAL sync engine and a
 * two-device in-memory server. A unit test on each helper does not prove the
 * ORDER (reset outbox → push → pull-from-zero → commit) or the destructive
 * branch scoping; this file nails the branch semantics of BOOT-01/BOOT-02
 * before any bootstrap UI exists.
 *
 * The server mirrors the Phase 19 wire surface used here: LWW via the REAL
 * `wins` comparator, `op`/`device_id` on every pull change, durable purge
 * markers, and the Phase 20 manifest (zero-filled live counts + `latest_seq`,
 * with `ids=1` for the use-local purge set).
 */

const BASE = Date.parse('2026-11-01T00:00:00.000Z')
const USER_A = 'user-a'

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

/** A fixed ISO stamp offset from BASE (controlled `updated_at` values). */
function iso(seconds: number): string {
  return new Date(BASE + seconds * 1000).toISOString()
}

function newName(): string {
  const name = `orbit-sync-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`
  createdNames.push(name)
  return name
}

function nextDeviceId(): string {
  deviceSeq += 1
  return `device-bootstrap-${deviceSeq}`
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

interface ManifestBody {
  version: 1
  counts: Record<string, number>
  latest_seq: number
  ids?: Record<string, string[]>
}

class FakeSyncServer {
  private readonly rows = new Map<string, ServerRow>()
  private readonly purges = new Map<string, PurgeMarker>()
  private seq = 0

  pushRequests = 0
  pullRequests = 0
  manifestRequests = 0
  rowsPushed = 0
  rowsPulled = 0
  requestLog: Array<'push' | 'pull' | 'manifest'> = []
  pullSince: number[] = []

  private key(user: string, entity: string, id: string): string {
    return `${user}:${entity}:${id}`
  }

  resetCounters(): void {
    this.pushRequests = 0
    this.pullRequests = 0
    this.manifestRequests = 0
    this.rowsPushed = 0
    this.rowsPulled = 0
    this.requestLog = []
    this.pullSince = []
  }

  /** Highest server_seq ever assigned (the cursor a converged device holds). */
  highestSeq(): number {
    return this.seq
  }

  rowsForUser(user: string): ServerRow[] {
    return [...this.rows.values()].filter((row) => row.user === user)
  }

  /** Ids of LIVE rows for one entity (tombstones never count). */
  liveIdsForUser(user: string, entity: SyncEntity): string[] {
    return this.rowsForUser(user)
      .filter((row) => row.entity === entity && row.deleted_at === null)
      .map((row) => row.id)
  }

  rowFor(user: string, entity: SyncEntity, id: string): ServerRow | undefined {
    return this.rows.get(this.key(user, entity, id))
  }

  purgesForUser(user: string): PurgeMarker[] {
    return [...this.purges.values()].filter((marker) => marker.user === user)
  }

  private nextSeq(): number {
    this.seq += 1
    return this.seq
  }

  private metaOf(row: {
    updated_at: string
    deleted_at: string | null
    device_id: string | null
  }): LwwMeta {
    return { updated_at: row.updated_at, deleted_at: row.deleted_at, device_id: row.device_id }
  }

  /** Project a stored row onto the pull wire envelope (op + device_id). */
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

  private applyChange(user: string, deviceId: string | null, change: PushChange): PushResult {
    const entity = change.entity
    const id = change.id
    const key = this.key(user, entity, id)

    // MERGE-04: physical delete + durable anti-resurrection marker.
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

    // A purge marker consumes later writes without storing.
    if (this.purges.has(key)) {
      return { entity, id, status: 'applied', server_seq: this.nextSeq() }
    }

    const existing = this.rows.get(key)
    const incomingMeta: LwwMeta = {
      updated_at: change.updated_at,
      deleted_at: change.deleted_at ?? null,
      device_id: deviceId,
    }
    const incomingWins = !existing || wins(incomingMeta, this.metaOf(existing))

    if (incomingWins) {
      const seq = this.nextSeq()
      this.rows.set(key, {
        user,
        entity,
        id,
        data: { ...(change.data ?? {}) },
        updated_at: change.updated_at,
        deleted_at: change.deleted_at ?? null,
        device_id: deviceId,
        server_seq: seq,
      })
      return { entity, id, status: 'applied', server_seq: seq }
    }

    return { entity, id, status: 'lost', current: this.wireChange(existing) }
  }

  push(user: string, body: PushBody): { version: 1; results: PushResult[] } {
    const changes = Array.isArray(body.changes) ? body.changes : []
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

    return {
      version: 1,
      changes,
      next_cursor: changes.length > 0 ? changes[changes.length - 1].server_seq : since,
      has_more: changes.length === limit,
    }
  }

  /** Mirror GET /v1/sync/manifest — zero-filled live counts + latest_seq. */
  manifest(user: string, includeIds: boolean): ManifestBody {
    const counts: Record<string, number> = {}
    const ids: Record<string, string[]> = {}
    for (const entity of SYNC_ENTITIES) {
      counts[entity] = 0
      ids[entity] = []
    }

    const rows = this.rowsForUser(user)
      .filter((row) => row.deleted_at === null)
      .sort((a, b) => (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : a.id < b.id ? -1 : 1))
    for (const row of rows) {
      counts[row.entity] += 1
      ids[row.entity].push(row.id)
    }

    const body: ManifestBody = { version: 1, counts, latest_seq: this.seq }
    if (includeIds) body.ids = ids
    return body
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function routeFetch(
  server: FakeSyncServer,
  user: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (path.startsWith('/v1/sync/push')) {
    server.pushRequests += 1
    server.requestLog.push('push')
    const body = init?.body ? (JSON.parse(String(init.body)) as PushBody) : { changes: [] }
    const response = server.push(user, body)
    server.rowsPushed += body.changes?.length ?? 0
    return jsonResponse(200, response)
  }

  if (path.startsWith('/v1/sync/pull')) {
    server.pullRequests += 1
    server.requestLog.push('pull')
    const query = new URLSearchParams(path.slice(path.indexOf('?') + 1))
    const since = Number(query.get('since') ?? '0')
    const limit = Number(query.get('limit') ?? '500')
    server.pullSince.push(since)
    const response = server.pull(user, since, limit)
    server.rowsPulled += response.changes.length
    return jsonResponse(200, response)
  }

  if (path.startsWith('/v1/sync/manifest')) {
    server.manifestRequests += 1
    server.requestLog.push('manifest')
    const query = new URLSearchParams(path.slice(path.indexOf('?') + 1))
    const ids = query.get('ids')
    if (ids !== undefined && ids !== '0' && ids !== '1') {
      return jsonResponse(400, { version: 1, error: 'invalid_ids' })
    }
    return jsonResponse(200, server.manifest(user, ids === '1'))
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
  fetchFn: (path: string, init?: RequestInit) => Promise<Response>
}

/**
 * Build one device with the production bootstrap gate ON. Because
 * `requireBootstrap: true`, every `run` in these tests must pass
 * `{ bootstrap: true }` (or have completed bootstrap) — which also proves the
 * gate cannot be bypassed accidentally.
 */
function makeDevice(server: FakeSyncServer, user: string, deviceId?: string): Device {
  const resolvedDeviceId = deviceId ?? nextDeviceId()
  const database = new OrbitDB(newName())
  opened.push(database)
  const repo = new LocalRepository(database, () => resolvedDeviceId)
  const fetchFn = (path: string, init?: RequestInit) =>
    routeFetch(server, user, path, init)

  const engine = createSyncEngine({
    db: database,
    repo,
    fetch: fetchFn,
    session: () => ({ accessToken: 'test-token' }),
    deviceId: () => resolvedDeviceId,
    locks: null,
    channel: null,
    online: () => true,
    now: () => Date.now(),
    random: () => 0.5,
    setTimer: () => Symbol('sync-timer'),
    clearTimer: () => {},
    win: null,
    doc: null,
    requireBootstrap: true,
  })

  return { db: database, repo, engine, fetchFn }
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

function goalRow(
  id: string,
  name: string,
  updatedAt: string = iso(1),
): Record<string, unknown> {
  return {
    id,
    category_id: 'cat-bootstrap',
    name,
    created_at: iso(0),
    sort_order: 0,
    updated_at: updatedAt,
    deleted_at: null,
  }
}

/** Seed one live goal directly on the server (no device involved). */
function seedServerGoal(
  server: FakeSyncServer,
  id: string,
  name: string,
  updatedAt: string = iso(1),
): void {
  const row = goalRow(id, name, updatedAt)
  server.push(USER_A, {
    changes: [
      {
        entity: 'goals',
        id,
        op: 'upsert',
        updated_at: updatedAt,
        deleted_at: null,
        data: row,
      },
    ],
  })
}

async function listAll(
  device: Device,
  entity: SyncEntity,
): Promise<Record<string, unknown>[]> {
  return (await device.repo.list(entity, { includeDeleted: true })) as Record<
    string,
    unknown
  >[]
}

async function liveIds(device: Device, entity: SyncEntity): Promise<string[]> {
  const rows = (await device.repo.list(entity)) as Record<string, unknown>[]
  return rows.map((row) => String(row.id))
}

/** True when any physical row (live OR tombstone) exists in any entity table. */
async function hasAnyPhysicalRows(device: Device): Promise<boolean> {
  for (const entity of SYNC_ENTITIES) {
    if ((await device.db.table(entity).count()) > 0) return true
  }
  return false
}

/** Branch A / C keep-both execution (plan 20-06 Task 1 helper). */
async function runKeepBoth(device: Device): Promise<SyncRunResult> {
  await setSyncCursor(device.db, 0)
  await setSyncValue(device.db, SYNC_KEYS.status, 'idle')
  await resetOutboxToLocalState(device.db)
  const result = await device.engine.run('manual', { bootstrap: true })
  if (result.ok) await commitBootstrapComplete(device.db, USER_A)
  return result
}

/**
 * Branch B execution (plan 20-06 Task 1 helper): push local tombstones first
 * (so a same-id live server row cannot resurrect), then download and adopt the
 * whole cloud baseline.
 */
async function runBranchB(
  device: Device,
  limit?: number,
): Promise<{ cursor: number; rows: number }> {
  if ((await countOutbox(device.db)) > 0 || (await hasAnyPhysicalRows(device))) {
    await resetOutboxToLocalState(device.db)
    await device.engine.run('manual', { bootstrap: true, pushOnly: true })
  }
  return downloadCloudBaseline({
    repo: device.repo,
    fetchFn: device.fetchFn,
    accountId: USER_A,
    epoch: 1,
    ...(limit === undefined ? {} : { limit }),
  })
}

// ---------------------------------------------------------------------------
// Task 2 helpers — destructive branches and the never-empty failure rule
// ---------------------------------------------------------------------------

async function localLiveIdsByEntity(device: Device): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  for (const entity of SYNC_ENTITIES) out[entity] = await liveIds(device, entity)
  return out
}

/** Manifest `ids=1` read — the authoritative use-local purge set (BOOT-02). */
async function fetchManifestIds(device: Device): Promise<Record<string, string[]>> {
  const res = await device.fetchFn('/v1/sync/manifest?ids=1')
  if (!res.ok) throw new Error(`manifest failed: HTTP ${res.status}`)
  const body = (await res.json()) as { ids?: Record<string, string[]> }
  if (!body.ids) throw new Error('manifest missing ids')
  return body.ids
}

function zeroCounts(): BootstrapCounts {
  const counts = {} as BootstrapCounts
  for (const entity of SYNC_ENTITIES) counts[entity] = 0
  return counts
}

async function localLiveCounts(device: Device): Promise<BootstrapCounts> {
  const counts = zeroCounts()
  for (const entity of SYNC_ENTITIES) {
    counts[entity] = (await device.repo.list(entity)).length
  }
  return counts
}

/** Physical row count per table — tombstones included. */
async function physicalTableCounts(device: Device): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const entity of SYNC_ENTITIES) out[entity] = await device.db.table(entity).count()
  return out
}

function manifestCountsFrom(body: unknown): BootstrapCounts | null {
  if (body === null || typeof body !== 'object') return null
  const counts = (body as { counts?: unknown }).counts
  if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) return null
  const out = zeroCounts()
  for (const entity of SYNC_ENTITIES) {
    const value = (counts as Record<string, unknown>)[entity]
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    out[entity] = value
  }
  return out
}

function pullCountsFrom(body: unknown): BootstrapCounts | null {
  if (body === null || typeof body !== 'object') return null
  const changes = (body as { changes?: unknown }).changes
  if (!Array.isArray(changes)) return null
  const out = zeroCounts()
  for (const change of changes) {
    if (change === null || typeof change !== 'object') return null
    const { entity, op } = change as { entity?: unknown; op?: unknown }
    if (op === 'purge') continue
    if (typeof entity !== 'string') return null
    if (!(SYNC_ENTITIES as readonly string[]).includes(entity)) return null
    out[entity as SyncEntity] += 1
  }
  return out
}

interface ReadBootstrapInput {
  fetchFn: (path: string) => Promise<Response>
  local: BootstrapCounts
  /** 'manifest' is the production detector source; 'pull' exercises the download read. */
  source?: 'manifest' | 'pull'
}

/**
 * Test-local stand-in for the future UI read adapter (plan 20-07). It maps a
 * transport outcome onto the pure `BootstrapRead` contract: a 401, a non-OK
 * response, a throw, or a malformed body is a typed ERROR — never zero counts
 * (T-20-02).
 */
async function readBootstrapState(input: ReadBootstrapInput): Promise<BootstrapRead> {
  const source = input.source ?? 'manifest'
  const path =
    source === 'manifest' ? '/v1/sync/manifest?ids=0' : '/v1/sync/pull?since=0&limit=500'

  let res: Response
  try {
    res = await input.fetchFn(path)
  } catch (error) {
    return {
      ok: false,
      where: 'server',
      reason: error instanceof TypeError ? 'network' : 'malformed',
    }
  }

  if (res.status === 401) return { ok: false, where: 'server', reason: 'auth' }
  if (!res.ok) return { ok: false, where: 'server', reason: 'server' }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, where: 'server', reason: 'malformed' }
  }

  const server = source === 'manifest' ? manifestCountsFrom(body) : pullCountsFrom(body)
  if (server === null) return { ok: false, where: 'server', reason: 'malformed' }
  return { ok: true, local: input.local, server }
}

// ---------------------------------------------------------------------------
// Tests — branch A / B / C keep-both
// ---------------------------------------------------------------------------

describe('bootstrap end to end: branch A uploads from cursor 0', () => {
  it('uploads every local live goal, pulls from cursor 0, and only commits after the cycle', async () => {
    const server = new FakeSyncServer()
    const a = makeDevice(server, USER_A)

    tick()
    await write(a.repo, 'goals', {
      id: 'goal-a1',
      category_id: 'cat-bootstrap',
      name: '本地目标一',
      created_at: iso(0),
      sort_order: 0,
    })
    tick()
    await write(a.repo, 'goals', {
      id: 'goal-a2',
      category_id: 'cat-bootstrap',
      name: '本地目标二',
      created_at: iso(0),
      sort_order: 0,
    })

    expect(await getBootstrapComplete(a.db)).toBe(false)

    await setSyncCursor(a.db, 0)
    await setSyncValue(a.db, SYNC_KEYS.status, 'idle')
    await resetOutboxToLocalState(a.db)

    const result = await a.engine.run('manual', { bootstrap: true })
    // The engine itself NEVER commits completion — the orchestrator does, and
    // only after the cycle returned ok.
    expect(result.ok).toBe(true)
    expect(await getBootstrapComplete(a.db)).toBe(false)

    await commitBootstrapComplete(a.db, USER_A)

    expect(server.liveIdsForUser(USER_A, 'goals').sort()).toEqual(['goal-a1', 'goal-a2'])
    expect(server.pullSince).toContain(0)
    expect(await getSyncCursor(a.db)).toBe(server.highestSeq())
    expect(await getBootstrapComplete(a.db)).toBe(true)
    expect(await getBootstrapAccountId(a.db)).toBe(USER_A)
    expect(await getSyncValue(a.db, SYNC_KEYS.status, '')).toBe('idle')
    expect(await countOutbox(a.db)).toBe(0)
  })
})

describe('bootstrap end to end: branch B downloads the baseline', () => {
  it('lands every server page locally, adopts the final cursor, and leaves no outbox', async () => {
    const server = new FakeSyncServer()
    seedServerGoal(server, 'goal-s1', '云端目标一')
    seedServerGoal(server, 'goal-s2', '云端目标二')

    const b = makeDevice(server, USER_A)
    // limit 1 forces TWO pull pages: the baseline must accumulate both.
    const result = await runBranchB(b, 1)

    expect(result.rows).toBe(2)
    expect((await liveIds(b, 'goals')).sort()).toEqual(['goal-s1', 'goal-s2'])
    expect(await getSyncCursor(b.db)).toBe(server.highestSeq())
    expect(result.cursor).toBe(server.highestSeq())
    expect(await getBootstrapComplete(b.db)).toBe(true)
    expect(await getBootstrapAccountId(b.db)).toBe(USER_A)
    expect(await getSyncValue(b.db, SYNC_KEYS.status, '')).toBe('idle')
    expect(await countOutbox(b.db)).toBe(0)
    expect(server.pullSince[0]).toBe(0)
  })

  it('pushes a local tombstone before the download so the server row cannot resurrect', async () => {
    const server = new FakeSyncServer()
    seedServerGoal(server, 'goal-tomb', '云端仍有', iso(1))

    const b = makeDevice(server, USER_A)
    tick()
    await write(b.repo, 'goals', {
      id: 'goal-tomb',
      category_id: 'cat-bootstrap',
      name: '本地已删',
      created_at: iso(0),
      sort_order: 0,
    })
    tick()
    await b.repo.softDelete('goals', 'goal-tomb')

    expect(server.liveIdsForUser(USER_A, 'goals')).toEqual(['goal-tomb'])

    const result = await runBranchB(b)
    expect(result.rows).toBeGreaterThanOrEqual(1)

    // The pre-push tombstone won: no LIVE server row and no LIVE local row.
    expect(server.liveIdsForUser(USER_A, 'goals')).toEqual([])
    expect(await liveIds(b, 'goals')).toEqual([])
    expect(server.rowFor(USER_A, 'goals', 'goal-tomb')!.deleted_at).not.toBeNull()

    const all = await listAll(b, 'goals')
    const tombstone = all.find((row) => row.id === 'goal-tomb')
    expect(tombstone).toBeDefined()
    expect(tombstone!.deleted_at).not.toBeNull()
  })
})

describe('bootstrap end to end: branch C keep-both', () => {
  it('leaves the union of both devices’ rows on both devices and the server', async () => {
    const server = new FakeSyncServer()
    const d1 = makeDevice(server, USER_A, 'device-c1')
    const d2 = makeDevice(server, USER_A, 'device-c2')

    // Device 2 has a cloud-only goal and has already converged by itself.
    tick()
    await write(d2.repo, 'goals', {
      id: 'server-only',
      category_id: 'cat-bootstrap',
      name: '仅云端',
      created_at: iso(0),
      sort_order: 0,
    })
    const d2Result = await d2.engine.run('manual', { bootstrap: true })
    expect(d2Result.ok).toBe(true)
    await commitBootstrapComplete(d2.db, USER_A)

    // Device 1 has its own local-only goal and runs branch C keep-both.
    tick()
    await write(d1.repo, 'goals', {
      id: 'local-only',
      category_id: 'cat-bootstrap',
      name: '仅本地',
      created_at: iso(0),
      sort_order: 0,
    })
    const result = await runKeepBoth(d1)
    expect(result.ok).toBe(true)

    // Device 2 pulls the newly uploaded local row.
    const d2Follow = await d2.engine.run('auto')
    expect(d2Follow.ok).toBe(true)

    for (const device of [d1, d2]) {
      expect((await liveIds(device, 'goals')).sort()).toEqual([
        'local-only',
        'server-only',
      ])
      const rows = (await device.repo.list('goals')) as Record<string, unknown>[]
      const byId = new Map(rows.map((row) => [String(row.id), row]))
      // No silent overwrite: each id keeps its own name.
      expect(byId.get('local-only')!.name).toBe('仅本地')
      expect(byId.get('server-only')!.name).toBe('仅云端')
    }

    expect(server.liveIdsForUser(USER_A, 'goals').sort()).toEqual([
      'local-only',
      'server-only',
    ])
  })
})

// ---------------------------------------------------------------------------
// Tests — destructive C choices, account change, and failure-never-empty
// ---------------------------------------------------------------------------

describe('bootstrap end to end: C use-local purges only cloud-only ids', () => {
  it('derives the purge set from the manifest and leaves the local rows intact', async () => {
    const server = new FakeSyncServer()
    seedServerGoal(server, 's1', '云端目标一')
    seedServerGoal(server, 's2', '云端目标二')

    const device = makeDevice(server, USER_A)
    tick()
    await write(device.repo, 'goals', {
      id: 'l1',
      category_id: 'cat-bootstrap',
      name: '本地目标',
      created_at: iso(0),
      sort_order: 0,
    })

    const serverIds = await fetchManifestIds(device)
    const localIds = await localLiveIdsByEntity(device)
    const serverOnly = serverOnlyIdsByEntity(serverIds, localIds)

    // Exactly the cloud-only ids — nothing the local device also holds.
    expect(serverOnly).toEqual({ goals: ['s1', 's2'] })

    await setSyncCursor(device.db, 0)
    await setSyncValue(device.db, SYNC_KEYS.status, 'idle')
    await resetOutboxToLocalState(device.db)
    expect(await enqueuePurges(device.db, serverOnly)).toBe(2)

    const declared = countCoalescedDeleteIntents(await readOutbox(device.db))
    expect(declared).toBe(2)

    const result = await device.engine.run('manual', {
      bootstrap: true,
      allowBulkDelete: true,
      declaredDeleteTotal: declared,
    })
    expect(result.ok).toBe(true)
    await commitBootstrapComplete(device.db, USER_A)

    expect(server.liveIdsForUser(USER_A, 'goals')).toEqual(['l1'])
    // The purged ids are physically gone, not tombstoned.
    expect(server.rowFor(USER_A, 'goals', 's1')).toBeUndefined()
    expect(server.rowFor(USER_A, 'goals', 's2')).toBeUndefined()
    expect(server.purgesForUser(USER_A).map((marker) => marker.id).sort()).toEqual([
      's1',
      's2',
    ])
    expect((await liveIds(device, 'goals')).sort()).toEqual(['l1'])
  })
})

describe('bootstrap end to end: C use-cloud adopts without echoing', () => {
  it('replaces local rows with the server snapshot and pushes nothing afterwards', async () => {
    const server = new FakeSyncServer()
    seedServerGoal(server, 's1', '云端目标')

    const device = makeDevice(server, USER_A)
    tick()
    await write(device.repo, 'goals', {
      id: 'l1',
      category_id: 'cat-bootstrap',
      name: '本地目标',
      created_at: iso(0),
      sort_order: 0,
    })
    expect(await countOutbox(device.db)).toBe(1)

    const baseline = await downloadCloudBaseline({
      repo: device.repo,
      fetchFn: device.fetchFn,
      accountId: USER_A,
      epoch: 1,
    })

    expect(baseline.rows).toBe(1)
    expect(await liveIds(device, 'goals')).toEqual(['s1'])
    expect(await countOutbox(device.db)).toBe(0)
    expect(await getSyncValue(device.db, SYNC_KEYS.status, '')).toBe('idle')
    expect(await getBootstrapComplete(device.db)).toBe(true)
    expect(await getSyncCursor(device.db)).toBe(server.highestSeq())

    // A normal post-bootstrap cycle must NOT re-upload the snapshot (no echo).
    const highest = server.highestSeq()
    server.resetCounters()
    const follow = await device.engine.run('auto')
    expect(follow.ok).toBe(true)
    expect(server.highestSeq()).toBe(highest)
    expect(server.rowsPushed).toBe(0)
    expect(server.rowsForUser(USER_A)).toHaveLength(1)
  })
})

describe('bootstrap end to end: account change forces re-bootstrap', () => {
  it('treats a mismatched bootstrapAccountId as un-bootstrapped even when complete', async () => {
    const server = new FakeSyncServer()
    const device = makeDevice(server, USER_A)

    await setBootstrapComplete(device.db, true)
    await setBootstrapAccountId(device.db, 'user-old')

    const complete = await getBootstrapComplete(device.db)
    const accountId = await getBootstrapAccountId(device.db)
    expect(complete).toBe(true)
    expect(accountId).toBe('user-old')

    // Same-account logout does NOT re-bootstrap...
    expect(needsBootstrap({ complete, accountId, currentSub: 'user-old' })).toBe(false)
    // ...but a different signed-in subject does, despite complete === true.
    expect(needsBootstrap({ complete, accountId, currentSub: 'user-a' })).toBe(true)
    // A never-bootstrapped device and a missing subject also re-bootstrap.
    expect(needsBootstrap({ complete: false, accountId, currentSub: 'user-a' })).toBe(
      true,
    )
    expect(needsBootstrap({ complete, accountId, currentSub: null })).toBe(true)
  })
})

describe('bootstrap end to end: failed reads are never empty', () => {
  it('maps a 401 manifest to ERROR and changes no entity or outbox row', async () => {
    const server = new FakeSyncServer()
    const device = makeDevice(server, USER_A)
    tick()
    await write(device.repo, 'goals', {
      id: 'l1',
      category_id: 'cat-bootstrap',
      name: '本地目标',
      created_at: iso(0),
      sort_order: 0,
    })

    const beforeTables = await physicalTableCounts(device)
    const beforeOutbox = await countOutbox(device.db)
    const local = await localLiveCounts(device)

    const failingFetch = async (path: string): Promise<Response> => {
      if (path.startsWith('/v1/sync/manifest')) {
        return jsonResponse(401, { version: 1, error: 'unauthorized' })
      }
      return device.fetchFn(path)
    }

    const read = await readBootstrapState({ fetchFn: failingFetch, local })
    const branch = detectBranch(read)

    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toBe('auth')
    expect(branch.kind).toBe('ERROR')
    // Never a branch decision (especially not D = "both sides empty").
    expect(branch.kind).not.toBe('D')

    expect(await physicalTableCounts(device)).toEqual(beforeTables)
    expect(await countOutbox(device.db)).toBe(beforeOutbox)
  })

  it('maps a throwing pull to ERROR and changes no entity or outbox row', async () => {
    const server = new FakeSyncServer()
    const device = makeDevice(server, USER_A)
    tick()
    await write(device.repo, 'goals', {
      id: 'l1',
      category_id: 'cat-bootstrap',
      name: '本地目标',
      created_at: iso(0),
      sort_order: 0,
    })

    const beforeTables = await physicalTableCounts(device)
    const beforeOutbox = await countOutbox(device.db)
    const local = await localLiveCounts(device)

    const failingFetch = async (path: string): Promise<Response> => {
      if (path.startsWith('/v1/sync/pull')) throw new TypeError('Failed to fetch')
      return device.fetchFn(path)
    }

    const read = await readBootstrapState({
      fetchFn: failingFetch,
      local,
      source: 'pull',
    })
    const branch = detectBranch(read)

    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toBe('network')
    expect(branch.kind).toBe('ERROR')
    expect(branch.kind).not.toBe('D')

    expect(await physicalTableCounts(device)).toEqual(beforeTables)
    expect(await countOutbox(device.db)).toBe(beforeOutbox)
  })
})
