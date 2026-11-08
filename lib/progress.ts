import type { Task } from '@/lib/types'
import { leafFraction, reachableLeaves } from '@/lib/task-tree'

/**
 * Pure progress derivation (PROG-01 / D-03). Mirrors lib/task-tree.ts and
 * lib/task-order.ts: no React, no repository, no browser globals — unit-testable
 * in isolation.
 *
 * Progress is computed, never stored (D-06). The input is the live task set the
 * caller already filtered; tombstones are excluded by the repository's default
 * list() and the callers' defensive filters (D-07).
 *
 * LEAF-AWARE (Phase 8): only leaves contribute, and each contributes its
 * `leafFraction` (checkbox → 0/1, quantity → min(current/target, 1)).
 * `TaskProgress.completed` is therefore a FLOAT; `total` is the integer leaf
 * count. Container tasks are never counted.
 */

export interface TaskProgress {
  completed: number
  total: number
}

/**
 * `leafFraction` is DEFINED in lib/task-tree.ts (so task-tree never imports
 * progress) and re-exported here to preserve the public import contract.
 */
export { leafFraction }

/**
 * Sum the leaf fractions vs the leaf count over the live tasks the caller
 * already filtered. Direct tasks (milestone_id null) are leaves in their own
 * scope; sub-task containers are not leaves.
 */
export function progressOf(tasks: readonly Task[]): TaskProgress {
  const leaves = reachableLeaves(tasks)
  let completed = 0
  for (const leaf of leaves) completed += leafFraction(leaf)
  return { completed, total: leaves.length }
}
