import { buildTaskTree, reachableLeaves } from '@/lib/task-tree'
import { dayKey } from '@/lib/today'
import type { DailyTodo, Goal, Milestone, Task } from '@/lib/types'

/**
 * Pure aggregation helpers for the 今日 view (Phase 9, DAILY-01/02).
 *
 * Mirrors lib/task-tree.ts and lib/progress.ts: no React, no repository, no
 * browser globals — unit-testable with plain objects.
 *
 * Leaf definition is REUSED, never rebuilt: `reachableLeaves` / `buildTaskTree`
 * are the same functions the long-term tree and progress rollup use, so the
 * picker and the today list can never disagree about what a leaf is (A5).
 */

export interface PickableLeaf {
  task: Task
  goal: Goal
  // null = 直接任务 (goal-scoped task with no milestone).
  milestone: Milestone | null
  // Ancestor chain below the goal (milestone → parent tasks), " - "-joined.
  breadcrumb: string | null
}

export interface TodayEntry {
  id: string // dailyTodos row id — stable target for remove/focus
  kind: 'todo' | 'task'
  addedAt: string
  // T28: the daily row's manual group rank (null = never ordered). Grouping by
  // goal happens in the UI; the rank travels with the entry.
  sortOrder: number | null
  todo: DailyTodo | null // set for kind 'todo'
  task: Task | null // set for kind 'task'
  // A linked task that gained children renders as the Phase 8 container variant
  // (non-interactive ProgressRing); it stays until manually removed.
  isContainer: boolean
  goalName: string | null
  milestoneName: string | null
  goalId: string | null // set for kind 'task'; the linked task's owning goal
  // Ancestor chain BELOW the goal (milestone → parent tasks), top-down,
  // " - "-joined. Excludes the leaf name (the row's own title) and the goal
  // (shown in the card header). Null when there is no milestone/parent.
  breadcrumb: string | null
}

interface Scope {
  goal: Goal
  milestone: Milestone | null
}

/**
 * Build a resolver for a task's live scope. A task is in scope only when its
 * owning goal is live, and — for milestone tasks — its milestone is live too.
 * Mirrors the orphan defense in rollupProgress.
 */
function scopeResolver(
  milestones: readonly Milestone[],
  goals: readonly Goal[],
): (task: Task) => Scope | null {
  const liveGoals = new Map<string, Goal>()
  for (const goal of goals) {
    if (goal.deleted_at == null) liveGoals.set(goal.id, goal)
  }

  const liveMilestones = new Map<string, Milestone>()
  for (const milestone of milestones) {
    if (milestone.deleted_at != null) continue
    if (!liveGoals.has(milestone.goal_id)) continue
    liveMilestones.set(milestone.id, milestone)
  }

  return (task: Task): Scope | null => {
    if (task.milestone_id != null) {
      const milestone = liveMilestones.get(task.milestone_id)
      if (!milestone) return null
      const goal = liveGoals.get(milestone.goal_id)
      return goal ? { goal, milestone } : null
    }
    if (task.goal_id == null) return null
    const goal = liveGoals.get(task.goal_id)
    return goal ? { goal, milestone: null } : null
  }
}

/**
 * Ancestor breadcrumb BELOW the goal: milestone name → parent container task
 * names (top-down), " - "-joined, excluding the leaf name and the goal. Null
 * when there is no milestone and no parent.
 */
function taskBreadcrumb(
  task: Task,
  milestone: Milestone | null,
  tasksById: ReadonlyMap<string, Task>,
): string | null {
  const parts: string[] = []
  if (milestone) parts.push(milestone.name)
  const parentChain: string[] = []
  let cursor: Task | undefined = task
  while (cursor.parent_id != null) {
    const parent = tasksById.get(cursor.parent_id)
    if (!parent) break
    parentChain.unshift(parent.name)
    cursor = parent
  }
  parts.push(...parentChain)
  return parts.length > 0 ? parts.join(' - ') : null
}

/**
 * Live-scope reachable leaves, excluding tasks already in today.
 *
 * Pure: no React / repository / browser globals. Order follows
 * `reachableLeaves`; the picker groups/sorts for display.
 */
export function pickableLeaves(
  tasks: readonly Task[],
  milestones: readonly Milestone[],
  goals: readonly Goal[],
  excludeTaskIds: ReadonlySet<string> = new Set(),
): PickableLeaf[] {
  const resolve = scopeResolver(milestones, goals)
  const liveTasks = tasks.filter((task) => task.deleted_at == null)
  const tasksById = new Map(liveTasks.map((task) => [task.id, task]))
  const result: PickableLeaf[] = []

  for (const task of reachableLeaves(liveTasks)) {
    if (excludeTaskIds.has(task.id)) continue
    // 已完成的不进候选列表（T16）：checkbox 看 completed，quantity 看
    // current 是否到达 target；target 为 null 的数量任务视为未完成（防误杀）。
    const completed =
      (task.progress_type ?? 'checkbox') === 'quantity'
        ? task.target_value != null && (task.current_value ?? 0) >= task.target_value
        : task.completed === true
    if (completed) continue
    const scope = resolve(task)
    if (!scope) continue
    result.push({
      task,
      goal: scope.goal,
      milestone: scope.milestone,
      breadcrumb: taskBreadcrumb(task, scope.milestone, tasksById),
    })
  }

  return result
}

/**
 * Merge standalone todos and linked task memberships into one list.
 *
 * Drops:
 *  - tombstoned daily rows,
 *  - completed rows whose completion fell on a prior logical day (D-04 rollover;
 *    only when `today` is supplied),
 *  - linked rows whose task is missing or tombstoned,
 *  - linked rows outside the live scope (archived goal/milestone),
 *  - linked rows whose task is neither a live leaf nor a live container
 *    (trapped in an orphaned subtree).
 *
 * A task that gained children is KEPT and flagged `isContainer: true` so the UI
 * can render the read-only container variant (09-UI-SPEC §Edge cases). Storage is
 * never mutated here (T-09-05).
 *
 * Order: `added_at` descending (newest first), tie-break entry id ascending.
 */
export function buildTodayEntries(
  daily: readonly DailyTodo[],
  tasks: readonly Task[],
  milestones: readonly Milestone[],
  goals: readonly Goal[],
  today: string = '',
  offsetHours = 0,
): TodayEntry[] {
  const resolve = scopeResolver(milestones, goals)
  const liveTasks = tasks.filter((task) => task.deleted_at == null)
  const tasksById = new Map(liveTasks.map((task) => [task.id, task]))
  const leafIds = new Set(reachableLeaves(liveTasks).map((task) => task.id))
  const containerIds = new Set(buildTaskTree(liveTasks).children.keys())

  const entries: TodayEntry[] = []

  for (const row of daily) {
    if (row.deleted_at != null) continue

    if (row.task_id === null) {
      // Completed on a prior logical day → roll it off the 今日 list (D-04).
      if (
        row.completed === true &&
        row.completed_at != null &&
        dayKey(row.completed_at, offsetHours) < today
      ) {
        continue
      }
      entries.push({
        id: row.id,
        kind: 'todo',
        addedAt: row.added_at,
        sortOrder: row.sort_order ?? null,
        todo: row,
        task: null,
        isContainer: false,
        goalName: null,
        milestoneName: null,
        goalId: null,
        breadcrumb: null,
      })
      continue
    }

    const task = tasksById.get(row.task_id)
    if (!task) continue // dangling / tombstoned linked task

    const scope = resolve(task)
    if (!scope) continue // archived goal or milestone

    const isContainer = containerIds.has(task.id)
    const isLeaf = leafIds.has(task.id)
    if (!isContainer && !isLeaf) continue // trapped in an orphaned subtree

    // A completed leaf rolls off the 今日 list once its completion falls on a
    // prior logical day (D-04). Containers are never rolled off. Quantity tasks
    // complete when current_value reaches target_value; checkbox tasks use
    // `completed`. T21: legacy quantity completions may lack completed_at, so
    // the rollover day falls back to updated_at (≥ actual completion; a later
    // sync rewrite only delays the roll-off by a day, never removes early).
    if (!isContainer) {
      const completed =
        (task.progress_type ?? 'checkbox') === 'quantity'
          ? task.target_value != null &&
            (task.current_value ?? 0) >= task.target_value
          : task.completed === true
      const rolloverStamp = task.completed_at ?? task.updated_at
      if (completed && dayKey(rolloverStamp, offsetHours) < today) {
        continue
      }
    }

    entries.push({
      id: row.id,
      kind: 'task',
      addedAt: row.added_at,
      sortOrder: row.sort_order ?? null,
      todo: null,
      task,
      isContainer,
      goalName: scope.goal.name,
      milestoneName: scope.milestone?.name ?? null,
      goalId: scope.goal.id,
      breadcrumb: taskBreadcrumb(task, scope.milestone, tasksById),
    })
  }

  // Linked long-term-plan entries display in plan order (milestone order →
  // task order), independent of when they were added (T19b) — a book's chapters
  // must read 一→十 even when added in separate batches. Standalone todos keep
  // newest-first recency.
  const milestoneOrder = new Map(milestones.map((m) => [m.id, m.sort_order]))
  entries.sort((a, b) => {
    if (a.task && b.task) {
      const aMs =
        a.task.milestone_id != null
          ? (milestoneOrder.get(a.task.milestone_id) ?? 0)
          : Infinity
      const bMs =
        b.task.milestone_id != null
          ? (milestoneOrder.get(b.task.milestone_id) ?? 0)
          : Infinity
      if (aMs !== bMs) return aMs - bMs
      const aOrder = a.task.sort_order ?? 0
      const bOrder = b.task.sort_order ?? 0
      if (aOrder !== bOrder) return aOrder - bOrder
      if (a.id === b.id) return 0
      return a.id < b.id ? -1 : 1
    }
    if (a.task) return -1
    if (b.task) return 1
    if (a.addedAt !== b.addedAt) return a.addedAt < b.addedAt ? 1 : -1
    if (a.id === b.id) return 0
    return a.id < b.id ? -1 : 1
  })

  return entries
}

/**
 * T28: order the 今日 长期计划 goal groups. A group's manual rank is the MIN
 * sort_order across its member rows (a drag writes one value to the whole
 * group). Ranked groups sort ascending in front; unranked groups keep the
 * legacy recency rule — newest member addition first, id ascending on a tie.
 * Callers pass the member entries (any order) per goal id.
 */
export function sortGoalGroupIds(
  groups: ReadonlyMap<string, readonly TodayEntry[]>,
): string[] {
  const rankOf = (goalId: string): number | null => {
    const members = groups.get(goalId) ?? []
    let rank: number | null = null
    for (const entry of members) {
      if (entry.sortOrder != null && (rank === null || entry.sortOrder < rank)) {
        rank = entry.sortOrder
      }
    }
    return rank
  }
  const fallbackOf = (goalId: string): string => {
    const members = groups.get(goalId) ?? []
    let latest = ''
    for (const entry of members) {
      if (entry.addedAt > latest) latest = entry.addedAt
    }
    return latest
  }

  return Array.from(groups.keys()).sort((a, b) => {
    const rankA = rankOf(a)
    const rankB = rankOf(b)
    if (rankA !== null && rankB !== null && rankA !== rankB) return rankA - rankB
    // Exactly one ranked group goes first; two unranked groups (or a rank tie)
    // fall through to the legacy added_at rule.
    if (rankA !== null && rankB === null) return -1
    if (rankA === null && rankB !== null) return 1
    const latestA = fallbackOf(a)
    const latestB = fallbackOf(b)
    if (latestA !== latestB) return latestA < latestB ? 1 : -1
    return a < b ? -1 : 1
  })
}

/** One collapsible group of pickable leaves sharing a parent container task (部). */
export interface ParentLeafGroup {
  parentId: string
  parentName: string
  leaves: PickableLeaf[]
}

/**
 * Split pickable leaves into direct leaves (no parent) and collapsible parent
 * groups, preserving first-appearance order. Parent name comes from the last
 * breadcrumb segment (the immediate container task, e.g. 第一部). Used by the
 * today picker to render 部-level collapsible submenus (T14).
 */
export function groupLeavesByParent(leaves: readonly PickableLeaf[]): {
  direct: PickableLeaf[]
  groups: ParentLeafGroup[]
} {
  const direct: PickableLeaf[] = []
  const byParent = new Map<string, ParentLeafGroup>()
  for (const leaf of leaves) {
    const parentId = leaf.task.parent_id
    if (parentId == null) {
      direct.push(leaf)
      continue
    }
    const existing = byParent.get(parentId)
    if (existing) {
      existing.leaves.push(leaf)
    } else {
      const parentName =
        leaf.breadcrumb?.split(' - ').pop()?.trim() || '子任务组'
      byParent.set(parentId, { parentId, parentName, leaves: [leaf] })
    }
  }
  return { direct, groups: [...byParent.values()] }
}
