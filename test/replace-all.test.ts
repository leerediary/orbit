import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/local-db'
import { getLocalRepository } from '@/lib/repository-provider'
import { importData } from '@/lib/data-import'
import { EXPORT_FORMAT, EXPORT_VERSION } from '@/lib/data-export'
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
 * D-01 proof: import is a 整库替换 (true restore), not a merge-by-id upsert.
 *
 *  - rows created after the backup are discarded (all eight tables cleared)
 *  - the backup's rows survive byte-for-byte (ids, timestamps, tombstones)
 *  - legacy rows without sort_order stay without sort_order
 *  - a failure mid-replace rolls back every clear (atomicity)
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

const categoryA: Category = {
  id: 'category-a',
  name: 'Pre-existing A',
  created_at: '2026-05-01T00:00:00.000Z',
  sort_order: 1,
  updated_at: '2026-05-01T00:00:00.000Z',
  deleted_at: null,
}

const categoryB: Category = {
  id: 'category-b',
  name: 'Pre-existing B',
  created_at: '2026-05-02T00:00:00.000Z',
  sort_order: 2,
  updated_at: '2026-05-02T00:00:00.000Z',
  deleted_at: null,
}

const backupCategory: Category = {
  id: 'category-backup',
  name: 'Only in the backup',
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
  category_id: backupCategory.id,
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

const dailyTodo: DailyTodo = {
  id: 'daily-1',
  task_id: null,
  name: '买牛奶',
  completed: false,
  completed_at: null,
  added_at: '2026-05-03T00:00:00.000Z',
  updated_at: '2026-05-03T00:00:00.000Z',
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

const journalEntry: JournalEntry = {
  id: 'journal-2026-05-03',
  day_key: '2026-05-03',
  content: '备份之外的日记',
  updated_at: '2026-05-03T00:00:00.000Z',
  deleted_at: null,
}

const backupHabit: Habit = {
  id: 'habit-backup',
  name: '每天跑步',
  short_name: '跑步',
  sort_order: 1,
  updated_at: '2026-01-06T00:00:00.000Z',
  deleted_at: null,
}

const backupCompletion: HabitCompletion = {
  id: 'habit-completion-backup',
  habit_id: backupHabit.id,
  date: '2026-05-03',
  note: '备份里的打卡',
  completed_at: '2026-05-03T07:00:00.000Z',
  updated_at: '2026-05-03T07:00:00.000Z',
  deleted_at: null,
}

// Rows that exist only in the current store (never in the backup), so the test
// proves they are discarded rather than merged.
const postBackupHabit: Habit = {
  id: 'habit-post-backup',
  name: '备份之后才创建的习惯',
  short_name: '之后',
  sort_order: 2,
  updated_at: '2026-05-10T00:00:00.000Z',
  deleted_at: null,
}

const postBackupCompletion: HabitCompletion = {
  id: 'habit-completion-post-backup',
  habit_id: postBackupHabit.id,
  date: '2026-05-10',
  note: null,
  completed_at: '2026-05-10T07:00:00.000Z',
  updated_at: '2026-05-10T07:00:00.000Z',
  deleted_at: null,
}

const backupSession: PomodoroSession = {
  id: 'session-backup',
  started_at: '2026-05-03T09:00:00.000Z',
  duration_sec: 1500,
  notes: ['备份里的番茄笔记'],
  habit_id: null,
  task_id: null,
  daily_todo_id: null,
  marked_task_complete: false,
  progress_amount: null,
  shared_indices: [],
  updated_at: '2026-05-03T09:25:00.000Z',
  deleted_at: null,
}

// Exists only in the current store (never in the backup), so the test proves it
// is discarded rather than merged.
const postBackupSession: PomodoroSession = {
  id: 'session-post-backup',
  started_at: '2026-05-10T09:00:00.000Z',
  duration_sec: 420,
  notes: [],
  habit_id: null,
  task_id: null,
  daily_todo_id: null,
  marked_task_complete: false,
  progress_amount: null,
  shared_indices: [],
  updated_at: '2026-05-10T09:07:00.000Z',
  deleted_at: null,
}

beforeEach(async () => {
  await reset()
})

describe('whole-store replace (D-01)', () => {
  it('discards rows created after the backup instead of merging by id', async () => {
    await db.categories.bulkPut([categoryA, categoryB])

    await importData(contract({ categories: [backupCategory] }))

    const rows = await db.categories.toArray()
    expect(rows.map((r) => r.id)).toEqual([backupCategory.id])
    expect(rows[0]).toEqual(backupCategory)
  })

  it('clears all nine tables when the backup is empty', async () => {
    await db.categories.bulkPut([categoryA])
    await db.goals.bulkPut([goal])
    await db.milestones.bulkPut([milestone])
    await db.tasks.bulkPut([task])
    await db.dailyTodos.bulkPut([dailyTodo])
    // Seeded through the local repository, not the backup: the whole-store
    // replace must clear it even though the backup omits journal data.
    await getLocalRepository().upsert<JournalEntry>('journalEntries', journalEntry)
    await db.habits.bulkPut([postBackupHabit])
    await db.habitCompletions.bulkPut([postBackupCompletion])
    await db.pomodoroSessions.bulkPut([postBackupSession])

    await importData(contract())

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

  it('preserves ids, updated_at timestamps, and tombstones verbatim through the replace', async () => {
    await importData(
      contract({
        categories: [backupCategory, tombstonedCategory],
        goals: [goal],
        milestones: [milestone],
        tasks: [task],
        dailyTodos: [dailyTodo],
        habits: [backupHabit],
        habitCompletions: [backupCompletion],
        pomodoroSessions: [backupSession],
      }),
    )

    const categories = await db.categories.toArray()
    const byId = new Map(categories.map((c) => [c.id, c]))
    expect(byId.get(backupCategory.id)).toEqual(backupCategory)
    expect(byId.get(tombstonedCategory.id)).toEqual(tombstonedCategory)

    expect(await db.goals.toArray()).toEqual([goal])
    expect(await db.milestones.toArray()).toEqual([milestone])
    expect(await db.tasks.toArray()).toEqual([task])
    expect(await db.dailyTodos.toArray()).toEqual([dailyTodo])
    expect(await db.habits.toArray()).toEqual([backupHabit])
    expect(await db.habitCompletions.toArray()).toEqual([backupCompletion])
    expect(await db.pomodoroSessions.toArray()).toEqual([backupSession])
  })

  it('keeps a legacy category without sort_order free of sort_order after the replace', async () => {
    const legacyCategory = { ...backupCategory } as Partial<Category>
    delete legacyCategory.sort_order

    await importData(contract({ categories: [legacyCategory] }))

    const stored = await db.categories.get(backupCategory.id)
    expect(stored).toBeDefined()
    expect(stored!.sort_order).toBeUndefined()
  })

  it('rolls back every clear when the last entity bulkPut throws', async () => {
    await db.goals.bulkPut([goal])
    await db.tasks.bulkPut([task])
    await db.habits.bulkPut([postBackupHabit])
    await db.habitCompletions.bulkPut([postBackupCompletion])
    await db.pomodoroSessions.bulkPut([postBackupSession])

    // A function is not structured-cloneable, so Dexie's bulkPut throws
    // DataCloneError AFTER every clear and the earlier writes — proving the
    // transaction rolls them ALL back rather than leaving the store wiped.
    // habitCompletions is the last written entity, so the failure lands there.
    await expect(
      getLocalRepository().replaceAll([
        ['goals', [goal]],
        ['tasks', [task]],
        ['habitCompletions', [{ id: 'bad', fn: () => 1 }]],
      ]),
    ).rejects.toThrow()

    expect((await db.goals.toArray()).map((g) => g.id)).toEqual([goal.id])
    expect((await db.tasks.toArray()).map((t) => t.id)).toEqual([task.id])
    expect((await db.habits.toArray()).map((h) => h.id)).toEqual([postBackupHabit.id])
    expect((await db.habitCompletions.toArray()).map((c) => c.id)).toEqual([
      postBackupCompletion.id,
    ])
    expect((await db.pomodoroSessions.toArray()).map((s) => s.id)).toEqual([
      postBackupSession.id,
    ])
  })
})
