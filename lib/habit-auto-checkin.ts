// Phase 22 / D-03..D-06 — the single reusable auto check-in primitive.
//
// Every trigger (checkbox toggle, addProgress, pomodoro settlement) calls this
// entry point; no trigger re-implements goal→habit resolution, the day boundary,
// idempotent upsert, or note appending. It is repository-injected on purpose so
// the risky write semantics live in one tested module rather than in the UI.
//
// Semantics locked by 22-CONTEXT.md:
//  - D-04: idempotent + append. One completion per (habit, logical day); a later
//    trigger keeps the row and appends the new note with a newline.
//  - D-05: an explicit note (pomodoro session notes) wins; otherwise the note is
//    the event description like `完成《读第3章》`.
//  - D-06: never undo. Withdrawing the source action does not delete/uncheck the
//    completion — this module has no delete path at all.
//
// No React, no direct Dexie import. `getRepository()` is only reached inside the
// async body (never at module scope) so Node prerender never touches IndexedDB.

import { habitCompletionId } from '@/lib/habit'
import { mergeHabitNote } from '@/lib/pomodoro'
import { getRepository } from '@/lib/repository-provider'
import { dayKey, getDayOffsetHours } from '@/lib/today'
import type { Repository } from '@/lib/repository'
import type { Goal, Habit, HabitCompletion, Milestone, Task } from '@/lib/types'

/** Which task mutation produced the check-in. */
export type TaskEventKind = 'complete' | 'progress'

/** Context for the default human-readable event description (D-05 fallback). */
export interface TaskEventContext {
  goalName: string
  /** Milestone name; null for a direct (goal-scoped) task. */
  milestoneName: string | null
  /** Container-task names between the milestone and the task, top-down (e.g. 部). T20. */
  ancestorNames?: string[]
  taskName: string
  kind: TaskEventKind
  /** Quantity progress range (before→after); present only for kind='progress'. */
  startValue?: number | null
  endValue?: number | null
  unit?: string | null
}

/** Human-readable event description used when no explicit note is supplied. */
export function describeTaskEvent(ctx: TaskEventContext): string {
  // T20: the full path 目标 → 里程碑 → 容器任务(部) → 任务, so a habit-note or
  // calendar line always reads as a complete address. Range suffix only for
  // progress events.
  const parts: string[] = [ctx.goalName]
  if (ctx.milestoneName) parts.push(ctx.milestoneName)
  parts.push(...(ctx.ancestorNames ?? []))
  parts.push(ctx.taskName)
  if (ctx.kind === 'progress' && ctx.startValue != null && ctx.endValue != null) {
    parts.push(`${ctx.startValue}-${ctx.endValue}${ctx.unit ?? ''}`)
  }
  return parts.join(', ')
}

export interface AutoCheckinOptions {
  /** The task whose Goal owns the habit. */
  task: Task
  /** `complete` for a checkbox tick, `progress` for a quantity increment. */
  kind: TaskEventKind
  /** Explicit note (e.g. the pomodoro session notes). Falls back to the event
   *  description when absent or blank (D-05). */
  note?: string | null
  /** Increment amount for quantity progress; derives the start→end range. */
  amount?: number
  /** Commit instant; also the completion's `completed_at` on first write. */
  nowIso: string
  /** DAY_OFFSET hours for the logical day; defaults to the stored setting. */
  offsetHours?: number
  /** Injected for tests; production callers omit it (resolved lazily). */
  repo?: Repository
}

/**
 * Locate the Goal that owns a task: direct tasks carry `goal_id`, milestone
 * tasks resolve through `Milestone.goal_id`. Tombstoned/missing rows yield null
 * so a check-in is never written against a deleted Goal.
 */
async function resolveTaskGoal(
  repo: Repository,
  task: Task,
): Promise<Goal | null> {
  const goals = await repo.list<Goal>('goals')

  if (task.goal_id != null) {
    return goals.find((goal) => goal.id === task.goal_id && goal.deleted_at == null) ?? null
  }

  if (task.milestone_id != null) {
    const milestones = await repo.list<Milestone>('milestones')
    const milestone = milestones.find(
      (row) => row.id === task.milestone_id && row.deleted_at == null,
    )
    if (!milestone) return null
    return goals.find((goal) => goal.id === milestone.goal_id && goal.deleted_at == null) ?? null
  }

  return null
}

/** Milestone name for a milestone-scoped task; null for a direct task. */
async function resolveTaskMilestoneName(
  repo: Repository,
  task: Task,
): Promise<string | null> {
  if (task.milestone_id == null) return null
  const milestones = await repo.list<Milestone>('milestones')
  const milestone = milestones.find(
    (row) => row.id === task.milestone_id && row.deleted_at == null,
  )
  return milestone?.name ?? null
}

/**
 * Names of the task's container ancestors (top-down, e.g. 部), for the T20
 * full-path event line. Cycle/orphan-safe; capped at 8 levels.
 */
async function resolveTaskAncestorNames(
  repo: Repository,
  task: Task,
): Promise<string[]> {
  const tasks = await repo.list<Task>('tasks')
  const byId = new Map(tasks.map((row) => [row.id, row]))
  const names: string[] = []
  let cursor = task.parent_id
  let guard = 0
  while (cursor != null && guard < 8) {
    const parent = byId.get(cursor)
    if (!parent || parent.deleted_at != null) break
    names.unshift(parent.name)
    cursor = parent.parent_id
    guard += 1
  }
  return names
}

/**
 * Auto check-in the habit linked to a task's Goal for the task's logical day.
 *
 * Returns the habit id that was written, or null when nothing was written:
 *  - no goal / no `goal_id` on the goal (D-01) → null
 *  - habit missing or archived → null (never create an orphan completion)
 *
 * Writes exactly one HabitCompletion at the deterministic
 * `habitCompletionId(habitId, date)`. On a repeat trigger the existing row (and
 * its `completed_at`) is preserved and the new note is appended. A tombstoned
 * row at the same id is revived with `deleted_at: null` rather than duplicated.
 * The note is never deleted or cleared (D-06).
 */
export async function autoCheckinForTask(
  options: AutoCheckinOptions,
): Promise<string | null> {
  // Repository is resolved lazily so module import stays side-effect free.
  const repo = options.repo ?? getRepository()
  const { task } = options

  // 1. Resolve Goal → habit_id (D-01). Any gap is a silent no-op.
  const goal = await resolveTaskGoal(repo, task)
  if (!goal) return null

  const habitId = goal.habit_id ?? null
  if (habitId == null || habitId === '') return null

  // 2. The habit must be live. Archived/missing habits no-op (D-01 / T-22-06):
  //    writing here would leave a dangling completion for a habit the UI cannot
  //    render and the user cannot uncheck.
  const habits = await repo.list<Habit>('habits')
  const habit = habits.find((row) => row.id === habitId && row.deleted_at == null)
  if (!habit) return null

  // 3. Deterministic logical day so every trigger on the same day targets one row.
  const date = dayKey(options.nowIso, options.offsetHours ?? getDayOffsetHours())
  const id = habitCompletionId(habitId, date)

  // 4. Read tombstone-inclusive: a previously deleted row is revived, not duplicated.
  const completions = await repo.list<HabitCompletion>('habitCompletions', {
    includeDeleted: true,
  })
  const existing = completions.find((row) => row.id === id) ?? null

  // 5. D-05: explicit note wins; otherwise the event description. A blank
  //    explicit note is treated as absent.
  const explicitNote = options.note
  const milestoneName = await resolveTaskMilestoneName(repo, task)
  const ancestorNames = await resolveTaskAncestorNames(repo, task)
  const hasRange = options.kind === 'progress' && options.amount != null
  const addition =
    explicitNote != null && explicitNote.trim() !== ''
      ? explicitNote
      : describeTaskEvent({
          goalName: goal.name,
          milestoneName,
          ancestorNames,
          taskName: task.name,
          kind: options.kind,
          startValue: hasRange
            ? (task.current_value ?? 0) - (options.amount ?? 0)
            : null,
          endValue: hasRange ? (task.current_value ?? 0) : null,
          unit: task.unit,
        })

  // 6. D-04: append, never overwrite. mergeHabitNote is idempotent, so a retried
  //    trigger cannot duplicate the same line.
  const note = mergeHabitNote(existing?.note ?? null, [addition])

  // 7. Upsert. `completed_at` is preserved across repeat triggers so a later
  //    note edit does not rewrite the original check time. Explicit
  //    `deleted_at: null` revives a tombstoned row (mirrors pomodoro settlement).
  await repo.upsert<HabitCompletion>('habitCompletions', {
    id,
    habit_id: habitId,
    date,
    note,
    completed_at: existing?.completed_at ?? options.nowIso,
    deleted_at: null,
  })

  return habitId
}
