import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Dexie from 'dexie'
import { OrbitDB, db } from '@/lib/local-db'
import { LocalRepository } from '@/lib/local-repository'
import { importData, prepareImport } from '@/lib/data-import'
import { EXPORT_ENTITIES, EXPORT_FORMAT, EXPORT_VERSION } from '@/lib/data-export'
import { readOutbox } from '@/lib/outbox'
import { SYNC_KEYS, getSyncValue } from '@/lib/sync-store'
import {
  cloudOnlyIds,
  executeImportDisconnect,
  executeImportOverride,
} from '@/lib/import-sync'
import type { Category, Habit, JournalEntry } from '@/lib/types'

/**
 * Phase 20 / BOOT-03 — validated, non-writing import preview.
 *
 * `prepareImport` must run every existing validation pass and return the exact
 * entries `importData` would apply, plus the backup's id set (live and
 * tombstoned), without touching the store. `importData` remains exactly one
 * atomic `replaceAll`.
 */

const liveCategory: Category = {
  id: 'cat-live',
  name: '本机分类',
  created_at: '2026-01-01T00:00:00.000Z',
  sort_order: 1,
  updated_at: '2026-02-01T00:00:00.000Z',
  deleted_at: null,
}

const tombstonedHabit: Habit = {
  id: 'habit-dead',
  name: '已删除习惯',
  short_name: '删除',
  sort_order: 1,
  updated_at: '2026-03-01T00:00:00.000Z',
  deleted_at: '2026-03-02T00:00:00.000Z',
}

const liveJournal: JournalEntry = {
  id: 'journal-live',
  day_key: '2026-06-01',
  content: '备份里的日记',
  updated_at: '2026-06-01T10:00:00.000Z',
  deleted_at: null,
}

function contract(
  data: Partial<Record<(typeof EXPORT_ENTITIES)[number], unknown[]>> = {},
) {
  const full: Record<string, unknown[]> = {}
  for (const entity of EXPORT_ENTITIES) full[entity] = []
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: '2026-11-02T00:00:00.000Z',
    data: { ...full, ...data },
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

const zeroCounts = {
  categories: 0,
  goals: 0,
  milestones: 0,
  tasks: 0,
  dailyTodos: 0,
  journalEntries: 0,
  habits: 0,
  habitCompletions: 0,
  pomodoroSessions: 0,
}

beforeEach(async () => {
  await reset()
})

describe('prepareImport', () => {
  it('returns the nine ordered entries and ids without changing entity or outbox counts', async () => {
    const json = contract({
      categories: [liveCategory],
      habits: [tombstonedHabit],
      journalEntries: [liveJournal],
    })

    // A pre-existing queue must be untouched by a preview.
    await db.syncOutbox.put({
      entity: 'habits',
      row_id: 'queued-habit',
      op: 'upsert',
      updated_at: '2026-01-01T00:00:00.000Z',
    })

    const plan = await prepareImport(json)

    expect(plan.entries.map(([entity]) => entity)).toEqual([...EXPORT_ENTITIES])
    expect(plan.entries).toHaveLength(9)
    expect(plan.ids).toEqual({
      categories: [liveCategory.id],
      habits: [tombstonedHabit.id],
      journalEntries: [liveJournal.id],
    })

    // Validation ran; nothing was written.
    expect(await counts()).toEqual(zeroCounts)
    expect(await db.syncOutbox.count()).toBe(1)
  })

  it('derives ids only from validated rows and keeps the branch order for a frozen v6 backup', async () => {
    const v6 = JSON.stringify({
      format: EXPORT_FORMAT,
      version: 6,
      exportedAt: '2026-11-02T00:00:00.000Z',
      data: {
        categories: [liveCategory],
        goals: [],
        milestones: [],
        tasks: [],
        dailyTodos: [],
        journalEntries: [liveJournal],
        habits: [tombstonedHabit],
        habitCompletions: [],
      },
    })

    const plan = await prepareImport(v6)

    // v6 appends the (empty) pomodoro table, so the plan still has nine entries.
    expect(plan.entries.map(([entity]) => entity)).toEqual([...EXPORT_ENTITIES])
    expect(plan.ids).toEqual({
      categories: [liveCategory.id],
      journalEntries: [liveJournal.id],
      habits: [tombstonedHabit.id],
    })
    expect(await counts()).toEqual(zeroCounts)
  })

  it('throws the same validation message as before and writes nothing', async () => {
    const malformed = JSON.stringify({
      format: EXPORT_FORMAT,
      version: 7,
      exportedAt: '2026-11-02T00:00:00.000Z',
      data: { categories: [{ id: 'broken' }] },
    })

    await expect(prepareImport(malformed)).rejects.toThrow(/缺少字段/)
    expect(await counts()).toEqual(zeroCounts)
  })
})

describe('importData applies a prepared plan', () => {
  it('calls replaceAll exactly once and clears the outbox', async () => {
    await db.syncOutbox.put({
      entity: 'categories',
      row_id: 'queued-category',
      op: 'upsert',
      updated_at: '2026-01-01T00:00:00.000Z',
    })

    const spy = vi.spyOn(LocalRepository.prototype, 'replaceAll')
    try {
      await importData(contract({ categories: [liveCategory] }))
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }

    expect(await db.categories.toArray()).toEqual([liveCategory])
    expect(await db.syncOutbox.count()).toBe(0)
  })
})

// ── Task 3: sync-aware import orchestration ──────────────────────────────

const createdNames: string[] = []
const opened: OrbitDB[] = []

function newName(): string {
  const name = `orbit-import-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
      // Already closed.
    }
  }
  for (const name of createdNames.splice(0)) {
    await Dexie.delete(name).catch(() => {})
  }
  vi.unstubAllGlobals()
})

const liveHabit: Habit = {
  id: 'habit-sync-live',
  name: '每天阅读',
  short_name: '阅读',
  sort_order: 0,
  updated_at: '2026-10-30T00:00:00.000Z',
  deleted_at: null,
}

const deadHabit: Habit = {
  id: 'habit-sync-dead',
  name: '已删除习惯',
  short_name: '删除',
  sort_order: 1,
  updated_at: '2026-10-30T00:00:00.000Z',
  deleted_at: '2026-10-31T00:00:00.000Z',
}

describe('cloudOnlyIds', () => {
  it('returns server ids absent from the backup and omits empty entities', () => {
    expect(
      cloudOnlyIds(
        { goals: ['a', 'b'], habits: ['h1'], categories: ['c1'] },
        { goals: ['b'], habits: ['h1'], categories: ['c1'] },
      ),
    ).toEqual({ goals: ['a'] })

    expect(cloudOnlyIds({ goals: ['a'] }, { goals: ['a'] })).toEqual({})
  })
})

describe('executeImportDisconnect', () => {
  it('pauses sync and clears completion before a network-free local replace', async () => {
    const database = open(newName())
    await database.syncState.bulkPut([
      { key: SYNC_KEYS.syncPaused, value: false },
      { key: SYNC_KEYS.bootstrapComplete, value: true },
      { key: SYNC_KEYS.bootstrapAccountId, value: 'acct-old' },
    ])

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    let observed: { paused: unknown; complete: unknown; account: unknown } | null = null
    let importCalls = 0
    const importFn = async (): Promise<void> => {
      importCalls += 1
      observed = {
        paused: await getSyncValue(database, SYNC_KEYS.syncPaused, false),
        complete: await getSyncValue(database, SYNC_KEYS.bootstrapComplete, true),
        account: await getSyncValue(database, SYNC_KEYS.bootstrapAccountId, null),
      }
    }

    const result = await executeImportDisconnect({
      db: database,
      json: '{}',
      importFn,
    })

    expect(result).toEqual({ ok: true })
    expect(importCalls).toBe(1)
    // The metadata was cleared BEFORE the local replace ran.
    expect(observed).toEqual({ paused: true, complete: false, account: null })
    expect(await getSyncValue(database, SYNC_KEYS.syncPaused, false)).toBe(true)
    expect(await getSyncValue(database, SYNC_KEYS.bootstrapComplete, true)).toBe(false)
    expect(await getSyncValue(database, SYNC_KEYS.bootstrapAccountId, null)).toBe(null)
    // The disconnect path never touches the network.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('propagates an import failure while leaving sync off', async () => {
    const database = open(newName())
    await database.syncState.put({ key: SYNC_KEYS.bootstrapComplete, value: true })

    await expect(
      executeImportDisconnect({
        db: database,
        json: '{}',
        importFn: async () => {
          throw new Error('坏备份')
        },
      }),
    ).rejects.toThrow('坏备份')

    expect(await getSyncValue(database, SYNC_KEYS.syncPaused, false)).toBe(true)
    expect(await getSyncValue(database, SYNC_KEYS.bootstrapComplete, true)).toBe(false)
  })
})

describe('executeImportOverride', () => {
  it('enqueues one purge per cloud-only id, idles status, and awaits one guarded push', async () => {
    const database = open(newName())
    await database.syncState.put({ key: SYNC_KEYS.status, value: 'needs-full-reconcile' })

    const importFn = async (): Promise<void> => {
      await database.habits.bulkPut([liveHabit, deadHabit])
    }
    const syncFn = vi.fn(async () => ({ ok: true }))

    const result = await executeImportOverride({
      db: database,
      json: '{}',
      cloudOnly: { goals: ['cloud-only-goal'] },
      importFn,
      syncFn,
    })

    expect(result).toEqual({ ok: true, imported: true })
    expect(await getSyncValue(database, SYNC_KEYS.status, null)).toBe('idle')

    const outbox = await readOutbox(database)
    expect(
      outbox.map((entry) => `${entry.entity}:${entry.row_id}:${entry.op}`).sort(),
    ).toEqual([
      'goals:cloud-only-goal:purge',
      'habits:habit-sync-dead:delete',
      'habits:habit-sync-live:upsert',
    ])

    expect(syncFn).toHaveBeenCalledTimes(1)
    // One delete (tombstone) + one purge (cloud-only) = the declared total.
    expect(syncFn).toHaveBeenCalledWith({ allowBulkDelete: true, declaredDeleteTotal: 2 })
  })

  it('stays pending until the guarded push resolves, then reports a partial failure', async () => {
    const database = open(newName())

    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    let settle!: (value: { ok: boolean; error?: string }) => void
    const syncFn = vi.fn(
      () =>
        new Promise<{ ok: boolean; error?: string }>((resolve) => {
          settle = resolve
          enter()
        }),
    )

    const promise = executeImportOverride({
      db: database,
      json: '{}',
      cloudOnly: {},
      importFn: async () => {},
      syncFn,
    })

    // The guarded push has been invoked but has not returned.
    await entered
    let settled = false
    void promise.then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    settle({ ok: false, error: 'offline' })
    await expect(promise).resolves.toEqual({
      ok: false,
      imported: true,
      error: 'offline',
    })
  })

  it('leaves the store untouched and never pushes when the import fails', async () => {
    const database = open(newName())
    await database.habits.bulkPut([liveHabit])
    const before = await database.habits.toArray()
    const syncFn = vi.fn(async () => ({ ok: true }))

    await expect(
      executeImportOverride({
        db: database,
        json: '{}',
        cloudOnly: { goals: ['cloud-only-goal'] },
        importFn: async () => {
          throw new Error('坏备份')
        },
        syncFn,
      }),
    ).rejects.toThrow('坏备份')

    expect(await database.habits.toArray()).toEqual(before)
    expect(await readOutbox(database)).toEqual([])
    expect(syncFn).not.toHaveBeenCalled()
  })
})
