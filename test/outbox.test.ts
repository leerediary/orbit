import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import {
  countOutbox,
  deleteOutboxEntries,
  enqueueOutbox,
  readOutbox,
  type OutboxDraft,
} from '@/lib/outbox'
import {
  getLastSyncedAt,
  getSyncCursor,
  getSyncValue,
  setLastSyncedAt,
  setSyncCursor,
  setSyncValue,
} from '@/lib/sync-store'

/**
 * Phase 18 / SYNC-01 — durable change queue primitives.
 *
 * Every test opens a fresh, uniquely named fake-indexeddb database and closes +
 * deletes it afterwards, so the module-level `db` singleton is never touched.
 * The tests prove the two side tables exist, `seq` is monotonic, reads are
 * ordered, deletes are targeted, and sync state round-trips without leaking
 * into the entity/export contract.
 */

const createdNames: string[] = []
const opened: OrbitDB[] = []

function newName(): string {
  const name = `orbit-outbox-${Date.now()}-${Math.random().toString(36).slice(2)}`
  createdNames.push(name)
  return name
}

function open(name: string): OrbitDB {
  const database = new OrbitDB(name)
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

function draft(over: Partial<OutboxDraft> = {}): OutboxDraft {
  return {
    entity: 'habits',
    row_id: 'row-1',
    op: 'upsert',
    updated_at: '2026-11-01T00:00:00.000Z',
    ...over,
  }
}

describe('sync side stores', () => {
  it('exposes syncOutbox and syncState alongside the nine entity stores', async () => {
    const db = open(newName())
    await db.open()
    const names = db.tables.map((t) => t.name)
    expect(names).toContain('syncOutbox')
    expect(names).toContain('syncState')
    for (const entity of [
      'categories',
      'goals',
      'milestones',
      'tasks',
      'dailyTodos',
      'journalEntries',
      'habits',
      'habitCompletions',
      'pomodoroSessions',
    ]) {
      expect(names).toContain(entity)
    }
  })
})

describe('outbox primitives', () => {
  it('assigns a strictly increasing seq and reads entries in ascending order', async () => {
    const db = open(newName())
    await enqueueOutbox(db, draft({ row_id: 'first' }))
    await enqueueOutbox(db, draft({ row_id: 'second' }))
    await enqueueOutbox(db, draft({ row_id: 'third' }))

    const entries = await readOutbox(db)
    expect(entries.map((e) => e.row_id)).toEqual(['first', 'second', 'third'])
    const seqs = entries.map((e) => e.seq as number)
    expect(seqs[0]).toBeLessThan(seqs[1])
    expect(seqs[1]).toBeLessThan(seqs[2])
    expect(entries[0]).toMatchObject({
      entity: 'habits',
      row_id: 'first',
      op: 'upsert',
      updated_at: '2026-11-01T00:00:00.000Z',
    })
  })

  it('deletes exactly the requested seq rows and leaves newer rows', async () => {
    const db = open(newName())
    for (const id of ['a', 'b', 'c', 'd']) {
      await enqueueOutbox(db, draft({ row_id: id }))
    }
    const before = await readOutbox(db)
    expect(before).toHaveLength(4)

    await deleteOutboxEntries(db, [before[0].seq as number, before[1].seq as number])

    const after = await readOutbox(db)
    expect(after.map((e) => e.row_id)).toEqual(['c', 'd'])
  })

  it('counts zero for a fresh store and N after N enqueues', async () => {
    const db = open(newName())
    expect(await countOutbox(db)).toBe(0)
    await enqueueOutbox(db, draft({ row_id: 'x' }))
    await enqueueOutbox(db, draft({ row_id: 'y' }))
    await enqueueOutbox(db, draft({ row_id: 'z' }))
    expect(await countOutbox(db)).toBe(3)
  })
})

describe('sync state store', () => {
  it('returns the fallback when absent and round-trips values', async () => {
    const db = open(newName())

    expect(await getSyncValue(db, 'missing', 'fallback')).toBe('fallback')

    await setSyncValue(db, 'num', 42)
    expect(await getSyncValue(db, 'num', 0)).toBe(42)

    await setSyncValue(db, 'str', 'hello')
    expect(await getSyncValue(db, 'str', '')).toBe('hello')

    await setSyncValue(db, 'bool', false)
    expect(await getSyncValue(db, 'bool', true)).toBe(false)

    await setSyncValue(db, 'nil', null)
    expect(await getSyncValue<string | null>(db, 'nil', null)).toBeNull()
  })

  it('exposes cursor and lastSyncedAt convenience wrappers', async () => {
    const db = open(newName())
    expect(await getSyncCursor(db)).toBe(0)
    expect(await getLastSyncedAt(db)).toBeNull()

    await setSyncCursor(db, 17)
    await setLastSyncedAt(db, '2026-11-01T12:00:00.000Z')

    expect(await getSyncCursor(db)).toBe(17)
    expect(await getLastSyncedAt(db)).toBe('2026-11-01T12:00:00.000Z')
  })
})
