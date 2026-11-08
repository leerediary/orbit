import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import type { Entity } from '@/lib/repository'
import {
  SYNC_KEYS,
  getSyncCursor,
  getLastSyncedAt,
  getSyncValue,
} from '@/lib/sync-store'
import {
  applyRemoteSyncApplied,
  emitSyncApplied,
  getSyncAppliedSeq,
  subscribeSyncApplied,
} from '@/lib/sync-applied'
import {
  QUARANTINE_KEY,
  appendQuarantine,
  countQuarantine,
  listQuarantine,
} from '@/lib/sync-quarantine'
import { validateImportRow } from '@/lib/entity-schema'
import { readOutbox } from '@/lib/outbox'
import type { Goal, JournalEntry, Task } from '@/lib/types'

/**
 * Phase 18 / SYNC-04 (T-18-14) — atomic, verbatim `applyRemote`, plus the
 * framework-free applied signal and the persisted quarantine.
 */

const createdNames: string[] = []
const opened: OrbitDB[] = []

function newName(): string {
  const name = `orbit-apply-remote-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    category_id: 'cat-1',
    name: '长期目标',
    created_at: '2026-10-01T00:00:00.000Z',
    sort_order: 0,
    updated_at: '2026-10-02T00:00:00.000Z',
    deleted_at: null,
    ...over,
  }
}

function journal(over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: 'journal-1',
    day_key: '2026-11-01',
    content: '正文',
    updated_at: '2026-10-02T00:00:00.000Z',
    deleted_at: null,
    ...over,
  }
}

function quantityTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    milestone_id: null,
    goal_id: 'goal-1',
    parent_id: null,
    name: '读书',
    progress_type: 'quantity',
    unit: '页',
    target_value: 100,
    current_value: 5,
    completed: false,
    completed_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    sort_order: 0,
    updated_at: '2026-10-02T00:00:00.000Z',
    deleted_at: null,
    ...over,
  }
}

/** Pull envelope: the data row plus the writer device id (23 / RESEARCH §4a). */
function remote(row: object, deviceId: string | null = null) {
  return { data: row as Record<string, unknown>, device_id: deviceId }
}

function entriesOf(
  ...items: Array<[Entity, unknown[]]>
): Array<readonly [Entity, unknown[]]> {
  return items
}

describe('LocalRepository.applyRemote', () => {
  it('writes the row verbatim and persists the cursor + lastSyncedAt', async () => {
    const { database, repo } = open(newName())
    const row = goal()

    await repo.applyRemote(entriesOf(['goals', [row]]), 7)

    // Byte-identical: id / updated_at / deleted_at are NOT re-stamped.
    expect(await database.goals.get('goal-1')).toEqual(row)
    expect(await getSyncCursor(database)).toBe(7)
    expect(await getLastSyncedAt(database)).not.toBeNull()
    // Sanity: the row is still a valid import shape.
    expect(() => validateImportRow('goals', row, 0)).not.toThrow()
  })

  it('rolls back every entity write and leaves the cursor unchanged on failure', async () => {
    const { database, repo } = open(newName())

    await expect(
      repo.applyRemote(
        entriesOf(
          ['goals', [goal()]],
          // categories requires a non-empty `id` primary key — Dexie rejects it.
          ['categories', [{ name: '没有主键' }]],
        ),
        9,
      ),
    ).rejects.toBeTruthy()

    expect(await database.goals.get('goal-1')).toBeUndefined()
    expect(await getSyncCursor(database)).toBe(0)
    expect(await getLastSyncedAt(database)).toBeNull()
  })

  it('never enqueues an outbox entry (no echo, SYNC-04)', async () => {
    const { database, repo } = open(newName())
    await repo.applyRemote(entriesOf(['goals', [goal()]]), 3)

    expect(await database.syncOutbox.count()).toBe(0)
  })

  it('preserves a tombstone verbatim', async () => {
    const { database, repo } = open(newName())
    const tombstone = goal({ id: 'goal-dead', deleted_at: '2026-10-03T00:00:00.000Z' })

    await repo.applyRemote(entriesOf(['goals', [tombstone]]), 4)

    const stored = await database.goals.get('goal-dead')
    expect(stored).toEqual(tombstone)
    expect(stored!.deleted_at).toBe('2026-10-03T00:00:00.000Z')
  })

  it('leaves the local row untouched when the incoming row is older, and advances the cursor', async () => {
    const { database, repo } = open(newName())
    const local = goal({ name: '本地', updated_at: '2026-10-05T00:00:00.000Z' })
    await database.goals.bulkPut([local])

    const incoming = goal({ name: '远端', updated_at: '2026-10-01T00:00:00.000Z' })
    await repo.applyRemote(entriesOf(['goals', [remote(incoming, 'device-b')]]), 11)

    expect(await database.goals.get('goal-1')).toEqual(local)
    expect(await getSyncCursor(database)).toBe(11)
    expect(await database.syncOutbox.count()).toBe(0)
  })

  it('replaces the local row when the incoming row is newer', async () => {
    const { database, repo } = open(newName())
    await database.goals.bulkPut([goal({ name: '本地', updated_at: '2026-10-01T00:00:00.000Z' })])

    const incoming = goal({ name: '远端', updated_at: '2026-10-05T00:00:00.000Z' })
    await repo.applyRemote(entriesOf(['goals', [remote(incoming, 'device-b')]]), 12)

    expect(await database.goals.get('goal-1')).toEqual(incoming)
    expect(await getSyncCursor(database)).toBe(12)
    expect(await database.syncOutbox.count()).toBe(0)
  })

  it('stores an incoming tombstone when it ties the local live row', async () => {
    const { database, repo } = open(newName())
    const ts = '2026-10-02T00:00:00.000Z'
    await database.goals.bulkPut([goal({ updated_at: ts, deleted_at: null })])

    const incoming = goal({ updated_at: ts, deleted_at: ts })
    await repo.applyRemote(entriesOf(['goals', [remote(incoming, 'device-b')]]), 13)

    const stored = await database.goals.get('goal-1')
    expect(stored!.deleted_at).toBe(ts)
    expect(await getSyncCursor(database)).toBe(13)
  })

  it('never lowers a quantity task when the incoming row wins with a smaller value', async () => {
    const { database, repo } = open(newName())
    await database.tasks.bulkPut([
      quantityTask({ updated_at: '2026-10-01T00:00:00.000Z', current_value: 12 }),
    ])

    const incoming = quantityTask({ updated_at: '2026-10-05T00:00:00.000Z', current_value: 7 })
    await repo.applyRemote(entriesOf(['tasks', [remote(incoming, 'device-b')]]), 14)

    const stored = await database.tasks.get('task-1')
    expect(stored!.current_value).toBe(12)
    expect(stored!.updated_at).toBe(incoming.updated_at)
    expect(await database.syncOutbox.count()).toBe(0)
  })

  it('raises the stored quantity when the local row wins but the incoming value is higher', async () => {
    const { database, repo } = open(newName())
    await database.tasks.bulkPut([
      quantityTask({ updated_at: '2026-10-05T00:00:00.000Z', current_value: 5 }),
    ])

    const incoming = quantityTask({ updated_at: '2026-10-01T00:00:00.000Z', current_value: 9 })
    await repo.applyRemote(entriesOf(['tasks', [remote(incoming, 'device-b')]]), 15)

    const stored = await database.tasks.get('task-1')
    expect(stored!.current_value).toBe(9)

    // The raise is a genuine local contribution, so exactly one upsert queues.
    const entries = await readOutbox(database)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ entity: 'tasks', row_id: 'task-1', op: 'upsert' })
  })

  it('merges a different-id journal row into one row for the day and preserves both bodies', async () => {
    const { database, repo } = open(newName())
    await database.journalEntries.bulkPut([
      journal({
        id: 'j-local',
        day_key: '2026-11-01',
        content: '本地正文',
        updated_at: '2026-10-01T00:00:00.000Z',
      }),
    ])

    const incoming = journal({
      id: 'j-remote',
      day_key: '2026-11-01',
      content: '远端正文',
      updated_at: '2026-10-05T00:00:00.000Z',
    })

    await expect(
      repo.applyRemote(entriesOf(['journalEntries', [remote(incoming, 'device-b')]]), 20),
    ).resolves.toBeUndefined()

    const rows = await database.journalEntries.where('day_key').equals('2026-11-01').toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('j-remote')
    expect(rows[0].content).toBe('远端正文')
    expect(rows[0].conflict_copies?.map((c) => c.content)).toContain('本地正文')
    expect(await database.journalEntries.count()).toBe(1)
    expect(await getSyncCursor(database)).toBe(20)
    // Ordinary pull path: no echo.
    expect(await database.syncOutbox.count()).toBe(0)
  })

  it('preserves a newer local journal body under the canonical id and queues one upsert', async () => {
    const { database, repo } = open(newName())
    await database.journalEntries.bulkPut([
      journal({
        id: 'j-local',
        day_key: '2026-11-01',
        content: '更新的本地正文',
        updated_at: '2026-10-09T00:00:00.000Z',
      }),
    ])

    const incoming = journal({
      id: 'j-remote',
      day_key: '2026-11-01',
      content: '较旧的远端正文',
      updated_at: '2026-10-01T00:00:00.000Z',
    })
    await repo.applyRemote(entriesOf(['journalEntries', [remote(incoming, 'device-b')]]), 21)

    const rows = await database.journalEntries.where('day_key').equals('2026-11-01').toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('j-remote')
    expect(rows[0].content).toBe('更新的本地正文')
    expect(rows[0].conflict_copies?.map((c) => c.content)).toContain('较旧的远端正文')

    const entries = await readOutbox(database)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      entity: 'journalEntries',
      row_id: 'j-remote',
      op: 'upsert',
    })
  })

  it('is idempotent when the same journal page is applied twice', async () => {
    const { database, repo } = open(newName())
    await database.journalEntries.bulkPut([
      journal({
        id: 'j-local',
        day_key: '2026-11-01',
        content: '本地正文',
        updated_at: '2026-10-01T00:00:00.000Z',
      }),
    ])

    const incoming = journal({
      id: 'j-remote',
      day_key: '2026-11-01',
      content: '远端正文',
      updated_at: '2026-10-05T00:00:00.000Z',
    })
    const page = entriesOf(['journalEntries', [remote(incoming, 'device-b')]])

    await repo.applyRemote(page, 20)
    await repo.applyRemote(page, 21)

    const rows = await database.journalEntries.where('day_key').equals('2026-11-01').toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('j-remote')
    expect(rows[0].conflict_copies?.map((c) => c.content)).toEqual(['本地正文'])
    expect(await database.journalEntries.count()).toBe(1)
    expect(await database.syncOutbox.count()).toBe(0)
  })

  it('does not resurrect a deleted day when a newer local tombstone wins (CR-01)', async () => {
    const { database, repo } = open(newName())
    await database.journalEntries.bulkPut([
      journal({
        id: 'j-local',
        day_key: '2026-11-01',
        content: '已删除的正文',
        updated_at: '2026-10-09T00:00:00.000Z',
        deleted_at: '2026-10-09T00:00:00.000Z',
      }),
    ])

    const incoming = journal({
      id: 'j-remote',
      day_key: '2026-11-01',
      content: '较旧的远端正文',
      updated_at: '2026-10-01T00:00:00.000Z',
    })

    await repo.applyRemote(entriesOf(['journalEntries', [remote(incoming, 'device-b')]]), 22)

    const rows = await database.journalEntries.where('day_key').equals('2026-11-01').toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('j-local')
    expect(rows[0].deleted_at).toBe('2026-10-09T00:00:00.000Z') // tombstone stays, no resurrection
    expect(await database.journalEntries.count()).toBe(1)
    expect(await database.syncOutbox.count()).toBe(0)
    expect(await getSyncCursor(database)).toBe(22)
  })

  it('applies an incoming different-id tombstone over an occupied day without a ConstraintError (CR-01)', async () => {
    const { database, repo } = open(newName())
    await database.journalEntries.bulkPut([
      journal({
        id: 'j-local',
        day_key: '2026-11-01',
        content: '本地正文',
        updated_at: '2026-10-01T00:00:00.000Z',
      }),
    ])

    const incoming = journal({
      id: 'j-remote',
      day_key: '2026-11-01',
      content: '远端正文',
      updated_at: '2026-10-09T00:00:00.000Z',
      deleted_at: '2026-10-09T00:00:00.000Z',
    })

    await expect(
      repo.applyRemote(entriesOf(['journalEntries', [remote(incoming, 'device-b')]]), 23),
    ).resolves.toBeUndefined()

    const rows = await database.journalEntries.where('day_key').equals('2026-11-01').toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('j-remote')
    expect(rows[0].deleted_at).toBe('2026-10-09T00:00:00.000Z') // the tombstone now occupies the day
    expect(await getSyncCursor(database)).toBe(23)
  })

  it('physically deletes purged rows and advances the cursor', async () => {
    const { database, repo } = open(newName())
    await database.goals.bulkPut([goal({ id: 'goal-gone' })])

    await repo.applyRemote([], 22, [{ entity: 'goals', id: 'goal-gone' }])

    // A purge is a physical delete, not a tombstone.
    expect(await database.goals.get('goal-gone')).toBeUndefined()
    expect(await database.goals.count()).toBe(0)
    expect(await getSyncCursor(database)).toBe(22)
  })
})

describe('sync-applied signal', () => {
  it('increments and notifies on emit; applyRemoteSyncApplied only moves forward', () => {
    const start = getSyncAppliedSeq()
    const seen: number[] = []
    const unsubscribe = subscribeSyncApplied((seq) => seen.push(seq))

    const emitted = emitSyncApplied()
    expect(emitted).toBe(start + 1)
    expect(getSyncAppliedSeq()).toBe(start + 1)
    expect(seen).toEqual([start + 1])

    // A stale cross-tab message must never lower the local counter.
    applyRemoteSyncApplied(start)
    expect(getSyncAppliedSeq()).toBe(start + 1)
    expect(seen).toEqual([start + 1])

    // A newer cross-tab sequence wins and notifies.
    applyRemoteSyncApplied(start + 5)
    expect(getSyncAppliedSeq()).toBe(start + 5)
    expect(seen).toEqual([start + 1, start + 5])

    unsubscribe()
  })
})

describe('sync quarantine', () => {
  it('persists entries under the sync state key and reads them back', async () => {
    const { database } = open(newName())

    await appendQuarantine(database, {
      kind: 'pull-invalid',
      entity: 'goals',
      id: 'goal-bad',
      serverSeq: 42,
      reason: '缺少字段 "name"',
      at: '2026-11-01T00:00:00.000Z',
    })
    await appendQuarantine(database, {
      kind: 'push-invalid',
      entity: 'habits',
      id: 'habit-bad',
      reason: '类型错误',
      at: '2026-11-01T00:00:01.000Z',
    })

    expect(await countQuarantine(database)).toBe(2)
    const listed = await listQuarantine(database)
    expect(listed).toHaveLength(2)
    expect(listed[0]).toMatchObject({ kind: 'pull-invalid', serverSeq: 42 })
    expect(listed[1]).toMatchObject({ kind: 'push-invalid', entity: 'habits' })

    // Stored as JSON in syncState, not in an entity table.
    const raw = await getSyncValue(database, QUARANTINE_KEY, '[]')
    expect(typeof raw).toBe('string')
    expect(JSON.parse(raw)).toHaveLength(2)
  })

  it('keeps the newest 500 entries', async () => {
    const { database } = open(newName())

    for (let i = 0; i < 505; i += 1) {
      await appendQuarantine(database, {
        kind: 'pull-invalid',
        entity: 'goals',
        id: `goal-${i}`,
        reason: 'bad',
        at: '2026-11-01T00:00:00.000Z',
      })
    }

    expect(await countQuarantine(database)).toBe(500)
    const listed = await listQuarantine(database)
    // Newest retained: the first five were evicted.
    expect(listed[0].id).toBe('goal-5')
    expect(listed[listed.length - 1].id).toBe('goal-504')
  })
})

// Keep the compiler aware that SYNC_KEYS is imported for the state contract.
void SYNC_KEYS
