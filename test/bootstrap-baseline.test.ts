import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import { countOutbox, enqueueOutbox, readOutbox } from '@/lib/outbox'
import { SYNC_KEYS, getSyncValue, subscribeSyncMetadata } from '@/lib/sync-store'
import { onLocalWrite } from '@/lib/sync-triggers'
import {
  countLiveRows,
  commitBootstrapComplete,
  downloadCloudBaseline,
  enqueuePurges,
  resetOutboxToLocalState,
  resetSyncMetadataAfterAccountDelete,
  serverOnlyIdsByEntity,
} from '@/lib/bootstrap-local'
import type { PullChange, PullResponse, PushOp } from '@/lib/sync-protocol'
import type { SyncEntity } from '@/lib/sync-entities'
import type { Category, Habit, JournalEntry } from '@/lib/types'

/**
 * Phase 20 / BOOT-01 + BOOT-02 — local bootstrap execution primitives.
 *
 * Every test drives a real LocalRepository against a fresh, uniquely named
 * fake-indexeddb database and inspects the tables directly. The module-level
 * singleton is never imported.
 */

const createdNames: string[] = []
const opened: OrbitDB[] = []

function newName(): string {
  const name = `orbit-bootstrap-baseline-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

const localJournal: JournalEntry = {
  id: 'local-journal',
  day_key: '2026-11-01',
  content: 'local body',
  updated_at: '2026-10-31T00:00:00.000Z',
  deleted_at: null,
}

const cloudJournal: JournalEntry = {
  id: 'cloud-journal',
  day_key: '2026-11-01',
  content: 'cloud body',
  updated_at: '2026-11-01T00:00:00.000Z',
  deleted_at: null,
}

const cloudCategory: Category = {
  id: 'category-cloud',
  name: 'Cloud category',
  created_at: '2026-10-01T00:00:00.000Z',
  sort_order: 1,
  updated_at: '2026-10-02T00:00:00.000Z',
  deleted_at: null,
}

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

function pullChange(over: {
  entity: SyncEntity
  id: string
  data: Record<string, unknown> | null
  op?: PushOp
  server_seq?: number
  updated_at?: string | null
}): PullChange {
  return {
    entity: over.entity,
    id: over.id,
    server_seq: over.server_seq ?? 1,
    op: over.op ?? 'upsert',
    updated_at:
      over.updated_at === undefined ? '2026-11-01T00:00:00.000Z' : over.updated_at,
    deleted_at: null,
    data: over.data,
    device_id: null,
  }
}

function jsonResponse(body: PullResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function seedOutbox(database: OrbitDB): Promise<void> {
  await enqueueOutbox(database, {
    entity: 'journalEntries',
    row_id: localJournal.id,
    op: 'upsert',
    updated_at: localJournal.updated_at,
  })
}

describe('LocalRepository.applyBootstrapBaseline', () => {
  it('clears the store, writes the snapshot, and commits metadata without an echo', async () => {
    const { database, repo } = open(newName())
    await database.journalEntries.bulkPut([localJournal])
    await database.habits.bulkPut([habit()])
    await seedOutbox(database)

    let metadataNotifications = 0
    const removeMetadata = subscribeSyncMetadata(() => {
      metadataNotifications += 1
    })
    let localWrites = 0
    const removeLocal = onLocalWrite(() => {
      localWrites += 1
    })
    try {
      await repo.applyBootstrapBaseline(
        [
          ['journalEntries', [cloudJournal]],
          ['categories', [cloudCategory]],
        ],
        { cursor: 12, accountId: 'acct-1', epoch: 4 },
      )

      // Clear-then-write: rows absent from the snapshot are gone.
      expect((await database.journalEntries.toArray()).map((r) => r.id)).toEqual([
        cloudJournal.id,
      ])
      expect((await database.categories.toArray()).map((r) => r.id)).toEqual([
        cloudCategory.id,
      ])
      expect(await database.habits.count()).toBe(0)

      // No echo: empty outbox, idle status, no local-write signal.
      expect(await countOutbox(database)).toBe(0)
      expect(localWrites).toBe(0)

      expect(await getSyncValue(database, SYNC_KEYS.cursor, null)).toBe(12)
      expect(await getSyncValue(database, SYNC_KEYS.status, null)).toBe('idle')
      expect(await getSyncValue(database, SYNC_KEYS.bootstrapComplete, false)).toBe(true)
      expect(await getSyncValue(database, SYNC_KEYS.bootstrapAccountId, null)).toBe('acct-1')
      expect(await getSyncValue(database, SYNC_KEYS.datasetEpoch, null)).toBe(4)
      expect(metadataNotifications).toBe(1)

      const state = await database.syncState.toArray()
      expect(state.some((row) => row.value === 'needs-full-reconcile')).toBe(false)
    } finally {
      removeMetadata()
      removeLocal()
    }
  })

  it('replaces a conflicting local journal day without a ConstraintError', async () => {
    const { database, repo } = open(newName())
    await database.journalEntries.bulkPut([localJournal])

    await repo.applyBootstrapBaseline([['journalEntries', [cloudJournal]]], {
      cursor: 3,
      accountId: 'acct-1',
      epoch: 1,
    })

    const rows = await database.journalEntries.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(cloudJournal.id)
    expect(rows[0].content).toBe(cloudJournal.content)
  })

  it('rejects an invalid row before writing anything', async () => {
    const { database, repo } = open(newName())
    await database.journalEntries.bulkPut([localJournal])
    await seedOutbox(database)

    await expect(
      repo.applyBootstrapBaseline(
        [['categories', [{ id: 'broken' }]]],
        { cursor: 1, accountId: 'acct-1', epoch: 1 },
      ),
    ).rejects.toThrow()

    expect((await database.journalEntries.toArray()).map((r) => r.id)).toEqual([
      localJournal.id,
    ])
    expect(await database.categories.count()).toBe(0)
    expect(await countOutbox(database)).toBe(1)
    expect(await getSyncValue(database, SYNC_KEYS.cursor, null)).toBe(null)
  })
})

describe('bootstrap-local helpers', () => {
  it('resetOutboxToLocalState enqueues one upsert per live row and one delete per tombstone', async () => {
    const { database } = open(newName())
    await database.habits.bulkPut([
      habit({ id: 'habit-live-a' }),
      habit({ id: 'habit-live-b' }),
      habit({ id: 'habit-tombstoned', deleted_at: '2026-10-29T00:00:00.000Z' }),
    ])
    // A stale pre-existing intent must be cleared, not duplicated.
    await seedOutbox(database)

    await resetOutboxToLocalState(database)

    const entries = await readOutbox(database)
    expect(entries).toHaveLength(3)
    expect(
      entries.map((entry) => `${entry.row_id}:${entry.op}`).sort(),
    ).toEqual(['habit-live-a:upsert', 'habit-live-b:upsert', 'habit-tombstoned:delete'])
  })

  it('enqueuePurges enqueues one purge intent per server-only id and returns the count', async () => {
    const { database } = open(newName())

    const total = await enqueuePurges(database, {
      habits: ['h1', 'h2'],
      categories: ['c1'],
    })

    expect(total).toBe(3)
    const entries = await readOutbox(database)
    expect(entries).toHaveLength(3)
    expect(entries.every((entry) => entry.op === 'purge')).toBe(true)
    expect(
      entries.map((entry) => `${entry.entity}:${entry.row_id}`).sort(),
    ).toEqual(['categories:c1', 'habits:h1', 'habits:h2'])
  })

  it('serverOnlyIdsByEntity returns server-not-local ids and omits empty entities', () => {
    expect(
      serverOnlyIdsByEntity(
        { habits: ['a', 'b', 'c'], categories: ['x'] },
        { habits: ['b', 'd'], categories: ['x'] },
      ),
    ).toEqual({ habits: ['a', 'c'] })
  })

  it('countLiveRows counts only live rows across the nine tables', async () => {
    const { database } = open(newName())
    await database.habits.bulkPut([
      habit({ id: 'h-live' }),
      habit({ id: 'h-dead', deleted_at: '2026-10-29T00:00:00.000Z' }),
    ])
    await database.categories.bulkPut([cloudCategory])

    expect(await countLiveRows(database)).toBe(2)
  })

  it('downloadCloudBaseline pages through pull and applies the snapshot once with the final cursor', async () => {
    const { database, repo } = open(newName())
    const paths: string[] = []
    const fetchFn = async (path: string): Promise<Response> => {
      paths.push(path)
      if (paths.length === 1) {
        return jsonResponse({
          version: 1,
          changes: [
            pullChange({
              entity: 'categories',
              id: cloudCategory.id,
              data: cloudCategory as unknown as Record<string, unknown>,
              server_seq: 1,
            }),
          ],
          next_cursor: 5,
          has_more: true,
        })
      }
      return jsonResponse({
        version: 1,
        changes: [
          pullChange({
            entity: 'journalEntries',
            id: cloudJournal.id,
            data: cloudJournal as unknown as Record<string, unknown>,
            server_seq: 5,
            updated_at: cloudJournal.updated_at,
          }),
          pullChange({
            entity: 'habits',
            id: 'gone-habit',
            data: null,
            op: 'purge',
            server_seq: 6,
            updated_at: null,
          }),
        ],
        next_cursor: 9,
        has_more: false,
      })
    }

    const result = await downloadCloudBaseline({
      repo,
      fetchFn,
      accountId: 'acct-1',
      epoch: 2,
    })

    expect(paths).toEqual([
      '/v1/sync/pull?since=0&limit=500',
      '/v1/sync/pull?since=5&limit=500',
    ])
    expect(result).toEqual({ cursor: 9, rows: 2 })
    expect((await database.categories.toArray()).map((r) => r.id)).toEqual([
      cloudCategory.id,
    ])
    expect((await database.journalEntries.toArray()).map((r) => r.id)).toEqual([
      cloudJournal.id,
    ])
    expect(await database.habits.count()).toBe(0)
    expect(await countOutbox(database)).toBe(0)
    expect(await getSyncValue(database, SYNC_KEYS.cursor, null)).toBe(9)
    expect(await getSyncValue(database, SYNC_KEYS.bootstrapComplete, false)).toBe(true)
  })

  it('downloadCloudBaseline throws on a malformed row on a later page and leaves local data untouched', async () => {
    const { database, repo } = open(newName())
    await database.categories.bulkPut([cloudCategory])
    await seedOutbox(database)

    const fetchFn = async (path: string): Promise<Response> => {
      if (path.includes('since=0')) {
        return jsonResponse({
          version: 1,
          changes: [],
          next_cursor: 5,
          has_more: true,
        })
      }
      return jsonResponse({
        version: 1,
        changes: [
          pullChange({
            entity: 'categories',
            id: 'broken',
            data: { id: 'broken' },
            server_seq: 6,
          }),
        ],
        next_cursor: 9,
        has_more: false,
      })
    }

    await expect(
      downloadCloudBaseline({ repo, fetchFn, accountId: 'acct-1', epoch: 2 }),
    ).rejects.toThrow()

    expect((await database.categories.toArray()).map((r) => r.id)).toEqual([
      cloudCategory.id,
    ])
    expect(await countOutbox(database)).toBe(1)
    expect(await getSyncValue(database, SYNC_KEYS.cursor, null)).toBe(null)
    expect(await getSyncValue(database, SYNC_KEYS.bootstrapComplete, false)).toBe(false)
  })

  it('commitBootstrapComplete writes completion metadata without touching cursor, epoch, or rows', async () => {
    const { database } = open(newName())
    await database.syncState.bulkPut([
      { key: SYNC_KEYS.cursor, value: 42 },
      { key: SYNC_KEYS.datasetEpoch, value: 3 },
      { key: SYNC_KEYS.status, value: 'error' },
    ])
    await database.habits.bulkPut([habit()])
    await seedOutbox(database)

    await commitBootstrapComplete(database, 'acct-1')

    expect(await getSyncValue(database, SYNC_KEYS.bootstrapComplete, false)).toBe(true)
    expect(await getSyncValue(database, SYNC_KEYS.bootstrapAccountId, null)).toBe('acct-1')
    expect(await getSyncValue(database, SYNC_KEYS.status, null)).toBe('idle')
    expect(await getSyncValue(database, SYNC_KEYS.syncPaused, true)).toBe(false)
    expect(await getSyncValue(database, SYNC_KEYS.cursor, null)).toBe(42)
    expect(await getSyncValue(database, SYNC_KEYS.datasetEpoch, null)).toBe(3)
    expect(await database.habits.count()).toBe(1)
    expect(await countOutbox(database)).toBe(1)
  })

  it('resetSyncMetadataAfterAccountDelete increments the epoch, clears the outbox, and keeps entity rows', async () => {
    const { database } = open(newName())
    await database.syncState.bulkPut([
      { key: SYNC_KEYS.cursor, value: 42 },
      { key: SYNC_KEYS.lastSyncedAt, value: '2026-11-01T00:00:00.000Z' },
      { key: SYNC_KEYS.lastError, value: 'boom' },
      { key: SYNC_KEYS.bootstrapComplete, value: true },
      { key: SYNC_KEYS.bootstrapAccountId, value: 'old-account' },
      { key: SYNC_KEYS.datasetEpoch, value: 2 },
      { key: SYNC_KEYS.syncPaused, value: true },
      { key: SYNC_KEYS.status, value: 'error' },
    ])
    await database.habits.bulkPut([habit()])
    await seedOutbox(database)

    await resetSyncMetadataAfterAccountDelete(database)

    expect(await getSyncValue(database, SYNC_KEYS.cursor, null)).toBe(0)
    expect(await getSyncValue(database, SYNC_KEYS.status, null)).toBe('idle')
    expect(await getSyncValue(database, SYNC_KEYS.lastSyncedAt, null)).toBe(null)
    expect(await getSyncValue(database, SYNC_KEYS.lastError, null)).toBe(null)
    expect(await getSyncValue(database, SYNC_KEYS.bootstrapComplete, true)).toBe(false)
    expect(await getSyncValue(database, SYNC_KEYS.bootstrapAccountId, null)).toBe(null)
    expect(await getSyncValue(database, SYNC_KEYS.datasetEpoch, null)).toBe(3)
    expect(await getSyncValue(database, SYNC_KEYS.syncPaused, true)).toBe(false)
    expect(await countOutbox(database)).toBe(0)
    expect(await database.habits.count()).toBe(1)
  })
})
