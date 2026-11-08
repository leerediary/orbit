import { describe, expect, it } from 'vitest'
import { buildTodayEntries, pickableLeaves } from '@/lib/today-list'
import type { DailyTodo, Goal, Milestone, Task } from '@/lib/types'

/**
 * Pure aggregation contract for the 今日 view (DAILY-01/02).
 *
 * These are plain-object tests: no jsdom, no IndexedDB. They lock the merge,
 * leaf filter, orphan defense, container preservation, picker exclusion and
 * ordering rules from 09-RESEARCH §3 and 09-UI-SPEC §Edge cases / §8.
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

describe('buildTodayEntries', () => {
  it('keeps a standalone todo without scope names', () => {
    const entries = buildTodayEntries([daily()], [], [], [])

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: 'daily-a',
      kind: 'todo',
      isContainer: false,
      goalName: null,
      milestoneName: null,
    })
    expect(entries[0].todo?.name).toBe('买牛奶')
    expect(entries[0].task).toBeNull()
  })

  it('keeps a linked leaf with its goal and milestone names', () => {
    const entries = buildTodayEntries(
      [daily({ id: 'daily-leaf', task_id: 'task-a', name: null, completed: null })],
      [task()],
      [milestone()],
      [goal()],
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: 'daily-leaf',
      kind: 'task',
      isContainer: false,
      goalName: '目标 A',
      milestoneName: '里程碑 A',
    })
    expect(entries[0].task?.id).toBe('task-a')
  })

  it('orders linked entries by plan order even across batches (T19b)', () => {
    // daily-1 is NEWER (would win any recency sort) but its task is 第二章.
    const newer = daily({
      id: 'daily-2',
      task_id: 'task-b',
      name: null,
      completed: null,
      added_at: '2026-11-05T09:00:00.000Z',
    })
    const older = daily({
      id: 'daily-1',
      task_id: 'task-a',
      name: null,
      completed: null,
      added_at: '2026-11-04T09:00:00.000Z',
    })
    const entries = buildTodayEntries(
      [newer, older],
      [task({ id: 'task-a', sort_order: 1 }), task({ id: 'task-b', sort_order: 2 })],
      [milestone()],
      [goal()],
    )

    expect(entries.map((entry) => entry.task?.id)).toEqual(['task-a', 'task-b'])
  })

  it('sets milestoneName null for a direct (goal-scoped) task', () => {
    const entries = buildTodayEntries(
      [daily({ task_id: 'task-direct', name: null, completed: null })],
      [task({ id: 'task-direct', milestone_id: null, goal_id: 'goal-a' })],
      [milestone()],
      [goal()],
    )

    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('task')
    expect(entries[0].goalName).toBe('目标 A')
    expect(entries[0].milestoneName).toBeNull()
  })

  it('builds an ancestor breadcrumb (goal → milestone → parent tasks)', () => {
    const parentTask = task({ id: 'task-parent', parent_id: null, name: '父任务' })
    const childTask = task({ id: 'task-child', parent_id: 'task-parent', name: '子任务' })
    const entries = buildTodayEntries(
      [daily({ id: 'daily-child', task_id: 'task-child', name: null, completed: null })],
      [childTask, parentTask],
      [milestone()],
      [goal()],
    )

    expect(entries).toHaveLength(1)
    expect(entries[0].breadcrumb).toBe('里程碑 A - 父任务')
  })

  it('sets breadcrumb null for a direct task (nothing below the goal)', () => {
    const directTask = task({ id: 'task-direct', milestone_id: null, goal_id: 'goal-a' })
    const entries = buildTodayEntries(
      [daily({ task_id: 'task-direct', name: null, completed: null })],
      [directTask],
      [milestone()],
      [goal()],
    )

    expect(entries).toHaveLength(1)
    expect(entries[0].breadcrumb).toBeNull()
  })

  it('drops a tombstoned linked task but keeps the unrelated todo', () => {
    const entries = buildTodayEntries(
      [
        daily({ id: 'daily-dead', task_id: 'task-dead', name: null, completed: null }),
        daily({ id: 'daily-live' }),
      ],
      [task({ id: 'task-dead', deleted_at: '2026-05-01T00:00:00.000Z' })],
      [milestone()],
      [goal()],
    )

    expect(entries.map((entry) => entry.id)).toEqual(['daily-live'])
  })

  it('drops a linked row whose task id is dangling', () => {
    const entries = buildTodayEntries(
      [daily({ task_id: 'task-missing', name: null, completed: null })],
      [],
      [milestone()],
      [goal()],
    )

    expect(entries).toEqual([])
  })

  it('keeps a task that gained children as a container while a sibling stays a leaf', () => {
    const parent = task({ id: 'task-parent', sort_order: 0 })
    const child = task({ id: 'task-child', parent_id: 'task-parent', sort_order: 0 })
    const sibling = task({ id: 'task-sibling', sort_order: 1 })

    const entries = buildTodayEntries(
      [
        daily({ id: 'daily-parent', task_id: 'task-parent', name: null, completed: null }),
        daily({ id: 'daily-sibling', task_id: 'task-sibling', name: null, completed: null }),
      ],
      [parent, child, sibling],
      [milestone()],
      [goal()],
    )

    const byId = new Map(entries.map((entry) => [entry.id, entry] as const))
    expect(byId.get('daily-parent')?.isContainer).toBe(true)
    expect(byId.get('daily-parent')?.kind).toBe('task')
    expect(byId.get('daily-sibling')?.isContainer).toBe(false)
  })

  it('drops a linked leaf whose goal was archived', () => {
    const entries = buildTodayEntries(
      [daily({ task_id: 'task-a', name: null, completed: null })],
      [task()],
      [milestone()],
      [goal({ deleted_at: '2026-05-01T00:00:00.000Z' })],
    )

    expect(entries).toEqual([])
  })

  it('drops a linked leaf whose milestone was archived', () => {
    const entries = buildTodayEntries(
      [daily({ task_id: 'task-a', name: null, completed: null })],
      [task()],
      [milestone({ deleted_at: '2026-05-01T00:00:00.000Z' })],
      [goal()],
    )

    expect(entries).toEqual([])
  })

  it('drops a task trapped in a non-live scope but keeps standalone todos', () => {
    const entries = buildTodayEntries(
      [
        daily({ id: 'daily-orphan', task_id: 'task-direct', name: null, completed: null }),
        daily({ id: 'daily-standalone' }),
      ],
      // Direct task with no goal_id — its scope cannot resolve.
      [task({ id: 'task-direct', milestone_id: null, goal_id: null })],
      [],
      [],
    )

    expect(entries.map((entry) => entry.id)).toEqual(['daily-standalone'])
  })

  it('sorts newest-first by added_at with an id-ascending tie-break', () => {
    const entries = buildTodayEntries(
      [
        daily({ id: 'entry-old', added_at: '2026-06-01T00:00:00.000Z' }),
        daily({ id: 'entry-new', added_at: '2026-06-03T00:00:00.000Z' }),
        daily({ id: 'entry-tie-b', added_at: '2026-06-02T00:00:00.000Z' }),
        daily({ id: 'entry-tie-a', added_at: '2026-06-02T00:00:00.000Z' }),
      ],
      [],
      [],
      [],
    )

    expect(entries.map((entry) => entry.id)).toEqual([
      'entry-new',
      'entry-tie-a',
      'entry-tie-b',
      'entry-old',
    ])
  })

  it('rolls off a standalone todo completed on a prior day', () => {
    const entries = buildTodayEntries(
      [daily({ id: 'todo-done', completed: true, completed_at: '2026-06-04T12:00:00' })],
      [],
      [],
      [],
      '2026-06-05',
    )

    expect(entries).toEqual([])
  })

  it('keeps a standalone todo completed today', () => {
    const entries = buildTodayEntries(
      [daily({ id: 'todo-done', completed: true, completed_at: '2026-06-05T12:00:00' })],
      [],
      [],
      [],
      '2026-06-05',
    )

    expect(entries).toHaveLength(1)
  })

  it('rolls off a linked checkbox task completed on a prior day', () => {
    const entries = buildTodayEntries(
      [daily({ id: 'daily-leaf', task_id: 'task-a', name: null, completed: null })],
      [task({ completed: true, completed_at: '2026-06-04T12:00:00' })],
      [milestone()],
      [goal()],
      '2026-06-05',
    )

    expect(entries).toEqual([])
  })

  it('keeps a linked checkbox task completed today', () => {
    const entries = buildTodayEntries(
      [daily({ id: 'daily-leaf', task_id: 'task-a', name: null, completed: null })],
      [task({ completed: true, completed_at: '2026-06-05T12:00:00' })],
      [milestone()],
      [goal()],
      '2026-06-05',
    )

    expect(entries).toHaveLength(1)
  })

  it('rolls off a quantity task that reached its target on a prior day', () => {
    const entries = buildTodayEntries(
      [daily({ id: 'daily-q', task_id: 'task-q', name: null, completed: null })],
      [
        task({
          id: 'task-q',
          progress_type: 'quantity',
          unit: '页',
          target_value: 10,
          current_value: 10,
          completed: false,
          completed_at: '2026-06-04T12:00:00',
        }),
      ],
      [milestone()],
      [goal()],
      '2026-06-05',
    )

    expect(entries).toEqual([])
  })

  it('rolls off a completed task whose completed_at is missing, using updated_at (T21)', () => {
    const entries = buildTodayEntries(
      [daily({ id: 'daily-leaf', task_id: 'task-a', name: null, completed: null })],
      [task({ completed: true, completed_at: null })],
      [milestone()],
      [goal()],
      '2026-06-05',
    )

    expect(entries).toEqual([])
  })

  it('keeps a stamp-less completed task touched today (updated_at fallback stays conservative)', () => {
    const entries = buildTodayEntries(
      [daily({ id: 'daily-leaf', task_id: 'task-a', name: null, completed: null })],
      [
        task({
          completed: true,
          completed_at: null,
          updated_at: '2026-06-05T08:00:00',
        }),
      ],
      [milestone()],
      [goal()],
      '2026-06-05',
    )

    expect(entries).toHaveLength(1)
  })

  it('never rolls off a container task', () => {
    const parent = task({ id: 'task-parent', sort_order: 0 })
    const child = task({ id: 'task-child', parent_id: 'task-parent', sort_order: 0 })

    const entries = buildTodayEntries(
      [daily({ id: 'daily-parent', task_id: 'task-parent', name: null, completed: null })],
      [parent, child],
      [milestone()],
      [goal()],
      '2026-06-05',
    )

    expect(entries).toHaveLength(1)
    expect(entries[0].isContainer).toBe(true)
  })
})

describe('pickableLeaves', () => {
  it('returns live-scope leaves with goal and milestone context', () => {
    const leaves = pickableLeaves([task()], [milestone()], [goal()])

    expect(leaves).toHaveLength(1)
    expect(leaves[0].task.id).toBe('task-a')
    expect(leaves[0].goal.id).toBe('goal-a')
    expect(leaves[0].milestone?.id).toBe('ms-a')
  })

  it('returns direct tasks with milestone null', () => {
    const leaves = pickableLeaves(
      [task({ id: 'task-direct', milestone_id: null, goal_id: 'goal-a' })],
      [milestone()],
      [goal()],
    )

    expect(leaves).toHaveLength(1)
    expect(leaves[0].milestone).toBeNull()
    expect(leaves[0].goal.id).toBe('goal-a')
  })

  it('excludes ids already in today', () => {
    const leaves = pickableLeaves(
      [task({ id: 'task-a' }), task({ id: 'task-b', sort_order: 1 })],
      [milestone()],
      [goal()],
      new Set(['task-a']),
    )

    expect(leaves.map((leaf) => leaf.task.id)).toEqual(['task-b'])
  })

  it('excludes leaves whose goal or milestone is archived', () => {
    const leaves = pickableLeaves(
      [
        task({ id: 'task-ok' }),
        task({ id: 'task-archived-goal', milestone_id: 'ms-b' }),
        task({ id: 'task-archived-ms', milestone_id: 'ms-archived' }),
      ],
      [
        milestone(),
        milestone({ id: 'ms-b', goal_id: 'goal-archived' }),
        milestone({ id: 'ms-archived', deleted_at: '2026-05-01T00:00:00.000Z' }),
      ],
      [goal(), goal({ id: 'goal-archived', deleted_at: '2026-05-01T00:00:00.000Z' })],
    )

    expect(leaves.map((leaf) => leaf.task.id)).toEqual(['task-ok'])
  })

  it('excludes containers and tombstoned tasks', () => {
    const parent = task({ id: 'task-parent' })
    const child = task({ id: 'task-child', parent_id: 'task-parent' })
    const dead = task({ id: 'task-dead', deleted_at: '2026-05-01T00:00:00.000Z' })

    const leaves = pickableLeaves([parent, child, dead], [milestone()], [goal()])

    expect(leaves.map((leaf) => leaf.task.id)).toEqual(['task-child'])
  })

  it('includes an ancestor breadcrumb (milestone → parent task)', () => {
    const parent = task({ id: 'task-parent', name: '第一部' })
    const child = task({ id: 'task-child', name: '一', parent_id: 'task-parent' })

    const leaves = pickableLeaves([parent, child], [milestone()], [goal()])

    expect(leaves).toHaveLength(1)
    expect(leaves[0].breadcrumb).toBe('里程碑 A - 第一部')
  })
})

describe('pickableLeaves completed filter (T16)', () => {
  it('excludes completed checkbox tasks', () => {
    const done = task({
      id: 't-done',
      name: '已完',
      completed: true,
      completed_at: '2026-11-05T10:00:00.000Z',
    })
    const open = task({ id: 't-open', name: '未完' })
    const leaves = pickableLeaves([done, open], [milestone()], [goal()])
    expect(leaves.map((l) => l.task.id)).toEqual(['t-open'])
  })

  it('excludes quantity tasks that reached target, keeps null-target ones', () => {
    const done = task({
      id: 't-q-done',
      name: '读完',
      progress_type: 'quantity',
      current_value: 100,
      target_value: 100,
    })
    const open = task({
      id: 't-q-open',
      name: '在读',
      progress_type: 'quantity',
      current_value: 40,
      target_value: 100,
    })
    const noTarget = task({
      id: 't-q-null',
      name: '无目标',
      progress_type: 'quantity',
      current_value: 5,
      target_value: null,
    })
    const leaves = pickableLeaves([done, open, noTarget], [milestone()], [goal()])
    expect(leaves.map((l) => l.task.id).sort()).toEqual(['t-q-null', 't-q-open'])
  })
})
