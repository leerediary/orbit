/**
 * Bulk-delete safety primitives (BOOT-04 client half).
 *
 * The server is the authoritative bulk-delete guard; this module holds the
 * client-side pieces that let the engine warn *before* a destructive drain and
 * surface a server 409 as a confirmation request instead of a silent retry.
 * Pure and DOM-free: no React, Dexie, fetch, or browser globals.
 */

export type BulkDeleteOp = 'upsert' | 'delete' | 'purge'

export interface OutboxIntent {
  entity: string
  row_id: string
  op: BulkDeleteOp
}

/** Minimum number of deletes before the client ever asks for confirmation. */
export const BULK_DELETE_MIN_RECORDS = 25

/** Fraction of the local live rows a drain must cover to be considered bulk. */
export const BULK_DELETE_FRACTION = 0.9

/**
 * True exactly when a drain deletes at least 25 rows AND at least 90% of the
 * local live rows. `max(totalLive, 1)` keeps the empty-store case (0/0) false
 * instead of dividing by zero.
 */
export function needsBulkDeleteConfirm(deletes: number, totalLive: number): boolean {
  return (
    totalLive > 0 &&
    deletes >= BULK_DELETE_MIN_RECORDS &&
    deletes / totalLive >= BULK_DELETE_FRACTION
  )
}

/**
 * Count the delete/purge intents of a coalesced outbox. Only the latest intent
 * per `entity:row_id` counts: an upsert after a delete cancels it, and a delete
 * after an upsert is one deletion.
 */
export function countCoalescedDeleteIntents(entries: readonly OutboxIntent[]): number {
  const latest = new Map<string, BulkDeleteOp>()
  for (const entry of entries) {
    latest.set(`${entry.entity}:${entry.row_id}`, entry.op)
  }

  let deletes = 0
  for (const op of latest.values()) {
    if (op === 'delete' || op === 'purge') deletes += 1
  }
  return deletes
}

/** The pending confirmation handed to the UI prompt (plan 20-09). */
export interface BulkDeleteRequest {
  deletes: number
  /** Local live-row count at prompt time (the denominator). */
  total: number
}

let current: BulkDeleteRequest | null = null
const listeners = new Set<(request: BulkDeleteRequest | null) => void>()

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener(current)
    } catch {
      // One broken subscriber must not stop the rest.
    }
  }
}

/** Publish (or replace) the pending confirmation and notify subscribers. */
export function publishBulkDeleteRequired(request: BulkDeleteRequest): void {
  current = { deletes: request.deletes, total: request.total }
  notify()
}

/** Clear the pending confirmation after the user decides. */
export function resolveBulkDelete(): void {
  current = null
  notify()
}

/**
 * Subscribe to the pending confirmation. The listener is invoked immediately
 * with the current snapshot (null when nothing is pending) and on every
 * publish/resolve. Returns an unsubscribe function.
 */
export function subscribeBulkDelete(
  listener: (request: BulkDeleteRequest | null) => void,
): () => void {
  listeners.add(listener)
  listener(current)
  return () => {
    listeners.delete(listener)
  }
}

/** Current pending confirmation, or null. */
export function getBulkDeleteSnapshot(): BulkDeleteRequest | null {
  return current
}
