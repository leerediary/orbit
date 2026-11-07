import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/local-db'
import { importData } from '@/lib/data-import'
import { EXPORT_FORMAT } from '@/lib/data-export'
import { unfiledGoalId } from '@/lib/legacy-migration'
import type { LegacyGoal, LegacyMilestone, LegacyTask } from '@/lib/legacy-migration'

/**
 * REST-02 / REST-03 proof: a legacy orbit-export **version 1** backup is
 * transformed (not rejected) into the four-level store through the SAME
 * `migrateLegacyRows` implementation the Dexie upgrade uses.
 *
 *  - v1 goals → categories, v1 milestones → goals, v1 tasks → milestones
 *  - a direct v1 task synthesizes a 「未分组」 goal under its category
 *  - v1 `reviews` are ignored (never written, never an unknown-field error)
 *  - a malformed v1 row throws and writes nothing (atomic rollback)
 */

function v1Contract(
  data: Partial<
    Record<'goals' | 'milestones' | 'tasks' | 'reviews' | 'dailyTodos', unknown[]>
  > = {},
) {
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      goals: [],
      milestones: [],
      tasks: [],
      reviews: [],
      dailyTodos: [],
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

const CREATED = '2026-01-01T00:00:00.000Z'
const UPDATED = '2026-01-02T00:00:00.000Z'

const legacyGoal: LegacyGoal = {
  id: 'g1',
  name: '旧目标',
  description: '描述会被丢弃',
  created_at: CREATED,
  sort_order: 0,
  updated_at: UPDATED,
  deleted_at: null,
}

const legacyMilestone: LegacyMilestone = {
  id: 'ms1',
  goal_id: 'g1',
  name: '旧里程碑',
  completed: true,
  completed_at: '2026-01-09T00:00:00.000Z',
  created_at: CREATED,
  sort_order: 0,
  updated_at: UPDATED,
  deleted_at: null,
}

const nestedLegacyTask: LegacyTask = {
  id: 't-nested',
  goal_id: 'g1',
  milestone_id: 'ms1',
  name: '旧任务（挂在里程碑下）',
  completed: false,
  completed_at: null,
  created_at: '2026-01-03T00:00:00.000Z',
  sort_order: 0,
  updated_at: UPDATED,
  deleted_at: null,
}

const directLegacyTask: LegacyTask = {
  id: 't-direct',
  goal_id: 'g1',
  milestone_id: null,
  name: '旧直接任务',
  completed: true,
  completed_at: '2026-01-10T00:00:00.000Z',
  created_at: '2026-01-04T00:00:00.000Z',
  sort_order: 1,
  updated_at: UPDATED,
  deleted_at: null,
}

beforeEach(async () => {
  await reset()
})

describe('legacy orbit-export v1 import', () => {
  it('transforms v1 rows into the four-level store and ignores reviews', async () => {
    await importData(
      v1Contract({
        goals: [legacyGoal],
        milestones: [legacyMilestone],
        tasks: [nestedLegacyTask, directLegacyTask],
        reviews: [
          { id: 'r1', goal_id: 'g1', content: '复盘', created_at: CREATED, updated_at: UPDATED, deleted_at: null },
        ],
      }),
    )

    const categories = await db.categories.toArray()
    expect(categories).toEqual([
      { id: 'g1', name: '旧目标', created_at: CREATED, sort_order: 0, updated_at: UPDATED, deleted_at: null },
    ])
    expect(Object.keys(categories[0])).not.toContain('description')

    const goals = await db.goals.toArray()
    const goalsById = new Map(goals.map((g) => [g.id, g] as const))
    expect(goalsById.get('ms1')).toEqual({
      id: 'ms1',
      category_id: 'g1',
      name: '旧里程碑',
      created_at: CREATED,
      sort_order: 0,
      updated_at: UPDATED,
      deleted_at: null,
    })
    expect(goalsById.get(unfiledGoalId('g1'))).toMatchObject({
      category_id: 'g1',
      name: '未分组',
      deleted_at: null,
    })

    const milestones = await db.milestones.toArray()
    const milestonesById = new Map(milestones.map((m) => [m.id, m] as const))
    expect(milestonesById.get('t-nested')!.goal_id).toBe('ms1')
    expect(milestonesById.get('t-direct')!.goal_id).toBe(unfiledGoalId('g1'))

    // The new leaf level stays empty; reviews are never written.
    expect(await db.tasks.count()).toBe(0)
    expect(await counts()).toEqual({
      categories: 1,
      goals: 2,
      milestones: 2,
      tasks: 0,
      dailyTodos: 0,
      journalEntries: 0,
      habits: 0,
      habitCompletions: 0,
      pomodoroSessions: 0,
    })
  })

  it('gives the synthesized 「未分组」 goal a finite sort_order even with zero milestones', async () => {
    await importData(v1Contract({ goals: [legacyGoal], tasks: [directLegacyTask] }))

    const unfiled = await db.goals.get(unfiledGoalId('g1'))
    expect(unfiled).toBeDefined()
    expect(Number.isFinite(unfiled!.sort_order)).toBe(true)
    expect(Number.isNaN(unfiled!.sort_order)).toBe(false)
  })

  it('rolls back everything when a transformed v1 row is malformed', async () => {
    await importData(v1Contract({ goals: [legacyGoal] }))
    expect(await counts()).toEqual({
      categories: 1,
      goals: 0,
      milestones: 0,
      tasks: 0,
      dailyTodos: 0,
      journalEntries: 0,
      habits: 0,
      habitCompletions: 0,
      pomodoroSessions: 0,
    })

    const malformed = v1Contract({
      goals: [{ ...legacyGoal, name: 42 }],
      tasks: [nestedLegacyTask],
    })

    await expect(importData(malformed)).rejects.toThrow(/必须是字符串/)
    // The earlier successful import stays untouched; no partial write occurred.
    expect(await counts()).toEqual({
      categories: 1,
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

  it('imports a v4 backup into an empty journal, ignoring a stray journalEntries key', async () => {
    const v4 = JSON.stringify({
      format: EXPORT_FORMAT,
      version: 4,
      exportedAt: new Date().toISOString(),
      data: {
        categories: [
          { id: 'cat-v4', name: '分类', created_at: CREATED, sort_order: 0, updated_at: UPDATED, deleted_at: null },
        ],
        goals: [
          { id: 'goal-v4', category_id: 'cat-v4', name: '目标', created_at: CREATED, sort_order: 0, updated_at: UPDATED, deleted_at: null },
        ],
        milestones: [
          { id: 'ms-v4', goal_id: 'goal-v4', name: '里程碑', created_at: CREATED, sort_order: 0, updated_at: UPDATED, deleted_at: null },
        ],
        tasks: [
          {
            id: 'task-v4',
            milestone_id: 'ms-v4',
            goal_id: null,
            parent_id: null,
            name: '任务',
            progress_type: 'checkbox',
            unit: null,
            target_value: null,
            current_value: null,
            completed: false,
            completed_at: null,
            created_at: CREATED,
            sort_order: 0,
            updated_at: UPDATED,
            deleted_at: null,
          },
        ],
        dailyTodos: [],
        // Predates the journal layer; v4 must ignore this rather than write it.
        journalEntries: [
          {
            id: 'journal-v4',
            day_key: '2026-01-05',
            content: '不应被导入',
            updated_at: UPDATED,
            deleted_at: null,
          },
        ],
      },
    })

    await importData(v4)

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

  it('imports a v5 backup into empty habit tables, ignoring stray habit keys', async () => {
    // v5 predates the habit layer. Its six arrays may be empty; the two stray
    // habit keys must be ignored entirely — never validated, never written.
    const v5 = JSON.stringify({
      format: EXPORT_FORMAT,
      version: 5,
      exportedAt: new Date().toISOString(),
      data: {
        categories: [],
        goals: [],
        milestones: [],
        tasks: [],
        dailyTodos: [],
        journalEntries: [],
        habits: [
          { id: 'stray-habit', name: '不应被导入', short_name: '不应', sort_order: 0, updated_at: UPDATED, deleted_at: null },
        ],
        habitCompletions: [
          { id: 'stray-completion', habit_id: 'stray-habit', date: '2026-01-05', note: null, completed_at: UPDATED, updated_at: UPDATED, deleted_at: null },
        ],
        // v5 predates the pomodoro layer too; this stray key must be ignored.
        pomodoroSessions: [
          { id: 'stray-session', started_at: UPDATED, duration_sec: 1500, notes: [], habit_id: null, task_id: null, daily_todo_id: null, marked_task_complete: false, progress_amount: null, shared_indices: [], updated_at: UPDATED, deleted_at: null },
        ],
      },
    })

    await importData(v5)

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

  it('imports a v6 backup into an empty pomodoro table, ignoring a stray session row', async () => {
    // v6 is frozen: it predates the pomodoro layer, so the stray
    // pomodoroSessions array must be ignored entirely — never validated, never
    // written — and the target table lands empty.
    const v6 = JSON.stringify({
      format: EXPORT_FORMAT,
      version: 6,
      exportedAt: new Date().toISOString(),
      data: {
        categories: [
          { id: 'cat-v6', name: '分类', created_at: CREATED, sort_order: 0, updated_at: UPDATED, deleted_at: null },
        ],
        goals: [],
        milestones: [],
        tasks: [],
        dailyTodos: [],
        journalEntries: [],
        habits: [],
        habitCompletions: [],
        pomodoroSessions: [
          { id: 'stray-session', started_at: UPDATED, duration_sec: 1500, notes: [], habit_id: null, task_id: null, daily_todo_id: null, marked_task_complete: false, progress_amount: null, shared_indices: [], updated_at: UPDATED, deleted_at: null },
        ],
      },
    })

    await importData(v6)

    expect(await counts()).toEqual({
      categories: 1,
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

  it('rejects an unsupported version and writes nothing', async () => {
    const future = JSON.stringify({
      format: EXPORT_FORMAT,
      version: 8,
      exportedAt: new Date().toISOString(),
      data: { categories: [], goals: [], milestones: [], tasks: [], dailyTodos: [], journalEntries: [], habits: [], habitCompletions: [], pomodoroSessions: [] },
    })

    await expect(importData(future)).rejects.toThrow(/不支持的版本 8（当前支持版本 7）/)
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
