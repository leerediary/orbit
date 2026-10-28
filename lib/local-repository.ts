import type { Repository, Entity } from '@/lib/repository'
import type { SyncMeta } from '@/lib/types'
import { db, OrbitDB } from '@/lib/local-db'

const now = () => new Date().toISOString()

// Every table that participates in a whole-store replace. Whole-store import
// (D-01) clears ALL FOUR unconditionally — an entity absent from the backup
// must end up empty, not stale.
const ALL_ENTITIES: readonly Entity[] = ['goals', 'milestones', 'tasks', 'reviews']

/**
 * Dexie/IndexedDB implementation of Repository — the on-device source of truth.
 * Browser-only; called only from client effects/handlers via repository-provider.
 */
export class LocalRepository implements Repository {
  constructor(private readonly d: OrbitDB = db) {}

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
    const id = r.id as string

    await this.d.transaction('rw', this.table(entity), async () => {
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
    })
  }

  async softDelete(entity: Entity, id: string): Promise<void> {
    const ts = now()
    await this.table(entity).update(id, { deleted_at: ts, updated_at: ts })
  }

  /**
   * Hard-delete a single row by id — no tombstone, no re-stamp.
   * Intentionally NOT on the Repository interface — local-only primitive.
   */
  async hardDelete(entity: Entity, id: string): Promise<void> {
    await this.table(entity).delete(id)
  }

  /**
   * Load rows EXACTLY as received — preserving `id`, `updated_at`, and
   * `deleted_at` — via a raw Dexie bulkPut. This deliberately BYPASSES `upsert`
   * (which regenerates ids and re-stamps `updated_at`), so exports/imports keep
   * their original timestamps and tombstones verbatim.
   * Intentionally NOT on the Repository interface — it is local-only.
   */
  async bulkLoad(entity: Entity, rows: unknown[]): Promise<void> {
    await this.table(entity).bulkPut(rows as object[])
  }

  /**
   * Atomic multi-entity load: every entity in ONE Dexie `rw` transaction, so a
   * failure on any entity rolls back ALL writes. The store is never left
   * half-imported. Same verbatim semantics as bulkLoad (no re-stamp, tombstones
   * preserved). Intentionally NOT on the Repository interface — local-only.
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
   * Whole-store replace (D-01): clear ALL FOUR tables unconditionally, then
   * bulkPut the supplied rows verbatim — all inside ONE Dexie `rw` transaction,
   * so a throw anywhere rolls back every clear. The result is the backup's exact
   * state; rows created after the backup are discarded.
   * Local-only primitive, NOT on the Repository interface.
   */
  async replaceAll(entries: ReadonlyArray<readonly [Entity, unknown[]]>): Promise<void> {
    await this.d.transaction('rw', ALL_ENTITIES, async () => {
      for (const entity of ALL_ENTITIES) {
        await this.table(entity).clear()
      }
      for (const [entity, rows] of entries) {
        await this.table(entity).bulkPut(rows as object[])
      }
    })
  }
}
