'use client'

import type { Entity } from '@/lib/repository'
import { getRepository } from '@/lib/repository-provider'

/**
 * Entities exported in the data-portability contract (v7). Order is deliberate
 * and parent-first: categories first (FK target), then goals, milestones, and
 * tasks which each reference the level above. A task array is self-referential:
 * `parent_id` points to another row in the same array (sub-task tree), while
 * `milestone_id`/`goal_id` select the owning scope. `dailyTodos` follows tasks
 * because a linked daily row references a task (`task_id`), so tasks must be
 * restored before it during a whole-store replace. `journalEntries` is
 * standalone — it has no foreign key, so its position is irrelevant to restore
 * order. `habits` and `habitCompletions` (v6) are appended after the hierarchy:
 * both are standalone (a completion's `habit_id` is allowed to dangle), so order
 * is irrelevant to restore. `pomodoroSessions` (v7) is appended last and is
 * likewise standalone — neither `task_id`, `daily_todo_id`, nor `habit_id` must
 * resolve during restore, so its position is irrelevant to restore order.
 * `satisfies readonly Entity[]` keeps this aligned with the Entity union — a
 * drift here is a compile error, not a runtime surprise.
 */
export const EXPORT_ENTITIES = [
  'categories',
  'goals',
  'milestones',
  'tasks',
  'dailyTodos',
  'journalEntries',
  'habits',
  'habitCompletions',
  'pomodoroSessions',
] as const satisfies readonly Entity[]

/** Contract format identifier — the import side validates against this literal (D-07). */
export const EXPORT_FORMAT = 'orbit-export'

/** Contract version — bump when the shape changes. Import validates against this. */
export const EXPORT_VERSION = 7

function yyyymmdd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** `${prefix}-YYYY-MM-DD.json` — one filename shape for every backup export. */
export function exportFilename(prefix: string, date: Date): string {
  return `${prefix}-${yyyymmdd(date)}.json`
}

/**
 * Deliver a JSON string through the platform's most reliable export path.
 *
 * Shared by the local backup (`exportData`) and the truthful cloud backup
 * (`exportCloudBackup`), so both honour the same iOS behaviour in one place.
 *
 * Two delivery paths. iOS Safari — especially a standalone PWA — silently
 * drops the classic <a download> blob (no download manager in standalone).
 * The Web Share API with a File routes through the native share sheet instead
 * (→ Save to Files / send), which is the only reliable export on iOS. Desktop
 * browsers don't implement file-share, so they fall back to the <a download>
 * path that already works.
 */
export async function downloadJsonContract(json: string, filename: string): Promise<void> {
  const blob = new Blob([json], { type: 'application/json' })

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
  await downloadJsonContract(json, exportFilename('orbit-export', new Date()))
}
