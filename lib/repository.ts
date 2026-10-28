import type { SyncMeta } from '@/lib/types'

export type Entity = 'goals' | 'milestones' | 'tasks' | 'reviews'

/**
 * The single owned storage abstraction for Orbit.
 *
 * Two implementations:
 *  - LocalRepository (Dexie/IndexedDB)      — the web source of truth
 *  - SqliteLocalRepository (native SQLite)  — dormant native-shell path (D-03)
 *
 * Binding semantics every implementation MUST honor:
 *  - Inserts create `id` with `crypto.randomUUID()` when absent.
 *  - Every write sets `updated_at = new Date().toISOString()`.
 *  - softDelete sets `deleted_at = updated_at = now()`. Rows are never
 *    physically removed. Reads exclude `deleted_at != null` unless
 *    `includeDeleted` is passed.
 */
export interface Repository {
  /** List rows of an entity. `sinceUpdatedAt` filters to rows changed strictly
   *  after that ISO timestamp (tombstones included). `includeDeleted` returns
   *  tombstoned rows too. */
  list<T>(entity: Entity, opts?: { sinceUpdatedAt?: string; includeDeleted?: boolean }): Promise<T[]>
  /** Insert or update by `id`; stamps `updated_at`. Creates `id` when absent.
   *  Accepts a partial row missing any SyncMeta field. */
  upsert<T extends SyncMeta>(
    entity: Entity,
    row: Omit<T, keyof SyncMeta> & Partial<SyncMeta>,
  ): Promise<void>
  /** Tombstone a row by id: sets `deleted_at = updated_at = now()`. Never physical delete. */
  softDelete(entity: Entity, id: string): Promise<void>
}
