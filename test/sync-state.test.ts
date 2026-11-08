import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrbitDB } from '@/lib/local-db'
import { enqueueOutbox } from '@/lib/outbox'
import { SYNC_KEYS, setSyncValue } from '@/lib/sync-store'
import {
  applyRemoteSyncApplied,
  emitSyncApplied,
  getSyncAppliedSeq,
  subscribeSyncApplied,
} from '@/lib/sync-applied'
import {
  createSyncStateStore,
  getSyncStatus,
  shouldDeferSyncReload,
  type SyncStateStore,
} from '@/lib/sync-state'

/**
 * Phase 18 / plan 18-04 — the UI-facing sync state store.
 *
 * Every test opens a fresh fake-indexeddb database and injects an online
 * provider + a fake BroadcastChannel, so no real global or the singleton `db`
 * is touched. Timers/liveQuery are real; `vi.waitFor` absorbs the asynchronous
 * liveQuery emission.
 */

const createdNames: string[] = []
const opened: OrbitDB[] = []
const stores: SyncStateStore[] = []

function newName(): string {
  const name = `orbit-sync-state-${Date.now()}-${Math.random().toString(36).slice(2)}`
  createdNames.push(name)
  return name
}

function freshDb(): OrbitDB {
  const database = new OrbitDB(newName())
  opened.push(database)
  return database
}

interface FakeChannel {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(message: unknown): void
  close(): void
  emit(data: unknown): void
  closed: boolean
}

function fakeChannel(): FakeChannel {
  const channel: FakeChannel = {
    onmessage: null,
    closed: false,
    postMessage() {},
    close() {
      channel.closed = true
    },
    emit(data) {
      channel.onmessage?.({ data })
    },
  }
  return channel
}

function makeStore(
  db: OrbitDB,
  opts: { online?: () => boolean; channelFactory?: () => FakeChannel | null } = {},
): SyncStateStore {
  const store = createSyncStateStore({
    db,
    online: opts.online ?? (() => true),
    channelFactory: opts.channelFactory ?? (() => null),
  })
  stores.push(store)
  return store
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.dispose()
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
})

describe('createSyncStateStore snapshot', () => {
  it('returns the stable default snapshot before any refresh', () => {
    const store = makeStore(freshDb())
    expect(store.getSnapshot()).toEqual({
      online: true,
      outboxCount: 0,
      lastSyncedAt: null,
      syncing: false,
      lastError: null,
    })
  })

  it('reports pending after an enqueue + refresh', async () => {
    const db = freshDb()
    const store = makeStore(db)
    await enqueueOutbox(db, {
      entity: 'habits',
      row_id: 'row-1',
      op: 'upsert',
      updated_at: '2026-11-01T00:00:00.000Z',
    })
    await store.refresh()

    const snap = store.getSnapshot()
    expect(snap.outboxCount).toBe(1)
    expect(getSyncStatus(snap)).toBe('pending')
  })

  it('reports synced once lastSyncedAt is stored and the outbox is empty', async () => {
    const db = freshDb()
    const store = makeStore(db)
    const iso = '2026-11-01T12:00:00.000Z'
    await setSyncValue(db, SYNC_KEYS.lastSyncedAt, iso)
    await store.refresh()

    const snap = store.getSnapshot()
    expect(snap.outboxCount).toBe(0)
    expect(snap.lastSyncedAt).toBe(Date.parse(iso))
    expect(typeof snap.lastSyncedAt).toBe('number')
    expect(getSyncStatus(snap)).toBe('synced')
  })

  it('honours an injected online provider returning false → offline', async () => {
    const db = freshDb()
    const store = makeStore(db, { online: () => false })
    await store.refresh()

    const snap = store.getSnapshot()
    expect(snap.online).toBe(false)
    expect(getSyncStatus(snap)).toBe('offline')
  })
})

describe('createSyncStateStore channel + subscribe', () => {
  it('reacts to sync-start / sync-complete / sync-error messages', async () => {
    const db = freshDb()
    const channel = fakeChannel()
    const store = makeStore(db, { channelFactory: () => channel })
    store.subscribe(() => {})

    channel.emit({ type: 'sync-start', reason: 'auto' })
    expect(store.getSnapshot().syncing).toBe(true)

    const iso = '2026-11-01T13:45:00.000Z'
    await setSyncValue(db, SYNC_KEYS.lastSyncedAt, iso)
    channel.emit({ type: 'sync-complete', lastSyncedAt: iso })
    expect(store.getSnapshot().syncing).toBe(false)
    await vi.waitFor(() => {
      expect(store.getSnapshot().lastSyncedAt).toBe(Date.parse(iso))
    })

    channel.emit({ type: 'sync-error', error: 'server' })
    const snap = store.getSnapshot()
    expect(snap.syncing).toBe(false)
    expect(snap.lastError).toBe('server')
  })

  it('emits immediately on subscribe and stops after unsubscribe', async () => {
    const db = freshDb()
    const store = makeStore(db)
    let calls = 0
    const unsubscribe = store.subscribe(() => {
      calls += 1
    })

    expect(calls).toBe(1) // immediate current-snapshot emit

    await enqueueOutbox(db, {
      entity: 'habits',
      row_id: 'row-1',
      op: 'upsert',
      updated_at: '2026-11-01T00:00:00.000Z',
    })
    await store.refresh()
    expect(calls).toBeGreaterThan(1)

    const afterUnsub = calls
    unsubscribe()
    await setSyncValue(db, SYNC_KEYS.lastError, 'server')
    await store.refresh()
    expect(calls).toBe(afterUnsub)
  })

  it('W5: a lower cross-tab sync-applied seq still advances the local sequence', () => {
    const db = freshDb()
    const channel = fakeChannel()
    const store = makeStore(db, { channelFactory: () => channel })
    store.subscribe(() => {})

    const base = getSyncAppliedSeq()
    applyRemoteSyncApplied(base + 50)
    expect(getSyncAppliedSeq()).toBe(base + 50)

    let observed = 0
    const unsubscribe = subscribeSyncApplied(() => {
      observed += 1
    })

    // The leader reloaded and reset its own counter to 1 — we must NOT adopt
    // that seq; we increment locally instead.
    channel.emit({ type: 'sync-applied', seq: 1 })
    expect(getSyncAppliedSeq()).toBe(base + 51)
    expect(observed).toBe(1)

    expect(emitSyncApplied()).toBe(base + 52)
    unsubscribe()
  })
})

describe('shouldDeferSyncReload (W2 draft guard)', () => {
  it('defers when a draft is pending, failed, or saving', () => {
    expect(shouldDeferSyncReload({ pending: true, failed: false, status: 'saved' })).toBe(true)
    expect(shouldDeferSyncReload({ pending: false, failed: true, status: 'idle' })).toBe(true)
    expect(shouldDeferSyncReload({ pending: false, failed: false, status: 'saving' })).toBe(true)
  })

  it('allows the reload only for a clean idle/saved/error view', () => {
    expect(shouldDeferSyncReload({ pending: false, failed: false, status: 'idle' })).toBe(false)
    expect(shouldDeferSyncReload({ pending: false, failed: false, status: 'saved' })).toBe(false)
    expect(shouldDeferSyncReload({ pending: false, failed: false, status: 'error' })).toBe(false)
  })
})
