'use client'

import {
  EXPORT_ENTITIES,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  downloadJsonContract,
  exportFilename,
} from '@/lib/data-export'
import type { PullResponse } from '@/lib/sync-protocol'

/**
 * Phase 20 / BOOT-03 — truthful cloud backup export.
 *
 * A "cloud backup" that only exported local rows would be a false safety claim:
 * it would silently omit cloud-only data and tombstones. This module pages the
 * server's pull endpoint into the SAME frozen orbit-export v7 envelope the local
 * backup uses, then hands it to the shared delivery helper (Web Share then
 * `<a download>`).
 *
 * Client-safe by construction: no browser global is touched at module scope,
 * and no Dexie store is read or written here. Purge markers are excluded — they
 * carry no row — while tombstones (`op:'delete'` with `data`) are preserved.
 */

/** One pull change, reduced to the fields the export envelope needs. */
export interface CloudExportChange {
  entity: string
  data?: Record<string, unknown>
  op?: string
}

export interface CloudExportContract {
  format: string
  version: number
  exportedAt: string
  data: Record<string, unknown[]>
}

/**
 * Build the orbit-export v7 envelope from a full server pull.
 *
 * Every `EXPORT_ENTITIES` key is present (empty array when the cloud has no
 * rows for it), so the result imports through the same v7 path as a local
 * backup. `op === 'purge'` entries are skipped: a purge is the absence of a
 * row, and the envelope only carries rows. An unknown entity or a non-purge
 * change without data throws instead of silently dropping data (T-20-25).
 */
export function buildCloudExportContract(
  changes: ReadonlyArray<CloudExportChange>,
): CloudExportContract {
  const data: Record<string, unknown[]> = {}
  for (const entity of EXPORT_ENTITIES) data[entity] = []

  for (const change of changes) {
    if (change.op === 'purge') continue
    // Own-property check: prototype names (toString/constructor) must never
    // resolve to an inherited slot and silently absorb a row (T-06-02).
    if (!Object.hasOwn(data, change.entity)) {
      throw new Error(`云端返回了未知实体：${change.entity}`)
    }
    if (change.data == null || typeof change.data !== 'object') {
      throw new Error(`云端返回了缺少数据的变更：${change.entity}`)
    }
    data[change.entity].push(change.data)
  }

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  }
}

export interface ExportCloudBackupInput {
  /** Caller-provided authenticated fetch (the token never enters this module). */
  fetchFn: (path: string) => Promise<Response>
  /** Page size; the server accepts [1, 1000] (default 500). */
  limit?: number
  /** Delivery seam; defaults to the shared Web Share / download helper. */
  deliver?: (json: string, filename: string) => Promise<void>
  /** Clock seam for the filename (tests pin a date). */
  now?: () => Date
}

/**
 * Export the full cloud snapshot as an orbit-export v7 JSON file.
 *
 * Pages `GET /v1/sync/pull?since=<cursor>&limit=<limit>` from cursor 0 and
 * accumulates every change. A non-OK response, a non-numeric `next_cursor`, a
 * missing `has_more`, or a stalled cursor throws before anything is delivered,
 * so a partial backup can never be handed to the user (T-20-25/T-20-28).
 *
 * @returns the number of non-purge rows included in the backup.
 */
export async function exportCloudBackup(
  input: ExportCloudBackupInput,
): Promise<{ rows: number }> {
  const limit = input.limit ?? 500
  const now = input.now ?? (() => new Date())
  const changes: CloudExportChange[] = []
  let cursor = 0

  for (;;) {
    const res = await input.fetchFn(`/v1/sync/pull?since=${cursor}&limit=${limit}`)
    if (!res.ok) {
      throw new Error(`导出云端备份失败（HTTP ${res.status}）`)
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
      changes.push({ entity: change.entity, data: change.data ?? undefined, op: change.op })
    }

    if (body.has_more && body.next_cursor === cursor) {
      throw new Error('云端游标未前进，已中止导出')
    }
    cursor = body.next_cursor
    if (!body.has_more) break
  }

  const contract = buildCloudExportContract(changes)
  const json = JSON.stringify(contract, null, 2)
  const filename = exportFilename('orbit-cloud-export', now())
  await (input.deliver ?? downloadJsonContract)(json, filename)

  return { rows: changes.filter((change) => change.op !== 'purge').length }
}
