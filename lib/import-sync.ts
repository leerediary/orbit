import type { OrbitDB } from '@/lib/local-db'
import { importData } from '@/lib/data-import'
import { enqueuePurges, resetOutboxToLocalState } from '@/lib/bootstrap-local'
import { readOutbox } from '@/lib/outbox'
import { countCoalescedDeleteIntents } from '@/lib/sync-bulk-delete'
import { requestSync } from '@/lib/sync-engine'
import {
  SYNC_KEYS,
  notifySyncMetadata,
  setBootstrapAccountId,
  setBootstrapComplete,
  setSyncPaused,
  setSyncValue,
} from '@/lib/sync-store'

/**
 * Phase 20 / BOOT-03 — sync-aware import orchestration.
 *
 * The plain `importData` is a whole-store local replace. When sync is active
 * that is not enough: the caller must choose between:
 *
 *  - **disconnect** (default, D-05): stop syncing first, then replace local
 *    data only. Zero network writes, and the device is marked "not yet
 *    bootstrapped" so the next sign-in runs the first-sync classifier again.
 *  - **override** (explicit, D-05/D-06): replace local data, then push the new
 *    local snapshot to the cloud and purge exactly the cloud-only ids. This is
 *    gated in the UI by a checkbox plus a second confirmation.
 *
 * Both paths live here so the UI never re-implements the destructive ordering.
 * Everything is DOM-free and testable under Node + fake-indexeddb.
 */

/** The guarded push seam; the default is the production `requestSync`. */
export type ImportSyncFn = (opts: {
  allowBulkDelete: boolean
  declaredDeleteTotal: number
}) => Promise<{ ok: boolean; error?: string }>

/**
 * Pure set difference: server ids with no counterpart in the backup.
 *
 * Server order is preserved and entities with no surviving id are omitted, so
 * the result is exactly the purge manifest (empty means "nothing to delete").
 * Tombstoned backup rows count as present: the id is known locally, so it must
 * never be purged just because the row is soft-deleted.
 */
export function cloudOnlyIds(
  serverIds: Readonly<Record<string, readonly string[]>>,
  backupIds: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [entity, ids] of Object.entries(serverIds)) {
    const known = new Set(backupIds[entity] ?? [])
    const only = ids.filter((id) => !known.has(id))
    if (only.length > 0) out[entity] = only
  }
  return out
}

export interface ImportDisconnectInput {
  db: OrbitDB
  json: string
  /** Test seam; defaults to the real whole-store import. */
  importFn?: (json: string) => Promise<void>
}

/**
 * Default import path when sync is active (D-05).
 *
 * Ordering is the safety contract: pause sync and clear bootstrap completion
 * FIRST, then replace the local store. No fetch and no sync-engine call is made
 * on this path, so the imported data never reaches the cloud.
 *
 * If the import throws, the error propagates; sync stays paused and the
 * completion flag stays cleared — the safe state (nothing is pushed).
 * `bootstrapAccountId` is cleared too, so a later re-enable re-classifies this
 * device against the current account.
 */
export async function executeImportDisconnect(
  input: ImportDisconnectInput,
): Promise<{ ok: true }> {
  await setSyncPaused(input.db, true)
  await setBootstrapComplete(input.db, false)
  await setBootstrapAccountId(input.db, null)
  // One signal for the multi-key write, matching the bootstrap helpers.
  notifySyncMetadata()

  await (input.importFn ?? importData)(input.json)
  return { ok: true }
}

export interface ImportOverrideInput {
  db: OrbitDB
  json: string
  /** The explicit, user-confirmed set of cloud-only ids (from the diff). */
  cloudOnly: Record<string, string[]>
  /** Test seam; defaults to the real whole-store import. */
  importFn?: (json: string) => Promise<void>
  /** Test seam; defaults to `requestSync('manual', opts)`. */
  syncFn?: ImportSyncFn
}

/**
 * Explicit override path (D-05/D-06): replace local data, then push the new
 * snapshot and permanently delete the cloud-only rows.
 *
 * Steps and their guarantees:
 *  1. Import locally (throws before anything else if the backup is bad).
 *  2. Reset the outbox to exactly the imported rows, so the cloud converges on
 *     the backup instead of replaying pre-import intent.
 *  3. Set status `idle` — the outbox was rebuilt explicitly, so the engine must
 *     not also perform a full-reconcile echo.
 *  4. Enqueue one `purge` per cloud-only id (never a soft delete: a delete
 *     intent for a missing local row is dropped by the engine).
 *  5. AWAIT one guarded sync with `allowBulkDelete` and the coalesced delete
 *     total. Plan 20-05 makes `requestSync` resolve only after the trailing run
 *     that consumes these options, so this await is the completion barrier —
 *     the push is never fire-and-forget (T-20-56). Success is reported only
 *     after the guarded run resolved ok.
 *
 * `imported: true` always means the LOCAL replace succeeded. When the cloud
 * push fails the result is `{ok:false, imported:true, error}`, so the UI can say
 * "导入成功，但云端覆盖未完成" instead of claiming nothing changed. Bootstrap
 * completion is deliberately left untouched on this path.
 */
export async function executeImportOverride(
  input: ImportOverrideInput,
): Promise<{ ok: boolean; imported: true; error?: string }> {
  await (input.importFn ?? importData)(input.json)

  await resetOutboxToLocalState(input.db)
  await setSyncValue(input.db, SYNC_KEYS.status, 'idle')
  await enqueuePurges(input.db, input.cloudOnly)

  const declaredDeleteTotal = countCoalescedDeleteIntents(await readOutbox(input.db))
  const syncFn: ImportSyncFn =
    input.syncFn ?? ((opts) => requestSync('manual', opts))

  const result = await syncFn({ allowBulkDelete: true, declaredDeleteTotal })

  if (result.ok) return { ok: true, imported: true }
  return { ok: false, imported: true, error: result.error }
}
