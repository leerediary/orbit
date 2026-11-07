import { describe, expect, it } from 'vitest'
import { progressOf } from '@/lib/progress'
import { rollupProgress } from '@/lib/hierarchy'
import type { Category, Goal, Milestone, Task } from '@/lib/types'

/**
 * Derived progress contract (D-04 / D-06 / D-07, PROG-01 / REST-04).
 *
 *  - progressOf counts task.completed === true over the live tasks the caller
 *    already filtered; total is the array length.
 *  - rollupProgress aggregates task → milestone → goal → category in one pass.
 *    Tombstones are excluded by the CALLER; a task whose milestone_id has no
 *    live milestone is an orphan and is skipped.
 *  - Pure: the input arrays are never mutated.
 */

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-a',
    milestone_id: 'milestone-a',
    goal_id: null,
    parent_id: null,
    progress_type: 'checkbox',
    unit: null,
    target_value: null,
    current_value: null,
    name: 'Task',
    completed: false,
    completed_at: null,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  }
}

function milestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: 'milestone-a',
    goal_id: 'goal-a',
    name: 'Milestone',
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  }
}

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-a',
    category_id: 'category-a',
    name: 'Goal',
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  }
}

function category(overrides: Partial<Category> = {}): Category {
  return {
    id: 'category-a',
    name: 'Category',
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  }
}

describe('progressOf', () => {
  it('returns zero counts for an empty list', () => {
    expect(progressOf([])).toEqual({ completed: 0, total: 0 })
  })

  it('counts completed and total over a mixed list', () => {
    const tasks = [
      task({ id: 'a', completed: true, completed_at: '2026-02-01T00:00:00.000Z' }),
      task({ id: 'b', completed: false }),
      task({ id: 'c', completed: true, completed_at: '2026-02-02T00:00:00.000Z' }),
      task({ id: 'd', completed: false }),
      task({ id: 'e', completed: false }),
    ]
    expect(progressOf(tasks)).toEqual({ completed: 2, total: 5 })
  })

  it('reports completed === total when every task is done', () => {
    const tasks = [
      task({ id: 'a', completed: true, completed_at: '2026-02-01T00:00:00.000Z' }),
      task({ id: 'b', completed: true, completed_at: '2026-02-02T00:00:00.000Z' }),
      task({ id: 'c', completed: true, completed_at: '2026-02-03T00:00:00.000Z' }),
    ]
    const progress = progressOf(tasks)
    expect(progress).toEqual({ completed: 3, total: 3 })
    expect(progress.completed).toBe(progress.total)
  })

  it('counts only completed === true and does not mutate the input', () => {
    const tasks = [
      task({ id: 'a', completed: true }),
      task({ id: 'b', completed: false }),
      task({ id: 'c', completed: true }),
    ]
    const snapshot = tasks.map((entry) => entry.id)

    expect(progressOf(tasks)).toEqual({ completed: 2, total: 3 })
    expect(tasks.map((entry) => entry.id)).toEqual(snapshot)
    expect(tasks[0].completed).toBe(true)
    expect(tasks[1].completed).toBe(false)
  })

  it('adds a quantity leaf as min(current/target, 1)', () => {
    const tasks = [
      task({ id: 'done', completed: true }),
      task({ id: 'partial', progress_type: 'quantity', target_value: 3, current_value: 1 }),
    ]

    const progress = progressOf(tasks)

    expect(progress.total).toBe(2)
    expect(progress.completed).toBeCloseTo(1 + 1 / 3)
  })

  it('excludes container tasks from the leaf count', () => {
    const tasks = [
      task({ id: 'container' }),
      task({ id: 'child', parent_id: 'container', completed: true }),
    ]

    expect(progressOf(tasks)).toEqual({ completed: 1, total: 1 })
  })

  it('returns completed === total with no float drift when every leaf is done', () => {
    const tasks = [
      task({ id: 'a', completed: true }),
      task({ id: 'b', progress_type: 'quantity', target_value: 3, current_value: 3 }),
      task({ id: 'c', progress_type: 'quantity', target_value: 7, current_value: 9 }),
    ]

    const progress = progressOf(tasks)

    expect(progress).toEqual({ completed: 3, total: 3 })
    expect(progress.completed).toBe(progress.total)
  })
})

describe('rollupProgress', () => {
  it('accumulates completed/total through all four levels', () => {
    const milestones = [
      milestone({ id: 'ms-1', goal_id: 'goal-1' }),
      milestone({ id: 'ms-2', goal_id: 'goal-2' }),
    ]
    const goals = [
      goal({ id: 'goal-1', category_id: 'cat-a' }),
      goal({ id: 'goal-2', category_id: 'cat-a' }),
    ]
    // Caller already excluded the tombstoned task below.
    const tasks = [
      task({ id: 't1', milestone_id: 'ms-1', completed: true }),
      task({ id: 't2', milestone_id: 'ms-1', completed: false }),
      task({ id: 't3', milestone_id: 'ms-2', completed: true }),
      task({ id: 't4-deleted', milestone_id: 'ms-1', completed: true, deleted_at: '2026-02-01T00:00:00.000Z' }),
    ]

    const live = tasks.filter((t) => t.deleted_at == null)
    const rollup = rollupProgress(live, milestones, goals)

    expect(rollup.milestone.get('ms-1')).toEqual({ completed: 1, total: 2 })
    expect(rollup.milestone.get('ms-2')).toEqual({ completed: 1, total: 1 })
    expect(rollup.goal.get('goal-1')).toEqual({ completed: 1, total: 2 })
    expect(rollup.goal.get('goal-2')).toEqual({ completed: 1, total: 1 })
    expect(rollup.category.get('cat-a')).toEqual({ completed: 2, total: 3 })
  })

  it('skips orphan tasks whose milestone has no live row', () => {
    const milestones = [milestone({ id: 'ms-1', goal_id: 'goal-1' })]
    const goals = [goal({ id: 'goal-1', category_id: 'cat-a' })]
    const tasks = [task({ id: 'orphan', milestone_id: 'ms-gone', completed: true })]

    const rollup = rollupProgress(tasks, milestones, goals)

    expect(rollup.milestone.size).toBe(0)
    expect(rollup.goal.size).toBe(0)
    expect(rollup.category.size).toBe(0)
  })

  it('does not mutate its inputs', () => {
    const milestones = [milestone({ id: 'ms-1', goal_id: 'goal-1' })]
    const goals = [goal({ id: 'goal-1', category_id: 'cat-a' })]
    const tasks = [task({ id: 't1', milestone_id: 'ms-1', completed: true })]
    const snapshot = tasks.map((t) => t.id)

    rollupProgress(tasks, milestones, goals)

    expect(tasks.map((t) => t.id)).toEqual(snapshot)
    expect(category({ id: 'cat-a' }).id).toBe('cat-a')
  })

  it('rolls a direct task (milestone_id null + goal_id) into goal and category', () => {
    const goals = [goal({ id: 'goal-1', category_id: 'cat-a' })]
    const tasks = [task({ id: 'direct', milestone_id: null, goal_id: 'goal-1', completed: true })]

    const rollup = rollupProgress(tasks, [], goals)

    expect(rollup.milestone.size).toBe(0)
    expect(rollup.goal.get('goal-1')).toEqual({ completed: 1, total: 1 })
    expect(rollup.category.get('cat-a')).toEqual({ completed: 1, total: 1 })
  })

  it('excludes container milestone tasks and counts only their leaves', () => {
    const milestones = [milestone({ id: 'ms-1', goal_id: 'goal-1' })]
    const goals = [goal({ id: 'goal-1', category_id: 'cat-a' })]
    const tasks = [
      task({ id: 'container', milestone_id: 'ms-1', completed: false }),
      task({ id: 'leaf', milestone_id: 'ms-1', parent_id: 'container', completed: true }),
    ]

    const rollup = rollupProgress(tasks, milestones, goals)

    expect(rollup.milestone.get('ms-1')).toEqual({ completed: 1, total: 1 })
    expect(rollup.goal.get('goal-1')).toEqual({ completed: 1, total: 1 })
  })

  it('skips orphan direct tasks whose goal is not live', () => {
    const goals = [goal({ id: 'goal-1', category_id: 'cat-a' })]
    const tasks = [task({ id: 'orphan', milestone_id: null, goal_id: 'goal-gone', completed: true })]

    const rollup = rollupProgress(tasks, [], goals)

    expect(rollup.milestone.size).toBe(0)
    expect(rollup.goal.size).toBe(0)
    expect(rollup.category.size).toBe(0)
  })

  it('rolls a partial quantity leaf into a fractional completed count', () => {
    const milestones = [milestone({ id: 'ms-1', goal_id: 'goal-1' })]
    const goals = [goal({ id: 'goal-1', category_id: 'cat-a' })]
    const tasks = [
      task({ id: 'q', milestone_id: 'ms-1', progress_type: 'quantity', target_value: 3, current_value: 1 }),
    ]

    const rollup = rollupProgress(tasks, milestones, goals)

    expect(rollup.milestone.get('ms-1')?.total).toBe(1)
    expect(rollup.milestone.get('ms-1')?.completed).toBeCloseTo(1 / 3)
    expect(rollup.category.get('cat-a')?.completed).toBeCloseTo(1 / 3)
  })
})
