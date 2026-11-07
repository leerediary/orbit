import { describe, expect, it } from 'vitest'
import { buildTodayEntries, sortGoalGroupIds } from '@/lib/today-list'
import type { TodayEntry } from '@/lib/today-list'
import { validateImportRow } from '@/lib/entity-schema'
import type { DailyTodo, Goal, Milestone, Task } from '@/lib/types'

/**
 * T28: manual ordering of the 今日 长期计划 goal groups.
 *
 * A drag writes one shared sort_order to every dailyTodos row of a group, so
 * the group's rank is the members' MIN. Ranked groups sort ascending in
 * front; unranked groups keep the legacy recency rule (newest first).
 */

const CREATED = '2026-01-01T00:00:00.000Z'

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-a',
    category_id: 'category-a',
    name: '目标 A',
    created_at: CREATED,
    sort_order: 0,
    updated_at: CREATED,
    deleted_at: null,
    ...overrides,
  }
}

function milestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: 'ms-a',
    goal_id: 'goal-a',
    name: '里程碑 A',
    created_at: CREATED,
    sort_order: 0,
    updated_at: CREATED,
    deleted_at: null,
    ...overrides,
  }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-a',
    milestone_id: 'ms-a',
    goal_id: null,
    parent_id: null,
    name: '任务 A',
    progress_type: 'checkbox',
    unit: null,
    target_value: null,
    current_value: null,
    completed: false,
    completed_at: null,
    created_at: CREATED,
    sort_order: 0,
    updated_at: CREATED,
    deleted_at: null,
    ...overrides,
  }
}

function daily(overrides: Partial<DailyTodo> = {}): DailyTodo {
  return {
    id: 'daily-a',
    task_id: null,
    name: '买牛奶',
    completed: false,
    completed_at: null,
    added_at: '2026-06-01T00:00:00.000Z',
    updated_at: CREATED,
    deleted_at: null,
    ...overrides,
  }
}

function entry(overrides: Partial<TodayEntry>): TodayEntry {
  return {
    id: 'daily-a',
    kind: 'task',
    addedAt: '2026-06-01T00:00:00.000Z',
    sortOrder: null,
    todo: null,
    task: null,
    isContainer: false,
    goalName: null,
    milestoneName: null,
    goalId: null,
    breadcrumb: null,
    ...overrides,
  }
}

describe('sortGoalGroupIds', () => {
  it('orders ranked groups ascending in front of unranked groups', () => {
    const groups = new Map<string, TodayEntry[]>([
      ['g-old', [entry({ id: 'd1', addedAt: '2026-06-01T00:00:00.000Z' })]],
      ['g-first', [entry({ id: 'd2', sortOrder: 0 })]],
      ['g-third', [entry({ id: 'd3', sortOrder: 2 })]],
      ['g-second', [entry({ id: 'd4', sortOrder: 1 })]],
    ])

    expect(sortGoalGroupIds(groups)).toEqual([
      'g-first',
      'g-second',
      'g-third',
      'g-old',
    ])
  })

  it('uses the MIN sort_order when group members disagree', () => {
    const groups = new Map<string, TodayEntry[]>([
      ['g-a', [entry({ id: 'd1', sortOrder: 5 }), entry({ id: 'd2', sortOrder: 1 })]],
      ['g-b', [entry({ id: 'd3', sortOrder: 3 })]],
    ])

    expect(sortGoalGroupIds(groups)).toEqual(['g-a', 'g-b'])
  })

  it('falls back to newest addedAt first among unranked groups', () => {
    const groups = new Map<string, TodayEntry[]>([
      ['g-recent', [entry({ id: 'd1', addedAt: '2026-06-03T00:00:00.000Z' })]],
      ['g-stale', [entry({ id: 'd2', addedAt: '2026-06-01T00:00:00.000Z' })]],
    ])

    expect(sortGoalGroupIds(groups)).toEqual(['g-recent', 'g-stale'])
  })

  it('breaks a rank tie by the legacy addedAt rule', () => {
    const groups = new Map<string, TodayEntry[]>([
      ['g-a', [entry({ id: 'd1', sortOrder: 0, addedAt: '2026-06-01T00:00:00.000Z' })]],
      ['g-b', [entry({ id: 'd2', sortOrder: 0, addedAt: '2026-06-02T00:00:00.000Z' })]],
    ])

    expect(sortGoalGroupIds(groups)).toEqual(['g-b', 'g-a'])
  })
})

describe('buildTodayEntries sortOrder', () => {
  it('carries the daily row sort_order on standalone todos', () => {
    const entries = buildTodayEntries(
      [daily({ sort_order: 2 })],
      [],
      [],
      [],
    )

    expect(entries[0].sortOrder).toBe(2)
  })

  it('carries the daily row sort_order on linked tasks', () => {
    const entries = buildTodayEntries(
      [daily({ id: 'daily-link', task_id: 'task-a', name: null, completed: null, sort_order: 3 })],
      [task()],
      [milestone()],
      [goal()],
    )

    expect(entries).toHaveLength(1)
    expect(entries[0].sortOrder).toBe(3)
  })

  it('normalizes a missing sort_order to null', () => {
    const entries = buildTodayEntries([daily()], [], [], [])

    expect(entries[0].sortOrder).toBeNull()
  })
})

describe('dailyTodos import validation (T28)', () => {
  const base = daily({ name: null, task_id: 'task-a', completed: null })

  it('accepts a finite sort_order number', () => {
    expect(() => validateImportRow('dailyTodos', { ...base, sort_order: 2 }, 0)).not.toThrow()
  })

  it('accepts an explicit null', () => {
    expect(() => validateImportRow('dailyTodos', { ...base, sort_order: null }, 0)).not.toThrow()
  })

  it('accepts a legacy row without the key', () => {
    const { sort_order: _omitted, ...legacy } = { ...base, sort_order: undefined }
    expect(() => validateImportRow('dailyTodos', legacy, 0)).not.toThrow()
  })

  it('rejects a non-numeric sort_order', () => {
    expect(() =>
      validateImportRow('dailyTodos', { ...base, sort_order: '2' }, 0),
    ).toThrow(/必须是 null 或数字/)
  })
})
