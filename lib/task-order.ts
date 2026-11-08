/**
 * Pure task helpers for the flexible hierarchy (D-05 / D-06). Mirrors
 * lib/goal-order.ts: no React, no repository, no browser globals —
 * unit-testable in isolation.
 *
 * Grouping/sorting moved to lib/task-tree.ts (`buildTaskTree`), which handles
 * direct tasks and the nested sub-task tree. `groupTasks` is intentionally
 * gone: with a nullable `milestone_id` its "bucket by milestone" contract no
 * longer covers the full task set.
 */

/**
 * Toggle payload for any row with a boolean `completed` — a leaf `Task` or a
 * standalone `DailyTodo`. Completing stamps `completed_at`; uncompleting clears
 * it. `now` is injectable so tests never depend on the wall clock.
 *
 * The structural parameter is a supertype of both `Task` and DailyTodo's
 * standalone shape, so existing `togglePayload(task)` call sites stay
 * source-compatible and daily callers need no cast.
 *
 * Quantity tasks derive completion from current/target, but this payload stays
 * generic: callers that allow a manual flag still get a consistent shape.
 */
export function togglePayload(
  row: { completed: boolean },
  now: string = new Date().toISOString(),
): { completed: boolean; completed_at: string | null } {
  const completed = !row.completed
  return { completed, completed_at: completed ? now : null }
}
