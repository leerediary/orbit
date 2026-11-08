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
//   - nullable columns (deleted_at, completed_at) deserialize as JS `null`,
//     not `undefined`.

import type { Repository, Entity } from '@/lib/repository'
import type { SyncMeta } from '@/lib/types'
import { type OrbitBridge, getBridge } from '@/lib/sqlite-bridge'
import { ENTITY_COLUMNS } from '@/lib/entity-schema'

const ENTITIES: readonly Entity[] = ['categories', 'goals', 'milestones', 'tasks', 'dailyTodos', 'journalEntries', 'habits', 'habitCompletions', 'pomodoroSessions']

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
    // Array columns are JSON-encoded into bound TEXT parameters — the value is
    // still a parameter, never interpolated into SQL (T-13-02). serializeValue
    // (applied in execute()) wraps the result for booleans/undefined.
    params: keys.map((k) =>
      entity === 'pomodoroSessions' && (k === 'notes' || k === 'shared_indices')
        ? JSON.stringify(row[k])
        : row[k],
    ),
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
    case 'categories':
      break
    case 'goals':
      break
    case 'milestones':
      break
    case 'tasks':
      r.completed = r.completed === 1 || r.completed === true
      if (r.completed_at === undefined) r.completed_at = null
      // v3 columns: legacy/external rows may omit them entirely, so restore the
      // same defaults normalizeTaskV3 applies (nullable scopes, checkbox mode).
      if (r.milestone_id === undefined) r.milestone_id = null
      if (r.goal_id === undefined) r.goal_id = null
      if (r.parent_id === undefined) r.parent_id = null
      if (r.progress_type === undefined) r.progress_type = 'checkbox'
      if (r.unit === undefined) r.unit = null
      if (r.target_value === undefined) r.target_value = null
      if (r.current_value === undefined) r.current_value = null
      break
    case 'dailyTodos':
      // Nullable completion: a SQLite NULL stays JS null (linked rows derive
      // completion from Task); 0/1 deserializes to a real boolean.
      if (r.completed !== undefined && r.completed !== null) {
        r.completed = r.completed === 1 || r.completed === true
      }
      if (r.task_id === undefined) r.task_id = null
      if (r.name === undefined) r.name = null
      if (r.completed_at === undefined) r.completed_at = null
      break
    case 'journalEntries':
      // Plain text; a legacy/external row that omits the column is an empty
      // journal, not a null one (content is never null in the domain model).
      if (r.content === undefined) r.content = ''
      break
    case 'habits':
      // Universal deleted_at handling above is all a habit row needs.
      break
    case 'habitCompletions':
      // Nullable note: a SQLite NULL or an omitted column becomes JS null.
      // `completed_at` is required, so it is left untouched.
      if (r.note === undefined) r.note = null
      break
    case 'pomodoroSessions': {
      // Array columns arrive as JSON TEXT. Parse defensively (a malformed blob
      // falls back to []); an already-array value is kept as-is and a missing
      // column defaults to []. `marked_task_complete` is a 0/1 INTEGER → boolean.
      const parseArray = (v: unknown): unknown[] => {
        if (Array.isArray(v)) return v
        if (typeof v === 'string') {
          try {
            const parsed = JSON.parse(v)
            return Array.isArray(parsed) ? parsed : []
          } catch {
            return []
          }
        }
        return []
      }
      r.notes = parseArray(r.notes)
      r.shared_indices = parseArray(r.shared_indices)
      r.marked_task_complete = r.marked_task_complete === 1 || r.marked_task_complete === true
      if (r.habit_id === undefined) r.habit_id = null
      if (r.task_id === undefined) r.task_id = null
      if (r.daily_todo_id === undefined) r.daily_todo_id = null
      if (r.progress_amount === undefined) r.progress_amount = null
      break
    }
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

        // categories (D-01) — root of the four-level hierarchy
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS categories (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
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
          `CREATE INDEX IF NOT EXISTS categories_updated_at ON categories(updated_at)`,
          [],
        )
        await bridge.execute(
          `CREATE INDEX IF NOT EXISTS categories_created_at ON categories(created_at)`,
          [],
        )

        // goals (D-01) — second level, parented by a category
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS goals (
             id TEXT PRIMARY KEY,
             category_id TEXT NOT NULL,
             name TEXT NOT NULL,
             created_at TEXT NOT NULL,
             -- Nullable: legacy rows predate sort_order; effectiveOrder() in
             -- lib/goal-order.ts falls back to created_at for them.
             sort_order INTEGER,
             updated_at TEXT NOT NULL,
             deleted_at TEXT
           )`,
          [],
        )
        await bridge.execute(`CREATE INDEX IF NOT EXISTS goals_category_id ON goals(category_id)`, [])
        await bridge.execute(`CREATE INDEX IF NOT EXISTS goals_updated_at ON goals(updated_at)`, [])
        await bridge.execute(`CREATE INDEX IF NOT EXISTS goals_created_at ON goals(created_at)`, [])

        // milestones (D-01) — third level, parented by a goal
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS milestones (
             id TEXT PRIMARY KEY,
             goal_id TEXT NOT NULL,
             name TEXT NOT NULL,
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

        // tasks (D-01/D-02) — leaf level; milestone_id is nullable (null = a
        // direct task under a goal), goal_id scopes direct tasks, and
        // parent_id forms the sub-task tree. progress_type selects checkbox vs
        // quantity progress; unit/target/current are quantity-only.
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS tasks (
             id TEXT PRIMARY KEY,
             milestone_id TEXT,
             goal_id TEXT,
             parent_id TEXT,
             name TEXT NOT NULL,
             progress_type TEXT NOT NULL DEFAULT 'checkbox',
             completed INTEGER NOT NULL DEFAULT 0,
             completed_at TEXT,
             unit TEXT,
             target_value REAL,
             current_value REAL,
             created_at TEXT NOT NULL,
             -- Nullable: legacy rows predate sort_order; effectiveOrder() in
             -- lib/goal-order.ts falls back to created_at for them.
             sort_order INTEGER,
             updated_at TEXT NOT NULL,
             deleted_at TEXT
           )`,
          [],
        )
        await bridge.execute(`CREATE INDEX IF NOT EXISTS tasks_milestone_id ON tasks(milestone_id)`, [])
        await bridge.execute(`CREATE INDEX IF NOT EXISTS tasks_updated_at ON tasks(updated_at)`, [])
        await bridge.execute(`CREATE INDEX IF NOT EXISTS tasks_created_at ON tasks(created_at)`, [])

        // dailyTodos (Phase 9, D-01) — the daily layer beside the hierarchy.
        // Column order mirrors SHAPES.dailyTodos Object.keys order.
        // `completed` is NULLABLE: null = linked row (completion derives from
        // Task), so a linked row can never carry a second copy of completion.
        // `added_at` is NOT NULL — it drives the relative-age badge and order.
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS dailyTodos (
             id TEXT PRIMARY KEY,
             task_id TEXT,
             name TEXT,
             completed INTEGER,
             completed_at TEXT,
             added_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             deleted_at TEXT
           )`,
          [],
        )
        await bridge.execute(
          `CREATE INDEX IF NOT EXISTS dailyTodos_task_id ON dailyTodos(task_id)`,
          [],
        )
        await bridge.execute(
          `CREATE INDEX IF NOT EXISTS dailyTodos_updated_at ON dailyTodos(updated_at)`,
          [],
        )

        // journalEntries (Phase 10, D-01/D-02) — one plain-text row per logical
        // local day. `day_key UNIQUE` enforces one row per day at the storage
        // layer (T-10-03), so no separate day_key index is needed. `content` is
        // NOT NULL: an empty day is stored as '' and never removed (D-04).
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS journalEntries (
             id TEXT PRIMARY KEY,
             day_key TEXT NOT NULL UNIQUE,
             content TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             deleted_at TEXT
           )`,
          [],
        )
        await bridge.execute(
          `CREATE INDEX IF NOT EXISTS journalEntries_updated_at ON journalEntries(updated_at)`,
          [],
        )

        // habits (Phase 12, HABIT-01) — column order mirrors SHAPES.habits
        // Object.keys order. `sort_order` is NOT NULL: every write supplies it.
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS habits (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             short_name TEXT NOT NULL,
             sort_order INTEGER NOT NULL,
             updated_at TEXT NOT NULL,
             deleted_at TEXT
           )`,
          [],
        )
        await bridge.execute(
          `CREATE INDEX IF NOT EXISTS habits_sort_order ON habits(sort_order)`,
          [],
        )
        await bridge.execute(
          `CREATE INDEX IF NOT EXISTS habits_updated_at ON habits(updated_at)`,
          [],
        )

        // habitCompletions (Phase 12, HABIT-02) — column order mirrors
        // SHAPES.habitCompletions Object.keys order. `note` is nullable;
        // `completed_at` is NOT NULL (the tap instant survives note edits).
        // NO UNIQUE(habit_id, date): uniqueness is live-only so tombstones may
        // duplicate a natural key — validateHabitCompletionRelations owns it (A4).
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS habitCompletions (
             id TEXT PRIMARY KEY,
             habit_id TEXT NOT NULL,
             date TEXT NOT NULL,
             note TEXT,
             completed_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             deleted_at TEXT
           )`,
          [],
        )
        await bridge.execute(
          `CREATE INDEX IF NOT EXISTS habitCompletions_habit_id_date ON habitCompletions(habit_id, date)`,
          [],
        )
        await bridge.execute(
          `CREATE INDEX IF NOT EXISTS habitCompletions_date ON habitCompletions(date)`,
          [],
        )
        await bridge.execute(
          `CREATE INDEX IF NOT EXISTS habitCompletions_updated_at ON habitCompletions(updated_at)`,
          [],
        )

        // pomodoroSessions (Phase 13, POMODORO-01) — column order mirrors
        // SHAPES.pomodoroSessions Object.keys order. `notes` and `shared_indices`
        // are JSON TEXT (arrays are not native SQLite types); both are NOT NULL
        // (an empty array is stored as '[]'). `marked_task_complete` is 0/1.
        await bridge.execute(
          `CREATE TABLE IF NOT EXISTS pomodoroSessions (
             id TEXT PRIMARY KEY,
             started_at TEXT NOT NULL,
             duration_sec INTEGER NOT NULL,
             notes TEXT NOT NULL,
             habit_id TEXT,
             task_id TEXT,
             daily_todo_id TEXT,
             marked_task_complete INTEGER NOT NULL,
             progress_amount REAL,
             shared_indices TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             deleted_at TEXT
           )`,
          [],
        )
        await bridge.execute(
          `CREATE INDEX IF NOT EXISTS pomodoroSessions_started_at ON pomodoroSessions(started_at)`,
          [],
        )
        await bridge.execute(
          `CREATE INDEX IF NOT EXISTS pomodoroSessions_updated_at ON pomodoroSessions(updated_at)`,
          [],
        )
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
   * ALL EIGHT entities unconditionally (an entity absent from the backup must
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
