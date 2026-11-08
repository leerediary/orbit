import type { OrbitDB } from '@/lib/local-db'
import type { Entity } from '@/lib/repository'
import { ALL_ENTITIES, type LocalRepository } from '@/lib/local-repository'
import { validateImportRow } from '@/lib/entity-schema'
import { enqueueOutbox } from '@/lib/outbox'
import { SYNC_ENTITIES, type SyncEntity } from '@/lib/sync-entities'
import type { PullResponse } from '@/lib/sync-protocol'
import { SYNC_KEYS, getDatasetEpoch, notifySyncMetadata } from '@/lib/sync-store'

/**
 * Phase 20 / BOOT-01 + BOOT-02 — local execution primitives for first sync.
 *
 * These helpers compose the pieces bootstrap needs and are the ONLY code paths
 * besides `LocalRepository.replaceAll` allowed to touch the whole local store.
 * They import no React and touch no browser global at module scope, so they are
 * safe to unit test under Node + fake-indexeddb.
 */

/** ISO now, used when a row carries no string `updated_at`. */
function now(): string {
  return new Date().toISOString()
}

function isKnownEntity(value: string): value is SyncEntity {
  return (SYNC_ENTITIES as readonly string[]).includes(value)
}

/**
 * Branch A / C keep-both and branch B tombstone pre-push: replace the outbox
 * with exactly one intent per local row.
 *
 * Runs in ONE `rw` transaction so the queue is never observed half-reset. Live
 * rows become `upsert`; tombstones become `delete` (they carry the delete
 * intent but keep their id/timestamp). Rows without a usable string `id` are
 * skipped — they cannot be addressed over the wire.
 */
export async function resetOutboxToLocalState(db: OrbitDB): Promise<void> {
  await db.transaction('rw', [...ALL_ENTITIES, db.syncOutbox], async () => {
    await db.syncOutbox.clear()
    for (const entity of ALL_ENTITIES) {
      const rows = (await db.table(entity).toArray()) as Record<string, unknown>[]
      for (const row of rows) {
        const id = row.id
        if (typeof id !== 'string' || id.length === 0) continue
        await enqueueOutbox(db, {
          entity,
          row_id: id,
          op: row.deleted_at == null ? 'upsert' : 'delete',
          updated_at:
            typeof row.updated_at === 'string' ? row.updated_at : now(),
        })
      }
    }
  })
}

/**
 * Branch C use-local / import-override: enqueue one `op:'purge'` intent per
 * server-only id.
 *
 * Purge (not `delete`) is mandatory: `pushOutbox` drops a delete intent whose
 * local row is missing, so a soft delete can never remove a cloud-only row
 * (RESEARCH Pitfall 1). Ids must come from an explicit, user-confirmed
 * `serverOnlyIdsByEntity` result (T-20-15).
 *
 * @returns the number of purge intents enqueued.
 */
export async function enqueuePurges(
  db: OrbitDB,
  idsByEntity: Readonly<Record<string, readonly string[]>>,
): Promise<number> {
  let total = 0
  await db.transaction('rw', db.syncOutbox, async () => {
    for (const [key, ids] of Object.entries(idsByEntity)) {
      if (!isKnownEntity(key)) {
        throw new Error(`未知的同步实体：${key}`)
      }
      for (const id of ids) {
        await enqueueOutbox(db, {
          entity: key,
          row_id: id,
          op: 'purge',
          updated_at: now(),
        })
        total += 1
      }
    }
  })
  return total
}

/**
 * Pure set difference: server ids that have no local counterpart, preserving
 * server order. Keys with no surviving id are omitted, so the result is exactly
 * the purge manifest (empty result means "nothing to delete").
 */
export function serverOnlyIdsByEntity(
  serverIds: Readonly<Record<string, readonly string[]>>,
  localIds: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [entity, ids] of Object.entries(serverIds)) {
    const local = new Set(localIds[entity] ?? [])
    const only = ids.filter((id) => !local.has(id))
    if (only.length > 0) out[entity] = only
  }
  return out
}

/** Sum of live (`deleted_at == null`) rows across the nine entity tables. */
export async function countLiveRows(db: OrbitDB): Promise<number> {
  let total = 0
  for (const entity of ALL_ENTITIES) {
    const rows = (await db.table(entity).toArray()) as Array<{
      deleted_at?: unknown
    }>
    for (const row of rows) {
      if (row.deleted_at == null) total += 1
    }
  }
  return total
}

/**
 * Branch A / C / D completion: mark this device bootstrapped for `accountId`.
 *
 * ONE `rw` transaction over `syncState` only. The pull cursor, dataset epoch,
 * last-synced/error stamps, entity tables, and outbox are deliberately left
 * untouched — completion is additive metadata, not a data mutation.
 */
export async function commitBootstrapComplete(
  db: OrbitDB,
  accountId: string,
): Promise<void> {
  await db.transaction('rw', db.syncState, async () => {
    await db.syncState.put({ key: SYNC_KEYS.status, value: 'idle' })
    await db.syncState.put({ key: SYNC_KEYS.bootstrapComplete, value: true })
    await db.syncState.put({ key: SYNC_KEYS.bootstrapAccountId, value: accountId })
    await db.syncState.put({ key: SYNC_KEYS.syncPaused, value: false })
  })
  notifySyncMetadata()
}

/**
 * After a successful cloud-account deletion: forget all sync progress so a
 * future account cannot inherit this device's cursor or completion, while
 * keeping every local entity row (D-10: cloud delete, local keep).
 *
 * The dataset epoch increments because the device's dataset is now unrelated to
 * the deleted cloud dataset. Entity tables are never touched.
 */
export async function resetSyncMetadataAfterAccountDelete(db: OrbitDB): Promise<void> {
  await db.transaction('rw', db.syncState, db.syncOutbox, async () => {
    const nextEpoch = (await getDatasetEpoch(db)) + 1
    await db.syncOutbox.clear()
    await db.syncState.put({ key: SYNC_KEYS.cursor, value: 0 })
    await db.syncState.put({ key: SYNC_KEYS.status, value: 'idle' })
    await db.syncState.put({ key: SYNC_KEYS.lastSyncedAt, value: null })
    await db.syncState.put({ key: SYNC_KEYS.lastError, value: null })
    await db.syncState.put({ key: SYNC_KEYS.bootstrapComplete, value: false })
    await db.syncState.put({ key: SYNC_KEYS.bootstrapAccountId, value: null })
    await db.syncState.put({ key: SYNC_KEYS.datasetEpoch, value: nextEpoch })
    await db.syncState.put({ key: SYNC_KEYS.syncPaused, value: false })
  })
  notifySyncMetadata()
}

export interface DownloadCloudBaselineInput {
  repo: LocalRepository
  /** Caller-provided authenticated fetch (token never enters this module). */
  fetchFn: (path: string) => Promise<Response>
  accountId: string
  epoch: number
  /** Page size; the server accepts [1, 1000] (default 500). */
  limit?: number
}

/**
 * Branch B / use-cloud: download the whole cloud snapshot, then adopt it as the
 * local baseline exactly once.
 *
 * Every page is accumulated in memory and validated row-by-row with
 * `validateImportRow` BEFORE any write. A malformed row, a non-OK response, or a
 * malformed envelope throws before `applyBootstrapBaseline` runs, so a
 * mid-download failure leaves local data byte-identical (RESEARCH Pattern 5 /
 * T-20-13/T-20-14). Sequential per-page cursor advancement is deliberately NOT
 * used (Anti-patterns).
 *
 * Purge entries are ignored: the baseline is the live/row snapshot, and a
 * tombstoned row arrives as an `op:'delete'` row carrying `data`.
 *
 * @returns the final pull cursor and the number of snapshot rows applied.
 */
export async function downloadCloudBaseline(
  input: DownloadCloudBaselineInput,
): Promise<{ cursor: number; rows: number }> {
  const limit = input.limit ?? 500
  let cursor = 0
  let rowCount = 0
  const grouped = new Map<SyncEntity, unknown[]>()

  for (;;) {
    const res = await input.fetchFn(`/v1/sync/pull?since=${cursor}&limit=${limit}`)
    if (!res.ok) {
      throw new Error(`下载云端数据失败（HTTP ${res.status}）`)
    }

    const body = (await res.json()) as Partial<PullResponse>
    if (typeof body.next_cursor !== 'number' || !Number.isFinite(body.next_cursor)) {
      throw new Error('云端返回缺少有效的 next_cursor')
    }
    if (typeof body.has_more !== 'boolean') {
      throw new Error('云端返回缺少 has_more')
    }
    if (!Array.isArray(body.changes)) {
      throw new Error('云端返回缺少 changes')
    }

    for (const change of body.changes) {
      if (change.op === 'purge') continue
      if (!isKnownEntity(change.entity)) {
        throw new Error(`云端返回了未知实体：${String(change.entity)}`)
      }
      const rows = grouped.get(change.entity) ?? []
      validateImportRow(change.entity, change.data, rows.length)
      rows.push(change.data)
      grouped.set(change.entity, rows)
      rowCount += 1
    }

    if (body.has_more && body.next_cursor === cursor) {
      throw new Error('云端游标未前进，已中止下载')
    }
    cursor = body.next_cursor
    if (!body.has_more) break
  }

  const entries: Array<readonly [Entity, unknown[]]> = [...grouped.entries()]
  await input.repo.applyBootstrapBaseline(entries, {
    cursor,
    accountId: input.accountId,
    epoch: input.epoch,
  })
  return { cursor, rows: rowCount }
}
