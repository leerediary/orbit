/**
 * UI-facing sync state layer (plan 18-04 / SYNC-03 + D-05).
 *
 * The badge and the data views must never query entity tables or recompute sync
 * business logic. This module is the ONE subscription source:
 *
 *  - a Dexie `liveQuery` over `syncOutbox.count()` + `syncState` keeps the
 *    snapshot live on this tab;
 *  - one `BroadcastChannel('orbit-sync')` (the same channel the engine owns)
 *    carries sync-start / sync-applied / sync-complete / sync-error from the
 *    leader tab;
 *  - `useSyncRefresh` bridges the framework-free `sync-applied` sequence into a
 *    thin "reload your own data" trigger for mounted views (B2 — a view-reload
 *    signal, not a liveQuery rewrite).
 *
 * Every browser global is touched inside a function only, and the store starts
 * lazily on the first `subscribe`/`refresh`, so importing this module during the
 * static-export prerender is safe.
 */

import { liveQuery } from 'dexie'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { db as defaultDb, type OrbitDB } from '@/lib/local-db'
import { countOutbox } from '@/lib/outbox'
import { SYNC_KEYS, type SyncStateRow } from '@/lib/sync-store'
import { emitSyncApplied, getSyncAppliedSeq, subscribeSyncApplied } from '@/lib/sync-applied'
import { deriveSyncStatus, type SyncStatus } from '@/lib/sync-time'

export interface SyncUiState {
  online: boolean
  outboxCount: number
  lastSyncedAt: number | null
  syncing: boolean
  lastError: string | null
}

export interface SyncStateStore {
  getSnapshot(): SyncUiState
  subscribe(fn: () => void): () => void
  refresh(): Promise<void>
  dispose(): void
}

/**
 * The minimal BroadcastChannel surface this module needs. Native
 * `BroadcastChannel` satisfies it structurally; tests inject a fake.
 */
export interface MinimalChannel {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(message: unknown): void
  close?(): void
}

export interface SyncStateDeps {
  db?: OrbitDB
  online?: () => boolean
  channelFactory?: () => MinimalChannel | null
}

/** Frozen first-render snapshot — a stable reference for `useSyncExternalStore`. */
const DEFAULT_STATE: SyncUiState = {
  online: true,
  outboxCount: 0,
  lastSyncedAt: null,
  syncing: false,
  lastError: null,
}

function readOnline(online: () => boolean): boolean {
  try {
    return online()
  } catch {
    return true
  }
}

function defaultChannelFactory(): MinimalChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  // The native `onmessage` signature is narrower than MinimalChannel's, so cast
  // through `unknown`; the runtime shape (`onmessage`/`postMessage`/`close`) is
  // exactly what this module uses.
  return new BroadcastChannel('orbit-sync') as unknown as MinimalChannel
}

export function createSyncStateStore(deps: SyncStateDeps = {}): SyncStateStore {
  const database = deps.db ?? defaultDb
  const online = deps.online ?? (() => true)

  let snapshot: SyncUiState = { ...DEFAULT_STATE }
  const listeners = new Set<() => void>()

  let started = false
  let liveSubscription: { unsubscribe(): void } | null = null
  let channel: MinimalChannel | null = null
  let onlineListener: (() => void) | null = null

  function notify(): void {
    for (const fn of [...listeners]) {
      try {
        fn()
      } catch {
        // One broken view must not stop the rest.
      }
    }
  }

  function setSnapshot(next: SyncUiState): void {
    if (
      snapshot.online === next.online &&
      snapshot.outboxCount === next.outboxCount &&
      snapshot.lastSyncedAt === next.lastSyncedAt &&
      snapshot.syncing === next.syncing &&
      snapshot.lastError === next.lastError
    ) {
      return
    }
    snapshot = next
    notify()
  }

  function applyRows(result: { count: number; rows: SyncStateRow[] }): void {
    let lastSyncedAt: number | null = null
    let lastError: string | null = null
    for (const row of result.rows) {
      if (row.key === SYNC_KEYS.lastSyncedAt && typeof row.value === 'string') {
        const parsed = Date.parse(row.value)
        lastSyncedAt = Number.isNaN(parsed) ? null : parsed
      } else if (row.key === SYNC_KEYS.lastError) {
        lastError =
          typeof row.value === 'string' && row.value.length > 0 ? row.value : null
      }
    }
    setSnapshot({ ...snapshot, outboxCount: result.count, lastSyncedAt, lastError })
  }

  function handleMessage(data: unknown): void {
    if (data === null || typeof data !== 'object') return
    const message = data as { type?: unknown; error?: unknown }

    switch (message.type) {
      case 'sync-start':
        setSnapshot({ ...snapshot, syncing: true })
        break
      case 'sync-complete':
        // Re-read Dexie instead of trusting the message payload (T-18-24).
        setSnapshot({ ...snapshot, syncing: false })
        void refresh().catch(() => {})
        break
      case 'sync-error':
        setSnapshot({
          ...snapshot,
          syncing: false,
          lastError: typeof message.error === 'string' ? message.error : 'unknown',
        })
        break
      case 'sync-applied':
        // W5: increment locally; never adopt the leader's `seq`. A leader reload
        // resets its own counter, so adopting it could silence this tab.
        emitSyncApplied()
        break
      default:
        break
    }
  }

  function ensureStarted(): void {
    if (started) return
    started = true

    const isOnline = readOnline(online)
    if (isOnline !== snapshot.online) setSnapshot({ ...snapshot, online: isOnline })

    // Live outbox-count + sync metadata. Started lazily, never at module scope.
    liveSubscription = liveQuery(async () => ({
      count: await countOutbox(database),
      rows: await database.syncState.toArray(),
    })).subscribe({
      next: (result) => applyRows(result),
      error: () => {},
    })

    if (typeof window !== 'undefined') {
      onlineListener = () => {
        const next = readOnline(online)
        if (next !== snapshot.online) setSnapshot({ ...snapshot, online: next })
      }
      window.addEventListener('online', onlineListener)
      window.addEventListener('offline', onlineListener)
    }

    channel = (deps.channelFactory ?? defaultChannelFactory)()
    if (channel) {
      channel.onmessage = (event) => handleMessage(event.data)
    }
  }

  async function refresh(): Promise<void> {
    ensureStarted()
    const [count, rows] = await Promise.all([
      countOutbox(database),
      database.syncState.toArray(),
    ])
    applyRows({ count, rows })
  }

  function subscribe(fn: () => void): () => void {
    ensureStarted()
    listeners.add(fn)
    // Emit the current snapshot immediately (React's external store contract).
    fn()
    return () => {
      listeners.delete(fn)
    }
  }

  function dispose(): void {
    liveSubscription?.unsubscribe()
    liveSubscription = null

    if (onlineListener && typeof window !== 'undefined') {
      window.removeEventListener('online', onlineListener)
      window.removeEventListener('offline', onlineListener)
    }
    onlineListener = null

    if (channel) {
      channel.onmessage = null
      try {
        channel.close?.()
      } catch {
        // Closing a fake/closed channel is harmless.
      }
    }
    channel = null

    listeners.clear()
    started = false
  }

  return {
    getSnapshot: () => snapshot,
    subscribe,
    refresh,
    dispose,
  }
}

// --- Lazy production singleton ---------------------------------------------

let singleton: SyncStateStore | null = null

/**
 * One store for the whole tab. Construction is cheap and touches no browser
 * global; the liveQuery and channel only start on the first subscribe/refresh.
 */
export function getSyncStateStore(): SyncStateStore {
  if (!singleton) {
    singleton = createSyncStateStore({
      db: defaultDb,
      online: () =>
        typeof navigator === 'undefined' ? true : navigator.onLine !== false,
    })
  }
  return singleton
}

/** Badge subscription source (18-05). Prerenders against the frozen default. */
export function useSyncState(): SyncUiState {
  const store = getSyncStateStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => DEFAULT_STATE)
}

/** Derive the locked four-state status from a snapshot. */
export function getSyncStatus(state: SyncUiState): SyncStatus {
  return deriveSyncStatus({
    online: state.online,
    outboxCount: state.outboxCount,
    lastSyncedAt: state.lastSyncedAt,
  })
}

/**
 * Reload a mounted data view when remote rows land (D-05 / B2).
 *
 * The first render — including a remount whose applied sequence is already
 * non-zero — NEVER triggers an extra reload: each view already runs `load()` on
 * mount. Only an actual advance of the applied sequence calls `onApplied`.
 */
export function useSyncRefresh(onApplied: () => void): void {
  const seq = useSyncExternalStore(subscribeSyncApplied, getSyncAppliedSeq, () => 0)

  const callbackRef = useRef(onApplied)
  callbackRef.current = onApplied

  const lastSeqRef = useRef(seq)
  useEffect(() => {
    if (seq === lastSeqRef.current) return
    lastSeqRef.current = seq
    callbackRef.current()
  }, [seq])
}

/**
 * W2 draft guard for JournalView: a remote reload would clobber an unsaved
 * draft. Defer while an edit is pending, a save failed, or a save is in flight.
 */
export function shouldDeferSyncReload(input: {
  pending: boolean
  failed: boolean
  status: 'idle' | 'saving' | 'saved' | 'error'
}): boolean {
  return input.pending || input.failed || input.status === 'saving'
}
