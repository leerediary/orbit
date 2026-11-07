/**
 * Local-write event seam (SYNC-01).
 *
 * This module intentionally imports NOTHING. It sits between the repository
 * (writer) and the sync engine (listener) without either importing the other,
 * so `local-repository → sync-triggers` and `sync-engine → sync-triggers` form
 * no cycle. It is a pure notification: emitting has no persistence side effect.
 */

const listeners = new Set<() => void>()

/**
 * Subscribe to "a local write just committed". Returns an unsubscribe function.
 * Listeners run after the Dexie transaction has resolved, so they observe the
 * committed state (a listener that reads the tables sees the new row).
 */
export function onLocalWrite(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * Notify every current listener exactly once. Each call is isolated in a
 * try/catch: a failing engine listener must never break a UI write path
 * (T-18-06). Iterate a snapshot so a listener that (un)subscribes during the
 * pass cannot skip or double-fire others.
 */
export function emitLocalWrite(): void {
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch {
      // Swallow: notification failures are not write failures.
    }
  }
}
