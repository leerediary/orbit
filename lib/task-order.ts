import { nextSortOrder, sortByEffectiveOrder } from '@/lib/goal-order'
import type { Task } from '@/lib/types'

/**
 * Pure task helpers for the Phase 3 hierarchy (03-03). Mirrors lib/goal-order.ts:
 * no React, no repository, no browser globals — unit-testable in isolation.
 *
 * Grouping is the single place orphan defense lives (TASK-02): a live task whose
 * `milestone_id` is null OR is not among the containing goal's live milestone
 * ids renders in the direct-tasks bucket. It is never dropped or hidden.
 */

export interface GroupedTasks {
  direct: Task[]
  byMilestone: Map<string, Task[]>
}

/**
 * Group live tasks into the direct bucket and per-milestone buckets, sorted
 * ascending by effective order (sort_order, else created_at).
 *
 * @param tasks live tasks of ONE goal (the caller filters `goal_id` + tombstones).
 * @param liveMilestoneIds ids of that goal's live milestones; anything else is an
 *   orphan and falls back to the direct bucket.
 */
export function groupTasks(
  tasks: readonly Task[],
  liveMilestoneIds: ReadonlySet<string>,
): GroupedTasks {
  const direct: Task[] = []
  const byMilestone = new Map<string, Task[]>()

  for (const task of tasks) {
    if (task.milestone_id !== null && liveMilestoneIds.has(task.milestone_id)) {
      const bucket = byMilestone.get(task.milestone_id)
      if (bucket) bucket.push(task)
      else byMilestone.set(task.milestone_id, [task])
    } else {
      direct.push(task)
    }
  }

  // Every bucket (including direct) is sorted so the stored order survives reload.
  for (const [id, bucket] of byMilestone) {
    byMilestone.set(id, sortByEffectiveOrder(bucket))
  }

  return { direct: sortByEffectiveOrder(direct), byMilestone }
}

/**
 * Toggle payload for TASK-01. Completing stamps `completed_at`; uncompleting
 * clears it. `now` is injectable so tests never depend on the wall clock.
 */
export function togglePayload(
  task: Task,
  now: string = new Date().toISOString(),
): { completed: boolean; completed_at: string | null } {
  const completed = !task.completed
  return { completed, completed_at: completed ? now : null }
}

/**
 * Re-parent ordering for delete-milestone (TASK-02). The base is computed ONCE
 * from the destination siblings, then each moved task gets `base + index` so
 * every moved task receives a DISTINCT sort_order (computing nextSortOrder per
 * task against one pre-write list would give them all the same value).
 *
 * @param directSiblings destination siblings, live + tombstoned (for append order).
 * @param movedTasks already sorted by effective order (their current visual order).
 */
export function reparentOrder(
  directSiblings: readonly Task[],
  movedTasks: readonly Task[],
): Array<{ id: string; sort_order: number }> {
  const base = nextSortOrder(directSiblings)
  return movedTasks.map((task, index) => ({ id: task.id, sort_order: base + index }))
}
