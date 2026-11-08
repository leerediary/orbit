/**
 * Pure sync-time formatting + four-state derivation (plan 18-04 / SYNC-03).
 *
 * The UI must never compute sync business logic: it asks this module for the
 * exact copy strings of UI-SPEC §3. No React, no Dexie, no browser global — this
 * file is safe to import during the static-export prerender and is unit-tested
 * under TZ=UTC.
 */

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Relative badge caption: 刚刚 / N 分钟前 / N 小时前 / N 天前. */
export function formatSyncRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts)
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  return `${Math.floor(diff / DAY)} 天前`
}

/** Absolute popover line: 上次同步 HH:mm / 昨天 HH:mm / M月D日 HH:mm. */
export function formatSyncAbsolute(ts: number, now: number): string {
  const date = new Date(ts)
  const ref = new Date(now)
  const hhmm = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`

  const sameDay =
    date.getFullYear() === ref.getFullYear() &&
    date.getMonth() === ref.getMonth() &&
    date.getDate() === ref.getDate()
  if (sameDay) return `上次同步 ${hhmm}`

  const yesterday = new Date(ref)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  if (isYesterday) return `上次同步 昨天 ${hhmm}`

  // Month / day are intentionally NOT zero-padded (UI-SPEC §3, verbatim).
  return `上次同步 ${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`
}

export type SyncStatus = 'offline' | 'pending' | 'synced' | 'never'

/**
 * UI-SPEC §3 precedence: offline beats everything, then a non-empty outbox is
 * `pending`, then a recorded last-sync time is `synced`, else the pre-first-sync
 * `never` edge state.
 */
export function deriveSyncStatus(input: {
  online: boolean
  outboxCount: number
  lastSyncedAt: number | null
}): SyncStatus {
  if (!input.online) return 'offline'
  if (input.outboxCount > 0) return 'pending'
  if (input.lastSyncedAt != null) return 'synced'
  return 'never'
}
