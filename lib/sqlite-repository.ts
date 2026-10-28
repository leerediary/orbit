// lib/sqlite-repository.ts — Native-SQLite implementation of the Repository
// interface. Drop-in peer of LocalRepository (Dexie/IndexedDB): same method
// surface, same semantics (client UUIDs, updated_at stamping, tombstones).
//
// Talks exclusively through `window.orbitBridge` (see lib/sqlite-bridge.ts).
// This is the dormant native path (D-03): no native shell exists in Phase 1, so
// web builds instantiate LocalRepository instead.
//
// Architectural invariants enforced in this file:
//   - the Repository interface is honored exactly, including list opts
//     `sinceUpdatedAt` (STRICT `>` — never `>=`) and `includeDeleted`;
//   - bulkLoad/bulkLoadAll preserve supplied updated_at; never re-stamp;
//   - boolean columns (completed) deserialize as JS booleans, not 0/1;
//   - nullable columns (deleted_at, completed_at, milestone_id) deserialize as
//     JS `null`, not `undefined`.

import type { Repository, Entity } from '@/lib/repository'
import type { SyncMeta } from '@/lib/types'
import { type OrbitBridge, getBridge } from '@/lib/sqlite-bridge'
import { ENTITY_COLUMNS } from '@/lib/entity-schema'

const ENTITIES: readonly Entity[] = ['goals', 'milestones', 'tasks', 'reviews']

function assertEntity(entity: string): asserts entity is Entity {
  if (!(ENTITIES as readonly string[]).includes(entity)) {
    throw new Error(`[SqliteLocalRepository] illegal entity: ${entity}`)
  }
}

// Module-scope schema-ready promise — concurrent constructors all await the
// same promise so the CREATE TABLE IF NOT EXISTS statements never race.
let schemaReady: Promise<void> | null = null

const now = () => new Date().toISOString()

// Serialize a JS value to a SQLite-safe parameter. Booleans → 0/1, undefined → null.
function serializeValue(v: unknown): unknown {
  if (v === undefined) return null
  if (v === true) return 1
  if (v === false) return 0
  return v
}

// Build a parameterized INSERT OR REPLACE from a row. Values are ALWAYS bound
// as parameters; the only SQL-interpolated text is a column name that passed
// the per-entity allowlist. Unknown keys are rejected (never interpolated), so
// an untrusted import row cannot alter the statement.
function insertOrReplaceStatement(
  entity: Entity,
  row: Record<string, unknown>,
): { sql: string; params: unknown[] } {
  const allowed = ENTITY_COLUMNS[entity]
  const keys = Object.keys(row)
  if (keys.length === 0) {
    throw new Error(`[SqliteLocalRepository] empty row for ${entity}`)
  }
  for (const key of keys) {
    if (!allowed.includes(key)) {
      throw new Error(`[SqliteLocalRepository] unknown column for ${entity}: ${key}`)
    }
  }
  const placeholders = keys.map(() => '?').join(', ')
  return {
    sql: `INSERT OR REPLACE INTO ${entity} (${keys.join(', ')}) VALUES (${placeholders})`,
    params: keys.map((k) => row[k]),
  }
}

// Deserialize a raw SQLite row into the strongly-typed shape the rest of the
// app expects: booleans for `completed`, JS null (not undefined) for every
// nullable column.
function deserializeRow<T>(entity: Entity, row: Record<string, unknown>): T {
  const r: Record<string, unknown> = { ...row }

  // Universal nullable: deleted_at — every entity has it.
  if (r.deleted_at === undefined) r.deleted_at = null

  switch (entity) {
    case 'goals':
      break
    case 'milestones':
      r.completed = r.completed === 1 || r.completed === true
      if (r.completed_at === undefined) r.completed_at = null
      break
    case 'tasks':
      r.completed = r.completed === 1 || r.completed === true
      if (r.completed_at === undefined) r.completed_at = null
      if (r.milestone_id === undefined) r.milestone_id = null
      break
    case 'reviews':
      break
  }
  return r as T
}

/**
 * SQLite implementation of Repository — selected by repository-provider.ts when
 * a native shell has injected `window.orbitBridge`. Web builds never
 * instantiate this class.
 */
export class SqliteLocalRepository implements Repository {
  private readonly bridge: OrbitBridge | null

  // Bridge may be passed explicitly (native test harness). When absent, every
  // public method calls getBridge() lazily — the bridge is not touched at
  // module-init time because the native shell injects window.orbitBridge after
  // this module is loaded.
  constructor(bridge?: OrbitBridge) {
    this.bridge = bridge ?? null
  }

  private getBridgeRef(): OrbitBridge {
    return this.bridge ?? getBridge()
  }

  private execute(sql: string, params: unknown[] = []): Promise<void> {
    return this.getBridgeRef().execute(sql, params.map(serializeValue))
  }

  private query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.getBridgeRef().query<T>(sql, params.map(serializeValue))
  }

  // ── Schema bootstrap ──

  private async ensureSchema(): Promise<void> {
    if (schemaReady) return schemaReady
    const init = (async () => {
        const bridge = this.getBridgeRef()

        // goals (D-01)
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS goals (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             description TEXT NOT NULL,
             created_at TEXT NOT NULL,
             -- Nullable: legacy rows predate sort_order; effectiveOrder() in
             -- lib/goal-order.ts falls back to created_at for them.
             sort_order INTEGER,
             updated_at TEXT NOT NULL,
             deleted_at TEXT
           )`,
          [],
        )
        await bridge.execute(`CREATE INDEX IF NOT EXISTS goals_updated_at ON goals(updated_at)`, [])
        await bridge.execute(`CREATE INDEX IF NOT EXISTS goals_created_at ON goals(created_at)`, [])

        // milestones (D-01)
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS milestones (
             id TEXT PRIMARY KEY,
             goal_id TEXT NOT NULL,
             name TEXT NOT NULL,
             completed INTEGER NOT NULL DEFAULT 0,
             completed_at TEXT,
             created_at TEXT NOT NULL,
             -- Nullable: legacy rows predate sort_order; effectiveOrder() in
             -- lib/goal-order.ts falls back to created_at for them.
             sort_order INTEGER,
             updated_at TEXT NOT NULL,
             deleted_at TEXT
           )`,
          [],
        )
        await bridge.execute(
          `CREATE INDEX IF NOT EXISTS milestones_goal_id ON milestones(goal_id)`,
          [],
        )
        await bridge.execute(
          `CREATE INDEX IF NOT EXISTS milestones_updated_at ON milestones(updated_at)`,
          [],
        )
        await bridge.execute(
          `CREATE INDEX IF NOT EXISTS milestones_created_at ON milestones(created_at)`,
          [],
        )

        // tasks (D-01) — milestone_id is nullable (no FK constraint in Phase 1)
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS tasks (
             id TEXT PRIMARY KEY,
             goal_id TEXT NOT NULL,
             milestone_id TEXT,
             name TEXT NOT NULL,
             completed INTEGER NOT NULL DEFAULT 0,
             completed_at TEXT,
             created_at TEXT NOT NULL,
             -- Nullable: legacy rows predate sort_order; effectiveOrder() in
             -- lib/goal-order.ts falls back to created_at for them.
             sort_order INTEGER,
             updated_at TEXT NOT NULL,
             deleted_at TEXT
           )`,
          [],
        )
        await bridge.execute(`CREATE INDEX IF NOT EXISTS tasks_goal_id ON tasks(goal_id)`, [])
        await bridge.execute(`CREATE INDEX IF NOT EXISTS tasks_updated_at ON tasks(updated_at)`, [])
        await bridge.execute(`CREATE INDEX IF NOT EXISTS tasks_created_at ON tasks(created_at)`, [])

        // reviews (D-01)
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS reviews (
             id TEXT PRIMARY KEY,
             goal_id TEXT NOT NULL,
             content TEXT NOT NULL,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             deleted_at TEXT
           )`,
          [],
        )
        await bridge.execute(`CREATE INDEX IF NOT EXISTS reviews_goal_id ON reviews(goal_id)`, [])
        await bridge.execute(`CREATE INDEX IF NOT EXISTS reviews_updated_at ON reviews(updated_at)`, [])
        await bridge.execute(`CREATE INDEX IF NOT EXISTS reviews_created_at ON reviews(created_at)`, [])
      })()
    // A transient bootstrap failure (bridge injected late, temporary execute
    // error) must not poison every later call. Clear the cache on rejection so
    // the next call retries the CREATE TABLE statements from scratch.
    const guarded = init.catch((e) => {
      schemaReady = null
      throw e
    })
    schemaReady = guarded
    return guarded
  }

  // ── Generic sync-facing core (Repository interface) ──

  async list<T>(
    entity: Entity,
    opts?: { sinceUpdatedAt?: string; includeDeleted?: boolean },
  ): Promise<T[]> {
    assertEntity(entity)
    await this.ensureSchema()
    let sql = `SELECT * FROM ${entity} WHERE 1=1`
    const params: unknown[] = []
    if (opts?.sinceUpdatedAt) {
      // STRICT > — never >=
      sql += ` AND updated_at > ?`
      params.push(opts.sinceUpdatedAt)
    }
    if (!opts?.includeDeleted) {
      sql += ` AND deleted_at IS NULL`
    }
    const rows = await this.query<Record<string, unknown>>(sql, params)
    return rows.map((r) => deserializeRow<T>(entity, r))
  }

  async upsert<T extends SyncMeta>(
    entity: Entity,
    row: Omit<T, keyof SyncMeta> & Partial<SyncMeta>,
  ): Promise<void> {
    assertEntity(entity)
    await this.ensureSchema()
    const r: Record<string, unknown> = { ...(row as unknown as Record<string, unknown>) }
    if (!r.id) r.id = crypto.randomUUID()
    r.updated_at = now()
    const id = r.id as string

    await this.execute('BEGIN', [])
    try {
      const existingRows = await this.query<Record<string, unknown>>(
        `SELECT * FROM ${entity} WHERE id = ?`,
        [id],
      )
      const existing = existingRows[0]
      if (existing) {
        // Preserve the tombstone unless the caller explicitly supplied one —
        // an ordinary edit must never resurrect a soft-deleted row.
        if (r.deleted_at === undefined) r.deleted_at = existing.deleted_at ?? null
        // Merge columns the caller omitted (INSERT OR REPLACE is whole-record).
        for (const [key, value] of Object.entries(existing)) {
          if (!(key in r)) r[key] = value
        }
      } else if (r.deleted_at === undefined) {
        // Genuine insert: live row by default.
        r.deleted_at = null
      }

      const { sql, params } = insertOrReplaceStatement(entity, r)
      await this.execute(sql, params)
      await this.execute('COMMIT', [])
    } catch (e) {
      await this.execute('ROLLBACK', []).catch(() => {})
      throw e
    }
  }

  async softDelete(entity: Entity, id: string): Promise<void> {
    assertEntity(entity)
    await this.ensureSchema()
    const ts = now()
    await this.execute(
      `UPDATE ${entity} SET deleted_at = ?, updated_at = ? WHERE id = ?`,
      [ts, ts, id],
    )
  }

  /**
   * Hard-delete a single row by id — no tombstone, no re-stamp.
   * Local-only primitive, not on the Repository interface.
   */
  async hardDelete(entity: Entity, id: string): Promise<void> {
    assertEntity(entity)
    await this.ensureSchema()
    await this.execute(`DELETE FROM ${entity} WHERE id = ?`, [id])
  }

  /**
   * Load rows EXACTLY as received — preserving `id`, `updated_at`, and
   * `deleted_at` — via INSERT OR REPLACE with the raw payload. DELIBERATELY
   * bypasses `upsert` (which re-stamps `updated_at = now()`), so imports keep
   * their original timestamps and tombstones verbatim. Wrapped in a single
   * BEGIN/COMMIT. Local-only primitive, not on the Repository interface.
   */
  async bulkLoad(entity: Entity, rows: unknown[]): Promise<void> {
    assertEntity(entity)
    await this.ensureSchema()
    if (rows.length === 0) return
    await this.execute('BEGIN', [])
    try {
      for (const row of rows) {
        const r = row as Record<string, unknown>
        const { sql, params } = insertOrReplaceStatement(entity, r)
        await this.execute(sql, params)
      }
      await this.execute('COMMIT', [])
    } catch (e) {
      await this.execute('ROLLBACK', []).catch(() => {})
      throw e
    }
  }

  /**
   * Atomic multi-entity load — every entity inside ONE BEGIN/COMMIT, so any
   * failed row rolls back all writes (mirrors LocalRepository.bulkLoadAll).
   * Preserves supplied updated_at/tombstones verbatim. Local-only primitive.
   */
  async bulkLoadAll(entries: ReadonlyArray<readonly [Entity, unknown[]]>): Promise<void> {
    await this.ensureSchema()
    await this.execute('BEGIN', [])
    try {
      for (const [entity, rows] of entries) {
        assertEntity(entity)
        for (const row of rows) {
          const r = row as Record<string, unknown>
          const { sql, params } = insertOrReplaceStatement(entity, r)
          await this.execute(sql, params)
        }
      }
      await this.execute('COMMIT', [])
    } catch (e) {
      await this.execute('ROLLBACK', []).catch(() => {})
      throw e
    }
  }

  /**
   * Whole-store replace (D-01): inside ONE BEGIN/COMMIT, DELETE every row from
   * ALL FOUR entities unconditionally (an entity absent from the backup must
   * end up empty, not stale), then INSERT OR REPLACE the supplied rows
   * verbatim. Any error — including an unknown column rejected before it can
   * reach SQL — rolls back every DELETE. No FK constraints exist, so delete
   * order is irrelevant. Local-only primitive.
   */
  async replaceAll(entries: ReadonlyArray<readonly [Entity, unknown[]]>): Promise<void> {
    await this.ensureSchema()
    await this.execute('BEGIN', [])
    try {
      for (const entity of ENTITIES) {
        assertEntity(entity)
        await this.execute(`DELETE FROM ${entity}`, [])
      }
      for (const [entity, rows] of entries) {
        assertEntity(entity)
        for (const row of rows) {
          const r = row as Record<string, unknown>
          const { sql, params } = insertOrReplaceStatement(entity, r)
          await this.execute(sql, params)
        }
      }
      await this.execute('COMMIT', [])
    } catch (e) {
      await this.execute('ROLLBACK', []).catch(() => {})
      throw e
    }
  }
}
