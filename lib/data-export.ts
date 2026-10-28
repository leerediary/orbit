'use client'

import type { Entity } from '@/lib/repository'
import { getRepository } from '@/lib/repository-provider'

/**
 * Entities exported in the data-portability contract. Order is deliberate:
 * goals first (FK target), then milestones and tasks which reference a goal,
 * then reviews which are standalone notes attached to a goal. `satisfies
 * readonly Entity[]` keeps this aligned with the Entity union — a drift here is
 * a compile error, not a runtime surprise.
 */
export const EXPORT_ENTITIES = [
  'goals',
  'milestones',
  'tasks',
  'reviews',
] as const satisfies readonly Entity[]

/** Contract format identifier — the import side validates against this literal (D-07). */
export const EXPORT_FORMAT = 'orbit-export'

/** Contract version — bump when the shape changes. Import validates against this. */
export const EXPORT_VERSION = 1

function yyyymmdd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Export all local data to a downloadable JSON file matching the Orbit contract.
 *
 * Reads every entity via `getRepository().list(entity, { includeDeleted: true })`
 * so tombstones are preserved. The resulting JSON is the single data-portability
 * contract — a future native shell imports this exact format via importData().
 */
export async function exportData(): Promise<void> {
  const repo = getRepository()

  // Read all entities in parallel — each list() is an independent read-only
  // query with no FK ordering constraint (FK order matters only for writes).
  const rows = await Promise.all(
    EXPORT_ENTITIES.map((entity) => repo.list(entity, { includeDeleted: true })),
  )
  const data: Record<string, unknown[]> = {}
  EXPORT_ENTITIES.forEach((entity, i) => { data[entity] = rows[i] })

  const contract = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  }

  const json = JSON.stringify(contract, null, 2)
  const filename = `orbit-export-${yyyymmdd(new Date())}.json`
  const blob = new Blob([json], { type: 'application/json' })

  // Two delivery paths. iOS Safari — especially a standalone PWA — silently
  // drops the classic <a download> blob (no download manager in standalone).
  // The Web Share API with a File routes through the native share sheet instead
  // (→ Save to Files / send), which is the only reliable export on iOS. Desktop
  // browsers don't implement file-share, so they fall back to the <a download>
  // path that already works.
  const file = new File([blob], filename, { type: 'application/json' })
  if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename })
      return
    } catch (e) {
      // User dismissed the share sheet — that's a cancel, not a failure.
      if (e instanceof DOMException && e.name === 'AbortError') return
      // Any other share error: fall through to the download path below.
    }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
