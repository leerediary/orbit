/**
 * Pure date helpers for the journal view.
 *
 * No React, no repository, no browser globals and no implicit `new Date()` —
 * every helper is a deterministic computation over strings and explicit inputs,
 * so this module is import-safe during Next.js static prerender and unit-testable
 * under the project's pinned `TZ=UTC`.
 *
 * Day arithmetic uses `Date.UTC`/`getUTC*` exclusively: mutating a local Date
 * crosses DST boundaries inconsistently and can produce off-by-one labels.
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Shift a `YYYY-MM-DD` key by whole calendar days.
 *
 * Boundaries (month end, year end, leap day) all come from UTC arithmetic, so
 * the result is independent of the device time zone.
 */
export function shiftDayKey(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d) + delta * 86_400_000)
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`
}

/**
 * True only for a real calendar date in `YYYY-MM-DD` shape.
 *
 * The UTC round-trip rejects overflowing dates (`2026-02-30`, `2025-02-29`,
 * `2026-13-01`) that would otherwise roll into the next month. Non-string input
 * returns `false` rather than throwing, so a malformed import row is rejected by
 * validation instead of crashing it.
 */
export function isValidDayKey(day: string): boolean {
  if (typeof day !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === m - 1 &&
    t.getUTCDate() === d
  )
}

/**
 * Visible date label for the journal pager (locked ladder, 10-UI-SPEC §2).
 *
 *   day === today        → 今天 · {M}月{D}日
 *   day === yesterday    → 昨天 · {M}月{D}日
 *   older, same year     → {M}月{D}日
 *   older, other year    → {YYYY}年{M}月{D}日
 *
 * M/D are parsed as numbers, so there is no zero padding. The copy is built
 * manually rather than through `Intl.DateTimeFormat` so it never varies by
 * locale. `today` is passed in, keeping the helper pure.
 */
export function journalDayLabel(day: string, today: string): string {
  const [, m, d] = day.split('-').map(Number)
  const dateLabel = `${m}月${d}日`

  if (day === today) return `今天 · ${dateLabel}`
  if (day === shiftDayKey(today, -1)) return `昨天 · ${dateLabel}`

  const year = Number(day.slice(0, 4))
  const todayYear = Number(today.slice(0, 4))
  return year === todayYear ? dateLabel : `${year}年${dateLabel}`
}

/**
 * Format a persisted `updated_at` as device-local zero-padded 24h `HH:mm`.
 *
 * Device-local by design — the UI shows the wall-clock time the save happened.
 * Unparseable input returns `''` rather than `Invalid Date`.
 */
export function formatSavedTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
