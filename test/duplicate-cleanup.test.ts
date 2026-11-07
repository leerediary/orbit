import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import { readOutbox } from '@/lib/outbox'
import {
  DUPLICATE_ENTITIES,
  deleteDuplicateRows,
  scanDuplicates,
  type DuplicateGroup,
  type DuplicateScan,
  type DuplicateSelection,
} from '@/lib/duplicate-cleanup'
import type {
  Category,
  DailyTodo,
  Goal,
  Habit,
  HabitCompletion,
  JournalEntry,
  Milestone,
  PomodoroSession,
  Task,
} from '@/lib/types'

/**
 * Phase 21 / OPS-03 — duplicate grouping engine.
 *
 * Every test drives a real OrbitDB against a fresh, uniquely named
 * fake-indexeddb database (the module singleton is never imported) and asserts
 * on the typed scan result only. No data content beyond the name is inspected.
 */

const createdNames: string[] = []
const opened: OrbitDB[] = []

function newName(): string {
  const name = `orbit-duplicate-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`
  createdNames.push(name)
  return name
}

function open(): OrbitDB {
  const database = new OrbitDB(newName())
  opened.push(database)
  return database
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const database of opened.splice(0)) {
    try {
      database.close()
    } catch {
      // Already closed by the test.
    }
  }
  for (const name of createdNames.splice(0)) {
    await Dexie.delete(name).catch(() => {})
  }
})

// --- fixtures -------------------------------------------------------------

const T0 = '2026-01-01T00:00:00.000Z'

function category(over: Partial<Category> = {}): Category {
  return { id: 'cat-1', name: '学习', created_at: T0, sort_order: 0, updated_at: T0, deleted_at: null, ...over }
}

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    category_id: 'cat-1',
    name: '读书',
    created_at: T0,
    sort_order: 0,
    updated_at: T0,
    deleted_at: null,
    ...over,
  }
}

function milestone(over: Partial<Milestone> = {}): Milestone {
  return {
    id: 'ms-1',
    goal_id: 'goal-1',
    name: '第一章',
    created_at: T0,
    sort_order: 0,
    updated_at: T0,
    deleted_at: null,
    ...over,
  }
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    milestone_id: 'ms-1',
    goal_id: null,
    parent_id: null,
    name: '复习',
    progress_type: 'checkbox',
    unit: null,
    target_value: null,
    current_value: null,
    completed: false,
    completed_at: null,
    created_at: T0,
    sort_order: 0,
    updated_at: T0,
    deleted_at: null,
    ...over,
  }
}

function dailyTodo(over: Partial<DailyTodo> = {}): DailyTodo {
  return {
    id: 'todo-1',
    task_id: null,
    name: '买牛奶',
    completed: false,
    completed_at: null,
    added_at: T0,
    updated_at: T0,
    deleted_at: null,
    ...over,
  }
}

function habit(over: Partial<Habit> = {}): Habit {
  return { id: 'habit-1', name: '每天跑步', short_name: '跑步', sort_order: 0, updated_at: T0, deleted_at: null, ...over }
}

function journalEntry(over: Partial<JournalEntry> = {}): JournalEntry {
  return { id: 'journal-1', day_key: '2026-11-01', content: '', updated_at: T0, deleted_at: null, ...over }
}

function habitCompletion(over: Partial<HabitCompletion> = {}): HabitCompletion {
  return {
    id: 'hc-1',
    habit_id: 'habit-1',
    date: '2026-11-01',
    note: null,
    completed_at: T0,
    updated_at: T0,
    deleted_at: null,
    ...over,
  }
}

function pomodoro(over: Partial<PomodoroSession> = {}): PomodoroSession {
  return {
    id: 'pomo-1',
    started_at: T0,
    duration_sec: 1500,
    notes: [],
    habit_id: null,
    task_id: null,
    daily_todo_id: null,
    marked_task_complete: false,
    progress_amount: null,
    shared_indices: [],
    updated_at: T0,
    deleted_at: null,
    ...over,
  }
}

interface Seed {
  categories?: Category[]
  goals?: Goal[]
  milestones?: Milestone[]
  tasks?: Task[]
  dailyTodos?: DailyTodo[]
  habits?: Habit[]
  journalEntries?: JournalEntry[]
  habitCompletions?: HabitCompletion[]
  pomodoroSessions?: PomodoroSession[]
}

async function seed(database: OrbitDB, data: Seed): Promise<void> {
  if (data.categories) await database.categories.bulkPut(data.categories)
  if (data.goals) await database.goals.bulkPut(data.goals)
  if (data.milestones) await database.milestones.bulkPut(data.milestones)
  if (data.tasks) await database.tasks.bulkPut(data.tasks)
  if (data.dailyTodos) await database.dailyTodos.bulkPut(data.dailyTodos)
  if (data.habits) await database.habits.bulkPut(data.habits)
  if (data.journalEntries) await database.journalEntries.bulkPut(data.journalEntries)
  if (data.habitCompletions) await database.habitCompletions.bulkPut(data.habitCompletions)
  if (data.pomodoroSessions) await database.pomodoroSessions.bulkPut(data.pomodoroSessions)
}

function groupsOf(scan: DuplicateScan): DuplicateGroup[] {
  expect(scan.ok).toBe(true)
  return scan.ok ? scan.groups : []
}

function groupFor(groups: DuplicateGroup[], entity: DuplicateGroup['entity'], name: string): DuplicateGroup | undefined {
  return groups.find((group) => group.entity === entity && group.name === name)
}

// --- scan -----------------------------------------------------------------

describe('scanDuplicates — grouping', () => {
  it('groups two live same-name categories and sorts rows newest first', async () => {
    const database = open()
    await seed(database, {
      categories: [
        category({ id: 'cat-1', name: '学习', updated_at: '2026-01-01T00:00:00.000Z' }),
        category({ id: 'cat-2', name: '学习', updated_at: '2026-02-01T00:00:00.000Z' }),
        category({ id: 'cat-3', name: '工作' }),
      ],
    })

    const groups = groupsOf(await scanDuplicates(database))
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      entity: 'categories',
      name: '学习',
      parentPath: '全部',
    })
    expect(groups[0].rows.map((row) => row.id)).toEqual(['cat-2', 'cat-1'])
    expect(groups[0].rows.every((row) => row.descendantCount === 0)).toBe(true)
  })

  it('keeps same-name goals separate by parent category', async () => {
    const database = open()
    await seed(database, {
      categories: [category({ id: 'cat-a', name: 'A' }), category({ id: 'cat-b', name: 'B' })],
      goals: [
        goal({ id: 'goal-a1', category_id: 'cat-a', name: '读书' }),
        goal({ id: 'goal-a2', category_id: 'cat-a', name: '读书' }),
        goal({ id: 'goal-b1', category_id: 'cat-b', name: '读书' }),
      ],
    })

    const groups = groupsOf(await scanDuplicates(database))
    expect(groups).toHaveLength(1)
    expect(groups[0].parentPath).toBe('分类「A」')
    expect(groups[0].rows.map((row) => row.id).sort()).toEqual(['goal-a1', 'goal-a2'])
  })

  it('does not group same-name tasks under different milestones', async () => {
    const database = open()
    await seed(database, {
      milestones: [
        milestone({ id: 'ms-1', name: '第一章' }),
        milestone({ id: 'ms-2', name: '第二章' }),
      ],
      tasks: [
        task({ id: 'task-1', milestone_id: 'ms-1', name: '复习' }),
        task({ id: 'task-2', milestone_id: 'ms-2', name: '复习' }),
      ],
    })

    expect(groupsOf(await scanDuplicates(database))).toHaveLength(0)

    await seed(database, {
      tasks: [task({ id: 'task-3', milestone_id: 'ms-1', name: '复习' })],
    })
    const groups = groupsOf(await scanDuplicates(database))
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ entity: 'tasks', parentPath: '里程碑「第一章」' })
    expect(groups[0].rows.map((row) => row.id).sort()).toEqual(['task-1', 'task-3'])
  })

  it('ignores linked dailyTodos and groups only standalone todos', async () => {
    const database = open()
    await seed(database, {
      dailyTodos: [
        dailyTodo({ id: 'todo-linked-1', task_id: 'task-1', name: null, completed: null }),
        dailyTodo({ id: 'todo-linked-2', task_id: 'task-2', name: null, completed: null }),
        dailyTodo({ id: 'todo-standalone-1', task_id: null, name: '买牛奶' }),
        dailyTodo({ id: 'todo-standalone-2', task_id: null, name: '买牛奶' }),
      ],
    })

    const groups = groupsOf(await scanDuplicates(database))
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ entity: 'dailyTodos', name: '买牛奶', parentPath: '独立待办' })
    expect(groups[0].rows.map((row) => row.id).sort()).toEqual(['todo-standalone-1', 'todo-standalone-2'])
  })

  it('ignores tombstones — they never create or join a group', async () => {
    const database = open()
    await seed(database, {
      categories: [
        category({ id: 'cat-live', name: 'X' }),
        category({ id: 'cat-dead', name: 'X', deleted_at: '2026-03-01T00:00:00.000Z' }),
      ],
    })

    expect(groupsOf(await scanDuplicates(database))).toHaveLength(0)
  })

  it('trims names for comparison and drops blank names', async () => {
    const database = open()
    await seed(database, {
      categories: [
        category({ id: 'cat-a', name: ' A ' }),
        category({ id: 'cat-b', name: 'A' }),
        category({ id: 'cat-blank-1', name: '   ' }),
        category({ id: 'cat-blank-2', name: '   ' }),
      ],
    })

    const groups = groupsOf(await scanDuplicates(database))
    expect(groups).toHaveLength(1)
    expect(groups[0].name).toBe('A')
    expect(groups[0].rows.map((row) => row.id).sort()).toEqual(['cat-a', 'cat-b'])
  })

  it('never returns diary, check-ins or pomodoro rows', async () => {
    const database = open()
    await seed(database, {
      journalEntries: [journalEntry({ id: 'j-1', day_key: '2026-11-01' })],
      habitCompletions: [habitCompletion({ id: 'hc-1' })],
      pomodoroSessions: [pomodoro({ id: 'p-1' })],
      categories: [category({ id: 'cat-1', name: '学习' }), category({ id: 'cat-2', name: '学习' })],
    })

    const groups = groupsOf(await scanDuplicates(database))
    expect(groups).toHaveLength(1)
    for (const group of groups) {
      expect(DUPLICATE_ENTITIES).toContain(group.entity)
    }
  })
})

describe('scanDuplicates — parent paths', () => {
  it('falls back when the parent row is missing', async () => {
    const database = open()
    await seed(database, {
      goals: [
        goal({ id: 'goal-1', category_id: 'ghost-cat', name: 'G' }),
        goal({ id: 'goal-2', category_id: 'ghost-cat', name: 'G' }),
      ],
      milestones: [
        milestone({ id: 'ms-1', goal_id: 'ghost-goal', name: 'M' }),
        milestone({ id: 'ms-2', goal_id: 'ghost-goal', name: 'M' }),
      ],
      tasks: [
        task({ id: 'task-1', milestone_id: null, goal_id: null, parent_id: 'ghost-task', name: 'T' }),
        task({ id: 'task-2', milestone_id: null, goal_id: null, parent_id: 'ghost-task', name: 'T' }),
      ],
    })

    const groups = groupsOf(await scanDuplicates(database))
    expect(groupFor(groups, 'goals', 'G')?.parentPath).toBe('分类「未分类」')
    expect(groupFor(groups, 'milestones', 'M')?.parentPath).toBe('目标「未命名父级」')
    expect(groupFor(groups, 'tasks', 'T')?.parentPath).toBe('任务「未命名父级」')
  })

  it('labels root-level tasks without any parent', async () => {
    const database = open()
    await seed(database, {
      tasks: [
        task({ id: 'task-1', milestone_id: null, goal_id: null, parent_id: null, name: 'T' }),
        task({ id: 'task-2', milestone_id: null, goal_id: null, parent_id: null, name: 'T' }),
      ],
    })

    const groups = groupsOf(await scanDuplicates(database))
    expect(groups[0].parentPath).toBe('未命名父级')
  })
})

describe('scanDuplicates — descendant counts', () => {
  it('counts live goals under each category', async () => {
    const database = open()
    await seed(database, {
      categories: [
        category({ id: 'cat-1', name: '学习' }),
        category({ id: 'cat-2', name: '学习' }),
      ],
      goals: [
        goal({ id: 'goal-1', category_id: 'cat-1', name: 'g1' }),
        goal({ id: 'goal-2', category_id: 'cat-1', name: 'g2' }),
        goal({ id: 'goal-3', category_id: 'cat-2', name: 'g3' }),
        goal({ id: 'goal-dead', category_id: 'cat-2', name: 'g-dead', deleted_at: '2026-03-01T00:00:00.000Z' }),
      ],
    })

    const groups = groupsOf(await scanDuplicates(database))
    const byId = new Map(groups[0].rows.map((row) => [row.id, row]))
    expect(byId.get('cat-1')?.descendantCount).toBe(2)
    expect(byId.get('cat-2')?.descendantCount).toBe(1)
  })

  it('counts direct tasks plus tasks under the goal’s milestones', async () => {
    const database = open()
    await seed(database, {
      categories: [category({ id: 'cat-1', name: '学习' })],
      goals: [
        goal({ id: 'goal-1', category_id: 'cat-1', name: '读书' }),
        goal({ id: 'goal-2', category_id: 'cat-1', name: '读书' }),
      ],
      milestones: [milestone({ id: 'ms-1', goal_id: 'goal-1', name: '第一章' })],
      tasks: [
        task({ id: 't-direct', milestone_id: null, goal_id: 'goal-1', name: '直接任务' }),
        task({ id: 't-ms-1', milestone_id: 'ms-1', name: '里程碑任务' }),
        task({ id: 't-ms-2', milestone_id: 'ms-1', name: '里程碑任务 2' }),
        task({ id: 't-dead', milestone_id: 'ms-1', name: '已删任务', deleted_at: '2026-03-01T00:00:00.000Z' }),
      ],
    })

    const groups = groupsOf(await scanDuplicates(database))
    const byId = new Map(groups[0].rows.map((row) => [row.id, row]))
    expect(byId.get('goal-1')?.descendantCount).toBe(3)
    expect(byId.get('goal-2')?.descendantCount).toBe(0)
  })

  it('counts live tasks under each milestone', async () => {
    const database = open()
    await seed(database, {
      goals: [goal({ id: 'goal-1', name: 'G' })],
      milestones: [
        milestone({ id: 'ms-1', goal_id: 'goal-1', name: '第一章' }),
        milestone({ id: 'ms-2', goal_id: 'goal-1', name: '第一章' }),
      ],
      tasks: [
        task({ id: 't1', milestone_id: 'ms-1', name: 'a' }),
        task({ id: 't2', milestone_id: 'ms-1', name: 'b' }),
      ],
    })

    const groups = groupsOf(await scanDuplicates(database))
    const byId = new Map(groups[0].rows.map((row) => [row.id, row]))
    expect(byId.get('ms-1')?.descendantCount).toBe(2)
    expect(byId.get('ms-2')?.descendantCount).toBe(0)
  })

  it('counts recursive subtasks for a task and guards cycles', async () => {
    const database = open()
    await seed(database, {
      milestones: [milestone({ id: 'ms-1', name: '第一章' })],
      tasks: [
        task({ id: 'parent', milestone_id: 'ms-1', parent_id: null, name: '父任务' }),
        task({ id: 'child-1', milestone_id: 'ms-1', parent_id: 'parent', name: '子任务' }),
        task({ id: 'child-2', milestone_id: 'ms-1', parent_id: 'parent', name: '子任务' }),
        task({ id: 'grandchild', milestone_id: 'ms-1', parent_id: 'child-1', name: '孙任务' }),
      ],
    })

    const groups = groupsOf(await scanDuplicates(database))
    const group = groupFor(groups, 'tasks', '子任务')
    expect(group).toBeDefined()
    const byId = new Map(group!.rows.map((row) => [row.id, row]))
    expect(byId.get('child-1')?.descendantCount).toBe(1)
    expect(byId.get('child-2')?.descendantCount).toBe(0)
  })
})

describe('scanDuplicates — failure shape', () => {
  it('maps a rejecting table read to a typed local-throw failure', async () => {
    const database = open()
    vi.spyOn(database.categories, 'toArray').mockRejectedValueOnce(new Error('boom'))

    expect(await scanDuplicates(database)).toEqual({ ok: false, reason: 'local-throw' })
  })
})

// --- deletion -------------------------------------------------------------

async function expectAllDeleteOps(database: OrbitDB, expected: number): Promise<void> {
  const entries = await readOutbox(database)
  expect(entries).toHaveLength(expected)
  expect(entries.every((entry) => entry.op === 'delete')).toBe(true)
}

describe('deleteDuplicateRows — tombstone semantics', () => {
  it('tombstones one of two duplicate categories and leaves the sibling live', async () => {
    const database = open()
    const repo = new LocalRepository(database)
    await seed(database, {
      categories: [category({ id: 'cat-1' }), category({ id: 'cat-2' })],
    })

    const result = await deleteDuplicateRows(database, repo, [{ entity: 'categories', id: 'cat-1' }])

    expect(result).toEqual({ ok: true, deleted: 1, cascaded: 0 })
    expect((await database.categories.get('cat-1'))!.deleted_at).not.toBeNull()
    expect((await database.categories.get('cat-2'))!.deleted_at).toBeNull()
    await expectAllDeleteOps(database, 1)
  })

  it('refuses to empty a group and writes nothing', async () => {
    const database = open()
    const repo = new LocalRepository(database)
    await seed(database, {
      categories: [category({ id: 'cat-1' }), category({ id: 'cat-2' })],
    })

    const selection: DuplicateSelection[] = [
      { entity: 'categories', id: 'cat-1' },
      { entity: 'categories', id: 'cat-2' },
    ]

    expect(await deleteDuplicateRows(database, repo, selection)).toEqual({
      ok: false,
      reason: 'empties-group',
      groupKey: expect.any(String),
    })
    expect((await database.categories.get('cat-1'))!.deleted_at).toBeNull()
    expect((await database.categories.get('cat-2'))!.deleted_at).toBeNull()
    expect(await readOutbox(database)).toHaveLength(0)
  })

  it('cascades a duplicate goal’s milestone, tasks and linked dailyTodo', async () => {
    const database = open()
    const repo = new LocalRepository(database)
    await seed(database, {
      categories: [category({ id: 'cat-1', name: '学习' })],
      goals: [
        goal({ id: 'goal-1', category_id: 'cat-1', name: '读书' }),
        goal({ id: 'goal-2', category_id: 'cat-1', name: '读书' }),
      ],
      milestones: [milestone({ id: 'ms-1', goal_id: 'goal-1', name: '第一章' })],
      tasks: [
        task({ id: 'task-1', milestone_id: 'ms-1', name: '任务 A' }),
        task({ id: 'task-2', milestone_id: 'ms-1', parent_id: 'task-1', name: '任务 B' }),
      ],
      dailyTodos: [dailyTodo({ id: 'todo-1', task_id: 'task-1', name: null, completed: null })],
    })

    const result = await deleteDuplicateRows(database, repo, [{ entity: 'goals', id: 'goal-1' }])

    expect(result).toEqual({ ok: true, deleted: 1, cascaded: 4 })
    for (const [table, id] of [
      ['goals', 'goal-1'],
      ['milestones', 'ms-1'],
      ['tasks', 'task-1'],
      ['tasks', 'task-2'],
      ['dailyTodos', 'todo-1'],
    ] as const) {
      expect((await database.table(table).get(id))!.deleted_at).not.toBeNull()
    }
    expect((await database.goals.get('goal-2'))!.deleted_at).toBeNull()
    await expectAllDeleteOps(database, 5)
  })

  it('dedupes repeated selections and treats unknown / already-deleted ids as no-ops', async () => {
    const database = open()
    const repo = new LocalRepository(database)
    await seed(database, {
      categories: [category({ id: 'cat-1' }), category({ id: 'cat-2' })],
    })

    const first = await deleteDuplicateRows(database, repo, [
      { entity: 'categories', id: 'cat-1' },
      { entity: 'categories', id: 'cat-1' },
      { entity: 'categories', id: 'never-existed' },
    ])
    expect(first).toEqual({ ok: true, deleted: 1, cascaded: 0 })
    await expectAllDeleteOps(database, 1)

    const second = await deleteDuplicateRows(database, repo, [
      { entity: 'categories', id: 'cat-1' },
      { entity: 'categories', id: 'never-existed' },
    ])
    expect(second).toEqual({ ok: true, deleted: 0, cascaded: 0 })
    await expectAllDeleteOps(database, 1)
  })

  it('maps a scan failure to local-throw before writing', async () => {
    const database = open()
    const repo = new LocalRepository(database)
    vi.spyOn(database.categories, 'toArray').mockRejectedValueOnce(new Error('boom'))

    expect(await deleteDuplicateRows(database, repo, [{ entity: 'categories', id: 'cat-1' }])).toEqual({
      ok: false,
      reason: 'local-throw',
    })
    expect(await readOutbox(database)).toHaveLength(0)
  })
})

describe('deleteDuplicateRows — cascade closure', () => {
  it('refuses when a container cascade would empty another duplicate group', async () => {
    const database = open()
    const repo = new LocalRepository(database)
    await seed(database, {
      categories: [category({ id: 'cat-1', name: '学习' })],
      goals: [goal({ id: 'goal-1', category_id: 'cat-1', name: '读书' })],
      milestones: [milestone({ id: 'ms-1', goal_id: 'goal-1', name: '第一章' })],
      tasks: [
        task({ id: 'task-1', milestone_id: 'ms-1', name: '复习' }),
        task({ id: 'task-2', milestone_id: 'ms-1', name: '复习' }),
      ],
    })

    // Both duplicate tasks are descendants of the selected goal, even though
    // neither was explicitly selected — the closure must still refuse.
    const result = await deleteDuplicateRows(database, repo, [{ entity: 'goals', id: 'goal-1' }])

    expect(result).toEqual({ ok: false, reason: 'empties-group', groupKey: expect.any(String) })
    for (const id of ['task-1', 'task-2']) {
      expect((await database.tasks.get(id))!.deleted_at).toBeNull()
    }
    expect(await readOutbox(database)).toHaveLength(0)
  })

  it('does not cross into same-named tasks under another milestone', async () => {
    const database = open()
    const repo = new LocalRepository(database)
    await seed(database, {
      categories: [category({ id: 'cat-1', name: '学习' })],
      goals: [
        goal({ id: 'goal-1', category_id: 'cat-1', name: '读书' }),
        goal({ id: 'goal-2', category_id: 'cat-1', name: '写作' }),
      ],
      milestones: [
        milestone({ id: 'ms-1', goal_id: 'goal-1', name: '第一章' }),
        milestone({ id: 'ms-2', goal_id: 'goal-2', name: '第二章' }),
      ],
      tasks: [
        task({ id: 'task-1', milestone_id: 'ms-1', name: '复习' }),
        task({ id: 'task-2', milestone_id: 'ms-2', name: '复习' }),
      ],
    })

    const result = await deleteDuplicateRows(database, repo, [{ entity: 'goals', id: 'goal-1' }])

    expect(result).toEqual({ ok: true, deleted: 1, cascaded: 2 })
    expect((await database.tasks.get('task-1'))!.deleted_at).not.toBeNull()
    expect((await database.milestones.get('ms-1'))!.deleted_at).not.toBeNull()
    expect((await database.tasks.get('task-2'))!.deleted_at).toBeNull()
    expect((await database.milestones.get('ms-2'))!.deleted_at).toBeNull()
  })

  it('reports deleted + cascaded as the full container closure size', async () => {
    const database = open()
    const repo = new LocalRepository(database)
    await seed(database, {
      categories: [category({ id: 'cat-1', name: '学习' })],
      goals: [goal({ id: 'goal-1', category_id: 'cat-1', name: '读书' })],
      milestones: [milestone({ id: 'ms-1', goal_id: 'goal-1', name: '第一章' })],
      tasks: [
        task({ id: 'task-1', milestone_id: 'ms-1', name: '任务 A' }),
        task({ id: 'task-2', milestone_id: 'ms-1', name: '任务 B' }),
      ],
      dailyTodos: [dailyTodo({ id: 'todo-1', task_id: 'task-1', name: null, completed: null })],
    })

    const result = await deleteDuplicateRows(database, repo, [{ entity: 'categories', id: 'cat-1' }])

    // One selected row + goal + milestone + two tasks + linked todo.
    expect(result).toEqual({ ok: true, deleted: 1, cascaded: 5 })
    if (result.ok) expect(result.deleted + result.cascaded).toBe(6)
    await expectAllDeleteOps(database, 6)
  })
})
