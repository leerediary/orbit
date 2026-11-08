import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { readOutbox } from '@/lib/outbox'
import { naturalKeyOf, reconcileNaturalKeys } from '@/lib/sync/natural-keys'
import type { DailyTodo, HabitCompletion } from '@/lib/types'

/**
 * Phase 19 / MERGE-02 — fake-indexeddb proofs for the client-owned soft
 * natural-key projection.
 *
 * Each test opens a fresh, uniquely named database (the module singleton is
 * never imported) and asserts on the real tables plus `syncOutbox`, so the
 * tombstone and its queued delete are checked together. A fixed `nowIso` keeps
 * the tombstone timestamps deterministic.
 */

const createdNames: string[] = []
const opened: OrbitDB[] = []

const NOW = '2026-11-01T00:00:00.000Z'
const fixedNow = () => NOW

function newName(): string {
  const name = `orbit-natural-keys-${Date.now()}-${Math.random().toString(36).slice(2)}`
  createdNames.push(name)
  return name
}

function open(): OrbitDB {
  const database = new OrbitDB(newName())
  opened.push(database)
  return database
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

function habitCompletion(over: Partial<HabitCompletion> = {}): HabitCompletion {
  return {
    id: 'hc-a',
    habit_id: 'habit-1',
    date: '2026-10-31',
    note: null,
    completed_at: '2026-10-31T09:00:00.000Z',
    updated_at: '2026-10-31T09:00:00.000Z',
    deleted_at: null,
    ...over,
  }
}

function dailyTodo(over: Partial<DailyTodo> = {}): DailyTodo {
  return {
    id: 'todo-a',
    task_id: 'task-1',
    name: null,
    completed: null,
    completed_at: null,
    added_at: '2026-10-31T08:00:00.000Z',
    updated_at: '2026-10-31T09:00:00.000Z',
    deleted_at: null,
    ...over,
  }
}

function liveHabitCompletions(database: OrbitDB): Promise<HabitCompletion[]> {
  return database.habitCompletions
    .toArray()
    .then((rows) => rows.filter((row) => row.deleted_at == null))
}

describe('naturalKeyOf', () => {
  it('names live habit-completion keys and ignores tombstones / malformed rows', () => {
    expect(naturalKeyOf('habitCompletions', habitCompletion())).toBe('habit-1::2026-10-31')
    expect(naturalKeyOf('habitCompletions', habitCompletion({ deleted_at: NOW }))).toBeNull()
    expect(naturalKeyOf('habitCompletions', habitCompletion({ habit_id: '' }))).toBeNull()
    expect(naturalKeyOf('habitCompletions', habitCompletion({ date: undefined }))).toBeNull()
  })

  it('names linked daily-todo keys and gives standalone todos no key', () => {
    expect(naturalKeyOf('dailyTodos', dailyTodo())).toBe('task:task-1')
    expect(naturalKeyOf('dailyTodos', dailyTodo({ task_id: null }))).toBeNull()
    expect(naturalKeyOf('dailyTodos', dailyTodo({ task_id: '' }))).toBeNull()
    expect(naturalKeyOf('dailyTodos', dailyTodo({ deleted_at: NOW }))).toBeNull()
  })

  it('returns null for every other entity', () => {
    for (const entity of [
      'categories',
      'goals',
      'milestones',
      'tasks',
      'journalEntries',
      'habits',
      'pomodoroSessions',
    ] as const) {
      expect(naturalKeyOf(entity, { deleted_at: null })).toBeNull()
    }
  })
})

describe('reconcileNaturalKeys — habit completions', () => {
  it('keeps one live row, merges fields, tombstones the loser, and queues one delete', async () => {
    const database = open()
    await database.habitCompletions.bulkPut([
      habitCompletion({
        id: 'hc-a',
        note: 'note from a',
        completed_at: '2026-10-31T10:00:00.000Z',
        updated_at: '2026-10-31T10:05:00.000Z',
      }),
      // Later updated_at ⇒ deterministic base; note is null so the merge must
      // carry the loser's note forward.
      habitCompletion({
        id: 'hc-b',
        note: null,
        completed_at: '2026-10-31T09:00:00.000Z',
        updated_at: '2026-10-31T11:00:00.000Z',
      }),
    ])

    const enqueued = await reconcileNaturalKeys(database, fixedNow)
    expect(enqueued).toBe(1)

    const live = await liveHabitCompletions(database)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({
      id: 'hc-b',
      note: 'note from a',
      completed_at: '2026-10-31T09:00:00.000Z',
      updated_at: NOW,
    })

    const tombstone = await database.habitCompletions.get('hc-a')
    expect(tombstone).toMatchObject({ deleted_at: NOW, updated_at: NOW })

    // The merged base now carries a fresh timestamp and is pushed as an upsert,
    // so the loser's preserved note propagates to the server (CR-03).
    const entries = await readOutbox(database)
    expect(entries).toHaveLength(2)
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: 'habitCompletions',
          row_id: 'hc-a',
          op: 'delete',
          updated_at: NOW,
        }),
        expect.objectContaining({
          entity: 'habitCompletions',
          row_id: 'hc-b',
          op: 'upsert',
          updated_at: NOW,
        }),
      ]),
    )
  })

  it('chooses the same base when insertion order is reversed', async () => {
    const rows = [
      habitCompletion({ id: 'hc-a', note: 'a', updated_at: '2026-10-31T10:00:00.000Z' }),
      habitCompletion({ id: 'hc-b', note: 'b', updated_at: '2026-10-31T10:00:00.000Z' }),
    ]

    const first = open()
    await first.habitCompletions.bulkPut(rows)
    await reconcileNaturalKeys(first, fixedNow)
    const firstLive = await liveHabitCompletions(first)

    const reversed = open()
    await reversed.habitCompletions.bulkPut([...rows].reverse())
    await reconcileNaturalKeys(reversed, fixedNow)
    const reversedLive = await liveHabitCompletions(reversed)

    // Equal updated_at ⇒ greater id wins, regardless of iteration order.
    expect(firstLive.map((row) => row.id)).toEqual(['hc-b'])
    expect(reversedLive.map((row) => row.id)).toEqual(['hc-b'])
    expect(reversedLive[0]).toEqual(firstLive[0])
  })
})

describe('reconcileNaturalKeys — daily todos', () => {
  it('collapses two linked todos into one live row and one tombstone', async () => {
    const database = open()
    await database.dailyTodos.bulkPut([
      dailyTodo({ id: 'todo-a', task_id: 'task-1', updated_at: '2026-10-31T09:00:00.000Z' }),
      dailyTodo({
        id: 'todo-b',
        task_id: 'task-1',
        completed_at: '2026-10-31T07:00:00.000Z',
        updated_at: '2026-10-31T12:00:00.000Z',
      }),
    ])

    expect(await reconcileNaturalKeys(database, fixedNow)).toBe(1)

    const live = (await database.dailyTodos.toArray()).filter((row) => row.deleted_at == null)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({
      id: 'todo-b',
      task_id: 'task-1',
      completed_at: '2026-10-31T07:00:00.000Z',
      updated_at: '2026-10-31T12:00:00.000Z',
    })

    const entries = await readOutbox(database)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ entity: 'dailyTodos', row_id: 'todo-a', op: 'delete' })
  })

  it('never groups standalone todos or tombstones', async () => {
    const database = open()
    await database.dailyTodos.bulkPut([
      dailyTodo({ id: 'standalone-a', task_id: null, name: '买菜' }),
      dailyTodo({ id: 'standalone-b', task_id: null, name: '买菜' }),
      // A tombstone sharing the live key must stay untouched too.
      dailyTodo({ id: 'todo-dead', task_id: 'task-1', deleted_at: NOW, updated_at: NOW }),
      dailyTodo({ id: 'todo-live', task_id: 'task-1' }),
    ])

    expect(await reconcileNaturalKeys(database, fixedNow)).toBe(0)
    expect(await readOutbox(database)).toHaveLength(0)
    expect(await database.dailyTodos.count()).toBe(4)
    expect((await database.dailyTodos.get('todo-dead'))!.deleted_at).toBe(NOW)
  })
})

describe('reconcileNaturalKeys — idempotence', () => {
  it('returns 0 and enqueues nothing on a second run', async () => {
    const database = open()
    await database.habitCompletions.bulkPut([
      habitCompletion({ id: 'hc-a', note: 'a', updated_at: '2026-10-31T10:00:00.000Z' }),
      habitCompletion({ id: 'hc-b', note: 'b', updated_at: '2026-10-31T11:00:00.000Z' }),
    ])

    expect(await reconcileNaturalKeys(database, fixedNow)).toBe(1)
    const afterFirst = await readOutbox(database)
    const snapshot = await database.habitCompletions.toArray()

    expect(await reconcileNaturalKeys(database, fixedNow)).toBe(0)
    expect(await readOutbox(database)).toHaveLength(afterFirst.length)
    expect(await database.habitCompletions.toArray()).toEqual(snapshot)
  })
})
