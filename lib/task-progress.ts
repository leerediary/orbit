import { autoCheckinForTask } from '@/lib/habit-auto-checkin'
import type { Repository } from '@/lib/repository'
import { getRepository } from '@/lib/repository-provider'
import type { Task } from '@/lib/types'
import { getDayOffsetHours } from '@/lib/today'

/**
 * Reusable progress-increment primitive (D-04 HARD CONSTRAINT).
 *
 * This is a standalone lib function on purpose: it must NEVER be buried inside
 * a goal-detail UI component. Future 今日待办 / 番茄钟 surfaces backfill progress
 * by calling this exact entry point, so the increment semantics stay in one
 * place. `note` is an optional explicit note (Phase 22 / D-05 — a pomodoro
 * session note); it is forwarded to the goal-inherited habit check-in.
 *
 * Every successful increment is also the single quantity trigger for the
 * goal's auto check-in (Phase 22 / D-03): the helper runs AFTER the task write
 * and its failure is swallowed, so a check-in problem can never block progress.
 *
 * Client-only by construction: the repository is touched inside the async body,
 * never at module scope or during render (Node prerender has no IndexedDB).
 */

/**
 * Add `amount` to a quantity task's `current_value` and persist it.
 *
 * Rejects:
 *  - a non-finite or non-positive `amount` (T-08-09 tamper guard)
 *  - a task that does not exist
 *  - a task whose `progress_type` is not `quantity`
 *
 * Returns the updated task (the caller may keep it for optimistic state).
 */
export async function addProgress(
  taskId: string,
  amount: number,
  note?: string,
  repo: Repository = getRepository(),
): Promise<Task> {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('增加量必须大于 0')
  }

  const tasks = await repo.list<Task>('tasks')
  const task = tasks.find((t) => t.id === taskId)
  if (!task) throw new Error('任务不存在')

  // Read-site fallback mirrors effectiveOrder's legacy-row tolerance.
  if ((task.progress_type ?? 'checkbox') !== 'quantity') {
    throw new Error('该任务不是数量型任务')
  }

  // One commit instant for both the completion stamp and the check-in's
  // logical day, so a target-crossing increment and its check-in agree.
  const commitIso = new Date().toISOString()
  const current = (task.current_value ?? 0) + amount
  const next: Task = { ...task, current_value: current }

  // Stamp completion whenever a write lands at/above target and no stamp
  // exists yet — parity with checkbox tasks (togglePayload stamps), and it
  // retro-heals legacy quantity completions that reached target before the
  // stamp logic existed (T21: they would otherwise never roll off 今日).
  const target = task.target_value
  if (target != null && current >= target && next.completed_at == null) {
    next.completed_at = commitIso
  }

  await repo.upsert<Task>('tasks', next)

  // D-03 quantity trigger: the goal-inherited habit is checked once per day
  // (idempotent, appending). Best effort — a habit write must never fail the
  // progress write (T-22-12).
  try {
    await autoCheckinForTask({
      task: next,
      kind: 'progress',
      note: note ?? null,
      amount,
      nowIso: commitIso,
      offsetHours: getDayOffsetHours(),
      repo,
    })
  } catch {
    // best effort: auto check-in must never fail the progress write
  }

  return next
}
