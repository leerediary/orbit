import type { OrbitDB } from '@/lib/local-db'
import type { SyncEntity } from '@/lib/sync-entities'

/**
 * Durable change queue for the sync engine (SYNC-01).
 *
 * The outbox is a SIDE table — entity rows carry no `dirty`/`rev` columns, so the
 * `orbit-export` v7 contract is untouched (D-13). `LocalRepository.upsert` /
 * `softDelete` write an entry in the SAME Dexie `rw` transaction as the data
 * row, so a crash right after commit loses neither the data nor the intent.
 *
 * `purge` (Phase 19 / MERGE-04) records an irreversible physical delete:
 * `hardDelete` removes the row and enqueues `op:'purge'` in the same
 * transaction, so the removal propagates to the server and every other device
 * instead of silently reappearing on the next pull.
 */
export type SyncOp = 'upsert' | 'delete' | 'purge'

export interface OutboxEntry {
  /** Auto-increment primary key assigned by Dexie (`++seq`). */
  seq?: number
  entity: SyncEntity
  row_id: string
  op: SyncOp
  /** The entity row's `updated_at` at the moment the change was captured. */
  updated_at: string
}

export type OutboxDraft = Omit<OutboxEntry, 'seq'>

/**
 * Append a change-intent row. When called inside an active Dexie transaction the
 * `put` joins that transaction; when called standalone it opens its own — either
 * way the caller never awaits a network call in a transaction.
 *
 * The draft is spread into a fresh object so a caller cannot mutate the stored
 * row (and so an accidental `seq` on a draft never overrides the auto-increment).
 */
export async function enqueueOutbox(d: OrbitDB, entry: OutboxDraft): Promise<void> {
  await d.syncOutbox.put({ ...entry })
}

/** Read the whole queue in ascending `seq` order (stable, oldest first). */
export async function readOutbox(d: OrbitDB): Promise<OutboxEntry[]> {
  const rows = await d.syncOutbox.toArray()
  return rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
}

/** Remove the acknowledged rows by `seq`. A no-op for an empty batch. */
export async function deleteOutboxEntries(d: OrbitDB, seqs: readonly number[]): Promise<void> {
  if (seqs.length === 0) return
  await d.syncOutbox.bulkDelete([...seqs])
}

/** Pending change count — backs the "待同步 N 项" badge. */
export async function countOutbox(d: OrbitDB): Promise<number> {
  return d.syncOutbox.count()
}
