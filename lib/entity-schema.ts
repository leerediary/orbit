import type { Entity } from '@/lib/repository'
import type { DailyTodo, HabitCompletion, JournalEntry, PomodoroSession, Task } from '@/lib/types'
import { isValidDayKey } from '@/lib/journal'

/**
 * Single source of truth for the shape of every synchronized entity.
 *
 * Two consumers:
 *  - `importData()` uses it to validate every incoming row BEFORE any write, so
 *    a malformed export can never overwrite good rows with partial ones.
 *  - `SqliteLocalRepository` uses `ENTITY_COLUMNS` as a strict allowlist before
 *    interpolating column names into SQL (values are always parameterized).
 *
 * Keep this aligned with lib/types.ts — a drift here is a data-loss bug, not a
 * cosmetic one.
 */

type ColumnKind =
  | 'string'
  | 'nullableString'
  | 'timestamp'
  | 'boolean'
  | 'nullableBoolean'
  | 'nullableTimestamp'
  | 'number'
  | 'nullableNumber'
  | 'progressType'
  | 'stringArray'
  | 'numberArray'
  | 'conflictCopyArray'

const SHAPES: Record<Entity, Readonly<Record<string, ColumnKind>>> = {
  categories: {
    id: 'string',
    name: 'string',
    created_at: 'timestamp',
    sort_order: 'number',
    updated_at: 'timestamp',
    deleted_at: 'nullableTimestamp',
  },
  goals: {
    id: 'string',
    category_id: 'string',
    name: 'string',
    created_at: 'timestamp',
    sort_order: 'number',
    updated_at: 'timestamp',
    deleted_at: 'nullableTimestamp',
  },
  milestones: {
    id: 'string',
    goal_id: 'string',
    name: 'string',
    created_at: 'timestamp',
    sort_order: 'number',
    updated_at: 'timestamp',
    deleted_at: 'nullableTimestamp',
  },
  tasks: {
    id: 'string',
    milestone_id: 'nullableString',
    goal_id: 'nullableString',
    parent_id: 'nullableString',
    name: 'string',
    progress_type: 'progressType',
    completed: 'boolean',
    completed_at: 'nullableTimestamp',
    unit: 'nullableString',
    target_value: 'nullableNumber',
    current_value: 'nullableNumber',
    created_at: 'timestamp',
    sort_order: 'number',
    updated_at: 'timestamp',
    deleted_at: 'nullableTimestamp',
  },
  dailyTodos: {
    id: 'string',
    task_id: 'nullableString',
    name: 'nullableString',
    completed: 'nullableBoolean',
    completed_at: 'nullableTimestamp',
    added_at: 'timestamp',
    updated_at: 'timestamp',
    deleted_at: 'nullableTimestamp',
  },
  journalEntries: {
    id: 'string',
    day_key: 'string',
    content: 'string',
    updated_at: 'timestamp',
    deleted_at: 'nullableTimestamp',
  },
  habits: {
    id: 'string',
    name: 'string',
    short_name: 'string',
    sort_order: 'number',
    updated_at: 'timestamp',
    deleted_at: 'nullableTimestamp',
  },
  habitCompletions: {
    id: 'string',
    habit_id: 'string',
    // `date` is a plain string here; the relation validator enforces the
    // YYYY-MM-DD calendar-day shape (RESEARCH A2).
    date: 'string',
    note: 'nullableString',
    completed_at: 'timestamp',
    updated_at: 'timestamp',
    deleted_at: 'nullableTimestamp',
  },
  // Phase 13. Notes / shared_indices are the first ARRAY columns; they are
  // validated element-by-element here and JSON-encoded on the SQLite path.
  pomodoroSessions: {
    id: 'string',
    started_at: 'timestamp',
    duration_sec: 'number',
    notes: 'stringArray',
    habit_id: 'nullableString',
    task_id: 'nullableString',
    daily_todo_id: 'nullableString',
    marked_task_complete: 'boolean',
    progress_amount: 'nullableNumber',
    shared_indices: 'numberArray',
    updated_at: 'timestamp',
    deleted_at: 'nullableTimestamp',
  },
}

/** Column allowlist per entity — the only keys allowed to reach SQL. */
export const ENTITY_COLUMNS: Record<Entity, readonly string[]> = {
  categories: Object.keys(SHAPES.categories),
  goals: Object.keys(SHAPES.goals),
  milestones: Object.keys(SHAPES.milestones),
  tasks: Object.keys(SHAPES.tasks),
  dailyTodos: Object.keys(SHAPES.dailyTodos),
  journalEntries: Object.keys(SHAPES.journalEntries),
  habits: Object.keys(SHAPES.habits),
  habitCompletions: Object.keys(SHAPES.habitCompletions),
  pomodoroSessions: Object.keys(SHAPES.pomodoroSessions),
}

// Identity / foreign-key columns that must not be empty strings.
const NON_EMPTY: Record<Entity, readonly string[]> = {
  categories: ['id'],
  goals: ['id', 'category_id'],
  milestones: ['id', 'goal_id'],
  // milestone_id is nullable now (null = direct task), so it left this list.
  tasks: ['id'],
  dailyTodos: ['id'],
  // `content` may legitimately be empty (a cleared day), so it is not NON_EMPTY.
  journalEntries: ['id', 'day_key'],
  habits: ['id', 'name'],
  habitCompletions: ['id', 'habit_id', 'date'],
  pomodoroSessions: ['id'],
}

// Columns that may be absent on legacy rows (a present value is still
// validated). `sort_order` may be missing on legacy rows; the UI's
// effectiveOrder() already falls back to created_at.
const OPTIONAL: Record<Entity, readonly string[]> = {
  categories: ['sort_order'],
  goals: ['sort_order'],
  milestones: ['sort_order'],
  tasks: ['sort_order'],
  // T28: dailyTodos.sort_order may be missing on legacy rows; the 今日 card
  // falls back to the added_at ordering for groups that have no manual rank.
  dailyTodos: ['sort_order'],
  journalEntries: [],
  // All habit fields are required.
  habits: [],
  // `note` may be null but its key must be present (nullableString).
  habitCompletions: [],
  // Every pomodoro field is required (arrays may be empty, never absent).
  pomodoroSessions: [],
}

// Import-only shape keys: accepted and validated on import (they ride the
// whole-row JSON Dexie store), but deliberately NOT part of SHAPES so they
// never enter ENTITY_COLUMNS and never reach the SQLite INSERT allowlist.
// `goals.habit_id` is the nullable habit link (Phase 22 / D-01); the dormant
// SQLite path has no such column and drops it on restore — a recorded
// limitation, not a coordinated migration.
const IMPORT_ONLY_SHAPES: Partial<Record<Entity, Readonly<Record<string, ColumnKind>>>> = {
  goals: { habit_id: 'nullableString' },
  // Phase 19 / D-02 — conflict copies ride the whole-row JSON. Validated on
  // import/push/pull but never in SHAPES/ENTITY_COLUMNS, so the SQLite path
  // never sees the column.
  journalEntries: { conflict_copies: 'conflictCopyArray' },
  // Phase 24+ multi-task association. Rides the whole-row JSON Dexie store;
  // validated on import but never in SHAPES/ENTITY_COLUMNS, so the SQLite path
  // never sees the column.
  pomodoroSessions: { task_ids: 'stringArray' },
  // T28 manual group order in the 今日 长期计划 card. Rides the whole-row JSON
  // (Dexie + sync payload); the dormant SQLite path drops it — same precedent
  // as goals.habit_id, no coordinated migration needed.
  dailyTodos: { sort_order: 'nullableNumber' },
}

const MAX_CONFLICT_COPIES = 20
const MAX_CONFLICT_COPY_BYTES = 65536
const CONFLICT_COPY_KEYS = ['content', 'at', 'device_id'] as const

function fail(message: string): never {
  throw new Error(`导入失败：${message}`)
}

/** Validate one value against its declared ColumnKind. Throws via fail(). */
function assertKind(kind: ColumnKind, value: unknown, where: string, key: string): void {
  switch (kind) {
    case 'string':
      if (typeof value !== 'string') fail(`${where}.${key} 必须是字符串`)
      break
    case 'nullableString':
      if (value !== null && typeof value !== 'string') {
        fail(`${where}.${key} 必须是 null 或字符串`)
      }
      break
    case 'timestamp':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        fail(`${where}.${key} 必须是有效的 ISO 时间戳`)
      }
      break
    case 'boolean':
      if (typeof value !== 'boolean') fail(`${where}.${key} 必须是布尔值`)
      break
    case 'nullableBoolean':
      // Daily-layer completion: null on linked rows (derived from Task), a
      // real boolean on standalone rows. Strings like 'yes' are rejected.
      if (value !== null && typeof value !== 'boolean') {
        fail(`${where}.${key} 必须是 null 或布尔值`)
      }
      break
    case 'nullableTimestamp':
      if (value !== null && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) {
        fail(`${where}.${key} 必须是 null 或有效的 ISO 时间戳`)
      }
      break
    case 'number':
      // Rejects strings, NaN, and Infinity — sort_order must be a finite
      // number so ordering comparisons stay meaningful.
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(`${where}.${key} 必须是数字`)
      }
      break
    case 'nullableNumber':
      // Quantity amounts: null or a finite number (T-08-07 — rejects NaN,
      // Infinity, and numeric strings so target/current stay comparable).
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        fail(`${where}.${key} 必须是 null 或数字`)
      }
      break
    case 'progressType':
      if (value !== 'checkbox' && value !== 'quantity') {
        fail(`${where}.${key} 必须是 checkbox 或 quantity`)
      }
      break
    case 'stringArray':
      // first-class array column: reject non-arrays and mixed element types.
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        fail(`${where}.${key} 必须是字符串数组`)
      }
      break
    case 'numberArray':
      if (
        !Array.isArray(value) ||
        !value.every((v) => typeof v === 'number' && Number.isFinite(v))
      ) {
        fail(`${where}.${key} 必须是数字数组`)
      }
      break
    case 'conflictCopyArray':
      // Phase 19 / D-02 — bounded array of { content, at, device_id } carried
      // inside the journal row JSON. Reject anything that could bloat a row past
      // the 256 KiB push cap or smuggle extra fields into the synced payload.
      if (!Array.isArray(value)) {
        fail(`${where}.${key} 必须是冲突副本数组`)
      }
      if (value.length > MAX_CONFLICT_COPIES) {
        fail(`${where}.${key} 的冲突副本不能超过 ${MAX_CONFLICT_COPIES} 条`)
      }
      for (let i = 0; i < value.length; i++) {
        const element = value[i]
        if (element === null || typeof element !== 'object' || Array.isArray(element)) {
          fail(`${where}.${key}[${i}] 必须是对象`)
        }
        const copy = element as Record<string, unknown>
        for (const copyKey of Object.keys(copy)) {
          if (!(CONFLICT_COPY_KEYS as readonly string[]).includes(copyKey)) {
            fail(`${where}.${key}[${i}] 含未知字段 "${copyKey}"`)
          }
        }
        for (const copyKey of CONFLICT_COPY_KEYS) {
          if (!Object.hasOwn(copy, copyKey)) {
            fail(`${where}.${key}[${i}] 缺少字段 "${copyKey}"`)
          }
        }
        if (typeof copy.content !== 'string') {
          fail(`${where}.${key}[${i}].content 必须是字符串`)
        }
        if (typeof copy.at !== 'string' || Number.isNaN(Date.parse(copy.at))) {
          fail(`${where}.${key}[${i}].at 必须是有效的 ISO 时间戳`)
        }
        if (copy.device_id !== null && typeof copy.device_id !== 'string') {
          fail(`${where}.${key}[${i}].device_id 必须是 null 或字符串`)
        }
      }
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_CONFLICT_COPY_BYTES) {
        fail(`${where}.${key} 的序列化大小不能超过 64 KiB`)
      }
      break
  }
}

/**
 * Validate one import row against its entity shape. Throws on the first
 * problem; returns nothing (the row is only ever read, never transformed).
 *
 * Rejected: non-objects, missing keys, unknown keys, wrong primitive types,
 * non-ISO timestamps, and empty identity columns. Timestamps are re-parsed so
 * the lexicographic `sinceUpdatedAt` comparison in list() stays meaningful.
 */
export function validateImportRow(entity: Entity, row: unknown, index: number): void {
  const where = `data.${entity}[${index}]`
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    fail(`${where} 不是对象`)
  }
  const r = row as Record<string, unknown>
  const shape = SHAPES[entity]

  // OWN-property allowlist: `in` would also accept prototype-named keys
  // (__proto__/constructor/toString) because they exist on Object.prototype.
  // Import-only keys (e.g. goals.habit_id) are likewise accepted.
  const importShape = IMPORT_ONLY_SHAPES[entity] ?? {}
  for (const key of Object.keys(r)) {
    if (!Object.hasOwn(shape, key) && !Object.hasOwn(importShape, key)) {
      fail(`${where} 含未知字段 "${key}"`)
    }
  }

  for (const key of Object.keys(shape)) {
    if (!Object.hasOwn(r, key)) {
      if (OPTIONAL[entity].includes(key)) continue
      fail(`${where} 缺少字段 "${key}"`)
    }
    assertKind(shape[key], r[key], where, key)
  }

  // Import-only keys: absent is allowed (legacy rows); a present value is
  // validated with the same primitive rules.
  for (const [key, kind] of Object.entries(importShape)) {
    if (Object.hasOwn(r, key)) assertKind(kind, r[key], where, key)
  }

  for (const key of NON_EMPTY[entity]) {
    if (r[key] === '') fail(`${where}.${key} 不能为空`)
  }
}

/** Validate every row of one entity. Throws on the first bad row. */
export function validateImportRows(entity: Entity, rows: readonly unknown[]): void {
  rows.forEach((row, index) => validateImportRow(entity, row, index))
}

/**
 * Cross-row task invariants (D-01/D-02). Runs AFTER per-row shape validation
 * and BEFORE any write, so a hand-edited backup can never introduce orphans,
 * cross-milestone parent links, cycles, over-deep trees, or bad quantity fields
 * (T-08-05).
 *
 * Rules:
 *  - a direct task (milestone_id null) must have a goal_id and no parent_id;
 *  - a milestone task (milestone_id set) must not carry a goal_id;
 *  - parent_id must reference a row in the same array and the same milestone;
 *  - the parent chain must be acyclic and at most 3 levels deep
 *    (top-level task = depth 1, so L1 → L2 → L3 is the maximum);
 *  - quantity tasks need a non-empty unit, target > 0, and current >= 0;
 *  - checkbox tasks must not carry unit/target/current.
 *
 * The depth walk uses explicit on-stack/visited marks (T-08-06), so a hostile
 * cyclic backup terminates instead of recursing forever.
 */
export function validateTaskRelations(rows: readonly unknown[]): void {
  if (rows.length === 0) return
  const tasks = rows as readonly Task[]

  const byId = new Map<string, Task>()
  for (const t of tasks) byId.set(t.id, t)

  // 1. Node-local invariants.
  for (const t of tasks) {
    const where = `任务 "${t.id}"`
    if (t.milestone_id === null) {
      // Direct tasks are goal-scoped leaves: no parent, must name a goal.
      if (t.parent_id !== null) fail(`${where} 是直接任务，不能有父任务`)
      if (t.goal_id === null || t.goal_id.trim() === '') {
        fail(`${where} 是直接任务，必须属于某个目标`)
      }
    } else if (t.goal_id !== null) {
      fail(`${where} 是里程碑任务，不能同时携带 goal_id`)
    }

    if (t.progress_type === 'quantity') {
      if (t.unit === null || t.unit.trim() === '') {
        fail(`${where} 使用数量进度，单位不能为空`)
      }
      if (t.target_value === null || t.target_value <= 0) {
        fail(`${where} 使用数量进度，目标量必须大于 0`)
      }
      if (t.current_value === null || t.current_value < 0) {
        fail(`${where} 使用数量进度，已做量不能为负`)
      }
    } else if (t.unit !== null || t.target_value !== null || t.current_value !== null) {
      fail(`${where} 使用勾选进度，不应携带单位或数量字段`)
    }
  }

  // 2. Parent existence + same-milestone scope.
  for (const t of tasks) {
    if (t.parent_id === null) continue
    const parent = byId.get(t.parent_id)
    if (!parent) fail(`任务 "${t.id}" 的父任务 "${t.parent_id}" 不存在`)
    if (parent.milestone_id !== t.milestone_id) {
      fail(`任务 "${t.id}" 与其父任务 "${parent.id}" 不属于同一里程碑`)
    }
  }

  // 3. Cycle detection + depth cap.
  const state = new Map<string, 1 | 2>() // 1 = on stack, 2 = finished
  const depth = new Map<string, number>()
  const visit = (id: string): number => {
    const s = state.get(id)
    if (s === 1) fail(`任务 "${id}" 的父子关系存在环`)
    if (s === 2) return depth.get(id)!
    state.set(id, 1)
    const t = byId.get(id)!
    const d = t.parent_id === null ? 1 : visit(t.parent_id) + 1
    if (d > 3) fail(`任务 "${id}" 超过 3 层嵌套`)
    state.set(id, 2)
    depth.set(id, d)
    return d
  }
  for (const t of tasks) visit(t.id)
}

/**
 * Cross-row daily invariants (Phase 9, D-01/D-04). Runs AFTER per-row shape
 * validation and BEFORE any write (T-09-01).
 *
 * Rules:
 *  - standalone (task_id null) owns its content: a non-empty trimmed name and a
 *    real boolean `completed` (never null);
 *  - linked (task_id set) carries NO content: name/completed/completed_at must
 *    all be null, so completion has exactly one source of truth — Task;
 *  - among live rows (deleted_at null), no two may reference the same task_id.
 *    Tombstoned duplicates are legitimate history;
 *  - task_id is NOT required to resolve to a task in the import: deleted/
 *    archived tasks legitimately leave dangling associations, and render-time
 *    orphan filtering handles them (A4).
 */
export function validateDailyTodoRelations(rows: readonly unknown[]): void {
  if (rows.length === 0) return
  const todos = rows as readonly DailyTodo[]

  // 1. Node-local invariants.
  for (const t of todos) {
    const where = `今日待办 "${t.id}"`
    if (t.task_id === null) {
      // Standalone: owns a name and a real completion boolean.
      if (typeof t.name !== 'string' || t.name.trim() === '') {
        fail(`${where} 是独立待办，名称不能为空`)
      }
      if (typeof t.completed !== 'boolean') {
        fail(`${where} 是独立待办，完成状态必须为布尔值`)
      }
    } else {
      if (typeof t.task_id !== 'string' || t.task_id.trim() === '') {
        fail(`${where} 的 task_id 不能为空`)
      }
      // Linked: never a second copy of name/completion.
      if (t.name !== null || t.completed !== null || t.completed_at !== null) {
        fail(`${where} 关联任务时不能携带名称或完成状态`)
      }
    }
  }

  // 2. Live uniqueness of task_id.
  const liveTaskIds = new Set<string>()
  for (const t of todos) {
    if (t.deleted_at != null || t.task_id === null) continue
    if (liveTaskIds.has(t.task_id)) {
      fail(`今日待办中存在重复关联的任务 "${t.task_id}"`)
    }
    liveTaskIds.add(t.task_id)
  }
}

/**
 * Cross-row journal invariants (Phase 10, D-04). Runs AFTER per-row shape
 * validation and BEFORE any write (T-10-06).
 *
 * Rules:
 *  - `day_key` must be a real calendar date in `YYYY-MM-DD` shape (an
 *    impossible date like `2026-02-30` is rejected rather than rolled over);
 *  - no two rows may share a `day_key`, including tombstoned rows. The storage
 *    layer enforces one row per day (Dexie `&day_key`, SQLite `UNIQUE`), and
 *    D-04 has no delete/re-create path, so a tombstone still occupies its day.
 *    Rejecting duplicates before any write keeps Dexie (throws) and SQLite
 *    (`INSERT OR REPLACE` overwrites) from diverging.
 */
export function validateJournalRelations(rows: readonly unknown[]): void {
  if (rows.length === 0) return
  const entries = rows as readonly JournalEntry[]

  const seenDays = new Set<string>()
  for (const e of entries) {
    if (!isValidDayKey(e.day_key)) {
      fail(`日记 "${e.id}" 的日期必须为有效的 YYYY-MM-DD`)
    }
    if (seenDays.has(e.day_key)) {
      fail(`日记中存在重复日期 "${e.day_key}"`)
    }
    seenDays.add(e.day_key)
  }
}

/**
 * Cross-row habit-completion invariants (Phase 12, HABIT-02). Runs AFTER per-row
 * shape validation and BEFORE any write (T-12-01).
 *
 * Rules:
 *  - `date` must be a real calendar date in `YYYY-MM-DD` shape (an impossible
 *    date like 2026-02-30 is rejected rather than rolled over);
 *  - among LIVE rows (deleted_at null), no two may share a (habit_id, date)
 *    pair. Tombstoned rows are legitimate history and may duplicate a live key,
 *    so re-checking can reuse the tombstoned row's id and note (RESEARCH A4);
 *  - `habit_id` is NOT required to resolve to a habit in the import: archived
 *    habits are tombstones and a hard-deleted habit leaves dangling completions
 *    (A5).
 */
export function validateHabitCompletionRelations(rows: readonly unknown[]): void {
  if (rows.length === 0) return
  const completions = rows as readonly HabitCompletion[]

  const liveKeys = new Set<string>()
  for (const c of completions) {
    if (!isValidDayKey(c.date)) {
      fail(`习惯打卡 "${c.id}" 的日期必须为有效的 YYYY-MM-DD`)
    }
    if (c.deleted_at != null) continue
    const key = `${c.habit_id}::${c.date}`
    if (liveKeys.has(key)) {
      fail(`习惯打卡中存在重复记录 "${c.habit_id}" / "${c.date}"`)
    }
    liveKeys.add(key)
  }
}

/**
 * Cross-row pomodoro invariants (Phase 13, POMODORO-03). Runs AFTER per-row
 * shape validation and BEFORE any write (T-13-01).
 *
 * Rules:
 *  - `task_id` and `daily_todo_id` identify one task source each and are XOR:
 *    never both non-null;
 *  - `marked_task_complete` requires a task or daily-todo target;
 *  - a non-null `progress_amount` must be finite and greater than 0;
 *  - every `shared_indices` entry is a non-negative integer that indexes into
 *    `notes`;
 *  - `shared_indices` may only be non-empty when a habit is linked.
 *
 * Referenced ids are NOT required to resolve in the import: archived / deleted
 * tasks and habits legitimately leave dangling references (mirrors
 * validateDailyTodoRelations and validateHabitCompletionRelations).
 */
export function validatePomodoroSessionRelations(rows: readonly unknown[]): void {
  if (rows.length === 0) return
  const sessions = rows as readonly PomodoroSession[]

  for (const s of sessions) {
    const where = `番茄记录 "${s.id}"`

    // 1. task_id XOR daily_todo_id.
    if (s.task_id !== null && s.daily_todo_id !== null) {
      fail(`${where} 不能同时关联任务和独立待办`)
    }

    // 2. Completion must name a target.
    if (s.marked_task_complete === true && s.task_id === null && s.daily_todo_id === null) {
      fail(`${where} 标记完成时必须关联任务或独立待办`)
    }

    // 3. Quantity progress must be a positive finite number.
    if (s.progress_amount !== null && (!Number.isFinite(s.progress_amount) || s.progress_amount <= 0)) {
      fail(`${where} 的推进量必须大于 0`)
    }

    // 4. Shared indices must be valid positions into notes.
    for (const index of s.shared_indices) {
      if (!Number.isInteger(index) || index < 0 || index >= s.notes.length) {
        fail(`${where} 的分发下标越界`)
      }
    }

    // 5. Sharing requires a linked habit.
    if (s.habit_id === null && s.shared_indices.length > 0) {
      fail(`${where} 未关联习惯时不能有分发笔记`)
    }
  }
}
