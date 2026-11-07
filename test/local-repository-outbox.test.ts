import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import { countOutbox, readOutbox } from '@/lib/outbox'
import { SYNC_KEYS, getSyncValue } from '@/lib/sync-store'
import { onLocalWrite } from '@/lib/sync-triggers'
import type { Habit, JournalEntry } from '@/lib/types'

/**
 * Phase 18 / SYNC-01 + SYNC-04 — atomic change capture at the two write funnels.
 *
 * Every test drives a real LocalRepository against a fresh, uniquely named
 * fake-indexeddb database and inspects `database.syncOutbox` directly. The
 * module-level singleton is never imported.
 */

const createdNames: string[] = []
const opened: OrbitDB[] = []

function newName(): string {
  const name = `orbit-repo-outbox-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

describe('outbox capture in LocalRepository', () => {
  it('enqueues exactly one upsert entry matching the written row', async () => {
    const { database, repo } = open(newName())
    await repo.upsert<Habit>('habits', habit())

    const stored = await database.habits.get('habit-1')
    const entries = await readOutbox(database)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      entity: 'habits',
      row_id: 'habit-1',
      op: 'upsert',
      updated_at: stored!.updated_at,
    })
  })

  it('enqueues op:delete when a tombstone is written through upsert', async () => {
    const { database, repo } = open(newName())
    await repo.upsert<Habit>('habits', habit({ deleted_at: '2026-10-29T00:00:00.000Z' }))

    const entries = await readOutbox(database)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ entity: 'habits', row_id: 'habit-1', op: 'delete' })
  })

  it('softDelete tombstones the row and enqueues one delete entry in the same transaction', async () => {
    const { database, repo } = open(newName())
    await database.habits.bulkPut([habit()])

    await repo.softDelete('habits', 'habit-1')

    const row = await database.habits.get('habit-1')
    expect(row).toBeDefined()
    expect(row!.deleted_at).not.toBeNull()
    expect(row!.updated_at).toBe(row!.deleted_at)

    const entries = await readOutbox(database)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ entity: 'habits', row_id: 'habit-1', op: 'delete' })
    expect(entries[0].updated_at).toBe(row!.updated_at)
  })

  it('hardDelete physically removes the row and enqueues exactly one purge entry', async () => {
    const { database, repo } = open(newName())
    const stored = habit()
    await database.habits.bulkPut([stored])

    await repo.hardDelete('habits', 'habit-1')

    expect(await database.habits.get('habit-1')).toBeUndefined()
    const entries = await readOutbox(database)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      entity: 'habits',
      row_id: 'habit-1',
      op: 'purge',
      updated_at: stored.updated_at,
    })
  })

  it('hardDelete of a missing row enqueues nothing and emits nothing', async () => {
    const { database, repo } = open(newName())
    let notifications = 0
    const remove = onLocalWrite(() => {
      notifications += 1
    })
    try {
      await repo.hardDelete('habits', 'never-existed')

      expect(await countOutbox(database)).toBe(0)
      expect(notifications).toBe(0)
    } finally {
      remove()
    }
  })

  it('adopts the existing journal id when the day_key is held by another id', async () => {
    const { database, repo } = open(newName())
    await database.journalEntries.bulkPut([
      {
        id: 'journal-canonical',
        day_key: '2026-11-01',
        content: 'canonical body',
        updated_at: '2026-10-31T00:00:00.000Z',
        deleted_at: null,
      },
    ])

    // A stale UI id must not create a second row on an occupied day.
    await repo.upsert<JournalEntry>('journalEntries', {
      id: 'journal-stale',
      day_key: '2026-11-01',
      content: 'edited body',
    })

    const rows = await database.journalEntries.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('journal-canonical')
    expect(rows[0].content).toBe('edited body')

    const entries = await readOutbox(database)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      entity: 'journalEntries',
      row_id: 'journal-canonical',
      op: 'upsert',
    })
  })

  it('bulkLoad and bulkLoadAll never enqueue (pull/import path)', async () => {
    const { database, repo } = open(newName())

    await repo.bulkLoad('habits', [habit()])
    await repo.bulkLoadAll([
      ['goals', [{ id: 'goal-1', name: 'G', category_id: null, created_at: 'x', sort_order: 0, updated_at: 'x', deleted_at: null }]],
    ])

    expect(await database.habits.count()).toBe(1)
    expect(await database.goals.count()).toBe(1)
    expect(await countOutbox(database)).toBe(0)
  })

  it('replaceAll clears the outbox, marks needs-full-reconcile, and emits once after commit', async () => {
    const { database, repo } = open(newName())
    await repo.upsert<Habit>('habits', habit())
    expect(await countOutbox(database)).toBe(1)

    let notifications = 0
    const remove = onLocalWrite(() => {
      notifications += 1
    })
    try {
      await repo.replaceAll([['habits', [habit({ id: 'replaced' })]]])

      expect(await countOutbox(database)).toBe(0)
      expect(await getSyncValue(database, SYNC_KEYS.status, null)).toBe('needs-full-reconcile')
      expect(notifications).toBe(1)
      expect((await database.habits.toArray()).map((h) => h.id)).toEqual(['replaced'])
    } finally {
      remove()
    }
  })

  it('fires onLocalWrite once per successful write, including hardDelete, and isolates throwing listeners', async () => {
    const { repo } = open(newName())

    let count = 0
    const removeCount = onLocalWrite(() => {
      count += 1
    })
    const removeThrow = onLocalWrite(() => {
      throw new Error('listener boom')
    })
    try {
      await repo.upsert<Habit>('habits', habit())
      expect(count).toBe(1)

      await repo.softDelete('habits', 'habit-1')
      expect(count).toBe(2)

      // Phase 19 / D-03: hardDelete enqueues a purge and emits once after commit.
      await repo.hardDelete('habits', 'habit-1')
      expect(count).toBe(3)
    } finally {
      removeCount()
      removeThrow()
    }
  })
})
