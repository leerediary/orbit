/**
 * Framework-free "remote data landed" signal (D-05 / plan 18-04).
 *
 * The sync engine bumps a monotonically increasing sequence after every applied
 * pull page and publishes it on the `orbit-sync` BroadcastChannel. Mounted views
 * subscribe here (via `useSyncRefresh` in plan 18-04) and reload — no Dexie
 * `liveQuery` rewrite, no React import in this module.
 *
 * No browser global is touched at module scope, so importing this during the
 * static-export prerender is safe.
 */

let appliedSeq = 0
const listeners = new Set<(seq: number) => void>()

export const SYNC_APPLIED_MESSAGE = 'sync-applied' as const

export function getSyncAppliedSeq(): number {
  return appliedSeq
}

/** Subscribe to applied-sequence changes. Returns an unsubscribe function. */
export function subscribeSyncApplied(fn: (seq: number) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function notify(seq: number): void {
  // Iterate a snapshot and isolate failures: one broken view must not stop the
  // rest from reloading, and a listener that unsubscribes mid-pass is safe.
  for (const fn of [...listeners]) {
    try {
      fn(seq)
    } catch {
      // Swallow — notification is best-effort.
    }
  }
}

/** Local data changed: increment the sequence and notify. */
export function emitSyncApplied(): number {
  appliedSeq += 1
  notify(appliedSeq)
  return appliedSeq
}

/**
 * Adopt a sequence received from another tab. Only ever moves the counter
 * forward (a stale BroadcastChannel message must not rewind it).
 */
export function applyRemoteSyncApplied(seq: number): void {
  if (!Number.isFinite(seq) || seq <= appliedSeq) return
  appliedSeq = seq
  notify(appliedSeq)
}
