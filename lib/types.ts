// Sync-ready metadata shared by every Orbit entity (D-02).
// updated_at is stamped client-side on every write; deleted_at is the
// soft-delete tombstone — null means the row is live.
export interface SyncMeta {
  id: string // client-generated UUID (crypto.randomUUID) at insert time
  updated_at: string // ISO 8601
  deleted_at: string | null // ISO 8601 tombstone; null = live
}

// Root of the four-level hierarchy (D-01): Category → Goal → Milestone → Task.
// Categories carry the full management set (create/rename/archive/reorder).
export interface Category extends SyncMeta {
  name: string
  created_at: string
  // Manual display order (D-05). Required for all writes; legacy rows may lack
  // it at runtime and sort by created_at via effectiveOrder().
  sort_order: number
}

// Second level. A goal belongs to exactly one category.
export interface Goal extends SyncMeta {
  category_id: string
  name: string
  created_at: string
  // Manual display order. Required for all writes; legacy rows may lack it at
  // runtime and sort by created_at via effectiveOrder().
  sort_order: number
  // Nullable 1:1 link to a Habit (Phase 22 / D-01). Optional so pre-Phase-22
  // rows and legacy exports remain valid without the field. Not unique (D-02 —
  // the same habit may belong to multiple goals; auto check-in is idempotent).
  // Dexie/web runtime only: it rides the whole-row JSON store, so no version
  // bump is needed. The dormant SQLite path has no matching column and will
  // drop this field on restore — a recorded limitation, not a migration target.
  habit_id?: string | null
}

// Third level. A milestone belongs to exactly one goal.
export interface Milestone extends SyncMeta {
  goal_id: string
  name: string
  created_at: string
  // Manual display order. Required for all writes; legacy rows may lack it at
  // runtime and sort by created_at via effectiveOrder().
  sort_order: number
}

// How a leaf task reports progress (D-02). `checkbox` flips a boolean;
// `quantity` accumulates current_value toward target_value in `unit`s.
export type TaskProgressType = 'checkbox' | 'quantity'

// Leaf level — the only checkable row (D-01/D-02/D-04). A task either hangs
// under a milestone (milestone_id set) or sits directly under a goal
// (milestone_id null = direct task). Container tasks (ones with children) have
// no manual completion; their progress is derived from descendants.
export interface Task extends SyncMeta {
  // null = 目标下的直接任务 (D-01); non-null = 里程碑任务.
  milestone_id: string | null
  // Only set on direct tasks (goal-scoped). Milestone tasks are owned through
  // milestone_id → Milestone.goal_id instead (A1).
  goal_id: string | null
  // Parent task id for the sub-task tree (null = top-level in its scope).
  parent_id: string | null
  name: string
  // Leaf progress mode (D-02). Defaults to 'checkbox' on migration.
  progress_type: TaskProgressType
  // Quantity mode only: display unit (e.g. 页) and the target/current amounts.
  unit: string | null
  target_value: number | null
  current_value: number | null
  // Checkbox mode only: manual completion flag (quantity mode derives
  // completion from current_value >= target_value and leaves this false).
  completed: boolean
  completed_at: string | null
  created_at: string
  // Manual display order. Required for all writes; legacy rows may lack it at
  // runtime and sort by created_at via effectiveOrder().
  sort_order: number
}

// Phase 19 / D-02 — a superseded journal body kept when two devices wrote the
// same day. Rides the whole-row JSON so it syncs with zero registry change.
export interface JournalConflictCopy {
  // The older body, verbatim.
  content: string
  // ISO timestamp of that older body's write (the row's updated_at at the time).
  at: string
  // Writer of the older body, if known.
  device_id: string | null
}

// Daily layer (Phase 10, D-01/D-02/D-04). One plain-text journal entry per
// logical local day. `journalEntries` is a daily-layer entity independent of the
// four-level hierarchy: it hangs beside it, never inside it. `day_key` uses the
// SAME day boundary getTodayStr/dayKey use, so "按日期归档" matches 今天 exactly.
//
// The storage layer enforces one row per day (Dexie `&day_key`, SQLite UNIQUE),
// so a day has at most one row no matter how many times it is saved.
export interface JournalEntry extends SyncMeta {
  // YYYY-MM-DD logical local day (dayKey output); unique.
  day_key: string
  // Plain text; newlines preserved; may be the empty string, never null.
  content: string
  // Phase 19 / D-02 — bodies superseded by a merge. Optional: legacy rows lack
  // it, and it is validated as an import-only field so it never reaches SQL.
  conflict_copies?: JournalConflictCopy[]
}

// Daily layer (Phase 12, HABIT-01). A habit is a repeating daily action the
// user checks off; it lives beside the four-level hierarchy and the other daily
// entities, never inside them. There is intentionally no `created_at`: a
// habit-specific ordering helper (sortHabits) uses sort_order, matching the
// diary-web habit shape (RESEARCH A7).
export interface Habit extends SyncMeta {
  name: string
  // Compact label for narrow calendar/grid columns (e.g. 跑步 for 每天跑步).
  short_name: string
  // Manual display order; rewritten 0..n-1 on reorder.
  sort_order: number
}

// Daily layer (Phase 12, HABIT-02). One completion row per habit per logical
// local day. The natural key is (habit_id, date); uniqueness is enforced
// LIVE-ONLY by validateHabitCompletionRelations, so a tombstone may duplicate a
// live key and re-checking reuses the same row (RESEARCH A4).
export interface HabitCompletion extends SyncMeta {
  // References a Habit.id. Not required to resolve during import — archived /
  // hard-deleted habits legitimately leave dangling completions (A5).
  habit_id: string
  // YYYY-MM-DD logical local day, produced by getTodayStr (same boundary as
  // journalEntries.day_key).
  date: string
  // Optional free-text note; the key must be present, the value may be null.
  note: string | null
  // ISO instant the check happened; required and separate from updated_at so a
  // later note edit does not overwrite the tap time (A3).
  completed_at: string
}

// Daily layer (Phase 13, POMODORO-01). One completed focus record. Existence
// means completion: there is intentionally NO `completed` boolean and no
// half-finished session is ever persisted (running timers live in memory only).
export interface PomodoroSession extends SyncMeta {
  // ISO 8601 instant focus started.
  started_at: string
  // Actual seconds focused. The mode is DERIVED at read time (< 16*60 = 圣女果);
  // it is never stored, matching diary-web (D-02).
  duration_sec: number
  // Multi-line notes. Empty array = no notes.
  notes: string[]
  // Linked habit; may coexist with a task/dailyTodo association (D-04).
  habit_id: string | null
  // Linked live leaf Task id. XOR with daily_todo_id (both never non-null).
  task_id: string | null
  // Phase 24+ multi-task: the full set of linked live leaf task ids. Import-only
  // (rides the whole-row JSON; the dormant SQLite path drops it). Optional so
  // legacy single-task rows remain valid; task_id is kept for backward compat.
  task_ids?: string[]
  // Linked standalone DailyTodo id. XOR with task_id.
  daily_todo_id: string | null
  // Whether the summary sheet marked the target complete this session; decoupled
  // from Task.completed. true requires task_id or daily_todo_id to be set.
  marked_task_complete: boolean
  // Quantity-leaf increment recorded for this session; null = no quantity progress.
  progress_amount: number | null
  // Indices into `notes` that were already shared to the linked habit.
  shared_indices: number[]
}

// Daily layer (Phase 9, D-01/D-04). One polymorphic membership row per entry in
// 今天 — it lives beside the four-level hierarchy, never inside it.
//
//   task_id === null  => independent lightweight todo that owns `name` + `completed`
//   task_id !== null  => "this leaf task is in 今天"; content derives from Task
export interface DailyTodo extends SyncMeta {
  // null = independent todo; non-null = this leaf task is in 今天 and its
  // content (name/completion/quantity) is read from Task at render time.
  task_id: string | null
  // Standalone only. null on linked rows (the name comes from Task.name).
  name: string | null
  // Standalone only. null on linked rows (completion derives from Task), so
  // there is exactly one source of truth for linked completion.
  completed: boolean | null
  completed_at: string | null
  // ISO instant this row entered 今天 — drives the relative-age badge and the
  // list order. Never mutated after insert; remove + re-add creates a new row.
  added_at: string
  // T28: manual group order in the 今日 长期计划 card. All rows linked from
  // the same goal share one value (the group's rank is the members' MIN).
  // Null/absent = never manually ordered (legacy behavior). Import-only shape:
  // rides the whole-row JSON (Dexie + sync payload); the dormant SQLite path
  // drops it, same precedent as goals.habit_id / pomodoroSessions.task_ids.
  sort_order?: number | null
}
