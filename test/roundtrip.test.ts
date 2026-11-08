import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/local-db'
import { getRepository } from '@/lib/repository-provider'
import { importData } from '@/lib/data-import'
import { EXPORT_ENTITIES, EXPORT_FORMAT, EXPORT_VERSION } from '@/lib/data-export'
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
 * Data-portability round-trip proof (success criterion #3).
 *
 * Builds the exact orbit-export v6 contract and feeds it through importData():
 *  - a live + a tombstoned Category survive with ids, updated_at, and
 *    deleted_at byte-identical to the input
 *  - a fully valid contract writes the expected per-entity row counts
 *  - a bad row in the LAST entity rolls back all eight tables (atomicity)
 *  - a wrong format identifier throws with zero writes
 *
 * The v6 contract adds habits + habitCompletions; both are proven byte-for-byte
 * including tombstones, and habitCompletions is now the LAST export entity.
 */

function contract(
  data: Partial<
    Record<
      | 'categories'
      | 'goals'
      | 'milestones'
      | 'tasks'
      | 'dailyTodos'
      | 'journalEntries'
      | 'habits'
      | 'habitCompletions'
      | 'pomodoroSessions',
      unknown[]
    >
  > = {},
) {
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      categories: [],
      goals: [],
      milestones: [],
      tasks: [],
      dailyTodos: [],
      journalEntries: [],
      habits: [],
      habitCompletions: [],
      pomodoroSessions: [],
      ...data,
    },
  })
}

async function reset() {
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear()
  })
}

async function counts() {
  return {
    categories: await db.categories.count(),
    goals: await db.goals.count(),
    milestones: await db.milestones.count(),
    tasks: await db.tasks.count(),
    dailyTodos: await db.dailyTodos.count(),
    journalEntries: await db.journalEntries.count(),
    habits: await db.habits.count(),
    habitCompletions: await db.habitCompletions.count(),
    pomodoroSessions: await db.pomodoroSessions.count(),
  }
}

const liveCategory: Category = {
  id: 'category-live',
  name: 'Ship Orbit',
  created_at: '2026-01-01T00:00:00.000Z',
  sort_order: 1,
  updated_at: '2026-02-01T00:00:00.000Z',
  deleted_at: null,
}

const tombstonedCategory: Category = {
  id: 'category-tombstoned',
  name: 'Archived category',
  created_at: '2026-01-02T00:00:00.000Z',
  sort_order: 2,
  updated_at: '2026-03-01T00:00:00.000Z',
  deleted_at: '2026-04-01T00:00:00.000Z',
}

const goal: Goal = {
  id: 'goal-1',
  category_id: liveCategory.id,
  name: 'First goal',
  created_at: '2026-01-03T00:00:00.000Z',
  sort_order: 1,
  updated_at: '2026-02-03T00:00:00.000Z',
  deleted_at: null,
}

const milestone: Milestone = {
  id: 'milestone-1',
  goal_id: goal.id,
  name: 'First milestone',
  created_at: '2026-01-04T00:00:00.000Z',
  sort_order: 1,
  updated_at: '2026-02-04T00:00:00.000Z',
  deleted_at: null,
}

const task: Task = {
  id: 'task-1',
  milestone_id: milestone.id,
  goal_id: null,
  parent_id: null,
  name: 'First task',
  progress_type: 'checkbox',
  unit: null,
  target_value: null,
  current_value: null,
  completed: true,
  completed_at: '2026-03-03T00:00:00.000Z',
  created_at: '2026-01-05T00:00:00.000Z',
  sort_order: 1,
  updated_at: '2026-02-05T00:00:00.000Z',
  deleted_at: null,
}

const liveHabit: Habit = {
  id: 'habit-live',
  name: '每天跑步',
  short_name: '跑步',
  sort_order: 1,
  updated_at: '2026-06-01T00:00:00.000Z',
  deleted_at: null,
}

const tombstonedHabit: Habit = {
  id: 'habit-tombstoned',
  name: '已归档习惯',
  short_name: '归档',
  sort_order: 2,
  updated_at: '2026-06-02T00:00:00.000Z',
  deleted_at: '2026-06-03T00:00:00.000Z',
}

const liveCompletion: HabitCompletion = {
  id: 'habit-completion-live',
  habit_id: liveHabit.id,
  date: '2026-06-04',
  note: '今天跑了 5 公里',
  completed_at: '2026-06-04T07:00:00.000Z',
  updated_at: '2026-06-04T07:00:00.000Z',
  deleted_at: null,
}

const tombstonedCompletion: HabitCompletion = {
  id: 'habit-completion-tombstoned',
  habit_id: liveHabit.id,
  date: '2026-06-05',
  note: null,
  completed_at: '2026-06-05T07:00:00.000Z',
  updated_at: '2026-06-06T07:00:00.000Z',
  deleted_at: '2026-06-06T07:00:00.000Z',
}

beforeEach(async () => {
  await reset()
})

describe('orbit-export round-trip', () => {
  it('preserves ids, updated_at timestamps, and soft-delete tombstones', async () => {
    await importData(contract({ categories: [liveCategory, tombstonedCategory] }))

    const rows = await getRepository().list<Category>('categories', { includeDeleted: true })
    expect(rows).toHaveLength(2)

    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(tombstonedCategory.id)).toEqual(tombstonedCategory)
    expect(byId.get(liveCategory.id)).toEqual(liveCategory)

    const tombstone = byId.get(tombstonedCategory.id)!
    expect(tombstone.deleted_at).toBe('2026-04-01T00:00:00.000Z')
    expect(tombstone.updated_at).toBe(tombstonedCategory.updated_at)

    // Live reads still hide the tombstone.
    const liveRows = await getRepository().list<Category>('categories')
    expect(liveRows).toHaveLength(1)
    expect(liveRows[0].id).toBe(liveCategory.id)
  })

  it('writes exactly the per-entity row counts for a fully valid contract', async () => {
    await importData(
      contract({
        categories: [liveCategory, tombstonedCategory],
        goals: [goal],
        milestones: [milestone],
        tasks: [task],
      }),
    )

    expect(await counts()).toEqual({
      categories: 2,
      goals: 1,
      milestones: 1,
      tasks: 1,
      dailyTodos: 0,
      journalEntries: 0,
      habits: 0,
      habitCompletions: 0,
      pomodoroSessions: 0,
    })
  })

  it('exposes the v7 contract with the pomodoro entity appended last', () => {
    expect(EXPORT_VERSION).toBe(7)
    expect(EXPORT_ENTITIES).toContain('habits')
    expect(EXPORT_ENTITIES).toContain('habitCompletions')
    expect(EXPORT_ENTITIES).toContain('pomodoroSessions')
    expect(EXPORT_ENTITIES[EXPORT_ENTITIES.length - 1]).toBe('pomodoroSessions')
    expect(EXPORT_ENTITIES).toHaveLength(9)
  })

  it('round-trips live and tombstoned habits and completions byte-for-byte', async () => {
    const habits = [liveHabit, tombstonedHabit]
    const completions = [liveCompletion, tombstonedCompletion]

    await importData(contract({ habits, habitCompletions: completions }))

    const habitRows = await getRepository().list<Habit>('habits', { includeDeleted: true })
    const completionRows = await getRepository().list<HabitCompletion>('habitCompletions', {
      includeDeleted: true,
    })
    expect(habitRows).toHaveLength(2)
    expect(completionRows).toHaveLength(2)

    const habitsById = new Map(habitRows.map((r) => [r.id, r]))
    for (const h of habits) expect(habitsById.get(h.id)).toEqual(h)

    const completionsById = new Map(completionRows.map((r) => [r.id, r]))
    for (const c of completions) {
      expect(completionsById.get(c.id)).toEqual(c)
      expect(completionsById.get(c.id)!.note).toBe(c.note)
    }

    expect(await counts()).toEqual({
      categories: 0,
      goals: 0,
      milestones: 0,
      tasks: 0,
      dailyTodos: 0,
      journalEntries: 0,
      habits: 2,
      habitCompletions: 2,
      pomodoroSessions: 0,
    })
  })

  it('round-trips a task whose milestone_id is a real UUID', async () => {
    const uuid = crypto.randomUUID()
    const uuidMilestone: Milestone = { ...milestone, id: uuid }
    const uuidTask: Task = { ...task, milestone_id: uuid }

    await importData(
      contract({ categories: [liveCategory], goals: [goal], milestones: [uuidMilestone], tasks: [uuidTask] }),
    )

    const rows = await getRepository().list<Task>('tasks')
    expect(rows).toHaveLength(1)
    expect(rows[0].milestone_id).toBe(uuid)
  })

  it('rolls back every table when a late entity has a row missing id', async () => {
    const malformed = contract({
      categories: [liveCategory],
      goals: [goal],
      milestones: [milestone],
      tasks: [task],
      habits: [liveHabit],
      // habitCompletions is a late export entity (pomodoroSessions is now last);
      // this row has no `id`, so validation aborts before any write.
      habitCompletions: [
        { habit_id: liveHabit.id, date: '2026-06-04', note: null, completed_at: '2026-06-04T07:00:00.000Z', updated_at: '2026-06-04T07:00:00.000Z', deleted_at: null },
      ],
    })

    await expect(importData(malformed)).rejects.toThrow(/缺少字段/)

    const result = await counts()
    expect(Object.values(result).every((n) => n === 0)).toBe(true)
    expect(Object.keys(result)).toHaveLength(9)
  })

  it('rejects an id-only row instead of overwriting a complete existing row', async () => {
    await importData(contract({ categories: [liveCategory] }))
    expect(await db.categories.toArray()).toEqual([liveCategory])

    // Dexie bulkPut would accept this and replace the full row with {id}.
    await expect(importData(contract({ categories: [{ id: liveCategory.id }] }))).rejects.toThrow(/缺少字段/)

    // The complete row is untouched.
    expect(await db.categories.toArray()).toEqual([liveCategory])
  })

  it('rejects a wrong-typed field and writes nothing', async () => {
    const malformed = contract({ categories: [{ ...liveCategory, name: 42 }] })
    await expect(importData(malformed)).rejects.toThrow(/必须是字符串/)
    expect(await counts()).toEqual({
      categories: 0,
      goals: 0,
      milestones: 0,
      tasks: 0,
      dailyTodos: 0,
      journalEntries: 0,
      habits: 0,
      habitCompletions: 0,
      pomodoroSessions: 0,
    })
  })

  it('rejects a non-numeric sort_order and writes nothing', async () => {
    const malformed = contract({ categories: [{ ...liveCategory, sort_order: '5' }] })
    await expect(importData(malformed)).rejects.toThrow(/必须是数字/)
    expect(await counts()).toEqual({
      categories: 0,
      goals: 0,
      milestones: 0,
      tasks: 0,
      dailyTodos: 0,
      journalEntries: 0,
      habits: 0,
      habitCompletions: 0,
      pomodoroSessions: 0,
    })
  })

  it('accepts a legacy category without sort_order (runtime effectiveOrder fallback)', async () => {
    const legacyCategory = { ...liveCategory } as Partial<Category>
    delete legacyCategory.sort_order

    await importData(contract({ categories: [legacyCategory] }))

    const rows = await getRepository().list<Category>('categories', { includeDeleted: true })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(liveCategory.id)
    expect(rows[0].sort_order).toBeUndefined()
  })

  it('accepts a legacy milestone and task without sort_order (runtime effectiveOrder fallback)', async () => {
    const legacyMilestone = { ...milestone } as Partial<Milestone>
    delete legacyMilestone.sort_order
    const legacyTask = { ...task } as Partial<Task>
    delete legacyTask.sort_order

    await importData(
      contract({ categories: [liveCategory], goals: [goal], milestones: [legacyMilestone], tasks: [legacyTask] }),
    )

    const milestoneRows = await getRepository().list<Milestone>('milestones', { includeDeleted: true })
    const taskRows = await getRepository().list<Task>('tasks', { includeDeleted: true })
    expect(milestoneRows).toHaveLength(1)
    expect(taskRows).toHaveLength(1)
    expect(milestoneRows[0].sort_order).toBeUndefined()
    expect(taskRows[0].sort_order).toBeUndefined()
  })

  it('rejects unknown keys and writes nothing', async () => {
    const malformed = contract({ categories: [{ ...liveCategory, injected_column: 'x' }] })
    await expect(importData(malformed)).rejects.toThrow(/未知字段/)
    expect(await counts()).toEqual({
      categories: 0,
      goals: 0,
      milestones: 0,
      tasks: 0,
      dailyTodos: 0,
      journalEntries: 0,
      habits: 0,
      habitCompletions: 0,
      pomodoroSessions: 0,
    })
  })

  it('rejects a non-ISO timestamp so incremental sync comparisons stay valid', async () => {
    const malformed = contract({ categories: [{ ...liveCategory, updated_at: 'not-a-date' }] })
    await expect(importData(malformed)).rejects.toThrow(/ISO 时间戳/)
    expect(await counts()).toEqual({
      categories: 0,
      goals: 0,
      milestones: 0,
      tasks: 0,
      dailyTodos: 0,
      journalEntries: 0,
      habits: 0,
      habitCompletions: 0,
      pomodoroSessions: 0,
    })
  })

  it('rejects a wrong format identifier and writes nothing', async () => {
    const wrongFormat = JSON.stringify({
      format: 'diary-web-export',
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      data: { categories: [liveCategory], goals: [], milestones: [], tasks: [] },
    })

    await expect(importData(wrongFormat)).rejects.toThrow(/文件格式不匹配/)
    expect(await counts()).toEqual({
      categories: 0,
      goals: 0,
      milestones: 0,
      tasks: 0,
      dailyTodos: 0,
      journalEntries: 0,
      habits: 0,
      habitCompletions: 0,
      pomodoroSessions: 0,
    })
  })

  // T-06-02: the allowlist must check OWN properties. A plain `key in shape`
  // accepts prototype-named keys (__proto__/constructor/toString) because they
  // live on Object.prototype. Each case below carries a real own enumerable key
  // (computed keys / JSON.parse), so the allowlist is genuinely exercised.
  it('rejects an own __proto__ key as an unknown field and writes nothing', async () => {
    const crafted = { ...liveCategory, ['__proto__']: 'x' }
    expect(Object.prototype.hasOwnProperty.call(crafted, '__proto__')).toBe(true)

    await expect(importData(contract({ categories: [crafted] }))).rejects.toThrow(/未知字段/)
    expect(await counts()).toEqual({
      categories: 0,
      goals: 0,
      milestones: 0,
      tasks: 0,
      dailyTodos: 0,
      journalEntries: 0,
      habits: 0,
      habitCompletions: 0,
      pomodoroSessions: 0,
    })
  })

  it('rejects an own constructor key as an unknown field and writes nothing', async () => {
    const crafted = { ...liveCategory, ['constructor']: 'x' }
    expect(Object.prototype.hasOwnProperty.call(crafted, 'constructor')).toBe(true)

    await expect(importData(contract({ categories: [crafted] }))).rejects.toThrow(/未知字段/)
    expect(await counts()).toEqual({
      categories: 0,
      goals: 0,
      milestones: 0,
      tasks: 0,
      dailyTodos: 0,
      journalEntries: 0,
      habits: 0,
      habitCompletions: 0,
      pomodoroSessions: 0,
    })
  })

  it('rejects an own toString key as an unknown field and writes nothing', async () => {
    const crafted = { ...liveCategory, ['toString']: 'x' }
    expect(Object.prototype.hasOwnProperty.call(crafted, 'toString')).toBe(true)

    // JSON.parse path proves the key survives serialization as an OWN property.
    const parsed = JSON.parse(JSON.stringify(crafted)) as Record<string, unknown>
    expect(Object.keys(parsed)).toContain('toString')

    await expect(importData(contract({ categories: [crafted] }))).rejects.toThrow(/未知字段/)
    expect(await counts()).toEqual({
      categories: 0,
      goals: 0,
      milestones: 0,
      tasks: 0,
      dailyTodos: 0,
      journalEntries: 0,
      habits: 0,
      habitCompletions: 0,
      pomodoroSessions: 0,
    })
  })
})

// ── v3 task contract + cross-row invariants (D-01/D-02/D-05) ──

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    milestone_id: milestone.id,
    goal_id: null,
    parent_id: null,
    name: 'Task',
    progress_type: 'checkbox',
    unit: null,
    target_value: null,
    current_value: null,
    completed: false,
    completed_at: null,
    created_at: '2026-01-05T00:00:00.000Z',
    sort_order: 1,
    updated_at: '2026-02-05T00:00:00.000Z',
    deleted_at: null,
    ...over,
  }
}

async function expectRelationReject(tasks: Task[], pattern: RegExp) {
  await expect(
    importData(
      contract({
        categories: [liveCategory],
        goals: [goal],
        milestones: [milestone],
        tasks,
      }),
    ),
  ).rejects.toThrow(pattern)
  expect(await counts()).toEqual({
      categories: 0,
      goals: 0,
      milestones: 0,
      tasks: 0,
      dailyTodos: 0,
      journalEntries: 0,
      habits: 0,
      habitCompletions: 0,
      pomodoroSessions: 0,
    })
}

describe('orbit-export v3 task round-trip', () => {
  it('round-trips quantity, direct, and nested tasks field-for-field', async () => {
    const quantityTask = baseTask({
      id: 'task-quantity',
      progress_type: 'quantity',
      unit: '页',
      target_value: 100,
      current_value: 40,
    })
    const directTask = baseTask({
      id: 'task-direct',
      milestone_id: null,
      goal_id: goal.id,
    })
    const subtask = baseTask({ id: 'task-subtask', parent_id: 'task-1' })
    const input = [baseTask({ id: 'task-1' }), quantityTask, directTask, subtask]

    await importData(
      contract({ categories: [liveCategory], goals: [goal], milestones: [milestone], tasks: input }),
    )

    const rows = await getRepository().list<Task>('tasks', { includeDeleted: true })
    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const t of input) expect(byId.get(t.id)).toEqual(t)
  })

  it('default-fills a v2 backup through normalizeTaskV3 on import', async () => {
    const v2Task = {
      id: 'task-v2',
      milestone_id: milestone.id,
      name: 'Legacy task',
      completed: false,
      completed_at: null,
      created_at: '2026-01-05T00:00:00.000Z',
      sort_order: 1,
      updated_at: '2026-02-05T00:00:00.000Z',
      deleted_at: null,
    }
    const v2 = JSON.stringify({
      format: EXPORT_FORMAT,
      version: 2,
      exportedAt: new Date().toISOString(),
      data: {
        categories: [liveCategory],
        goals: [goal],
        milestones: [milestone],
        tasks: [v2Task],
      },
    })

    await importData(v2)

    const rows = await getRepository().list<Task>('tasks', { includeDeleted: true })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      ...v2Task,
      goal_id: null,
      parent_id: null,
      progress_type: 'checkbox',
      unit: null,
      target_value: null,
      current_value: null,
    })
  })
})

describe('validateTaskRelations rejects invalid task trees before writing', () => {
  it('rejects a parent_id that does not exist in the same array', async () => {
    await expectRelationReject([baseTask({ parent_id: 'ghost' })], /父任务 "ghost" 不存在/)
  })

  it('rejects a parent in a different milestone', async () => {
    await expectRelationReject(
      [
        baseTask({ id: 'parent', milestone_id: 'milestone-a' }),
        baseTask({ id: 'child', parent_id: 'parent', milestone_id: 'milestone-b' }),
      ],
      /不属于同一里程碑/,
    )
  })

  it('rejects a parent/child cycle', async () => {
    await expectRelationReject(
      [
        baseTask({ id: 'a', parent_id: 'b' }),
        baseTask({ id: 'b', parent_id: 'a' }),
      ],
      /存在环/,
    )
  })

  it('rejects a tree deeper than three levels', async () => {
    await expectRelationReject(
      [
        baseTask({ id: 'l1' }),
        baseTask({ id: 'l2', parent_id: 'l1' }),
        baseTask({ id: 'l3', parent_id: 'l2' }),
        baseTask({ id: 'l4', parent_id: 'l3' }),
      ],
      /超过 3 层嵌套/,
    )
  })

  it('rejects a direct task without a goal', async () => {
    await expectRelationReject(
      [baseTask({ milestone_id: null, goal_id: null })],
      /直接任务，必须属于某个目标/,
    )
  })

  it('rejects invalid quantity fields and checkbox tasks carrying quantity fields', async () => {
    await expectRelationReject(
      [baseTask({ progress_type: 'quantity', unit: '  ', target_value: 10, current_value: 0 })],
      /单位不能为空/,
    )
    await expectRelationReject(
      [baseTask({ progress_type: 'quantity', unit: '页', target_value: 0, current_value: 0 })],
      /目标量必须大于 0/,
    )
    await expectRelationReject(
      [baseTask({ progress_type: 'quantity', unit: '页', target_value: 10, current_value: -1 })],
      /已做量不能为负/,
    )
    await expectRelationReject(
      [baseTask({ progress_type: 'checkbox', unit: '页' })],
      /使用勾选进度/,
    )
  })
})

// ── v4 daily contract + cross-row invariants (DAILY-04) ──

const standaloneTodo: DailyTodo = {
  id: 'daily-standalone',
  task_id: null,
  name: '买牛奶',
  completed: false,
  completed_at: null,
  added_at: '2026-05-01T00:00:00.000Z',
  updated_at: '2026-05-01T00:00:00.000Z',
  deleted_at: null,
}

const tombstonedTodo: DailyTodo = {
  id: 'daily-tombstoned',
  task_id: null,
  name: '旧待办',
  completed: true,
  completed_at: '2026-05-02T00:00:00.000Z',
  added_at: '2026-04-20T00:00:00.000Z',
  updated_at: '2026-05-02T00:00:00.000Z',
  deleted_at: '2026-05-02T00:00:00.000Z',
}

function linkedTodo(id: string, taskId: string, over: Partial<DailyTodo> = {}): DailyTodo {
  return {
    id,
    task_id: taskId,
    name: null,
    completed: null,
    completed_at: null,
    added_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    deleted_at: null,
    ...over,
  }
}

async function expectDailyReject(daily: DailyTodo[], pattern: RegExp) {
  await expect(
    importData(
      contract({
        categories: [liveCategory],
        goals: [goal],
        milestones: [milestone],
        tasks: [task],
        dailyTodos: daily,
      }),
    ),
  ).rejects.toThrow(pattern)
  expect(await counts()).toEqual({
    categories: 0,
    goals: 0,
    milestones: 0,
    tasks: 0,
    dailyTodos: 0,
    journalEntries: 0,
    habits: 0,
    habitCompletions: 0,
    pomodoroSessions: 0,
  })
}

describe('orbit-export v5 daily round-trip', () => {
  it('round-trips standalone, tombstoned, linked, and dangling rows byte-for-byte', async () => {
    const linked = linkedTodo('daily-linked', task.id)
    // A dangling task_id is legitimate after a hard delete — import must accept it.
    const dangling = linkedTodo('daily-dangling', 'task-hard-deleted')
    const input = [standaloneTodo, tombstonedTodo, linked, dangling]

    await importData(
      contract({
        categories: [liveCategory],
        goals: [goal],
        milestones: [milestone],
        tasks: [task],
        dailyTodos: input,
      }),
    )

    const rows = await getRepository().list<DailyTodo>('dailyTodos', { includeDeleted: true })
    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const t of input) expect(byId.get(t.id)).toEqual(t)
    expect(await db.dailyTodos.count()).toBe(4)
  })

  it('rejects a linked row that carries a completion state and writes nothing', async () => {
    await expectDailyReject(
      [linkedTodo('daily-linked', task.id, { completed: true })],
      /关联任务时不能携带名称或完成状态/,
    )
  })

  it('rejects two live linked rows sharing a task_id and writes nothing', async () => {
    await expectDailyReject(
      [linkedTodo('daily-a', task.id), linkedTodo('daily-b', task.id)],
      /重复关联/,
    )
  })

  it('rejects a standalone row without a name and writes nothing', async () => {
    await expectDailyReject(
      [{ ...standaloneTodo, name: null }],
      /名称不能为空/,
    )
  })

  it('imports a v3 backup with an empty daily list, ignoring a stray dailyTodos key', async () => {
    const v3 = JSON.stringify({
      format: EXPORT_FORMAT,
      version: 3,
      exportedAt: new Date().toISOString(),
      data: {
        categories: [liveCategory],
        goals: [goal],
        milestones: [milestone],
        tasks: [task],
        // Predates the daily layer; v3 must ignore this rather than validate it.
        dailyTodos: [standaloneTodo],
      },
    })

    await importData(v3)

    expect(await counts()).toEqual({
      categories: 1,
      goals: 1,
      milestones: 1,
      tasks: 1,
      dailyTodos: 0,
      journalEntries: 0,
      habits: 0,
      habitCompletions: 0,
      pomodoroSessions: 0,
    })
  })
})

// ── v5 journal contract (JOURNAL-03) ──

const liveJournal: JournalEntry = {
  id: 'journal-2026-06-01',
  day_key: '2026-06-01',
  content: '今天写下了第一篇日记',
  updated_at: '2026-06-01T10:00:00.000Z',
  deleted_at: null,
}

const tombstonedJournal: JournalEntry = {
  id: 'journal-2026-06-02',
  day_key: '2026-06-02',
  content: '',
  updated_at: '2026-06-02T10:00:00.000Z',
  deleted_at: '2026-06-03T10:00:00.000Z',
}

describe('orbit-export v5 journal round-trip', () => {
  it('round-trips a live and a tombstoned journal row byte-for-byte', async () => {
    const input = [liveJournal, tombstonedJournal]

    await importData(contract({ journalEntries: input }))

    const rows = await getRepository().list<JournalEntry>('journalEntries', {
      includeDeleted: true,
    })
    expect(rows).toHaveLength(2)

    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const entry of input) expect(byId.get(entry.id)).toEqual(entry)

    // Live reads still hide the tombstone.
    const liveRows = await getRepository().list<JournalEntry>('journalEntries')
    expect(liveRows.map((r) => r.id)).toEqual([liveJournal.id])
  })

  it('rejects duplicate journal days before writing anything', async () => {
    const duplicate = {
      ...liveJournal,
      id: 'journal-duplicate',
      deleted_at: '2026-06-09T10:00:00.000Z',
    }

    await expect(
      importData(contract({ journalEntries: [liveJournal, duplicate] })),
    ).rejects.toThrow(/重复日期/)

    expect(await counts()).toEqual({
      categories: 0,
      goals: 0,
      milestones: 0,
      tasks: 0,
      dailyTodos: 0,
      journalEntries: 0,
      habits: 0,
      habitCompletions: 0,
      pomodoroSessions: 0,
    })
  })
})

// ── v7 pomodoro contract + cross-row invariants (POMODO-03) ──

const liveSession: PomodoroSession = {
  id: 'session-live',
  started_at: '2026-10-31T09:00:00.000Z',
  duration_sec: 1500,
  notes: ['写完了第一段', '再记一条'],
  habit_id: liveHabit.id,
  task_id: null,
  daily_todo_id: null,
  marked_task_complete: false,
  progress_amount: null,
  shared_indices: [0],
  updated_at: '2026-10-31T09:25:00.000Z',
  deleted_at: null,
}

const tombstonedSession: PomodoroSession = {
  id: 'session-tombstoned',
  started_at: '2026-10-31T10:00:00.000Z',
  duration_sec: 420,
  notes: [],
  habit_id: null,
  task_id: null,
  daily_todo_id: null,
  marked_task_complete: false,
  progress_amount: null,
  shared_indices: [],
  updated_at: '2026-10-31T10:07:00.000Z',
  deleted_at: '2026-10-31T11:00:00.000Z',
}

async function expectSessionReject(sessions: PomodoroSession[], pattern: RegExp) {
  await expect(importData(contract({ pomodoroSessions: sessions }))).rejects.toThrow(pattern)
  expect(await counts()).toEqual({
    categories: 0,
    goals: 0,
    milestones: 0,
    tasks: 0,
    dailyTodos: 0,
    journalEntries: 0,
    habits: 0,
    habitCompletions: 0,
    pomodoroSessions: 0,
  })
}

describe('orbit-export v7 pomodoro round-trip', () => {
  it('round-trips live and tombstoned sessions with notes and shared_indices byte-for-byte', async () => {
    const input = [liveSession, tombstonedSession]

    await importData(contract({ pomodoroSessions: input }))

    const rows = await getRepository().list<PomodoroSession>('pomodoroSessions', {
      includeDeleted: true,
    })
    expect(rows).toHaveLength(2)

    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const s of input) {
      expect(byId.get(s.id)).toEqual(s)
      expect(byId.get(s.id)!.notes).toEqual(s.notes)
      expect(byId.get(s.id)!.shared_indices).toEqual(s.shared_indices)
    }
    expect(await counts()).toEqual({
      categories: 0,
      goals: 0,
      milestones: 0,
      tasks: 0,
      dailyTodos: 0,
      journalEntries: 0,
      habits: 0,
      habitCompletions: 0,
      pomodoroSessions: 2,
    })
  })

  it('rejects a session linking both a task and a daily todo with zero writes', async () => {
    await expectSessionReject(
      [
        {
          ...liveSession,
          id: 'session-xor',
          task_id: 'task-1',
          daily_todo_id: 'daily-1',
          habit_id: null,
          shared_indices: [],
        },
      ],
      /不能同时关联/,
    )
  })

  it('rejects a shared index equal to notes.length with zero writes', async () => {
    await expectSessionReject(
      [
        {
          ...liveSession,
          id: 'session-bad-index',
          notes: ['只有一条'],
          shared_indices: [1],
        },
      ],
      /分发下标越界/,
    )
  })
})
