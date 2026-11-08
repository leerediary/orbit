import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import {
  normalizeTaskV3,
  unfiledGoalId,
  type LegacyGoal,
  type LegacyMilestone,
  type LegacyTask,
  type LegacyV2Task,
} from '@/lib/legacy-migration'

/**
 * REST-02 / REST-03 proof: the Dexie version(1) → version(2) upgrade maps the
 * three-level rows down into the four-level hierarchy without losing identity.
 *
 * A legacy v1 DB is created by name through raw Dexie, seeded, closed, and then
 * re-opened through OrbitDB (constructor accepts an isolated name) so Dexie runs
 * the real `.upgrade()` callback.
 */
const created: string[] = []

function legacyDb(name: string): Dexie {
  created.push(name)
  const legacy = new Dexie(name)
  legacy.version(1).stores({
    goals: 'id, updated_at, created_at',
    milestones: 'id, goal_id, updated_at, created_at',
    tasks: 'id, goal_id, updated_at, created_at',
    reviews: 'id, goal_id, updated_at, created_at',
  })
  return legacy
}

/**
 * A DB already at v2 (four-level schema, milestone-bound checkbox tasks) so
 * opening it through OrbitDB runs ONLY the v2 → v3 upgrade. Does not declare
 * `reviews` — the v2 schema already drops that table.
 */
function v2Db(name: string): Dexie {
  created.push(name)
  const v2 = new Dexie(name)
  v2.version(2).stores({
    categories: 'id, updated_at, created_at',
    goals: 'id, category_id, updated_at, created_at',
    milestones: 'id, goal_id, updated_at, created_at',
    tasks: 'id, milestone_id, updated_at, created_at',
  })
  return v2
}

/**
 * A DB already at v3 (four-level schema + the Phase 8 task columns) so opening
 * it through OrbitDB runs ONLY the v3 → v4 upgrade (additive dailyTodos store).
 */
function v3Db(name: string): Dexie {
  created.push(name)
  const v3 = new Dexie(name)
  v3.version(3).stores({
    categories: 'id, updated_at, created_at',
    goals: 'id, category_id, updated_at, created_at',
    milestones: 'id, goal_id, updated_at, created_at',
    tasks: 'id, milestone_id, updated_at, created_at',
  })
  return v3
}

/**
 * A DB already at v4 (four-level schema + dailyTodos) so opening it through
 * OrbitDB runs ONLY the v4 → v5 upgrade (additive journalEntries store).
 */
function v4Db(name: string): Dexie {
  created.push(name)
  const v4 = new Dexie(name)
  v4.version(4).stores({
    categories: 'id, updated_at, created_at',
    goals: 'id, category_id, updated_at, created_at',
    milestones: 'id, goal_id, updated_at, created_at',
    tasks: 'id, milestone_id, updated_at, created_at',
    dailyTodos: 'id, task_id, updated_at',
  })
  return v4
}

/**
 * A DB already at v5 (four-level schema + dailyTodos + journalEntries) so
 * opening it through OrbitDB runs ONLY the v5 → v6 upgrade (additive habits and
 * habitCompletions stores).
 */
function v5Db(name: string): Dexie {
  created.push(name)
  const v5 = new Dexie(name)
  v5.version(5).stores({
    categories: 'id, updated_at, created_at',
    goals: 'id, category_id, updated_at, created_at',
    milestones: 'id, goal_id, updated_at, created_at',
    tasks: 'id, milestone_id, updated_at, created_at',
    dailyTodos: 'id, task_id, updated_at',
    journalEntries: 'id, &day_key, updated_at',
  })
  return v5
}

/**
 * A DB already at v6 (four-level schema + dailyTodos + journalEntries + habits
 * and habitCompletions) so opening it through OrbitDB runs ONLY the v6 → v7
 * upgrade (additive pomodoroSessions store).
 */
function v6Db(name: string): Dexie {
  created.push(name)
  const v6 = new Dexie(name)
  v6.version(6).stores({
    categories: 'id, updated_at, created_at',
    goals: 'id, category_id, updated_at, created_at',
    milestones: 'id, goal_id, updated_at, created_at',
    tasks: 'id, milestone_id, updated_at, created_at',
    dailyTodos: 'id, task_id, updated_at',
    journalEntries: 'id, &day_key, updated_at',
    habits: 'id, sort_order, updated_at',
    habitCompletions: 'id, [habit_id+date], date, updated_at',
  })
  return v6
}

/** Read the ACTUAL IndexedDB object-store names (not just the declared schema). */
function actualStoreNames(name: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => {
      const database = request.result
      const names = Array.from(database.objectStoreNames)
      database.close()
      resolve(names)
    }
    request.onerror = () => reject(request.error)
  })
}

afterEach(async () => {
  for (const name of created.splice(0)) {
    await Dexie.delete(name).catch(() => {})
  }
})

const CREATED = '2026-01-01T00:00:00.000Z'
const UPDATED = '2026-01-02T00:00:00.000Z'

describe('Dexie v1 → v2 upgrade', () => {
  it('maps old rows into categories/goals/milestones, preserving identity and tombstones', async () => {
    const name = 'test-mig-mapping'
    const legacy = legacyDb(name)

    const goal: LegacyGoal = {
      id: 'g1',
      name: '旧目标',
      description: '这一段描述必须消失',
      created_at: CREATED,
      sort_order: 0,
      updated_at: UPDATED,
      deleted_at: null,
    }
    const milestone: LegacyMilestone = {
      id: 'ms1',
      goal_id: 'g1',
      name: '旧里程碑',
      completed: true,
      completed_at: '2026-01-09T00:00:00.000Z',
      created_at: CREATED,
      sort_order: 1,
      updated_at: UPDATED,
      deleted_at: null,
    }
    const tombstonedMilestone: LegacyMilestone = {
      id: 'ms2',
      goal_id: 'g1',
      name: '已归档里程碑',
      completed: false,
      completed_at: null,
      created_at: '2026-01-03T00:00:00.000Z',
      sort_order: 2,
      updated_at: '2026-01-04T00:00:00.000Z',
      deleted_at: '2026-05-01T00:00:00.000Z',
    }
    const directTask: LegacyTask = {
      id: 't1',
      goal_id: 'g1',
      milestone_id: null,
      name: '直接旧任务',
      completed: true,
      completed_at: '2026-01-10T00:00:00.000Z',
      created_at: '2026-01-05T00:00:00.000Z',
      sort_order: 0,
      updated_at: '2026-01-06T00:00:00.000Z',
      deleted_at: null,
    }

    await legacy.open()
    await legacy.table('goals').bulkPut([goal])
    await legacy.table('milestones').bulkPut([milestone, tombstonedMilestone])
    await legacy.table('tasks').bulkPut([directTask])
    legacy.close()

    const upgraded = new OrbitDB(name)
    const categories = await upgraded.table('categories').toArray()
    const goals = await upgraded.table('goals').toArray()
    const milestones = await upgraded.table('milestones').toArray()
    const tasks = await upgraded.table('tasks').toArray()
    upgraded.close()

    // Old Goal → Category, description dropped.
    expect(categories).toEqual([
      {
        id: 'g1',
        name: '旧目标',
        created_at: CREATED,
        sort_order: 0,
        updated_at: UPDATED,
        deleted_at: null,
      },
    ])
    expect(Object.keys(categories[0])).not.toContain('description')

    // Old Milestone → Goal, completed/completed_at dropped, tombstone verbatim.
    const goalsById = new Map(goals.map((g) => [g.id, g] as const))
    expect(goalsById.get('ms1')).toEqual({
      id: 'ms1',
      category_id: 'g1',
      name: '旧里程碑',
      created_at: CREATED,
      sort_order: 1,
      updated_at: UPDATED,
      deleted_at: null,
    })
    expect(Object.keys(goalsById.get('ms1')!)).not.toContain('completed')
    expect(Object.keys(goalsById.get('ms1')!)).not.toContain('completed_at')
    expect(goalsById.get('ms2')!.deleted_at).toBe('2026-05-01T00:00:00.000Z')
    expect(goalsById.get('ms2')!.updated_at).toBe('2026-01-04T00:00:00.000Z')

    // Direct old task gets a synthesized 「未分组」 goal with a finite order.
    const unfiled = goalsById.get(unfiledGoalId('g1'))!
    expect(unfiled).toMatchObject({ category_id: 'g1', name: '未分组', deleted_at: null })
    expect(Number.isFinite(unfiled.sort_order)).toBe(true)
    expect(Number.isNaN(unfiled.sort_order)).toBe(false)

    // Old Task → Milestone, completed cleared, attached to the unfiled goal.
    expect(milestones).toEqual([
      {
        id: 't1',
        goal_id: unfiledGoalId('g1'),
        name: '直接旧任务',
        created_at: '2026-01-05T00:00:00.000Z',
        sort_order: 0,
        updated_at: '2026-01-06T00:00:00.000Z',
        deleted_at: null,
      },
    ])
    expect(Object.keys(milestones[0])).not.toContain('completed')

    // The new leaf level starts empty (D-02).
    expect(tasks).toEqual([])

    // The reviews table is physically dropped from IndexedDB.
    expect(await actualStoreNames(name)).not.toContain('reviews')
  })

  it('drops the reviews table and its rows', async () => {
    const name = 'test-mig-drops-reviews'
    const legacy = legacyDb(name)

    await legacy.open()
    await legacy.table('goals').bulkPut([
      { id: 'g1', name: '目标', description: '', created_at: CREATED, sort_order: 0, updated_at: UPDATED, deleted_at: null },
    ])
    await legacy.table('reviews').bulkPut([
      { id: 'r1', goal_id: 'g1', content: '复盘', created_at: CREATED, updated_at: UPDATED, deleted_at: null },
    ])
    legacy.close()

    const upgraded = new OrbitDB(name)
    expect(await upgraded.table('categories').count()).toBe(1)
    upgraded.close()

    expect(await actualStoreNames(name)).not.toContain('reviews')
  })

  it('does not synthesize a 「未分组」 goal when a category has no direct tasks', async () => {
    const name = 'test-mig-no-direct'
    const legacy = legacyDb(name)

    await legacy.open()
    await legacy.table('goals').bulkPut([
      { id: 'g1', name: '目标', description: '', created_at: CREATED, sort_order: 0, updated_at: UPDATED, deleted_at: null },
    ])
    await legacy.table('milestones').bulkPut([
      { id: 'ms1', goal_id: 'g1', name: '里程碑', completed: false, completed_at: null, created_at: CREATED, sort_order: 0, updated_at: UPDATED, deleted_at: null },
    ])
    legacy.close()

    const upgraded = new OrbitDB(name)
    const goals = await upgraded.table('goals').toArray()
    upgraded.close()

    expect(goals.map((g) => g.id)).toEqual(['ms1'])
    expect(goals.some((g) => g.id === unfiledGoalId('g1'))).toBe(false)
  })
})

/**
 * D-05 / T-08-01 / T-08-02: opening a v2 DB through OrbitDB runs the real
 * version(3).upgrade. Every pre-existing task must be default-filled in place —
 * identity, timestamps and tombstones byte-for-byte — and unrelated tables must
 * not be touched.
 */
describe('Dexie v2 → v3 upgrade', () => {
  it('default-fills new task fields while preserving identity, tombstones and other tables', async () => {
    const name = 'test-mig-v2-to-v3'
    const v2 = v2Db(name)

    const category = {
      id: 'cat1',
      name: '分类',
      created_at: CREATED,
      sort_order: 0,
      updated_at: UPDATED,
      deleted_at: null,
    }
    const goal = {
      id: 'goal1',
      category_id: 'cat1',
      name: '目标',
      created_at: CREATED,
      sort_order: 0,
      updated_at: UPDATED,
      deleted_at: null,
    }
    const milestone = {
      id: 'ms1',
      goal_id: 'goal1',
      name: '里程碑',
      created_at: CREATED,
      sort_order: 0,
      updated_at: UPDATED,
      deleted_at: null,
    }
    const liveTask = {
      id: 'task-live',
      milestone_id: 'ms1',
      name: '任务',
      completed: true,
      completed_at: '2026-01-09T00:00:00.000Z',
      created_at: CREATED,
      sort_order: 0,
      updated_at: UPDATED,
      deleted_at: null,
    }
    const tombstonedTask = {
      id: 'task-deleted',
      milestone_id: 'ms1',
      name: '已删任务',
      completed: false,
      completed_at: null,
      created_at: '2026-01-03T00:00:00.000Z',
      sort_order: 1,
      updated_at: '2026-01-04T00:00:00.000Z',
      deleted_at: '2026-05-01T00:00:00.000Z',
    }

    await v2.open()
    await v2.table('categories').bulkPut([category])
    await v2.table('goals').bulkPut([goal])
    await v2.table('milestones').bulkPut([milestone])
    await v2.table('tasks').bulkPut([liveTask, tombstonedTask])
    v2.close()

    const upgraded = new OrbitDB(name)
    const tasks = await upgraded.tasks.toArray()
    const categories = await upgraded.categories.toArray()
    const goals = await upgraded.goals.toArray()
    const milestones = await upgraded.milestones.toArray()
    upgraded.close()

    // Every task gains the six v3 defaults.
    const byId = new Map(tasks.map((t) => [t.id, t] as const))
    expect(tasks).toHaveLength(2)
    expect(byId.get('task-live')).toEqual({
      ...liveTask,
      goal_id: null,
      parent_id: null,
      progress_type: 'checkbox',
      unit: null,
      target_value: null,
      current_value: null,
    })
    // The tombstone is not resurrected and its timestamps stay verbatim.
    expect(byId.get('task-deleted')).toEqual({
      ...tombstonedTask,
      goal_id: null,
      parent_id: null,
      progress_type: 'checkbox',
      unit: null,
      target_value: null,
      current_value: null,
    })

    // Unrelated tables are untouched (row counts survive).
    expect(categories).toEqual([category])
    expect(goals).toEqual([goal])
    expect(milestones).toEqual([milestone])
  })

  it('is a no-op when the tasks store is empty', async () => {
    const name = 'test-mig-v2-to-v3-empty'
    const v2 = v2Db(name)

    await v2.open()
    await v2.table('categories').bulkPut([
      { id: 'cat1', name: '分类', created_at: CREATED, sort_order: 0, updated_at: UPDATED, deleted_at: null },
    ])
    v2.close()

    const upgraded = new OrbitDB(name)
    expect(await upgraded.tasks.count()).toBe(0)
    expect(await upgraded.categories.count()).toBe(1)
    upgraded.close()
  })
})

/**
 * D-05: the v2 → v3 default-fill is a PURE normalizer shared by the Dexie
 * version(3) upgrade and the (later) v2 import branch. It must add the six new
 * fields without perturbing identity, tombstone, or any existing column.
 */
describe('normalizeTaskV3', () => {
  it('adds v3 defaults while preserving every existing field byte-for-byte', () => {
    const v2Task: LegacyV2Task = {
      id: 'task-1',
      milestone_id: 'milestone-1',
      name: '任务',
      completed: true,
      completed_at: '2026-01-09T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      sort_order: 2,
      updated_at: '2026-01-02T00:00:00.000Z',
      deleted_at: '2026-05-01T00:00:00.000Z',
    }

    const normalized = normalizeTaskV3(v2Task)

    expect(normalized).toEqual({
      ...v2Task,
      goal_id: null,
      parent_id: null,
      progress_type: 'checkbox',
      unit: null,
      target_value: null,
      current_value: null,
    })
    // Identity + tombstone survive verbatim.
    expect(normalized.id).toBe(v2Task.id)
    expect(normalized.updated_at).toBe(v2Task.updated_at)
    expect(normalized.deleted_at).toBe(v2Task.deleted_at)
    expect(normalized.milestone_id).toBe('milestone-1')
    // Pure: the input row is not mutated.
    expect(Object.keys(v2Task)).not.toContain('goal_id')
  })

  it('backfills sort_order from created_at when a legacy row omits it', () => {
    const v2Task: LegacyV2Task = {
      id: 'task-legacy',
      milestone_id: 'milestone-1',
      name: '无排序旧任务',
      completed: false,
      completed_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      deleted_at: null,
    }

    expect(normalizeTaskV3(v2Task).sort_order).toBe(Date.parse(v2Task.created_at))
  })
})

/**
 * D-01 / T-09-02: v3 → v4 is a PURE additive schema diff. Opening a v3 DB
 * through OrbitDB must add an EMPTY dailyTodos store and leave every existing
 * row byte-for-byte unchanged — no upgrade callback rewrites anything.
 */
describe('Dexie v3 → v4 upgrade', () => {
  it('adds an empty dailyTodos store without touching existing rows', async () => {
    const name = 'test-mig-v3-to-v4'
    const v3 = v3Db(name)

    const category = {
      id: 'cat1',
      name: '分类',
      created_at: CREATED,
      sort_order: 0,
      updated_at: UPDATED,
      deleted_at: null,
    }
    const goal = {
      id: 'goal1',
      category_id: 'cat1',
      name: '目标',
      created_at: CREATED,
      sort_order: 0,
      updated_at: UPDATED,
      deleted_at: null,
    }
    const milestone = {
      id: 'ms1',
      goal_id: 'goal1',
      name: '里程碑',
      created_at: CREATED,
      sort_order: 0,
      updated_at: UPDATED,
      deleted_at: null,
    }
    const liveTask = {
      id: 'task-live',
      milestone_id: 'ms1',
      goal_id: null,
      parent_id: null,
      name: '任务',
      progress_type: 'checkbox',
      unit: null,
      target_value: null,
      current_value: null,
      completed: true,
      completed_at: '2026-01-09T00:00:00.000Z',
      created_at: CREATED,
      sort_order: 0,
      updated_at: UPDATED,
      deleted_at: null,
    }
    const tombstonedTask = {
      id: 'task-deleted',
      milestone_id: 'ms1',
      goal_id: null,
      parent_id: null,
      name: '已删任务',
      progress_type: 'checkbox',
      unit: null,
      target_value: null,
      current_value: null,
      completed: false,
      completed_at: null,
      created_at: '2026-01-03T00:00:00.000Z',
      sort_order: 1,
      updated_at: '2026-01-04T00:00:00.000Z',
      deleted_at: '2026-05-01T00:00:00.000Z',
    }

    await v3.open()
    await v3.table('categories').bulkPut([category])
    await v3.table('goals').bulkPut([goal])
    await v3.table('milestones').bulkPut([milestone])
    await v3.table('tasks').bulkPut([liveTask, tombstonedTask])
    v3.close()

    const upgraded = new OrbitDB(name)
    expect(await upgraded.dailyTodos.count()).toBe(0)
    // Every seeded row comes back exactly equal — identity, updated_at and
    // deleted_at unchanged (no rewrite happened).
    expect(await upgraded.categories.toArray()).toEqual([category])
    expect(await upgraded.goals.toArray()).toEqual([goal])
    expect(await upgraded.milestones.toArray()).toEqual([milestone])
    expect(await upgraded.tasks.toArray()).toHaveLength(2)
    const tasksById = new Map((await upgraded.tasks.toArray()).map((t) => [t.id, t] as const))
    expect(tasksById.get('task-live')).toEqual(liveTask)
    expect(tasksById.get('task-deleted')).toEqual(tombstonedTask)
    upgraded.close()

    expect(await actualStoreNames(name)).toContain('dailyTodos')
  })
})

/**
 * D-01 / T-10-01: v4 → v5 is a PURE additive schema diff. Opening a v4 DB
 * through OrbitDB must add an EMPTY journalEntries store and leave every
 * existing row byte-for-byte unchanged — no upgrade callback rewrites anything.
 */
describe('Dexie v4 → v5 upgrade', () => {
  it('adds an empty journalEntries store without touching existing rows', async () => {
    const name = 'test-mig-v4-to-v5'
    const v4 = v4Db(name)

    const category = {
      id: 'cat1',
      name: '分类',
      created_at: CREATED,
      sort_order: 0,
      updated_at: UPDATED,
      deleted_at: null,
    }
    const dailyTodo = {
      id: 'daily-1',
      task_id: null,
      name: '买牛奶',
      completed: false,
      completed_at: null,
      added_at: '2026-06-01T08:00:00.000Z',
      updated_at: UPDATED,
      deleted_at: null,
    }

    await v4.open()
    await v4.table('categories').bulkPut([category])
    await v4.table('dailyTodos').bulkPut([dailyTodo])
    v4.close()

    const upgraded = new OrbitDB(name)
    // The new store exists and is empty.
    expect(await upgraded.journalEntries.count()).toBe(0)
    // Every seeded row comes back exactly equal — identity, updated_at and
    // deleted_at unchanged (no rewrite happened).
    expect(await upgraded.categories.toArray()).toEqual([category])
    expect(await upgraded.dailyTodos.toArray()).toEqual([dailyTodo])
    upgraded.close()

    expect(await actualStoreNames(name)).toContain('journalEntries')
  })
})

/**
 * HABIT-01 / T-12-03: v5 → v6 is a PURE additive schema diff. Opening a v5 DB
 * through OrbitDB must add EMPTY habits and habitCompletions stores and leave
 * every existing row byte-for-byte unchanged — no upgrade callback rewrites
 * anything.
 */
describe('Dexie v5 → v6 upgrade', () => {
  it('adds empty habit stores without touching existing rows', async () => {
    const name = 'test-mig-v5-to-v6'
    const v5 = v5Db(name)

    const category = {
      id: 'cat1',
      name: '分类',
      created_at: CREATED,
      sort_order: 0,
      updated_at: UPDATED,
      deleted_at: null,
    }
    const dailyTodo = {
      id: 'daily-1',
      task_id: null,
      name: '买牛奶',
      completed: false,
      completed_at: null,
      added_at: '2026-06-01T08:00:00.000Z',
      updated_at: UPDATED,
      deleted_at: null,
    }
    const journal = {
      id: 'journal-2026-06-01',
      day_key: '2026-06-01',
      content: '日记正文',
      updated_at: UPDATED,
      deleted_at: null,
    }

    await v5.open()
    await v5.table('categories').bulkPut([category])
    await v5.table('dailyTodos').bulkPut([dailyTodo])
    await v5.table('journalEntries').bulkPut([journal])
    v5.close()

    const upgraded = new OrbitDB(name)
    // Both new stores exist and are empty.
    expect(await upgraded.habits.count()).toBe(0)
    expect(await upgraded.habitCompletions.count()).toBe(0)
    // Every seeded row comes back exactly equal — identity, updated_at and
    // deleted_at unchanged (no rewrite happened).
    expect(await upgraded.categories.toArray()).toEqual([category])
    expect(await upgraded.dailyTodos.toArray()).toEqual([dailyTodo])
    expect(await upgraded.journalEntries.toArray()).toEqual([journal])
    upgraded.close()

    const storeNames = await actualStoreNames(name)
    expect(storeNames).toContain('habits')
    expect(storeNames).toContain('habitCompletions')
  })
})

/**
 * POMODORO-01 / T-13-04: v6 → v7 is a PURE additive schema diff. Opening a v6 DB
 * through OrbitDB must add an EMPTY pomodoroSessions store and leave every
 * existing row byte-for-byte unchanged — no upgrade callback rewrites anything.
 */
describe('Dexie v6 → v7 upgrade', () => {
  it('adds an empty pomodoroSessions store without touching existing rows', async () => {
    const name = 'test-mig-v6-to-v7'
    const v6 = v6Db(name)

    const category = {
      id: 'cat1',
      name: '分类',
      created_at: CREATED,
      sort_order: 0,
      updated_at: UPDATED,
      deleted_at: null,
    }
    const dailyTodo = {
      id: 'daily-1',
      task_id: null,
      name: '买牛奶',
      completed: false,
      completed_at: null,
      added_at: '2026-06-01T08:00:00.000Z',
      updated_at: UPDATED,
      deleted_at: null,
    }
    const journal = {
      id: 'journal-2026-06-01',
      day_key: '2026-06-01',
      content: '日记正文',
      updated_at: UPDATED,
      deleted_at: null,
    }
    const habit = {
      id: 'habit-1',
      name: '每天跑步',
      short_name: '跑步',
      sort_order: 0,
      updated_at: UPDATED,
      deleted_at: null,
    }
    const habitCompletion = {
      id: 'habit-1-2026-06-01',
      habit_id: 'habit-1',
      date: '2026-06-01',
      note: '今天跑了 5km',
      completed_at: '2026-06-01T07:00:00.000Z',
      updated_at: UPDATED,
      deleted_at: null,
    }

    await v6.open()
    await v6.table('categories').bulkPut([category])
    await v6.table('dailyTodos').bulkPut([dailyTodo])
    await v6.table('journalEntries').bulkPut([journal])
    await v6.table('habits').bulkPut([habit])
    await v6.table('habitCompletions').bulkPut([habitCompletion])
    v6.close()

    const upgraded = new OrbitDB(name)
    // The new store exists and is empty.
    expect(await upgraded.pomodoroSessions.count()).toBe(0)
    // Every seeded row comes back exactly equal — identity, updated_at and
    // deleted_at unchanged (no rewrite happened).
    expect(await upgraded.categories.toArray()).toEqual([category])
    expect(await upgraded.dailyTodos.toArray()).toEqual([dailyTodo])
    expect(await upgraded.journalEntries.toArray()).toEqual([journal])
    expect(await upgraded.habits.toArray()).toEqual([habit])
    expect(await upgraded.habitCompletions.toArray()).toEqual([habitCompletion])
    upgraded.close()

    expect(await actualStoreNames(name)).toContain('pomodoroSessions')
  })
})
