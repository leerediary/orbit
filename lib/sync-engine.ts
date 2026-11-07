import type { OrbitDB } from '@/lib/local-db'
import { db } from '@/lib/local-db'
import type { LocalRepository } from '@/lib/local-repository'
import { getLocalRepository } from '@/lib/repository-provider'
import { authedFetch } from '@/lib/auth-client'
import { SYNC_ENTITIES, type SyncEntity } from '@/lib/sync-entities'
import { deleteOutboxEntries, enqueueOutbox, readOutbox } from '@/lib/outbox'
import {
  countCoalescedDeleteIntents,
  needsBulkDeleteConfirm,
  publishBulkDeleteRequired,
} from '@/lib/sync-bulk-delete'
import {
  SYNC_KEYS,
  getBootstrapComplete,
  getSyncCursor,
  getSyncValue,
  setLastSyncedAt,
  setSyncValue,
} from '@/lib/sync-store'
import { validateImportRow } from '@/lib/entity-schema'
import { emitSyncApplied } from '@/lib/sync-applied'
import { appendQuarantine, type QuarantineEntry } from '@/lib/sync-quarantine'
import { readDeviceId, readSession } from '@/lib/auth-storage'
import { reconcileNaturalKeys } from '@/lib/sync/natural-keys'
import { onLocalWrite } from '@/lib/sync-triggers'
import {
  MAX_PUSH_CHANGES,
  MAX_REJECTIONS,
  MAX_ROW_BYTES,
  MAX_SYNC_BODY_BYTES,
  PULL_LIMIT,
  type PullResponse,
  type PushChange,
  type PushRequestBody,
  type PushResponse,
  type PushResult,
  type SyncErrorKind,
} from '@/lib/sync-protocol'

/**
 * Client sync engine (SYNC-01/SYNC-02/SYNC-04).
 *
 * One cycle ALWAYS pushes the outbox before pulling (ARCHITECTURE ordering
 * rule): an offline journal edit reaches the server before a conflicting remote
 * row can arrive. Pulled rows are applied verbatim through
 * `LocalRepository.applyRemote` in the same transaction that advances the
 * server-owned `server_seq` cursor, and they never enqueue (no echo).
 *
 * Poison rows are isolated instead of retried forever:
 *  - an outbound row that fails `validateImportRow` → `push-invalid`;
 *  - an outbound row over 256 KiB → `push-oversize`;
 *  - an HTTP 400/413/422 chunk → bisected until the single offending row is
 *    isolated (`push-http-4xx`) — never a backoff;
 *  - a row rejected three times → `push-rejected` and out of the queue;
 *  - an inbound row that fails `validateImportRow` → `pull-invalid`, while the
 *    cursor still advances past it.
 *
 * Every browser global is touched inside a function only — importing this
 * module during the static-export prerender must not open IndexedDB.
 */

export interface SyncEventSource {
  addEventListener(type: string, fn: () => void): void
  removeEventListener(type: string, fn: () => void): void
}

export interface SyncVisibilitySource extends SyncEventSource {
  readonly visibilityState?: string
}

export interface SyncDeps {
  db: OrbitDB
  repo: LocalRepository
  fetch: (path: string, init?: RequestInit) => Promise<Response>
  /** Session accessor (W5). Defaults to `readSession`; tests inject a fake. */
  session?: () => { accessToken: string } | null
  /**
   * Stable writer identity (Phase 19 / RESEARCH §5). Defaults to
   * `readDeviceId`; tests inject a fixed id so LWW tie-break assertions are
   * meaningful under Node, where `readDeviceId()` mints a fresh UUID per call
   * (Landmine 12).
   */
  deviceId?: () => string
  locks?: Pick<LockManager, 'request'> | null
  /** The single `orbit-sync` BroadcastChannel (W2), or a fake in tests. */
  channel?: { postMessage(message: unknown): void } | null
  online?: () => boolean
  now?: () => number
  random?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Trigger targets (W6). Default to the ambient window/document in start(). */
  win?: SyncEventSource | null
  doc?: SyncVisibilitySource | null
  /**
   * Production bootstrap gate (BOOT-01/BOOT-04). When true, `run` skips until
   * `bootstrapComplete` is set, unless the caller passes `bootstrap: true`.
   * Defaults to false so existing engines (and tests) keep their behavior.
   */
  requireBootstrap?: boolean
}

export interface SyncRunResult {
  ok: boolean
  skipped?: 'no-session' | 'leader' | 'offline' | 'unsupported-repo' | 'not-bootstrapped'
  error?: SyncErrorKind
  rowsTransferred?: number
}

/** Per-run options threaded to the trailing cycle (RESEARCH Pattern 4). */
export interface SyncRunOptions {
  /** Bypass the runtime `bootstrapComplete` guard (bootstrap UI only). */
  bootstrap?: boolean
  /** Push the outbox but skip the pull half (branch B tombstone pre-push). */
  pushOnly?: boolean
  /** One-shot, user-confirmed permission for a destructive drain. Never persisted. */
  allowBulkDelete?: boolean
  /** Total delete/purge intents for the whole logical drain, judged per chunk. */
  declaredDeleteTotal?: number
}

export interface SyncEngineHandle {
  run(reason: 'auto' | 'manual', opts?: SyncRunOptions): Promise<SyncRunResult>
  requestSync(reason: 'auto' | 'manual', opts?: SyncRunOptions): Promise<SyncRunResult>
  start(): () => void
  stop(): void
}

const keyOf = (entity: string, id: string): string => `${entity}:${id}`

class SyncHttpError extends Error {
  constructor(readonly kind: SyncErrorKind) {
    super(kind)
    this.name = 'SyncHttpError'
  }
}

/** Map any thrown value to a stable UI-facing kind. Never carries a token/body. */
export function classifySyncError(error: unknown): SyncErrorKind {
  if (error instanceof SyncHttpError) return error.kind
  // Browser fetch rejects with TypeError on network/DNS failure.
  if (error instanceof TypeError) return 'offline'
  return 'unknown'
}

/**
 * Normalize a persisted timestamp to the server's fixed-width ISO form
 * (`YYYY-MM-DDTHH:MM:SS.sssZ`). Legacy rows migrated from the old Python
 * system store `datetime.isoformat()` (`...ssssss+00:00`), which `Date.parse`
 * accepts but the server's strict `ISO_TIMESTAMP` rejects. Re-serializing
 * through `Date` collapses both to the canonical 3-millisecond `Z` form.
 */
export function toIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

/** Exponential backoff with jitter, capped at 5 minutes. Integer ms. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(300_000, 2_000 * 2 ** attempt)
  // Jitter is ±20% around the (already capped) base; the final value is capped
  // as well so a 5xx retry can never exceed 5 minutes (T-18-20).
  return Math.min(300_000, Math.round(base * (0.8 + 0.4 * random())))
}

const RETRYABLE: ReadonlySet<SyncErrorKind> = new Set(['offline', 'server', 'unknown'])
const NON_RETRYABLE_HTTP: ReadonlySet<number> = new Set([400, 413, 422])
/** Local-write debounce (D-01). Precise value is Claude's discretion. */
const LOCAL_WRITE_DEBOUNCE_MS = 3_000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

/**
 * Split changes into requests the server accepts: at most 200 changes and at
 * most 2 MiB of serialized body. Order is preserved, so per-chunk
 * acknowledgement stays contiguous.
 */
function chunkChanges(changes: PushChange[], deviceId: string): PushChange[][] {
  const overhead = byteLength(JSON.stringify({ device_id: deviceId, changes: [] }))
  const chunks: PushChange[][] = []
  let current: PushChange[] = []
  let bytes = overhead

  for (const change of changes) {
    const cost = byteLength(JSON.stringify(change)) + 1 // +1 for the separator
    const tooMany = current.length + 1 > MAX_PUSH_CHANGES
    const tooBig = current.length > 0 && bytes + cost > MAX_SYNC_BODY_BYTES
    if (current.length > 0 && (tooMany || tooBig)) {
      chunks.push(current)
      current = []
      bytes = overhead
    }
    current.push(change)
    bytes += cost
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export function createSyncEngine(deps: SyncDeps): SyncEngineHandle {
  const db = deps.db
  const session = deps.session ?? defaultSession
  const deviceIdOf = deps.deviceId ?? readDeviceId
  const nowMs = () => deps.now?.() ?? Date.now()
  const random = () => deps.random?.() ?? Math.random()
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  // Single-flight within this engine: a trigger that arrives mid-run joins the
  // in-flight loop, sets `rerun`, and coalesces its options into the trailing
  // cycle. It resolves with the trailing run's result — never an early ok:true
  // (T-20-55).
  let running: Promise<SyncRunResult> | null = null
  let rerun = false
  let pendingOpts: SyncRunOptions = {}
  let stopped = false

  let backoffHandle: unknown = null
  let backoffAttempt = 0

  /**
   * Per-engine-process rejection counter. PHASE 18 LIMITATION (I11): a page
   * reload resets the count, so a permanently rejected row may retry once per
   * session. Phase 19 persists this counter (or quarantines by server error
   * code) — Phase 18 accepts the reset.
   */
  const rejections = new Map<string, number>()

  /** Latest per-row isolation reason in this cycle (survives a "successful" run). */
  let rowError: string | null = null

  function quarantine(
    kind: QuarantineEntry['kind'],
    entity: SyncEntity,
    id: string,
    reason: string,
    serverSeq?: number,
  ): Promise<void> {
    return appendQuarantine(db, {
      kind,
      entity,
      id,
      reason,
      at: new Date(nowMs()).toISOString(),
      ...(serverSeq == null ? {} : { serverSeq }),
    })
  }

  /**
   * "Local snapshot wins" rebuild after a whole-store import (W12). `replaceAll`
   * cleared the outbox and set `needs-full-reconcile` atomically; re-enqueue one
   * intent per surviving row before draining. Whether an import should instead
   * ask for confirmation is a Phase 20 decision.
   */
  async function reconcileIfNeeded(): Promise<void> {
    const status = await getSyncValue<string>(db, SYNC_KEYS.status, '')
    if (status !== 'needs-full-reconcile') return

    for (const entity of SYNC_ENTITIES) {
      const rows = await deps.repo.list<Record<string, unknown>>(entity, {
        includeDeleted: true,
      })
      for (const row of rows) {
        const id = row.id
        if (typeof id !== 'string' || id.length === 0) continue
        await enqueueOutbox(db, {
          entity,
          row_id: id,
          op: row.deleted_at == null ? 'upsert' : 'delete',
          updated_at:
            typeof row.updated_at === 'string'
              ? row.updated_at
              : new Date(nowMs()).toISOString(),
        })
      }
    }
    await setSyncValue(db, SYNC_KEYS.status, 'idle')
  }

  async function sendPush(
    chunk: PushChange[],
    deviceId: string,
    options: { allowBulkDelete?: boolean; declaredDeleteTotal?: number } = {},
  ): Promise<Response> {
    const body: PushRequestBody = { device_id: deviceId, changes: chunk }
    // T-20-19: a confirmed drain only. Never sent as `false`, never persisted.
    if (options.allowBulkDelete === true) body.allow_bulk_delete = true
    // T-20-18: the whole-run total rides every chunk, so a split delete cannot
    // slip its first chunk past the server guard.
    if (
      typeof options.declaredDeleteTotal === 'number' &&
      Number.isFinite(options.declaredDeleteTotal)
    ) {
      body.declared_delete_total = options.declaredDeleteTotal
    }
    return deps.fetch('/v1/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /** Apply per-row push outcomes. Only acknowledged keys lose their seqs. */
  async function handleResults(
    results: PushResult[],
    seqsByKey: ReadonlyMap<string, number[]>,
  ): Promise<void> {
    const acked: number[] = []

    for (const result of results) {
      const key = keyOf(result.entity, result.id)

      if (result.status === 'applied') {
        acked.push(...(seqsByKey.get(key) ?? []))
        continue
      }

      if (result.status === 'lost') {
        // The server's winner replaces our local row. Phase 19 / T-19-01: apply
        // it through the SAME merge-aware path as a pull, so a lost echo can
        // never bypass the comparator or throw on a different-id journal day.
        // `advanceCursor: false` keeps pull progress untouched.
        acked.push(...(seqsByKey.get(key) ?? []))
        const current = result.current
        if (!current || current.data == null) continue
        try {
          validateImportRow(current.entity, current.data, 0)
        } catch (error) {
          await quarantine(
            'pull-invalid',
            current.entity,
            current.id,
            messageOf(error),
            current.server_seq,
          )
          continue
        }
        await deps.repo.applyRemote(
          [[current.entity, [{ data: current.data, device_id: current.device_id ?? null }]]],
          0,
          [],
          { advanceCursor: false },
        )
        continue
      }

      // rejected: keep the seqs so the row is retried next cycle.
      const count = (rejections.get(key) ?? 0) + 1
      rejections.set(key, count)
      if (count >= MAX_REJECTIONS) {
        await quarantine('push-rejected', result.entity, result.id, result.error)
        acked.push(...(seqsByKey.get(key) ?? []))
        rowError = result.error
      }
    }

    await deleteOutboxEntries(db, acked)
  }

  /**
   * Push one chunk. Returns how many changes were accepted by the server.
   * 400/413/422 are non-retryable and bisected; 5xx/network throw a retryable
   * error so the caller can back off.
   */
  async function pushChunk(
    chunk: PushChange[],
    seqsByKey: ReadonlyMap<string, number[]>,
    deviceId: string,
    options: { allowBulkDelete?: boolean; declaredDeleteTotal?: number } = {},
  ): Promise<number> {
    const res = await sendPush(chunk, deviceId, options)

    if (res.status === 401) throw new SyncHttpError('auth')

    // T-20-17 / RESEARCH Pitfall 2: a 409 bulk-delete gate is a confirmation
    // request, not a poison chunk. Special-case it BEFORE the generic non-ok
    // path so it is never bisected, quarantined, auto-retried, or dropped. The
    // outbox stays intact and the UI resolves the pending request (plan 20-09).
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as {
        error?: string
        deletes?: number
        total?: number
      } | null
      if (body?.error === 'bulk_delete_required') {
        publishBulkDeleteRequired({
          deletes: typeof body.deletes === 'number' ? body.deletes : 0,
          total: typeof body.total === 'number' ? body.total : 0,
        })
        throw new SyncHttpError('bulk')
      }
    }

    if (!res.ok) {
      if (NON_RETRYABLE_HTTP.has(res.status)) {
        if (chunk.length > 1) {
          // Bisect so one poison row cannot block the rest.
          const mid = Math.floor(chunk.length / 2)
          const left = await pushChunk(chunk.slice(0, mid), seqsByKey, deviceId, options)
          const right = await pushChunk(chunk.slice(mid), seqsByKey, deviceId, options)
          return left + right
        }
        const change = chunk[0]
        if (!change) return 0
        await quarantine(
          'push-http-4xx',
          change.entity,
          change.id,
          `HTTP ${res.status}`,
        )
        await deleteOutboxEntries(db, seqsByKey.get(keyOf(change.entity, change.id)) ?? [])
        rowError = `http_${res.status}`
        return 0
      }
      throw new SyncHttpError(res.status >= 500 ? 'server' : 'unknown')
    }

    let body: PushResponse
    try {
      body = (await res.json()) as PushResponse
    } catch {
      throw new SyncHttpError('server')
    }
    await handleResults(body.results ?? [], seqsByKey)
    return chunk.length
  }

  /**
   * Drain the outbox. Coalesces by `entity:row_id` (keeping the highest seq but
   * remembering EVERY seq of the key), validates + size-guards each row, then
   * pushes bounded chunks and deletes only the seqs each chunk acknowledged.
   */
  async function pushOutbox(
    options: { allowBulkDelete?: boolean; declaredDeleteTotal?: number } = {},
  ): Promise<number> {
    const snapshot = await readOutbox(db)

    const seqsByKey = new Map<string, number[]>()
    const coalesced = new Map<string, { entry: (typeof snapshot)[number]; seqs: number[] }>()
    for (const entry of snapshot) {
      const seq = entry.seq
      if (seq == null) continue
      const key = keyOf(entry.entity, entry.row_id)
      const existing = coalesced.get(key)
      if (existing) {
        existing.entry = entry
        existing.seqs.push(seq)
      } else {
        coalesced.set(key, { entry, seqs: [seq] })
      }
      seqsByKey.set(key, coalesced.get(key)!.seqs)
    }

    const changes: PushChange[] = []
    const droppedSeqs: number[] = []
    let index = 0

    for (const [key, { entry }] of coalesced) {
      const seqs = seqsByKey.get(key) ?? []

      // MERGE-04 / T-19-03 / Landmine 11: a purge intent ALWAYS has no local
      // row (the row was physically removed when the intent was queued), so it
      // must be handled BEFORE the row lookup — never validated, size-checked,
      // or dropped for a missing row.
      if (entry.op === 'purge') {
        changes.push({
          entity: entry.entity,
          id: entry.row_id,
          op: 'purge',
          updated_at: entry.updated_at,
          deleted_at: null,
          data: null,
        })
        index += 1
        continue
      }

      const row = (await db.table(entry.entity).get(entry.row_id)) as
        | Record<string, unknown>
        | undefined
      if (!row) {
        // The row is gone locally (deleted after queueing) — nothing to send.
        droppedSeqs.push(...seqs)
        continue
      }

      // Outbound validation (I11): a permanently malformed row must never
      // re-enter the retry loop every session.
      try {
        validateImportRow(entry.entity, row, index)
      } catch (error) {
        await quarantine('push-invalid', entry.entity, entry.row_id, messageOf(error))
        droppedSeqs.push(...seqs)
        continue
      }

      if (byteLength(JSON.stringify(row)) > MAX_ROW_BYTES) {
        await quarantine(
          'push-oversize',
          entry.entity,
          entry.row_id,
          `row exceeds ${MAX_ROW_BYTES} bytes`,
        )
        droppedSeqs.push(...seqs)
        continue
      }

      const deletedAt = toIsoTimestamp(row.deleted_at)
      changes.push({
        entity: entry.entity,
        id: entry.row_id,
        op: deletedAt == null ? 'upsert' : 'delete',
        updated_at: toIsoTimestamp(row.updated_at) ?? entry.updated_at,
        deleted_at: deletedAt,
        data: row,
      })
      index += 1
    }

    await deleteOutboxEntries(db, droppedSeqs)

    const deviceId = deviceIdOf()
    // An empty outbox still gets one push so the server can observe the device;
    // a queue where every row was isolated locally sends nothing.
    const chunks =
      changes.length > 0
        ? chunkChanges(changes, deviceId)
        : snapshot.length === 0
          ? [[] as PushChange[]]
          : []

    let pushed = 0
    for (const chunk of chunks) {
      pushed += await pushChunk(chunk, seqsByKey, deviceId, options)
    }
    return pushed
  }

  /**
   * Pull every page after the persisted cursor. Each row is shape-validated;
   * invalid rows are quarantined with their `server_seq` and skipped while the
   * cursor still advances (B6) — one bad server row can never stall sync.
   */
  async function pullSinceCursor(): Promise<number> {
    let cursor = await getSyncCursor(db)
    let pulled = 0

    for (;;) {
      const res = await deps.fetch(`/v1/sync/pull?since=${cursor}&limit=${PULL_LIMIT}`)
      if (res.status === 401) throw new SyncHttpError('auth')
      if (!res.ok) throw new SyncHttpError(res.status >= 500 ? 'server' : 'unknown')

      let body: PullResponse
      try {
        body = (await res.json()) as PullResponse
      } catch {
        throw new SyncHttpError('server')
      }

      const grouped = new Map<
        SyncEntity,
        Array<{ data: Record<string, unknown>; device_id: string | null }>
      >()
      // Highest server_seq of every row that validated and will be applied in
      // this page. `applyRemote` puts every row BEFORE every purge, so an older
      // purge for the same id would otherwise delete the newer record.
      const validatedSeq = new Map<string, number>()
      const purges: Array<{ entity: SyncEntity; id: string; serverSeq: number }> = []
      for (let i = 0; i < body.changes.length; i += 1) {
        const change = body.changes[i]

        // MERGE-04 / RESEARCH §2: a purge has no data to validate — collect the
        // identity and let `applyRemote` physically delete it.
        if (change.op === 'purge') {
          purges.push({
            entity: change.entity,
            id: change.id,
            serverSeq: change.server_seq,
          })
          continue
        }

        if (change.data == null) continue
        try {
          validateImportRow(change.entity, change.data, i)
        } catch (error) {
          await quarantine(
            'pull-invalid',
            change.entity,
            change.id,
            messageOf(error),
            change.server_seq,
          )
          continue
        }
        const key = keyOf(change.entity, change.id)
        const previousSeq = validatedSeq.get(key)
        if (previousSeq === undefined || change.server_seq > previousSeq) {
          validatedSeq.set(key, change.server_seq)
        }
        const rows = grouped.get(change.entity) ?? []
        // Carry the writer device id so `applyRemote` can break LWW ties
        // (RESEARCH §4a) — a raw row would lose it.
        rows.push({ data: change.data, device_id: change.device_id ?? null })
        grouped.set(change.entity, rows)
      }

      // Defence in depth for D-06: the server guarantees a purge and a record
      // cannot coexist for one id after restore, but if a mixed page ever
      // appears, last-change-wins by server_seq. A purge is dropped only when a
      // validated row for the same id has a strictly higher seq; a quarantined
      // row never suppresses it.
      const applicablePurges = purges.filter((purge) => {
        const rowSeq = validatedSeq.get(keyOf(purge.entity, purge.id))
        return rowSeq === undefined || rowSeq < purge.serverSeq
      })

      // One transaction: rows + purges + cursor. An empty page is legal (advance only).
      await deps.repo.applyRemote(
        [...grouped.entries()],
        body.next_cursor,
        applicablePurges,
      )

      cursor = body.next_cursor
      pulled += body.changes.length

      const seq = emitSyncApplied()
      deps.channel?.postMessage({ type: 'sync-applied', seq })

      if (!body.has_more) break
    }

    return pulled
  }

  /** Sum of live (non-tombstoned) rows across the nine sync entities. */
  async function countTotalLiveRows(): Promise<number> {
    let total = 0
    for (const entity of SYNC_ENTITIES) {
      total += (await deps.repo.list(entity)).length
    }
    return total
  }

  function scheduleBackoff(): void {
    const delay = backoffDelay(backoffAttempt, random)
    backoffAttempt += 1
    clearBackoff()
    backoffHandle = setTimer(() => {
      backoffHandle = null
      if (!stopped) void run('auto')
    }, delay)
  }

  function clearBackoff(): void {
    if (backoffHandle == null) return
    clearTimer(backoffHandle)
    backoffHandle = null
  }

  async function cycle(
    reason: 'auto' | 'manual',
    opts: SyncRunOptions = {},
  ): Promise<SyncRunResult> {
    rowError = null
    deps.channel?.postMessage({ type: 'sync-start', reason })

    try {
      await reconcileIfNeeded()

      // Compute the whole-run delete total once, before chunking, and send it
      // on every chunk (T-20-18). A `pushOnly` run (branch B tombstone
      // pre-push) still pushes; it only skips the pull half.
      const declaredDeleteTotal =
        opts.declaredDeleteTotal ?? countCoalescedDeleteIntents(await readOutbox(db))

      // T-20-20 / RESEARCH Pitfall 5: warn before a destructive drain. This is
      // advisory UX; the server 409 remains authoritative. A confirmed run
      // (`allowBulkDelete`) skips straight to the push.
      if (opts.allowBulkDelete !== true) {
        const totalLive = await countTotalLiveRows()
        if (needsBulkDeleteConfirm(declaredDeleteTotal, totalLive)) {
          publishBulkDeleteRequired({ deletes: declaredDeleteTotal, total: totalLive })
          throw new SyncHttpError('bulk')
        }
      }

      const guardOptions = {
        allowBulkDelete: opts.allowBulkDelete,
        declaredDeleteTotal,
      }

      const pushed = await pushOutbox(guardOptions)

      let pulled = 0
      let repushed = 0
      if (opts.pushOnly !== true) {
        pulled = await pullSinceCursor()

        // MERGE-02 / D-04 / RESEARCH §3b: after pulling, collapse duplicate soft
        // natural keys (habit completions / linked daily todos). If that queued
        // tombstones, push them exactly once more so a single cycle converges.
        // Bounded — never a loop (T-19-04).
        const tombstones = await reconcileNaturalKeys(db)
        repushed = tombstones > 0 ? await pushOutbox(guardOptions) : 0
      }

      const lastSyncedAt = new Date(nowMs()).toISOString()
      await setLastSyncedAt(db, lastSyncedAt)
      // A clean cycle clears the error; a cycle that isolated bad rows records
      // the latest per-row reason instead (the overall run still succeeded).
      await setSyncValue(db, SYNC_KEYS.lastError, rowError)
      backoffAttempt = 0

      deps.channel?.postMessage({ type: 'sync-complete', lastSyncedAt })
      return { ok: true, rowsTransferred: pushed + pulled + repushed }
    } catch (error) {
      const kind = classifySyncError(error)
      try {
        await setSyncValue(db, SYNC_KEYS.lastError, kind)
      } catch {
        // A storage failure must not mask the original failure.
      }
      deps.channel?.postMessage({ type: 'sync-error', error: kind })
      if (reason === 'auto' && RETRYABLE.has(kind) && !stopped) scheduleBackoff()
      return { ok: false, error: kind }
    }
  }

  async function run(
    reason: 'auto' | 'manual',
    opts: SyncRunOptions = {},
  ): Promise<SyncRunResult> {
    // W7: the native SqliteLocalRepository has no applyRemote/outbox. Report it
    // instead of throwing `repo.applyRemote is not a function`; v4.0 sync is
    // web/Dexie-only.
    const repo = deps.repo as unknown as { applyRemote?: unknown; bulkLoadAll?: unknown }
    if (typeof repo.applyRemote !== 'function' || typeof repo.bulkLoadAll !== 'function') {
      return { ok: true, skipped: 'unsupported-repo' }
    }

    // W5: default session accessor (`readSession`) is null under Node, so the
    // injected fake is what makes these tests meaningful.
    if (!session()) return { ok: true, skipped: 'no-session' }

    if (reason === 'auto' && deps.online?.() === false) {
      return { ok: true, skipped: 'offline' }
    }

    // Defense in depth (BOOT-01/BOOT-04): production refuses to sync an
    // unclassified dataset. The bootstrap UI passes `bootstrap: true` to run
    // the first upload/download through this same engine.
    if (deps.requireBootstrap === true && opts.bootstrap !== true) {
      if (!(await getBootstrapComplete(db))) {
        return { ok: true, skipped: 'not-bootstrapped' }
      }
    }

    if (running !== null) {
      // T-20-55: join the in-flight loop instead of answering `ok:true` early.
      // The caller's present options are coalesced into the trailing cycle and
      // its promise resolves with that trailing run's result.
      rerun = true
      pendingOpts = { ...pendingOpts, ...opts }
      return running
    }

    let cycleOpts: SyncRunOptions = { ...opts }
    const loop = (async (): Promise<SyncRunResult> => {
      let result: SyncRunResult = { ok: true }
      do {
        rerun = false
        result = await acquireAndCycle(reason, cycleOpts)
        if (rerun) {
          // A later present option wins per key; consumed options are cleared
          // so they cannot leak into a subsequent run.
          cycleOpts = { ...cycleOpts, ...pendingOpts }
          pendingOpts = {}
        }
      } while (rerun && !stopped)
      return result
    })()

    running = loop
    try {
      return await loop
    } finally {
      running = null
    }
  }

  /**
   * SC5 (T-18-18): one sync cycle at a time across tabs. `ifAvailable` makes a
   * non-leader tab skip the run and rely on BroadcastChannel status instead of
   * queueing behind the leader's lock.
   */
  async function acquireAndCycle(
    reason: 'auto' | 'manual',
    opts: SyncRunOptions = {},
  ): Promise<SyncRunResult> {
    const locks = deps.locks
    if (!locks) return cycle(reason, opts)
    const result = await locks.request('orbit-sync', { ifAvailable: true }, async (lock) => {
      if (!lock) return { ok: true, skipped: 'leader' } satisfies SyncRunResult
      return cycle(reason, opts)
    })
    return result as SyncRunResult
  }

  function requestSync(
    reason: 'auto' | 'manual' = 'manual',
    opts: SyncRunOptions = {},
  ): Promise<SyncRunResult> {
    return run(reason, opts)
  }

  // --- Scheduling & leadership (Task 3) -----------------------------------

  let debounceHandle: unknown = null
  let detach: (() => void) | null = null

  function clearDebounce(): void {
    if (debounceHandle == null) return
    clearTimer(debounceHandle)
    debounceHandle = null
  }

  /** Immediate trigger (online / visible): supersedes pending debounce+backoff. */
  function triggerImmediate(): void {
    if (stopped) return
    clearDebounce()
    clearBackoff()
    void run('auto')
  }

  function scheduleDebounced(): void {
    if (stopped) return
    clearDebounce()
    debounceHandle = setTimer(() => {
      debounceHandle = null
      if (!stopped) void run('auto')
    }, LOCAL_WRITE_DEBOUNCE_MS)
  }

  function stop(): void {
    stopped = true
    clearDebounce()
    clearBackoff()
    detach?.()
    detach = null
  }

  function start(): () => void {
    // Restartable (B1/W6): logout → login tears the old wiring down here and
    // re-subscribes below, so triggers resume.
    stop()
    stopped = false

    // W6: injected targets make this executable under Node. The ambient globals
    // are read inside `start()` only — never at module scope, so the static
    // export prerender can import this module safely.
    const win = deps.win ?? (typeof window !== 'undefined' ? window : null)
    const doc = deps.doc ?? (typeof document !== 'undefined' ? document : null)
    if (win === null) return () => {}

    // App-start trigger (immediate). D-01 has no fixed-interval poll.
    void run('auto')

    const unsubscribe = onLocalWrite(scheduleDebounced)

    const onOnline = () => triggerImmediate()
    win.addEventListener('online', onOnline)

    const onVisibility = () => {
      if (doc?.visibilityState === 'visible') triggerImmediate()
    }
    doc?.addEventListener('visibilitychange', onVisibility)

    detach = () => {
      unsubscribe()
      win.removeEventListener('online', onOnline)
      doc?.removeEventListener('visibilitychange', onVisibility)
    }

    return () => stop()
  }

  return { run, requestSync, start, stop }
}

/**
 * Default session accessor. Kept as a named function so `createSyncEngine` can
 * fall back to it without importing the storage module twice.
 */
export function defaultSession(): { accessToken: string } | null {
  return readSession()
}

// --- Lazy production singleton (Task 4) -----------------------------------

let engine: SyncEngineHandle | null = null

/**
 * Build (once) the production engine.
 *
 * MUST never run at module scope: it calls `getLocalRepository()` and creates
 * the one real `BroadcastChannel('orbit-sync')` (W2). Importing this module
 * during the static-export prerender is safe because nothing here executes
 * until a function is called.
 *
 * W10/W7: `getLocalRepository()` returns the Dexie-backed `LocalRepository` on
 * the web path (the supported v4.0 sync path). Under the native `orbitBridge`
 * it returns `SqliteLocalRepository`, which has no `applyRemote`/outbox; `run`'s
 * capability check turns that path into `skipped:'unsupported-repo'` instead of
 * a runtime crash.
 */
export function getSyncEngine(): SyncEngineHandle {
  if (!engine) {
    engine = createSyncEngine({
      db,
      repo: getLocalRepository(),
      fetch: authedFetch,
      session: readSession,
      locks:
        typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : null,
      // One channel only (W2): lib/sync-state.ts (plan 18-04) listens on the
      // same name, so this must really broadcast in production. The `window`
      // guard keeps Node's worker_threads BroadcastChannel out of the prerender.
      channel:
        typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
          ? new BroadcastChannel('orbit-sync')
          : null,
      online: () => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true),
      // BOOT-01/BOOT-04: production never syncs before the device has completed
      // a classified first sync; the bootstrap UI is the only bypass.
      requireBootstrap: true,
    })
  }
  return engine
}

/**
 * Manual "立即同步" entry point (D-02). During the static-export prerender
 * (no `window`) this resolves as a no-op without opening IndexedDB.
 */
export function requestSync(
  reason: 'auto' | 'manual' = 'manual',
  opts: SyncRunOptions = {},
): Promise<SyncRunResult> {
  if (typeof window === 'undefined') {
    return Promise.resolve({ ok: true, skipped: 'no-session' })
  }
  return getSyncEngine().requestSync(reason, opts)
}

/**
 * Start the trigger set from a mount effect (plan 18-05). The returned cleanup
 * covers `stop()`; there is no separate `stopSyncEngine()`.
 */
export function startSyncEngine(): () => void {
  if (typeof window === 'undefined') return () => {}
  return getSyncEngine().start()
}
