import type { OrbitDB } from '@/lib/local-db'
import type { LocalRepository } from '@/lib/local-repository'
import {
  commitBootstrapComplete,
  downloadCloudBaseline,
  enqueuePurges,
  resetOutboxToLocalState,
  serverOnlyIdsByEntity,
} from '@/lib/bootstrap-local'
import { EXPORT_ENTITIES } from '@/lib/data-export'
import { readLocalInventory } from '@/lib/sync-diagnostics'
import type { SyncRunOptions, SyncRunResult } from '@/lib/sync-engine'
import {
  SYNC_KEYS,
  getDatasetEpoch,
  notifySyncMetadata,
  setSyncValue,
} from '@/lib/sync-store'

/**
 * Phase 21 / OPS-01 — one-click full resync, both directions.
 *
 * Pull (`resyncFromCloud`) is the default and is non-destructive on failure:
 * `downloadCloudBaseline` accumulates and validates every page BEFORE touching
 * local data, so a mid-download failure leaves the store byte-identical.
 *
 * Push (`resyncToCloud`) is the destructive escape hatch: it is confirm-gated,
 * wipes only the CLOUD, and re-uploads local data. It never deletes or replaces
 * a local row. Because the reset also removes cloud-only ids, those ids are
 * enqueued as durable `op:'purge'` intents before the re-push, so every other
 * device deletes them instead of resurrecting them on its next pull.
 *
 * Importing this module touches no React and no browser global at module scope.
 */

export type ResyncFailure = 'auth' | 'network' | 'server' | 'malformed' | 'unknown'

export type ResyncResult =
  | { ok: true; rows: number }
  | { ok: false; reason: ResyncFailure }

export interface ResyncDeps {
  db: OrbitDB
  repo: LocalRepository
  fetchFn: (path: string, init?: RequestInit) => Promise<Response>
  /**
   * The caller's session subject. Never read from a response body (T-21-03-04):
   * the server binds the JWT `sub`, and this is only stored on completion.
   */
  accountId: string
  /**
   * Production wiring is `(opts) => requestSync('manual', opts)`. Typed
   * opts-only so the injected adapter is the only correct shape.
   */
  runSync: (opts?: SyncRunOptions) => Promise<SyncRunResult>
  now?: () => number
}

type FetchFn = (path: string, init?: RequestInit) => Promise<Response>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKnownEntity(value: string): boolean {
  return (EXPORT_ENTITIES as readonly string[]).includes(value)
}

/**
 * Validate the reset envelope `{version:1, ok:true, ids}`. Every entry must be a
 * string array under a known entity; anything else is `malformed`. Returns null
 * when the envelope cannot be trusted.
 */
function parseResetIds(body: unknown): Record<string, string[]> | null {
  if (!isPlainObject(body)) return null
  if (body.version !== 1 || body.ok !== true) return null

  const raw = body.ids
  if (!isPlainObject(raw)) return null

  const ids: Record<string, string[]> = {}
  for (const [entity, value] of Object.entries(raw)) {
    if (!isKnownEntity(entity)) return null
    if (!Array.isArray(value)) return null
    if (value.some((id) => typeof id !== 'string' || id.length === 0)) return null
    ids[entity] = [...(value as string[])]
  }
  return ids
}

/** Map a sync-engine error kind to a resync failure reason. */
function mapSyncError(error: SyncRunResult['error']): ResyncFailure {
  switch (error) {
    case 'auth':
      return 'auth'
    case 'offline':
      return 'network'
    case 'server':
      return 'server'
    // `bulk` and `unknown` both mean "we cannot explain this"; never report
    // success after the cloud was already emptied.
    default:
      return 'unknown'
  }
}

/**
 * Pull resync: increment the dataset epoch and replace the whole local store
 * with the cloud baseline. A failed download changes nothing locally.
 */
export async function resyncFromCloud(deps: ResyncDeps): Promise<ResyncResult> {
  // Classify a failure that surfaced as an HTTP/network signal. An envelope or
  // row-validation failure leaves this null and is reported as `malformed`.
  let failure: ResyncFailure | null = null

  const tracked: FetchFn = async (path) => {
    let res: Response
    try {
      res = await deps.fetchFn(path)
    } catch {
      failure = 'network'
      throw new Error('network')
    }
    if (res.status === 401) failure = 'auth'
    else if (res.status >= 500) failure = 'server'
    else if (!res.ok) failure = 'unknown'
    return res
  }

  const epoch = (await getDatasetEpoch(deps.db)) + 1

  try {
    const { rows } = await downloadCloudBaseline({
      repo: deps.repo,
      fetchFn: tracked,
      accountId: deps.accountId,
      epoch,
    })

    const nowIso = new Date(deps.now?.() ?? Date.now()).toISOString()
    await deps.db.transaction('rw', deps.db.syncState, async () => {
      await deps.db.syncState.put({ key: SYNC_KEYS.lastError, value: null })
      await deps.db.syncState.put({ key: SYNC_KEYS.lastSyncedAt, value: nowIso })
      await deps.db.syncState.put({ key: SYNC_KEYS.syncPaused, value: false })
    })
    notifySyncMetadata()

    return { ok: true, rows }
  } catch {
    return { ok: false, reason: failure ?? 'malformed' }
  }
}

/**
 * Push resync: wipe the cloud, rebuild the outbox from local rows, enqueue a
 * purge for every cloud-only id, then re-push. Local entity rows are never
 * deleted or replaced; only the cloud and this device's outbox change.
 */
export async function resyncToCloud(deps: ResyncDeps): Promise<ResyncResult> {
  const local = await readLocalInventory(deps.db)
  // Abort before ANY network call: if we cannot read the local inventory, a
  // reset would destroy cloud data we cannot account for.
  if (!local.ok) return { ok: false, reason: 'unknown' }

  let res: Response
  try {
    res = await deps.fetchFn('/v1/sync/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    })
  } catch {
    return { ok: false, reason: 'network' }
  }

  if (res.status === 401) return { ok: false, reason: 'auth' }
  if (res.status >= 500) return { ok: false, reason: 'server' }
  if (!res.ok) return { ok: false, reason: 'unknown' }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  const ids = parseResetIds(body)
  if (ids === null) return { ok: false, reason: 'malformed' }

  // The reset reports the deduped union of deleted live records, tombstones, and
  // purge markers. Any id with no local LIVE counterpart would otherwise
  // resurrect on another device's next pull.
  const cloudOnly = serverOnlyIdsByEntity(ids, local.inventory.ids)

  await resetOutboxToLocalState(deps.db)
  await enqueuePurges(deps.db, cloudOnly)
  await setSyncValue(deps.db, SYNC_KEYS.lastError, null)

  let result: SyncRunResult
  try {
    result = await deps.runSync({ bootstrap: true, allowBulkDelete: true })
  } catch {
    // The rebuilt outbox (including the purges) stays for retry.
    return { ok: false, reason: 'unknown' }
  }

  // A skipped run pushed nothing, and the cloud is ALREADY empty. Reporting
  // success would be a false success over an empty cloud and would drop the
  // one-shot allowBulkDelete permission. Treat it as a failure, keep the queue.
  if (result.skipped !== undefined) {
    const reason: ResyncFailure =
      result.skipped === 'offline'
        ? 'network'
        : result.skipped === 'no-session'
          ? 'auth'
          : 'unknown'
    return { ok: false, reason }
  }

  if (!result.ok) {
    return { ok: false, reason: mapSyncError(result.error) }
  }

  await commitBootstrapComplete(deps.db, deps.accountId)
  return { ok: true, rows: result.rowsTransferred ?? 0 }
}
