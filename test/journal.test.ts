import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import type { JournalEntry } from '@/lib/types'

/**
 * JOURNAL-01/JOURNAL-03 persistence proof (Phase 10).
 *
 * Every case runs against a FRESH OrbitDB + LocalRepository instance (never the
 * shared singleton), so writes are proven to have reached fake-indexeddb rather
 * than an in-memory test double. The unique `&day_key` index is what guarantees
 * "at most one row per logical local day".
 */

const DAY = '2026-10-30'

const dbNames: string[] = []
const opened: OrbitDB[] = []

function fresh(suffix: string): { db: OrbitDB; repo: LocalRepository } {
  const name = `test-journal-${suffix}`
  dbNames.push(name)
  const db = new OrbitDB(name)
  opened.push(db)
  return { db, repo: new LocalRepository(db) }
}

afterEach(async () => {
  for (const db of opened.splice(0)) db.close()
  for (const name of dbNames.splice(0)) {
    await Dexie.delete(name).catch(() => {})
  }
})

describe('journalEntries persistence', () => {
  it('inserts a deterministic-id row preserving newlines and a real updated_at', async () => {
    const { repo } = fresh('create')

    await repo.upsert<JournalEntry>('journalEntries', {
      id: `journal-${DAY}`,
      day_key: DAY,
      content: '第一行\n第二行',
    })

    const rows = await repo.list<JournalEntry>('journalEntries')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(`journal-${DAY}`)
    expect(rows[0].day_key).toBe(DAY)
    expect(rows[0].content).toBe('第一行\n第二行')
    expect(rows[0].deleted_at).toBeNull()
    expect(rows[0].updated_at).toBeTruthy()
    expect(Number.isNaN(Date.parse(rows[0].updated_at))).toBe(false)
  })

  it('updates the same day in place when the same id is saved again', async () => {
    const { repo } = fresh('update-same-id')
    const id = `journal-${DAY}`
    await repo.upsert<JournalEntry>('journalEntries', {
      id,
      day_key: DAY,
      content: '初稿',
    })

    await repo.upsert<JournalEntry>('journalEntries', {
      id,
      day_key: DAY,
      content: '改过的内容',
    })

    const rows = await repo.list<JournalEntry>('journalEntries')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(id)
    expect(rows[0].content).toBe('改过的内容')
  })

  it('persists empty content as a live empty row', async () => {
    const { repo } = fresh('empty')

    await repo.upsert<JournalEntry>('journalEntries', {
      id: `journal-${DAY}`,
      day_key: DAY,
      content: '',
    })

    const rows = await repo.list<JournalEntry>('journalEntries')
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe('')
    expect(rows[0].deleted_at).toBeNull()
  })

  it('adopts the existing id for a second row on the same day instead of throwing', async () => {
    const { repo } = fresh('duplicate-day')
    await repo.upsert<JournalEntry>('journalEntries', {
      id: 'journal-a',
      day_key: DAY,
      content: '第一天',
    })

    // Phase 19 / MERGE-02 / SC-2: a different id for the same day now adopts
    // the canonical id (the UI can hold a stale id after a merge) instead of
    // throwing a ConstraintError.
    await repo.upsert<JournalEntry>('journalEntries', {
      id: 'journal-b',
      day_key: DAY,
      content: '更新的正文',
    })

    const rows = await repo.list<JournalEntry>('journalEntries')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('journal-a')
    expect(rows[0].content).toBe('更新的正文')
  })

  it('survives closing and reopening the database', async () => {
    const name = `test-journal-reopen`
    dbNames.push(name)
    const firstDb = new OrbitDB(name)
    await new LocalRepository(firstDb).upsert<JournalEntry>('journalEntries', {
      id: `journal-${DAY}`,
      day_key: DAY,
      content: '重开后仍在',
    })
    firstDb.close()

    const reopened = new OrbitDB(name)
    opened.push(reopened)
    const rows = await new LocalRepository(reopened).list<JournalEntry>('journalEntries')
    expect(rows).toHaveLength(1)
    expect(rows[0].day_key).toBe(DAY)
    expect(rows[0].content).toBe('重开后仍在')
  })
})
