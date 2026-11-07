import type { TaskProgress } from '@/lib/progress'
import { leafFraction, reachableLeaves } from '@/lib/task-tree'
import type { Goal, Milestone, Task } from '@/lib/types'

/**
 * Pure progress rollup (D-03 / D-04 / REST-04). Mirrors lib/progress.ts and
 * lib/task-tree.ts: no React, no repository, no browser globals — unit-testable
 * in isolation.
 *
 * Progress is derived, never stored. Callers pass LIVE rows; tombstone
 * exclusion stays with the repository defaults + callers' defensive filters.
 *
 * LEAF-AWARE (Phase 8): every reachable leaf contributes its `leafFraction` to
 * its owning milestone → goal → category, and to the direct-task goal →
 * category path when it hangs under a goal (milestone_id null). Containers and
 * orphans contribute nothing. `TaskProgress.completed` is a FLOAT.
 */
export function rollupProgress(
  tasks: readonly Task[],
  milestones: readonly Milestone[],
  goals: readonly Goal[],
): {
  milestone: Map<string, TaskProgress>
  goal: Map<string, TaskProgress>
  category: Map<string, TaskProgress>
} {
  const milestoneGoal = new Map(milestones.map((m) => [m.id, m.goal_id]))
  const goalCategory = new Map(goals.map((g) => [g.id, g.category_id]))

  const milestone = new Map<string, TaskProgress>()
  const goal = new Map<string, TaskProgress>()
  const category = new Map<string, TaskProgress>()

  const bump = (map: Map<string, TaskProgress>, id: string, fraction: number) => {
    const current = map.get(id) ?? { completed: 0, total: 0 }
    current.total += 1
    // Fraction, not boolean: quantity leaves contribute a partial 0..1 value.
    current.completed += fraction
    map.set(id, current)
  }

  for (const leaf of reachableLeaves(tasks)) {
    const fraction = leafFraction(leaf)

    if (leaf.milestone_id != null) {
      const goalId = milestoneGoal.get(leaf.milestone_id)
      // Orphan defense: no live milestone means nothing to roll up to.
      if (goalId === undefined) continue

      bump(milestone, leaf.milestone_id, fraction)
      bump(goal, goalId, fraction)
      const categoryId = goalCategory.get(goalId)
      if (categoryId !== undefined) bump(category, categoryId, fraction)
      continue
    }

    // Direct task (D-01): needs a live goal to attribute to.
    if (leaf.goal_id == null) continue
    const goalId = leaf.goal_id
    const categoryId = goalCategory.get(goalId)
    if (categoryId === undefined) continue

    bump(goal, goalId, fraction)
    bump(category, categoryId, fraction)
  }

  return { milestone, goal, category }
}
