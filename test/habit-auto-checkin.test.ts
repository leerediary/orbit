import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import { habitCompletionId } from '@/lib/habit'
import { autoCheckinForTask, describeTaskEvent } from '@/lib/habit-auto-checkin'
import { dayKey } from '@/lib/today'
import type { Goal, Habit, HabitCompletion, Milestone, Task } from '@/lib/types'

/**
 * Phase 22 / D-04..D-06 — auto check-in integration proofs.
 *
 * Every case drives `autoCheckinForTask` through a real LocalRepository on a
 * fresh fake-indexeddb database, so the assertions cover the actual persisted
 * row (identity, note merging, tombstone revival) rather than a mock. Covers:
 *  - first write keyed by habitCompletionId with the event description
 *  - same-day append that preserves completed_at
 *  - pre-existing manual note preserved and appended to
 *  - no-ops: no goal, no habit_id, archived habit
 *  - direct (goal_id) task resolution
 *  - tombstone revival instead of duplication
 *  - explicit note overriding the event description
 */

const createdNames: string[] = []
const opened: OrbitDB[] = []

function newName(): string {
  const name = `orbit-habit-auto-checkin-${Date.now()}-${Math.random().toString(36).slice(2)}`
  createdNames.push(name)
  return name
}

function open(name: string): { database: OrbitDB; repo: LocalRepository } {
  const database = new OrbitDB(name)
  opened.push(database)
  return { database, repo: new LocalRepository(database) }
}

afterEach(async () => {
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

const UPDATED = '2026-10-31T00:00:00.000Z'
const NOW = '2026-10-31T01:25:00.000Z'
const DAY = dayKey(NOW, 0)
const HABIT_ID = 'habit-1'

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    category_id: 'category-1',
    name: '读《原则》',
    created_at: '2026-10-01T00:00:00.000Z',
    sort_order: 0,
    habit_id: HABIT_ID,
    updated_at: UPDATED,
    deleted_at: null,
    ...over,
  }
}

function milestone(over: Partial<Milestone> = {}): Milestone {
  return {
    id: 'milestone-1',
    goal_id: 'goal-1',
    name: '第三章',
    created_at: '2026-10-01T00:00:00.000Z',
    sort_order: 0,
    updated_at: UPDATED,
    deleted_at: null,
    ...over,
  }
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    milestone_id: 'milestone-1',
    goal_id: null,
    parent_id: null,
    name: '读第3章',
    progress_type: 'quantity',
    unit: '页',
    target_value: 30,
    current_value: 10,
    completed: false,
    completed_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    sort_order: 0,
    updated_at: UPDATED,
    deleted_at: null,
    ...over,
  }
}

function habit(over: Partial<Habit> = {}): Habit {
  return {
    id: HABIT_ID,
    name: '阅读',
    short_name: '阅读',
    sort_order: 0,
    updated_at: UPDATED,
    deleted_at: null,
    ...over,
  }
}

function completion(over: Partial<HabitCompletion> = {}): HabitCompletion {
  return {
    id: habitCompletionId(HABIT_ID, DAY),
    habit_id: HABIT_ID,
    date: DAY,
    note: null,
    completed_at: '2026-10-31T00:10:00.000Z',
    updated_at: UPDATED,
    deleted_at: null,
    ...over,
  }
}

/** Seed a milestone-owned task whose Goal links HABIT_ID to a live habit. */
async function seedLinked(repo: LocalRepository): Promise<void> {
  await repo.upsert<Goal>('goals', goal())
  await repo.upsert<Milestone>('milestones', milestone())
  await repo.upsert<Task>('tasks', task())
  await repo.upsert<Habit>('habits', habit())
}

async function allCompletions(
  repo: LocalRepository,
): Promise<HabitCompletion[]> {
  return repo.list<HabitCompletion>('habitCompletions', { includeDeleted: true })
}

describe('describeTaskEvent', () => {
  it('emits the full path 目标 → 里程碑 → 任务 (T20)', () => {
    const base = { goalName: '读《原则》', milestoneName: '第三章', taskName: '读第3章' }
    expect(describeTaskEvent({ ...base, kind: 'complete' })).toBe(
      '读《原则》, 第三章, 读第3章',
    )
    expect(
      describeTaskEvent({
        ...base,
        kind: 'progress',
        startValue: 10,
        endValue: 25,
        unit: '页',
      }),
    ).toBe('读《原则》, 第三章, 读第3章, 10-25页')
  })

  it('includes container ancestors (部) between the milestone and the task', () => {
    expect(
      describeTaskEvent({
        goalName: '陀思妥耶夫斯基',
        milestoneName: '白痴',
        ancestorNames: ['第二部'],
        taskName: '八',
        kind: 'progress',
        startValue: 0,
        endValue: 248,
        unit: '行',
      }),
    ).toBe('陀思妥耶夫斯基, 白痴, 第二部, 八, 0-248行')
  })

  it('keeps the goal as anchor for a goal-scoped task with no milestone', () => {
    expect(
      describeTaskEvent({
        goalName: '读《原则》',
        milestoneName: null,
        taskName: '读第3章',
        kind: 'complete',
      }),
    ).toBe('读《原则》, 读第3章')
  })
})

describe('autoCheckinForTask — write paths', () => {
  it('creates exactly one completion on the first trigger', async () => {
    const { repo } = open(newName())
    await seedLinked(repo)

    const returned = await autoCheckinForTask({
      task: task(),
      kind: 'complete',
      nowIso: NOW,
      offsetHours: 0,
      repo,
    })

    expect(returned).toBe(HABIT_ID)
    const rows = await allCompletions(repo)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: habitCompletionId(HABIT_ID, DAY),
      habit_id: HABIT_ID,
      date: DAY,
      note: '读《原则》, 第三章, 读第3章',
      completed_at: NOW,
      deleted_at: null,
    })
  })

  it('appends a second same-day trigger and preserves completed_at (D-04)', async () => {
    const { repo } = open(newName())
    await seedLinked(repo)

    await autoCheckinForTask({
      task: task(),
      kind: 'complete',
      nowIso: NOW,
      offsetHours: 0,
      repo,
    })
    const later = '2026-10-31T09:00:00.000Z'
    await autoCheckinForTask({
      task: task(),
      kind: 'progress',
      amount: 5,
      nowIso: later,
      offsetHours: 0,
      repo,
    })

    const rows = await allCompletions(repo)
    expect(rows).toHaveLength(1)
    expect(rows[0].note).toBe('读《原则》, 第三章, 读第3章\n读《原则》, 第三章, 读第3章, 5-10页')
    expect(rows[0].completed_at).toBe(NOW)
  })

  it('preserves a pre-existing manual note and appends the event to it', async () => {
    const { repo } = open(newName())
    await seedLinked(repo)
    await repo.upsert<HabitCompletion>(
      'habitCompletions',
      completion({ note: '手写笔记' }),
    )

    await autoCheckinForTask({
      task: task(),
      kind: 'complete',
      nowIso: NOW,
      offsetHours: 0,
      repo,
    })

    const rows = await allCompletions(repo)
    expect(rows).toHaveLength(1)
    expect(rows[0].note).toBe('手写笔记\n读《原则》, 第三章, 读第3章')
    expect(rows[0].completed_at).toBe('2026-10-31T00:10:00.000Z')
  })

  it('resolves a direct task through its own goal_id', async () => {
    const { repo } = open(newName())
    await repo.upsert<Goal>('goals', goal())
    await repo.upsert<Habit>('habits', habit())
    const direct = task({ id: 'task-direct', milestone_id: null, goal_id: 'goal-1' })

    const returned = await autoCheckinForTask({
      task: direct,
      kind: 'progress',
      nowIso: NOW,
      offsetHours: 0,
      repo,
    })

    expect(returned).toBe(HABIT_ID)
    const rows = await allCompletions(repo)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      habit_id: HABIT_ID,
      date: DAY,
      note: '读《原则》, 读第3章',
      deleted_at: null,
    })
  })

  it('revives a tombstoned completion at the same id instead of duplicating', async () => {
    const { repo } = open(newName())
    await seedLinked(repo)
    await repo.upsert<HabitCompletion>(
      'habitCompletions',
      completion({
        note: '旧笔记',
        completed_at: '2026-10-31T00:00:00.000Z',
        deleted_at: '2026-10-31T00:05:00.000Z',
      }),
    )

    await autoCheckinForTask({
      task: task(),
      kind: 'complete',
      nowIso: NOW,
      offsetHours: 0,
      repo,
    })

    const rows = await allCompletions(repo)
    expect(rows).toHaveLength(1)
    expect(rows[0].deleted_at).toBeNull()
    expect(rows[0].note).toBe('旧笔记\n读《原则》, 第三章, 读第3章')
    expect(rows[0].completed_at).toBe('2026-10-31T00:00:00.000Z')
  })

  it('uses an explicit note in place of the event description (D-05)', async () => {
    const { repo } = open(newName())
    await seedLinked(repo)

    await autoCheckinForTask({
      task: task(),
      kind: 'progress',
      note: '专注 25 分钟',
      nowIso: NOW,
      offsetHours: 0,
      repo,
    })

    const rows = await allCompletions(repo)
    expect(rows).toHaveLength(1)
    expect(rows[0].note).toBe('专注 25 分钟')
  })
})

describe('autoCheckinForTask — no-op paths', () => {
  it('writes nothing when the task has no resolvable goal', async () => {
    const { repo } = open(newName())
    await repo.upsert<Habit>('habits', habit())

    const returned = await autoCheckinForTask({
      task: task({ milestone_id: null, goal_id: null }),
      kind: 'complete',
      nowIso: NOW,
      offsetHours: 0,
      repo,
    })

    expect(returned).toBeNull()
    expect(await allCompletions(repo)).toHaveLength(0)
  })

  it('writes nothing when the goal has no habit_id', async () => {
    const { repo } = open(newName())
    await repo.upsert<Goal>('goals', goal({ habit_id: null }))
    await repo.upsert<Milestone>('milestones', milestone())
    await repo.upsert<Task>('tasks', task())
    await repo.upsert<Habit>('habits', habit())

    const returned = await autoCheckinForTask({
      task: task(),
      kind: 'complete',
      nowIso: NOW,
      offsetHours: 0,
      repo,
    })

    expect(returned).toBeNull()
    expect(await allCompletions(repo)).toHaveLength(0)
  })

  it('writes nothing for an archived habit', async () => {
    const { repo } = open(newName())
    await repo.upsert<Goal>('goals', goal())
    await repo.upsert<Milestone>('milestones', milestone())
    await repo.upsert<Task>('tasks', task())
    await repo.upsert<Habit>(
      'habits',
      habit({ deleted_at: '2026-10-30T00:00:00.000Z' }),
    )

    const returned = await autoCheckinForTask({
      task: task(),
      kind: 'complete',
      nowIso: NOW,
      offsetHours: 0,
      repo,
    })

    expect(returned).toBeNull()
    expect(await allCompletions(repo)).toHaveLength(0)
  })
})
