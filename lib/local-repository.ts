import type { Repository, Entity } from '@/lib/repository'
import type { SyncMeta } from '@/lib/types'
import { db, OrbitDB } from '@/lib/local-db'
import { enqueueOutbox } from '@/lib/outbox'
import { readDeviceId } from '@/lib/auth-storage'
import { validateImportRow } from '@/lib/entity-schema'
import { SYNC_KEYS, notifySyncMetadata } from '@/lib/sync-store'
import { emitLocalWrite } from '@/lib/sync-triggers'
import { wins, type LwwMeta } from '@/lib/sync/conflict'
import {
  canonicalCopies,
  mergeJournalBodies,
  mergeQuantity,
  type ConflictCopy,
  type JournalBody,
} from '@/lib/sync/merge'

const now = () => new Date().toISOString()

/**
 * A pulled row envelope — the shape `sync-engine` forwards from `PullChange`
 * (RESEARCH §4a). `applyRemote` also accepts a plain row for backward
 * compatibility; a plain row carries no writer device id.
 */
export interface RemoteRow {
  data: Record<string, unknown>
  device_id: string | null
}

type PlainRow = Record<string, unknown>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Split a pulled item into its row data and writer device id. The envelope is
 * detected by `data` + `device_id`; no entity row carries a `device_id` field,
 * so a plain row can never be mistaken for one.
 */
function unwrapRemoteRow(raw: unknown): { data: PlainRow; deviceId: string | null } {
  if (isPlainObject(raw) && 'data' in raw && 'device_id' in raw && isPlainObject(raw.data)) {
    return { data: raw.data, deviceId: (raw.device_id as string | null) ?? null }
  }
  return { data: raw as PlainRow, deviceId: null }
}

function metaOf(row: PlainRow, deviceId: string | null): LwwMeta {
  return {
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : '',
    deleted_at: typeof row.deleted_at === 'string' ? row.deleted_at : null,
    device_id: deviceId,
  }
}

/** Narrow an untyped `current_value` to what `mergeQuantity` accepts. */
function quantityOf(row: PlainRow): number | null | undefined {
  const value = row.current_value
  return typeof value === 'number' || value === null || value === undefined ? value : undefined
}

function bodyOf(row: PlainRow, deviceId: string | null): JournalBody {
  return {
    content: typeof row.content === 'string' ? row.content : '',
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : '',
    device_id: deviceId,
    conflict_copies: Array.isArray(row.conflict_copies)
      ? (row.conflict_copies as ConflictCopy[])
      : [],
  }
}

// Every table that participates in a whole-store replace. Whole-store import
// (D-01) clears ALL NINE unconditionally — an entity absent from the backup
// must end up empty, not stale. Exported so the bootstrap helpers can open one
// transaction over the same table set (Phase 20 / BOOT-01).
export const ALL_ENTITIES: readonly Entity[] = ['categories', 'goals', 'milestones', 'tasks', 'dailyTodos', 'journalEntries', 'habits', 'habitCompletions', 'pomodoroSessions']

/**
 * Dexie/IndexedDB implementation of Repository — the on-device source of truth.
 * Browser-only; called only from client effects/handlers via repository-provider.
 */
export class LocalRepository implements Repository {
  /**
   * `deviceId` is injectable so LWW tie-break tests can pin two distinct,
   * stable writers. `readDeviceId()` mints a fresh UUID per call when there is
   * no `localStorage` (Node), which would make those tests meaningless
   * (RESEARCH §4a / Landmine 12).
   */
  constructor(
    private readonly d: OrbitDB = db,
    private readonly deviceId: () => string = readDeviceId,
  ) {}

  private table(entity: Entity) {
    return this.d.table<unknown, string>(entity)
  }

  async list<T>(entity: Entity, opts?: { sinceUpdatedAt?: string; includeDeleted?: boolean }): Promise<T[]> {
    let rows = (await this.table(entity).toArray()) as Array<T & { updated_at: string; deleted_at: string | null }>
    const since = opts?.sinceUpdatedAt
    if (since) rows = rows.filter((r) => r.updated_at > since)
    if (!opts?.includeDeleted) rows = rows.filter((r) => r.deleted_at == null)
    return rows as unknown as T[]
  }

  async upsert<T extends SyncMeta>(
    entity: Entity,
    row: Omit<T, keyof SyncMeta> & Partial<SyncMeta>,
  ): Promise<void> {
    const r: Record<string, unknown> = { ...(row as object) }
    if (!r.id) r.id = crypto.randomUUID()
    r.updated_at = now()
    let id = r.id as string

    // SYNC-01: the outbox row is written in the SAME `rw` transaction as the
    // entity row, so a crash right after commit loses neither the data nor the
    // intent (T-18-01/T-18-04). No fetch/network await happens in here.
    await this.d.transaction('rw', this.table(entity), this.d.syncOutbox, async () => {
      // MERGE-02 / SC-2 (Landmine 5): a live journal save must adopt the id
      // already holding that `day_key`. The UI's `idByDayRef` can lag a merge
      // while a draft is pending, and without this the save would create a
      // second id on an occupied day and throw `ConstraintError`.
      if (entity === 'journalEntries' && r.deleted_at == null && typeof r.day_key === 'string') {
        const byDay = (await this.table('journalEntries')
          .where('day_key')
          .equals(r.day_key)
          .first()) as { id?: string } | undefined
        if (byDay && typeof byDay.id === 'string' && byDay.id !== id) {
          id = byDay.id
          r.id = id
        }
      }

      const existing = (await this.table(entity).get(id)) as Record<string, unknown> | undefined
      if (existing) {
        // Preserve the tombstone unless the caller explicitly supplied one —
        // an ordinary edit must never resurrect a soft-deleted row.
        if (r.deleted_at === undefined) r.deleted_at = existing.deleted_at ?? null
        // Merge columns the caller omitted. Dexie `put` is a whole-record
        // replace, so a partial runtime row would otherwise drop fields.
        for (const [key, value] of Object.entries(existing)) {
          if (!(key in r)) r[key] = value
        }
      } else if (r.deleted_at === undefined) {
        // Genuine insert: live row by default.
        r.deleted_at = null
      }
      await this.table(entity).put(r)
      // A tombstoned write is a delete-intent; a live write is an upsert.
      await enqueueOutbox(this.d, {
        entity,
        row_id: id,
        op: r.deleted_at == null ? 'upsert' : 'delete',
        updated_at: r.updated_at as string,
      })
    })
    emitLocalWrite()
  }

  async softDelete(entity: Entity, id: string): Promise<void> {
    const ts = now()
    let changed = false
    // SYNC-01: tombstone + delete-intent commit atomically. If the row is
    // already gone, enqueue nothing and emit nothing (a no-op delete must not
    // push a phantom change or wake the engine).
    await this.d.transaction('rw', this.table(entity), this.d.syncOutbox, async () => {
      const existing = await this.table(entity).get(id)
      if (!existing) return
      await this.table(entity).update(id, { deleted_at: ts, updated_at: ts })
      await enqueueOutbox(this.d, { entity, row_id: id, op: 'delete', updated_at: ts })
      changed = true
    })
    if (changed) emitLocalWrite()
  }

  /**
   * Hard-delete a single row by id — no tombstone, no re-stamp.
   * Intentionally NOT on the Repository interface — local-only primitive.
   *
   * Phase 19 / MERGE-04 / D-03: the physical delete now leaves durable evidence.
   * The row is removed and an `op:'purge'` intent is enqueued in the SAME `rw`
   * transaction, so a crash cannot leave a local delete with no propagation
   * evidence (T-19-03). `clearArchivedCategories`'s loop of `hardDelete` calls
   * therefore propagates cross-device. Ordinary deletion still propagates
   * through `softDelete` (tombstone + `op:'delete'`).
   *
   * A missing row is a no-op: no entry, no event (matching `softDelete`).
   */
  async hardDelete(entity: Entity, id: string): Promise<void> {
    let removed = false
    await this.d.transaction('rw', this.table(entity), this.d.syncOutbox, async () => {
      const row = (await this.table(entity).get(id)) as Record<string, unknown> | undefined
      if (!row) return
      await this.table(entity).delete(id)
      await enqueueOutbox(this.d, {
        entity,
        row_id: id,
        op: 'purge',
        updated_at: typeof row.updated_at === 'string' ? row.updated_at : now(),
      })
      removed = true
    })
    // Landmine 10: emit AFTER commit or the purge may sit until an unrelated
    // trigger wakes the engine.
    if (removed) emitLocalWrite()
  }

  /**
   * Load rows EXACTLY as received — preserving `id`, `updated_at`, and
   * `deleted_at` — via a raw Dexie bulkPut. This deliberately BYPASSES `upsert`
   * (which regenerates ids and re-stamps `updated_at`), so exports/imports keep
   * their original timestamps and tombstones verbatim.
   * Intentionally NOT on the Repository interface — it is local-only.
   *
   * SYNC-04 / T-18-03: this is a PULL/IMPORT path. It deliberately never
   * enqueues an outbox entry or emits a local-write event — a remotely applied
   * row must never echo back to the server.
   */
  async bulkLoad(entity: Entity, rows: unknown[]): Promise<void> {
    await this.table(entity).bulkPut(rows as object[])
  }

  /**
   * Atomic multi-entity load: every entity in ONE Dexie `rw` transaction, so a
   * failure on any entity rolls back ALL writes. The store is never left
   * half-imported. Same verbatim semantics as bulkLoad (no re-stamp, tombstones
   * preserved). Intentionally NOT on the Repository interface — local-only.
   *
   * SYNC-04 / T-18-03: pull/import path — never enqueues and never emits, so a
   * pulled row cannot echo back to the server.
   */
  async bulkLoadAll(entries: ReadonlyArray<readonly [Entity, unknown[]]>): Promise<void> {
    const stores = entries.map(([entity]) => entity)
    await this.d.transaction('rw', stores, async () => {
      for (const [entity, rows] of entries) {
        await this.table(entity).bulkPut(rows as object[])
      }
    })
  }

  /**
   * Phase 19 / SYNC-04 / T-19-01 — merge-aware atomic pull apply.
   *
   * Every incoming row is decided with the ONE `wins()` comparator inside a
   * single Dexie `rw` transaction, so the cursor can never advance past rows
   * that failed to commit. The merge policy:
   *  - older incoming rows leave the local row untouched (the cursor still
   *    advances);
   *  - quantity-task `current_value` is the max of both sides on BOTH LWW
   *    outcomes (MERGE-03 / D-01);
   *  - same-id journal bodies keep the loser as a conflict copy (D-02);
   *  - a journal row whose day is held by a DIFFERENT id physically deletes that
   *    row before the canonical put (Dexie's `&day_key` is unique across
   *    tombstones, so a tombstone can never free the day) and reconciles the
   *    bodies (MERGE-02 / D-04);
   *  - `purges` physically delete their rows (MERGE-04 / D-03).
   *
   * No-echo invariant (Landmine 4): the ordinary pull path enqueues NOTHING. The
   * only documented exception is a journal different-id body that is newer
   * locally and not yet on the server — a genuine local contribution, pushed as
   * exactly one upsert. No network await happens in here (T-18-16).
   *
   * Callers MUST validate row payloads with `validateImportRow` first — this
   * primitive does not validate. Invalid rows belong in the quarantine.
   */
  async applyRemote(
    entries: ReadonlyArray<readonly [Entity, unknown[]]>,
    cursor: number,
    purges: ReadonlyArray<{ entity: Entity; id: string }> = [],
    opts: { advanceCursor?: boolean } = {},
  ): Promise<void> {
    // Dedupe stores: Dexie rejects a store list containing the same table
    // twice, and `syncOutbox` is included because the journal defensive path
    // may enqueue (Landmine 14).
    const storeNames = new Set<string>()
    for (const [entity] of entries) storeNames.add(entity)
    for (const purge of purges) storeNames.add(purge.entity)

    await this.d.transaction(
      'rw',
      [...storeNames, this.d.syncState, this.d.syncOutbox],
      async () => {
        const pending = new Set<string>()
        for (const entry of await this.d.syncOutbox.toArray()) {
          pending.add(`${entry.entity}:${entry.row_id}`)
        }

        // A row this device wrote (still queued) is stamped with this device's
        // id; a row that came from a pull has an unknown writer, so on an exact
        // tie it adopts the incoming server row (RESEARCH §4a).
        const localDeviceId = (entity: Entity, rowId: string): string | null =>
          pending.has(`${entity}:${rowId}`) ? this.deviceId() : null

        for (const [entity, rows] of entries) {
          if (rows.length === 0) continue
          const table = this.table(entity)

          for (const raw of rows) {
            const { data, deviceId: incomingDeviceId } = unwrapRemoteRow(raw)
            const id = typeof data.id === 'string' ? data.id : undefined
            const local = (
              id === undefined ? undefined : await table.get(id)
            ) as PlainRow | undefined

            const incomingMeta = metaOf(data, incomingDeviceId)
            const localMeta = local && id ? metaOf(local, localDeviceId(entity, id)) : null
            const merged: PlainRow = { ...data }

            const quantityPair =
              entity === 'tasks' &&
              local !== undefined &&
              local.progress_type === 'quantity' &&
              data.progress_type === 'quantity'

            if (local && localMeta) {
              if (!wins(incomingMeta, localMeta)) {
                // Local wins. Still raise a quantity value when the incoming
                // (losing) write carries more progress — otherwise it is lost
                // forever (MERGE-03).
                if (quantityPair) {
                  const current = typeof local.current_value === 'number' ? local.current_value : 0
                  const raised = mergeQuantity(quantityOf(local), quantityOf(data))
                  if (raised > current) {
                    const ts = now()
                    await table.put({ ...local, current_value: raised, updated_at: ts })
                    // A genuine local contribution, not an echo. A pending
                    // entry already pushes the live row, so leave it alone.
                    if (id && !pending.has(`${entity}:${id}`)) {
                      await enqueueOutbox(this.d, {
                        entity,
                        row_id: id,
                        op: 'upsert',
                        updated_at: ts,
                      })
                    }
                  }
                }
                continue
              }

              // Incoming wins. A same-id journal body keeps the loser as a
              // conflict copy. This also carries forward copies the incoming
              // row omits, which is what makes a replayed page idempotent.
              if (entity === 'journalEntries') {
                const bodies = mergeJournalBodies(
                  bodyOf(data, incomingDeviceId),
                  bodyOf(local, localMeta.device_id),
                )
                merged.content = bodies.content
                if (bodies.conflict_copies.length > 0) {
                  merged.conflict_copies = bodies.conflict_copies
                }
              }
            }

            if (quantityPair && local) {
              merged.current_value = mergeQuantity(quantityOf(local), quantityOf(data))
            }

            // Journal natural-key merge (MERGE-02 / D-04). Unique `&day_key`
            // includes tombstones, so the other id must be physically removed
            // BEFORE the canonical put — never tombstoned to "free" the day.
            if (
              entity === 'journalEntries' &&
              typeof data.day_key === 'string'
            ) {
              const other = (await table
                .where('day_key')
                .equals(data.day_key)
                .first()) as PlainRow | undefined

              if (other && other.id !== id) {
                const otherMeta = metaOf(
                  other,
                  typeof other.id === 'string' ? localDeviceId(entity, other.id) : null,
                )
                const incomingCopies = Array.isArray(data.conflict_copies)
                  ? (data.conflict_copies as ConflictCopy[])
                  : []
                const otherContent = typeof other.content === 'string' ? other.content : ''

                // Tombstones resolve by LWW without resurrecting content
                // (MERGE-04). Never let a live row overwrite a winning
                // tombstone, and never collide a losing tombstone with the
                // occupied unique `day_key`.
                const otherIsTombstone = other.deleted_at != null
                const incomingIsTombstone = data.deleted_at != null
                if (otherIsTombstone && wins(otherMeta, incomingMeta)) {
                  // The local tombstone wins: consume the incoming row.
                  continue
                }
                if (incomingIsTombstone) {
                  if (wins(incomingMeta, otherMeta)) {
                    // The incoming tombstone wins: replace the occupied day.
                    await table.delete(other.id as string)
                    await table.put(merged)
                    continue
                  }
                  // The incoming tombstone loses: consume it.
                  continue
                }

                if (wins(otherMeta, incomingMeta)) {
                  const alreadyRepresented = incomingCopies.some(
                    (copy) => copy.content === otherContent,
                  )
                  if (!alreadyRepresented) {
                    // The local different-id body is newer and not on the
                    // server: keep it primary, adopt the canonical id, and push
                    // exactly one upsert (the only enqueue on the pull path).
                    const bodies = mergeJournalBodies(
                      bodyOf(other, otherMeta.device_id),
                      bodyOf(data, incomingDeviceId),
                    )
                    merged.content = bodies.content
                    merged.updated_at = otherMeta.updated_at
                    merged.conflict_copies = bodies.conflict_copies
                    await table.delete(other.id as string)
                    await enqueueOutbox(this.d, {
                      entity,
                      row_id: id as string,
                      op: 'upsert',
                      updated_at: otherMeta.updated_at,
                    })
                    await table.put(merged)
                    continue
                  }
                  // The local body is already preserved on the incoming row —
                  // adopt the incoming content and drop the duplicate id.
                  merged.content = data.content
                  merged.conflict_copies = canonicalCopies(
                    [
                      ...incomingCopies,
                      ...(Array.isArray(other.conflict_copies)
                        ? (other.conflict_copies as ConflictCopy[])
                        : []),
                    ],
                    typeof data.content === 'string' ? data.content : undefined,
                  )
                  await table.delete(other.id as string)
                  await table.put(merged)
                  continue
                }

                // Incoming wins: keep its content, retain the local body as a
                // copy, and remove the duplicate id before the put.
                const bodies = mergeJournalBodies(
                  bodyOf(data, incomingDeviceId),
                  bodyOf(other, otherMeta.device_id),
                )
                merged.content = bodies.content
                if (bodies.conflict_copies.length > 0) {
                  merged.conflict_copies = bodies.conflict_copies
                }
                await table.delete(other.id as string)
              }
            }

            await table.put(merged)
          }
        }

        for (const purge of purges) {
          // Absent row is a no-op; the cursor still advances.
          await this.table(purge.entity).delete(purge.id)
        }

        if (opts.advanceCursor !== false) {
          await this.d.syncState.put({ key: SYNC_KEYS.cursor, value: cursor })
          await this.d.syncState.put({ key: SYNC_KEYS.lastSyncedAt, value: now() })
        }
      },
    )
  }

  /**
   * Phase 20 / BOOT-01 + BOOT-02 — adopt a server snapshot as the local
   * baseline. This is the ONLY primitive allowed to wholesale-replace local
   * data for bootstrap (branch B and use-cloud).
   *
   * Deliberately NOT `replaceAll`: `replaceAll` marks the store for a full
   * reconcile, so the next engine cycle re-enqueues and re-uploads the entire
   * snapshot (the echo in RESEARCH Pitfall 3). Bootstrap adoption leaves
   * `status` at `idle` with an empty outbox, so nothing is pushed back.
   *
   * Validation runs BEFORE the transaction: one invalid row aborts with zero
   * writes (T-20-13). The clear + write + cursor/metadata update then happen in
   * ONE `rw` transaction, so a partial baseline can never exist (T-20-14).
   * Never enqueues an outbox entry and never emits a local-write signal — the
   * snapshot came from the server and must not echo back.
   */
  async applyBootstrapBaseline(
    entries: ReadonlyArray<readonly [Entity, unknown[]]>,
    meta: { cursor: number; accountId: string; epoch: number },
  ): Promise<void> {
    for (const [entity, rows] of entries) {
      rows.forEach((row, index) => validateImportRow(entity, row, index))
    }

    await this.d.transaction(
      'rw',
      [...ALL_ENTITIES, this.d.syncOutbox, this.d.syncState],
      async () => {
        for (const entity of ALL_ENTITIES) {
          await this.table(entity).clear()
        }
        for (const [entity, rows] of entries) {
          await this.table(entity).bulkPut(rows as object[])
        }
        await this.d.syncOutbox.clear()
        await this.d.syncState.put({ key: SYNC_KEYS.cursor, value: meta.cursor })
        await this.d.syncState.put({ key: SYNC_KEYS.status, value: 'idle' })
        await this.d.syncState.put({ key: SYNC_KEYS.bootstrapComplete, value: true })
        await this.d.syncState.put({ key: SYNC_KEYS.bootstrapAccountId, value: meta.accountId })
        await this.d.syncState.put({ key: SYNC_KEYS.datasetEpoch, value: meta.epoch })
      },
    )

    notifySyncMetadata()
  }

  /**
   * Whole-store replace (D-01): clear ALL NINE tables unconditionally, then
   * bulkPut the supplied rows verbatim — all inside ONE Dexie `rw` transaction,
   * so a throw anywhere rolls back every clear. The result is the backup's exact
   * state; rows created after the backup are discarded.
   * Local-only primitive, NOT on the Repository interface.
   */
  async replaceAll(entries: ReadonlyArray<readonly [Entity, unknown[]]>): Promise<void> {
    // SYNC-04 / T-18-07 (W12): a whole-store replace invalidates every pending
    // change. The outbox is cleared and the engine is marked for a full
    // reconcile inside the SAME transaction, so stale pre-import intent can
    // never be pushed and the queue is never a mix of pre/post-import rows.
    // Whether this should push to the cloud or require confirmation is a
    // Phase 20 (first-sync) decision — Phase 18 only guarantees the
    // invalidation is observable.
    await this.d.transaction(
      'rw',
      [...ALL_ENTITIES, this.d.syncOutbox, this.d.syncState],
      async () => {
        for (const entity of ALL_ENTITIES) {
          await this.table(entity).clear()
        }
        for (const [entity, rows] of entries) {
          await this.table(entity).bulkPut(rows as object[])
        }
        await this.d.syncOutbox.clear()
        await this.d.syncState.put({ key: SYNC_KEYS.status, value: 'needs-full-reconcile' })
      },
    )
    // Emit exactly once AFTER commit so the engine is triggered instead of the
    // queue silently diverging from local state.
    emitLocalWrite()
  }
}
