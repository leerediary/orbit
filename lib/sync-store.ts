import type { OrbitDB } from '@/lib/local-db'

/**
 * Persistent sync metadata (SYNC-01/SYNC-04) — a tiny key/value side table that
 * stays out of `EXPORT_ENTITIES`, so `orbit-export` v7 is unaffected.
 *
 * Values are restricted to structured-clone-safe primitives. The pull cursor
 * (`serverCursor`) is a number; `lastSyncedAt` is an ISO string; `status` carries
 * engine state such as `needs-full-reconcile` after a whole-store import.
 */
export interface SyncStateRow {
  key: string
  value: string | number | boolean | null
}

export const SYNC_KEYS = {
  cursor: 'serverCursor',
  lastSyncedAt: 'lastSyncedAt',
  lastError: 'lastError',
  status: 'status',
  // Phase 20 first-sync metadata (BOOT-01). These live in the same KV table as
  // the cursor, so they inherit the existing atomic-transaction behaviour.
  bootstrapComplete: 'bootstrapComplete',
  bootstrapAccountId: 'bootstrapAccountId',
  datasetEpoch: 'datasetEpoch',
  syncPaused: 'syncPaused',
} as const

/**
 * Read a sync value, falling back when the key is absent (or explicitly null).
 * `??` is deliberate: a stored `0`, `false`, or `''` is a real value and must
 * never be replaced by the fallback.
 */
export async function getSyncValue<T extends string | number | boolean | null>(
  d: OrbitDB,
  key: string,
  fallback: T,
): Promise<T> {
  const row = await d.syncState.get(key)
  return (row?.value as T | undefined) ?? fallback
}

export async function setSyncValue(
  d: OrbitDB,
  key: string,
  value: string | number | boolean | null,
): Promise<void> {
  await d.syncState.put({ key, value })
}

/** Pull cursor — the last applied `server_seq`. Starts at 0 for a fresh store. */
export async function getSyncCursor(d: OrbitDB): Promise<number> {
  return getSyncValue<number>(d, SYNC_KEYS.cursor, 0)
}

export async function setSyncCursor(d: OrbitDB, cursor: number): Promise<void> {
  await setSyncValue(d, SYNC_KEYS.cursor, cursor)
}

/** ISO timestamp of the last successful sync, or null if never synced. */
export async function getLastSyncedAt(d: OrbitDB): Promise<string | null> {
  return getSyncValue<string | null>(d, SYNC_KEYS.lastSyncedAt, null)
}

export async function setLastSyncedAt(d: OrbitDB, iso: string): Promise<void> {
  await setSyncValue(d, SYNC_KEYS.lastSyncedAt, iso)
}

// --- Phase 20 bootstrap metadata (BOOT-01) ---------------------------------

/** True once this device finished a classified first sync. */
export async function getBootstrapComplete(d: OrbitDB): Promise<boolean> {
  return getSyncValue<boolean>(d, SYNC_KEYS.bootstrapComplete, false)
}

export async function setBootstrapComplete(d: OrbitDB, value: boolean): Promise<void> {
  await setSyncValue(d, SYNC_KEYS.bootstrapComplete, value)
}

/** The JWT `sub` that completed bootstrap, or null before the first sync. */
export async function getBootstrapAccountId(d: OrbitDB): Promise<string | null> {
  return getSyncValue<string | null>(d, SYNC_KEYS.bootstrapAccountId, null)
}

export async function setBootstrapAccountId(
  d: OrbitDB,
  value: string | null,
): Promise<void> {
  await setSyncValue(d, SYNC_KEYS.bootstrapAccountId, value)
}

/** Count of wholesale local baseline replacements (branches B / use-cloud). */
export async function getDatasetEpoch(d: OrbitDB): Promise<number> {
  return getSyncValue<number>(d, SYNC_KEYS.datasetEpoch, 0)
}

export async function setDatasetEpoch(d: OrbitDB, value: number): Promise<void> {
  await setSyncValue(d, SYNC_KEYS.datasetEpoch, value)
}

/** True when the user chose "断开同步" during an import. */
export async function isSyncPaused(d: OrbitDB): Promise<boolean> {
  return getSyncValue<boolean>(d, SYNC_KEYS.syncPaused, false)
}

export async function setSyncPaused(d: OrbitDB, value: boolean): Promise<void> {
  await setSyncValue(d, SYNC_KEYS.syncPaused, value)
}

/**
 * BOOT-01: whether this device must (re-)bootstrap.
 *
 * Re-bootstrap is forced when the device never completed a sync, when no
 * subject can be derived from the current session, or when the signed-in
 * account differs from the account that bootstrapped this device. A same-account
 * logout keeps `bootstrapComplete`/`bootstrapAccountId`, so it does NOT force a
 * re-bootstrap (Phase 17 D-09).
 */
export function needsBootstrap(input: {
  complete: boolean
  accountId: string | null
  currentSub: string | null
}): boolean {
  return (
    input.complete !== true ||
    input.currentSub === null ||
    input.accountId !== input.currentSub
  )
}

// --- Explicit metadata change notifications ---------------------------------

/**
 * Same-document notification seam for bootstrap metadata.
 *
 * Bootstrap writes several keys in one transaction; a Dexie `liveQuery` could
 * pick them up, but components that read the metadata through these accessors
 * need an explicit signal so a multi-key write is observed as ONE change.
 * Browser globals are never touched (callers own any dispatch), so this module
 * stays safe to import during the static-export prerender.
 */
const metadataListeners = new Set<() => void>()

export function subscribeSyncMetadata(listener: () => void): () => void {
  metadataListeners.add(listener)
  return () => {
    metadataListeners.delete(listener)
  }
}

/** Invoke every current listener. Call after a multi-key bootstrap write. */
export function notifySyncMetadata(): void {
  for (const listener of [...metadataListeners]) {
    try {
      listener()
    } catch {
      // One broken subscriber must not stop the rest.
    }
  }
}
