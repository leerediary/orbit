import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import { habitCompletionId, nextHabitSortOrder, sortHabits } from '@/lib/habit'
import type { Habit, HabitCompletion } from '@/lib/types'

/**
 * Phase 12 / HABIT-01 + HABIT-02 + HABIT-03 persistence proof.
 *
 * Every test writes through a real `LocalRepository` backed by a fresh, uniquely
 * named fake-indexeddb database, then CLOSES it and re-opens a new OrbitDB under
 * the same name — so the assertions prove bytes reached IndexedDB rather than
 * surviving in an in-memory cache.
 *
 * The module-level `db` singleton is deliberately never imported: these tests
 * must not share state with the rest of the suite.
 *
 * Covered:
 *  - habit create / rename / short_name / reorder persist across reopen
 *  - archive tombstone hides a row; includeDeleted shows it; restore un-hides it
 *  - nextHabitSortOrder appends after the archived max over tombstone-inclusive
 *    rows
 *  - check writes ONE deterministic completion row keyed by
 *    habitCompletionId(habit_id, date)
 *  - uncheck soft-deletes it and preserves the note in the tombstone
 *  - re-check resurrects the SAME row (no duplicate) and keeps its note
 *  - a multi-line note survives reopen and a note-only save keeps completed_at
 */

const createdNames: string[] = []
const opened: OrbitDB[] = []

function newName(): string {
  const name = `orbit-habit-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

const DAY = '2026-10-31'
const COMPLETED_AT = '2026-10-31T08:00:00.000Z'

function habit(over: Partial<Habit> = {}): Habit {
  return {
    id: 'habit-1',
    name: '每天跑步',
    short_name: '跑步',
    sort_order: 0,
    updated_at: '2026-10-30T00:00:00.000Z',
    deleted_at: null,
    ...over,
  }
}

function completion(over: Partial<HabitCompletion> = {}): HabitCompletion {
  return {
    id: habitCompletionId('habit-1', DAY),
    habit_id: 'habit-1',
    date: DAY,
    note: null,
    completed_at: COMPLETED_AT,
    updated_at: '2026-10-31T08:00:00.000Z',
    deleted_at: null,
    ...over,
  }
}

describe('habit CRUD persistence across reopen', () => {
  it('persists a created habit and reads it after closing and reopening', async () => {
    const name = newName()
    const first = open(name)
    const h = habit()
    await first.repo.upsert<Habit>('habits', h)
    first.database.close()

    const second = open(name)
    const rows = await second.repo.list<Habit>('habits')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: h.id,
      name: h.name,
      short_name: h.short_name,
      sort_order: h.sort_order,
      deleted_at: null,
    })
  })

  it('persists a rename and a short_name change', async () => {
    const name = newName()
    const first = open(name)
    const h = habit()
    await first.repo.upsert<Habit>('habits', h)
    await first.repo.upsert<Habit>('habits', {
      id: h.id,
      name: '每天读书',
      short_name: '读书',
      sort_order: h.sort_order,
    })
    first.database.close()

    const second = open(name)
    const rows = await second.repo.list<Habit>('habits')
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('每天读书')
    expect(rows[0].short_name).toBe('读书')
  })

  it('persists a reorder and sortHabits returns the new order deterministically', async () => {
    const name = newName()
    const first = open(name)
    const a = habit({ id: 'habit-a', name: 'A', short_name: 'A', sort_order: 0 })
    const b = habit({ id: 'habit-b', name: 'B', short_name: 'B', sort_order: 1 })
    const c = habit({ id: 'habit-c', name: 'C', short_name: 'C', sort_order: 2 })
    for (const h of [a, b, c]) await first.repo.upsert<Habit>('habits', h)

    // Reverse the order by rewriting sort_order 0..n-1 over the rows.
    await first.repo.upsert<Habit>('habits', { ...c, sort_order: 0 })
    await first.repo.upsert<Habit>('habits', { ...b, sort_order: 1 })
    await first.repo.upsert<Habit>('habits', { ...a, sort_order: 2 })
    first.database.close()

    const second = open(name)
    const rows = await second.repo.list<Habit>('habits')
    expect(sortHabits(rows).map((h) => h.id)).toEqual(['habit-c', 'habit-b', 'habit-a'])
  })

  it('archives, hides, reveals with includeDeleted, and restores a habit', async () => {
    const name = newName()
    const first = open(name)
    const h = habit()
    await first.repo.upsert<Habit>('habits', h)
    await first.repo.softDelete('habits', h.id)
    first.database.close()

    const second = open(name)
    expect(await second.repo.list<Habit>('habits')).toHaveLength(0)
    const tombstoned = await second.repo.list<Habit>('habits', { includeDeleted: true })
    expect(tombstoned).toHaveLength(1)
    expect(tombstoned[0].deleted_at).not.toBeNull()
    second.database.close()

    const third = open(name)
    await third.repo.upsert<Habit>('habits', {
      id: h.id,
      name: h.name,
      short_name: h.short_name,
      sort_order: h.sort_order,
      deleted_at: null,
    })
    third.database.close()

    const fourth = open(name)
    const live = await fourth.repo.list<Habit>('habits')
    expect(live).toHaveLength(1)
    expect(live[0].id).toBe(h.id)
    expect(live[0].deleted_at).toBeNull()
  })

  it('appends nextHabitSortOrder after the archived max over tombstone-inclusive rows', async () => {
    const name = newName()
    const first = open(name)
    const live = habit({ id: 'habit-live', sort_order: 3 })
    const archived = habit({
      id: 'habit-archived',
      sort_order: 7,
      deleted_at: '2026-10-20T00:00:00.000Z',
    })
    await first.repo.upsert<Habit>('habits', live)
    await first.repo.upsert<Habit>('habits', archived)
    first.database.close()

    const second = open(name)
    const all = await second.repo.list<Habit>('habits', { includeDeleted: true })
    expect(all).toHaveLength(2)
    expect(nextHabitSortOrder(all)).toBe(8)
  })
})

describe('habit completion persistence across reopen', () => {
  it('creates exactly one completion keyed by habitCompletionId', async () => {
    const name = newName()
    const first = open(name)
    const h = habit()
    await first.repo.upsert<Habit>('habits', h)
    const id = habitCompletionId(h.id, DAY)
    await first.repo.upsert<HabitCompletion>('habitCompletions', {
      id,
      habit_id: h.id,
      date: DAY,
      note: null,
      completed_at: COMPLETED_AT,
    })
    first.database.close()

    const second = open(name)
    const rows = await second.repo.list<HabitCompletion>('habitCompletions')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(id)
    expect(rows[0].date).toBe(DAY)
  })

  it('unchecks by tombstoning the row while keeping its note for includeDeleted', async () => {
    const name = newName()
    const first = open(name)
    const id = habitCompletionId('habit-1', DAY)
    await first.repo.upsert<HabitCompletion>('habitCompletions', completion({ note: '今天状态很好' }))
    await first.repo.softDelete('habitCompletions', id)
    first.database.close()

    const second = open(name)
    // The default list hides the unchecked row.
    expect(await second.repo.list<HabitCompletion>('habitCompletions')).toHaveLength(0)
    // The tombstone is still there, with the note intact.
    const all = await second.repo.list<HabitCompletion>('habitCompletions', {
      includeDeleted: true,
    })
    expect(all).toHaveLength(1)
    expect(all[0].deleted_at).not.toBeNull()
    expect(all[0].note).toBe('今天状态很好')
  })

  it('re-checks by resurrecting the same row: one live row, note preserved', async () => {
    const name = newName()
    const first = open(name)
    const id = habitCompletionId('habit-1', DAY)
    await first.repo.upsert<HabitCompletion>(
      'habitCompletions',
      completion({ id, note: '第一次打卡的备注' }),
    )
    await first.repo.softDelete('habitCompletions', id)
    first.database.close()

    // Read the tombstone (includeDeleted) and reuse its note on re-check.
    const second = open(name)
    const tombstoned = await second.repo.list<HabitCompletion>('habitCompletions', {
      includeDeleted: true,
    })
    expect(tombstoned).toHaveLength(1)
    const existing = tombstoned[0]
    await second.repo.upsert<HabitCompletion>('habitCompletions', {
      id,
      habit_id: existing.habit_id,
      date: existing.date,
      note: existing.note ?? null,
      completed_at: new Date().toISOString(),
      deleted_at: null,
    })
    second.database.close()

    const third = open(name)
    const live = await third.repo.list<HabitCompletion>('habitCompletions')
    expect(live).toHaveLength(1)
    expect(live[0].id).toBe(id)
    expect(live[0].deleted_at).toBeNull()
    expect(live[0].note).toBe('第一次打卡的备注')
    // Exactly one row exists for the id — no duplicate was inserted.
    const stored = await third.database.habitCompletions.where('id').equals(id).count()
    expect(stored).toBe(1)
  })

  it('preserves a multi-line note and completed_at across reopen on a note-only save', async () => {
    const name = newName()
    const first = open(name)
    const id = habitCompletionId('habit-1', DAY)
    await first.repo.upsert<HabitCompletion>('habitCompletions', completion({ id, note: '第一行' }))

    // A note-only save keeps the original completed_at (tap time).
    const before = await first.repo.list<HabitCompletion>('habitCompletions', {
      includeDeleted: true,
    })
    await first.repo.upsert<HabitCompletion>('habitCompletions', {
      id,
      habit_id: before[0].habit_id,
      date: before[0].date,
      note: '第一行\n第二行',
      completed_at: before[0].completed_at,
    })
    first.database.close()

    const second = open(name)
    const rows = await second.repo.list<HabitCompletion>('habitCompletions')
    expect(rows).toHaveLength(1)
    expect(rows[0].note).toBe('第一行\n第二行')
    expect(rows[0].note).toContain('\n')
    expect(rows[0].completed_at).toBe(COMPLETED_AT)
  })
})
