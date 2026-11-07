import { sortByEffectiveOrder } from '@/lib/goal-order'
import type { Task } from '@/lib/types'

/**
 * Pure task-tree helpers for the flexible hierarchy (D-01/D-02/D-03). Mirrors
 * lib/goal-order.ts and lib/progress.ts: no React, no repository, no browser
 * globals — unit-testable in isolation.
 *
 * SHARED LEAF DEFINITION (A5): the UI tree and the progress rollup MUST agree on
 * what a "leaf" is. Both go through `buildTaskTree` / `reachableLeaves`, so a
 * container task is never counted as a leaf and a task hidden by an orphaned
 * parent is never counted at all.
 *
 * `leafFraction` lives here (not in lib/progress.ts) so task-tree does not need
 * to import progress — that would create a task-tree ↔ progress cycle.
 * lib/progress.ts re-exports it to preserve the public import contract.
 */

/**
 * Completion fraction of ONE leaf task (D-02/D-03).
 *
 * checkbox → 1 when completed, else 0.
 * quantity → 0 when target <= 0; an exact 1 once current >= target (never the
 *   computed ratio, so an all-done scope cannot drift below 1.0); otherwise
 *   max(0, current / target) — the clamp guards negative recorded amounts.
 *
 * T-08-10: the target<=0 and current>=target branches are the tamper guards.
 */
export function leafFraction(task: Task): number {
  if ((task.progress_type ?? 'checkbox') === 'quantity') {
    const target = task.target_value ?? 0
    const current = task.current_value ?? 0
    if (target <= 0) return 0
    if (current >= target) return 1
    return Math.max(0, current / target)
  }
  return task.completed ? 1 : 0
}

/**
 * Build the parent → children relation for a set of live tasks.
 *
 * Orphan defense (A5): a task with a `parent_id` is attached only when its
 * parent is present AND shares the same `milestone_id`. A missing parent or a
 * cross-milestone parent means the node (and its subtree) is dropped — it has
 * no container to render under. Top-level tasks (`parent_id == null`) become
 * roots. Every bucket is sorted ascending by effective order.
 */
export function buildTaskTree(tasks: readonly Task[]): {
  roots: Task[]
  children: Map<string, Task[]>
} {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const roots: Task[] = []
  const children = new Map<string, Task[]>()

  for (const task of tasks) {
    if (task.parent_id == null) {
      roots.push(task)
      continue
    }
    const parent = byId.get(task.parent_id)
    // Orphan defense: parent must exist and share this task's milestone scope.
    if (!parent || parent.milestone_id !== task.milestone_id) continue

    const bucket = children.get(task.parent_id)
    if (bucket) bucket.push(task)
    else children.set(task.parent_id, [task])
  }

  for (const [id, bucket] of children) {
    children.set(id, sortByEffectiveOrder(bucket))
  }

  return { roots: sortByEffectiveOrder(roots), children }
}

/**
 * The leaves reachable from the tree roots.
 *
 * A container that still has reachable children is never a leaf; a node with no
 * children is a leaf. `seen` guards against cycles and shared nodes (T-08-11),
 * so a hostile cyclic graph terminates instead of looping.
 */
export function reachableLeaves(tasks: readonly Task[]): Task[] {
  const { roots, children } = buildTaskTree(tasks)
  const leaves: Task[] = []
  const seen = new Set<string>()

  const visit = (node: Task): void => {
    if (seen.has(node.id)) return
    seen.add(node.id)
    const kids = children.get(node.id)
    if (!kids || kids.length === 0) {
      leaves.push(node)
      return
    }
    for (const child of kids) visit(child)
  }

  for (const root of roots) visit(root)
  return leaves
}

/**
 * All descendant ids of `rootId` (exclusive), depth-first, cycle-safe.
 */
export function descendantIds(
  rootId: string,
  children: ReadonlyMap<string, readonly Task[]>,
): string[] {
  const result: string[] = []
  const seen = new Set<string>([rootId])

  const walk = (id: string): void => {
    for (const child of children.get(id) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      result.push(child.id)
      walk(child.id)
    }
  }

  walk(rootId)
  return result
}

/**
 * Depth of a task in the hierarchy. A milestone-level top task is depth 1, its
 * child 2, and so on. Walks `parent_id` upward with a `seen` guard.
 */
export function taskDepth(task: Task, byId: ReadonlyMap<string, Task>): number {
  let depth = 1
  const seen = new Set<string>([task.id])
  let parentId = task.parent_id

  while (parentId != null) {
    const parent = byId.get(parentId)
    if (!parent || seen.has(parent.id)) break
    seen.add(parent.id)
    depth += 1
    parentId = parent.parent_id
  }

  return depth
}

/**
 * Aggregate leaf fractions over the descendants of one container.
 *
 * Counts only reachable leaves strictly below `rootId` (the container itself is
 * never a leaf). Cycle-safe via `seen`.
 */
export function subtreeProgress(
  rootId: string,
  children: ReadonlyMap<string, readonly Task[]>,
): { completed: number; total: number } {
  let completed = 0
  let total = 0
  const seen = new Set<string>([rootId])
  const stack: Task[] = [...(children.get(rootId) ?? [])]

  while (stack.length > 0) {
    const node = stack.pop() as Task
    if (seen.has(node.id)) continue
    seen.add(node.id)

    const kids = children.get(node.id)
    if (!kids || kids.length === 0) {
      completed += leafFraction(node)
      total += 1
    } else {
      stack.push(...kids)
    }
  }

  return { completed, total }
}
