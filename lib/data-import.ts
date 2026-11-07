import type { Entity } from '@/lib/repository'
import { getLocalRepository } from '@/lib/repository-provider'
import { EXPORT_ENTITIES, EXPORT_FORMAT, EXPORT_VERSION } from '@/lib/data-export'
import {
  validateDailyTodoRelations,
  validateHabitCompletionRelations,
  validateImportRows,
  validateJournalRelations,
  validatePomodoroSessionRelations,
  validateTaskRelations,
} from '@/lib/entity-schema'
import {
  migrateLegacyRows,
  normalizeTaskV3,
  type LegacyGoal,
  type LegacyMilestone,
  type LegacyTask,
  type LegacyV2Task,
} from '@/lib/legacy-migration'

/** v1 contract entities — the legacy three-level backup shape. */
const LEGACY_ENTITIES = ['goals', 'milestones', 'tasks'] as const

/**
 * The pre-daily (v2/v3) contract shape: the four hierarchy tables, without the
 * Phase 9 `dailyTodos` array. v2/v3 backups legitimately carry no daily data,
 * so their branches validate only these and append an empty daily table.
 */
const CORE_ENTITIES = ['categories', 'goals', 'milestones', 'tasks'] as const satisfies readonly Entity[]

/**
 * The pre-journal (v4) contract shape: the five hierarchy/daily tables, without
 * the Phase 10 `journalEntries` array. v4 backups legitimately carry no journal
 * data, so their branch validates only these and appends an empty journal table.
 */
const V4_ENTITIES = ['categories', 'goals', 'milestones', 'tasks', 'dailyTodos'] as const satisfies readonly Entity[]

/**
 * The pre-habits (v5) contract shape: the six hierarchy/daily/journal tables,
 * without the Phase 12 `habits` and `habitCompletions` arrays. v5 backups
 * legitimately carry no habit data, so their branch validates only these and
 * appends empty habit tables.
 */
const V5_ENTITIES = ['categories', 'goals', 'milestones', 'tasks', 'dailyTodos', 'journalEntries'] as const satisfies readonly Entity[]

/**
 * The FROZEN pre-pomodoro (v6) contract shape: the eight hierarchy/daily/journal
 * tables with habits, without the Phase 13 `pomodoroSessions` array. A v6 backup
 * legitimately carries no pomodoro data, so its branch validates only these and
 * appends an empty pomodoro table.
 */
const V6_ENTITIES = ['categories', 'goals', 'milestones', 'tasks', 'dailyTodos', 'journalEntries', 'habits', 'habitCompletions'] as const satisfies readonly Entity[]

/** A validated backup waiting to be applied, plus the ids it carries. */
export interface ImportPlan {
  /** Exactly the entries `replaceAll` will receive, in branch order. */
  entries: ReadonlyArray<readonly [Entity, unknown[]]>
  /** Per-entity ids (live and tombstoned), for the cloud-only diff. */
  ids: Record<string, string[]>
}

/**
 * Collect every string `id` from a validated plan, per entity.
 *
 * Tombstoned rows are included deliberately: a tombstone in the backup means
 * "this id is known here", so it must not be treated as cloud-only. Rows
 * without a usable string id are skipped (they cannot be addressed over the
 * wire). Entities with no ids are omitted.
 */
function collectIds(
  entries: ReadonlyArray<readonly [Entity, unknown[]]>,
): Record<string, string[]> {
  const ids: Record<string, string[]> = {}
  for (const [entity, rows] of entries) {
    const list: string[] = []
    for (const row of rows) {
      if (row == null || typeof row !== 'object') continue
      const id = (row as { id?: unknown }).id
      if (typeof id === 'string' && id.length > 0) list.push(id)
    }
    if (list.length > 0) ids[entity] = list
  }
  return ids
}

/**
 * Parse and validate a data-portability JSON string WITHOUT writing anything.
 *
 * This is the preview half of an import: every version branch runs its full
 * validation pass and returns the entries it would apply, then `ids` is derived
 * from those validated rows. The UI can therefore compute the cloud-only diff
 * and ask for confirmation before a single row is replaced (BOOT-03). No
 * network and no Dexie access happens here.
 *
 * Supports seven contract versions:
 *  - version 7  → all nine entities used as-is (current shape; tasks pass
 *                 `validateTaskRelations`, daily rows pass
 *                 `validateDailyTodoRelations`, journal rows pass
 *                 `validateJournalRelations`, habit completions pass
 *                 `validateHabitCompletionRelations`, and pomodoro sessions
 *                 pass `validatePomodoroSessionRelations`)
 *  - version 6  → the eight pre-pomodoro tables used as-is (FROZEN); the store
 *                 lands with an EMPTY pomodoroSessions table. A stray
 *                 `pomodoroSessions` key is ignored, the same way v5 ignores a
 *                 stray `habits` key.
 *  - version 5  → the six pre-habits tables used as-is (FROZEN); the store
 *                 lands with EMPTY habits, habitCompletions, and
 *                 pomodoroSessions tables. A stray habit key is ignored, the
 *                 same way v4 ignores a stray `journalEntries` key.
 *  - version 4  → the five pre-journal tables used as-is; the store lands with
 *                 an EMPTY journalEntries table (plus empty habit and pomodoro
 *                 tables). A stray `journalEntries` key is ignored, the same way
 *                 v3 ignores a stray `dailyTodos` key.
 *  - version 3  → the four hierarchy tables used as-is (tasks pass
 *                 `validateTaskRelations`); the store lands with EMPTY
 *                 dailyTodos, journalEntries, habit, and pomodoro tables. A
 *                 stray `dailyTodos` key is ignored, the same way v1 ignores
 *                 `reviews`.
 *  - version 2  → the pre-Phase-8 task rows are default-filled through the
 *                 SAME `normalizeTaskV3` the Dexie upgrade uses, then validated
 *                 as v3 rows (transform-before-validate, A3)
 *  - version 1  → legacy goals/milestones/tasks transformed through the SAME
 *                 `migrateLegacyRows` mapping the Dexie upgrade uses, then
 *                 validated as current rows. v1 `reviews` are ignored.
 *
 * This function is pure — zero DOM access. A future native SQLite path reuses
 * it unchanged by calling `prepareImport(json)` from Swift via
 * `evaluateJavaScript`.
 *
 * Validation runs BEFORE any write (there is no write at all here), so any
 * per-row failure throws without touching the store.
 */
export async function prepareImport(json: string): Promise<ImportPlan> {
  // 1. Parse
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('导入失败：文件内容不是有效的 JSON')
  }

  // 2. Validate envelope — all checks before any write
  if (parsed == null || typeof parsed !== 'object') {
    throw new Error('导入失败：文件格式不正确（期望一个 JSON 对象）')
  }
  const obj = parsed as Record<string, unknown>

  if (obj.format !== EXPORT_FORMAT) {
    throw new Error(`导入失败：文件格式不匹配（期望 "${EXPORT_FORMAT}"，实际是 "${String(obj.format)}"）`)
  }

  if (typeof obj.version !== 'number') {
    throw new Error('导入失败：缺少版本号')
  }

  const data = obj.data
  if (data == null || typeof data !== 'object') {
    throw new Error('导入失败：缺少 data 字段或格式不正确')
  }
  const payload = data as Record<string, unknown>

  let entries: ReadonlyArray<readonly [Entity, unknown[]]>

  if (obj.version === EXPORT_VERSION) {
    entries = await prepareCurrentVersion(payload)
  } else if (obj.version === 6) {
    entries = await prepareV6Version(payload)
  } else if (obj.version === 5) {
    entries = await prepareV5Version(payload)
  } else if (obj.version === 4) {
    entries = await prepareV4Version(payload)
  } else if (obj.version === 3) {
    entries = await prepareV3Version(payload)
  } else if (obj.version === 2) {
    entries = await prepareV2Version(payload)
  } else if (obj.version === 1) {
    entries = await prepareLegacyVersion(payload)
  } else {
    throw new Error(`导入失败：不支持的版本 ${obj.version}（当前支持版本 ${EXPORT_VERSION}）`)
  }

  return { entries, ids: collectIds(entries) }
}

/**
 * Import a data-portability JSON string into the local repository.
 *
 * Repository-agnostic by design: uses `getLocalRepository()` to reach
 * `replaceAll` (the local-only whole-store primitive). Import is a 整库替换
 * (true restore, D-01): all nine tables are cleared and then loaded with the
 * backup's rows verbatim — preserving id, updated_at, deleted_at, and all
 * other fields. Rows created after the backup are discarded; timestamps are
 * never re-stamped.
 *
 * All parsing/validation lives in `prepareImport`; this function only applies
 * the resulting plan in exactly ONE atomic `replaceAll`.
 */
export async function importData(json: string): Promise<void> {
  const plan = await prepareImport(json)
  await getLocalRepository().replaceAll(plan.entries)
}

/**
 * v7 path (current): validate every entity array, run the cross-row task, daily,
 * journal, habit-completion, and pomodoro-session invariant passes, then replace
 * the whole store in ONE atomic transaction (EXPORT_ENTITIES order). Every
 * relation validator runs before any write, so a bad task tree, malformed daily
 * row, duplicate journal day, duplicate live habit completion, or invalid
 * pomodoro session (task/daily XOR, out-of-range shared index) is rejected with
 * zero writes (T-13-08).
 */
async function prepareCurrentVersion(
  payload: Record<string, unknown>,
): Promise<ReadonlyArray<readonly [Entity, unknown[]]>> {
  for (const entity of EXPORT_ENTITIES) {
    const rows = payload[entity]
    if (!Array.isArray(rows)) {
      throw new Error(`导入失败：data.${entity} 不是数组`)
    }
    // Per-row shape validation. Dexie's bulkPut accepts any object with an
    // `id` and performs a FULL-record replace, so an id-only row would destroy
    // an existing complete row. Reject malformed rows here, before any write.
    validateImportRows(entity, rows)
  }

  // Cross-row invariants for the self-referential task tree (T-08-05).
  validateTaskRelations(payload.tasks as unknown[])

  // Cross-row daily invariants: standalone-vs-linked content, live task_id
  // uniqueness (T-09-09). Dangling task ids are deliberately allowed.
  validateDailyTodoRelations(payload.dailyTodos as unknown[])

  // Cross-row journal invariants: real calendar days and one row per day across
  // ALL rows (T-10-06), so Dexie and SQLite agree before any write.
  validateJournalRelations(payload.journalEntries as unknown[])

  // Cross-row habit invariants: real calendar days and live-only (habit_id,
  // date) uniqueness; tombstones may duplicate a live key (T-12-01).
  validateHabitCompletionRelations(payload.habitCompletions as unknown[])

  // Cross-row pomodoro invariants: task/daily XOR, completion target presence,
  // positive progress, and in-range shared indices (T-13-08).
  validatePomodoroSessionRelations(payload.pomodoroSessions as unknown[])

  const entries = EXPORT_ENTITIES.map(
    (entity) => [entity as Entity, payload[entity] as unknown[]] as const,
  )
  return entries
}

/**
 * v6 path (frozen legacy, pre-pomodoro): the eight hierarchy/daily/journal/habit
 * tables are used as-is; tasks pass the cross-row invariant pass, daily rows
 * pass the daily pass, journal rows pass the journal pass, habit completions
 * pass the habit pass, then the whole store is replaced with an EMPTY
 * pomodoroSessions table. A v6 backup predates the pomodoro layer, so any stray
 * `pomodoroSessions` key is ignored entirely — its rows are never validated —
 * mirroring v5's treatment of a stray `habits` key (T-13-09).
 */
async function prepareV6Version(
  payload: Record<string, unknown>,
): Promise<ReadonlyArray<readonly [Entity, unknown[]]>> {
  for (const entity of V6_ENTITIES) {
    const rows = payload[entity]
    if (!Array.isArray(rows)) {
      throw new Error(`导入失败：data.${entity} 不是数组`)
    }
    validateImportRows(entity, rows)
  }

  validateTaskRelations(payload.tasks as unknown[])
  validateDailyTodoRelations(payload.dailyTodos as unknown[])
  validateJournalRelations(payload.journalEntries as unknown[])
  validateHabitCompletionRelations(payload.habitCompletions as unknown[])

  const entries: ReadonlyArray<readonly [Entity, unknown[]]> = [
    ...V6_ENTITIES.map(
      (entity) => [entity as Entity, payload[entity] as unknown[]] as const,
    ),
    ['pomodoroSessions', []],
  ]
  return entries
}

/**
 * v5 path (frozen legacy, pre-habits): the six hierarchy/daily/journal tables
 * are used as-is; tasks pass the cross-row invariant pass, daily rows pass the
 * daily pass, and journal rows pass the journal pass, then the whole store is
 * replaced with EMPTY habits and habitCompletions tables. A v5 backup predates
 * the habit layer, so any stray `habits`/`habitCompletions` key is ignored
 * entirely — its rows are never validated — mirroring v4's treatment of a stray
 * `journalEntries` key (T-12-07).
 */
async function prepareV5Version(
  payload: Record<string, unknown>,
): Promise<ReadonlyArray<readonly [Entity, unknown[]]>> {
  for (const entity of V5_ENTITIES) {
    const rows = payload[entity]
    if (!Array.isArray(rows)) {
      throw new Error(`导入失败：data.${entity} 不是数组`)
    }
    validateImportRows(entity, rows)
  }

  validateTaskRelations(payload.tasks as unknown[])
  validateDailyTodoRelations(payload.dailyTodos as unknown[])
  validateJournalRelations(payload.journalEntries as unknown[])

  const entries: ReadonlyArray<readonly [Entity, unknown[]]> = [
    ...V5_ENTITIES.map(
      (entity) => [entity as Entity, payload[entity] as unknown[]] as const,
    ),
    ['habits', []],
    ['habitCompletions', []],
    ['pomodoroSessions', []],
  ]
  return entries
}

/**
 * v4 path (frozen legacy, pre-journal): the five hierarchy/daily tables are used
 * as-is; tasks pass the cross-row invariant pass, daily rows pass the daily
 * invariant pass, then the whole store is replaced with an EMPTY journalEntries
 * table. A v4 backup predates the journal layer, so any stray `journalEntries`
 * key is ignored — mirroring v3's "ignore stray dailyTodos" and v1's "ignore
 * reviews" precedent rather than rejecting an otherwise-valid backup.
 */
async function prepareV4Version(
  payload: Record<string, unknown>,
): Promise<ReadonlyArray<readonly [Entity, unknown[]]>> {
  for (const entity of V4_ENTITIES) {
    const rows = payload[entity]
    if (!Array.isArray(rows)) {
      throw new Error(`导入失败：data.${entity} 不是数组`)
    }
    validateImportRows(entity, rows)
  }

  validateTaskRelations(payload.tasks as unknown[])
  validateDailyTodoRelations(payload.dailyTodos as unknown[])

  const entries: ReadonlyArray<readonly [Entity, unknown[]]> = [
    ...V4_ENTITIES.map(
      (entity) => [entity as Entity, payload[entity] as unknown[]] as const,
    ),
    ['journalEntries', []],
    ['pomodoroSessions', []],
  ]
  return entries
}

/**
 * v3 path (legacy, pre-daily): the four hierarchy tables are used as-is; tasks
 * pass the cross-row invariant pass, then the whole store is replaced with an
 * EMPTY dailyTodos table. A v3 backup predates the daily layer, so any stray
 * `dailyTodos` key is ignored — mirroring the v1 "reviews are ignored"
 * precedent rather than rejecting an otherwise-valid backup.
 */
async function prepareV3Version(
  payload: Record<string, unknown>,
): Promise<ReadonlyArray<readonly [Entity, unknown[]]>> {
  for (const entity of CORE_ENTITIES) {
    const rows = payload[entity]
    if (!Array.isArray(rows)) {
      throw new Error(`导入失败：data.${entity} 不是数组`)
    }
    validateImportRows(entity, rows)
  }

  validateTaskRelations(payload.tasks as unknown[])

  const entries: ReadonlyArray<readonly [Entity, unknown[]]> = [
    ...CORE_ENTITIES.map(
      (entity) => [entity as Entity, payload[entity] as unknown[]] as const,
    ),
    ['dailyTodos', []],
    ['journalEntries', []],
    ['pomodoroSessions', []],
  ]
  return entries
}

/**
 * v2 path: default-fill each pre-Phase-8 task through `normalizeTaskV3` (the
 * same normalizer the Dexie upgrade uses — never a fork), then validate the
 * TRANSFORMED rows and apply the cross-row task invariants before writing.
 * Transformation must precede validation (A3): a v2 row legitimately omits
 * goal_id/parent_id/progress_type/unit/target_value/current_value.
 */
async function prepareV2Version(
  payload: Record<string, unknown>,
): Promise<ReadonlyArray<readonly [Entity, unknown[]]>> {
  for (const entity of CORE_ENTITIES) {
    if (!Array.isArray(payload[entity])) {
      throw new Error(`导入失败：data.${entity} 不是数组`)
    }
  }

  const tasks = (payload.tasks as unknown[]).map((row) =>
    normalizeTaskV3(row as LegacyV2Task),
  )

  for (const entity of CORE_ENTITIES) {
    const rows = entity === 'tasks' ? tasks : (payload[entity] as unknown[])
    validateImportRows(entity, rows)
  }
  validateTaskRelations(tasks)

  const entries: ReadonlyArray<readonly [Entity, unknown[]]> = [
    ...CORE_ENTITIES.map(
      (entity) => [entity as Entity, entity === 'tasks' ? tasks : (payload[entity] as unknown[])] as const,
    ),
    ['dailyTodos', []],
    ['journalEntries', []],
    ['pomodoroSessions', []],
  ]
  return entries
}

/**
 * v1 path: validate array presence, transform through `migrateLegacyRows`, then
 * validate the TRANSFORMED v2 rows before writing. The transform must run
 * before validation because legacy rows legitimately carry `description`,
 * `completed`, `completed_at`, and `goal_id`, which are unknown to the v2
 * allowlists. `reviews` is intentionally ignored.
 */
async function prepareLegacyVersion(
  payload: Record<string, unknown>,
): Promise<ReadonlyArray<readonly [Entity, unknown[]]>> {
  for (const entity of LEGACY_ENTITIES) {
    if (!Array.isArray(payload[entity])) {
      throw new Error(`导入失败：data.${entity} 不是数组`)
    }
  }

  const next = migrateLegacyRows({
    goals: payload.goals as LegacyGoal[],
    milestones: payload.milestones as LegacyMilestone[],
    tasks: payload.tasks as LegacyTask[],
  })

  validateImportRows('categories', next.categories)
  validateImportRows('goals', next.goals)
  validateImportRows('milestones', next.milestones)
  // The new leaf level starts empty (D-02).
  validateImportRows('tasks', [])

  const entries: ReadonlyArray<readonly [Entity, unknown[]]> = [
    ['categories', next.categories],
    ['goals', next.goals],
    ['milestones', next.milestones],
    ['tasks', []],
    ['dailyTodos', []],
    ['journalEntries', []],
    ['pomodoroSessions', []],
  ]
  return entries
}
