import type { Task } from '@/lib/types'

/**
 * Pure progress derivation for Phase 4 (PROG-01). Mirrors lib/task-order.ts:
 * no React, no repository, no browser globals — unit-testable in isolation.
 *
 * Progress is computed, never stored (D-06). `Task.completed` over the live
 * tasks the caller already filtered is the only input; tombstones are excluded
 * by the repository's default list() and the callers' defensive filters (D-07).
 */

export interface TaskProgress {
  completed: number
  total: number
}

/**
 * Count completed vs total over the live tasks the caller already filtered.
 * `completed` counts task.completed === true; `total` counts every entry.
 */
export function progressOf(tasks: readonly Task[]): TaskProgress {
  let completed = 0
  for (const task of tasks) {
    if (task.completed) completed += 1
  }
  return { completed, total: tasks.length }
}
