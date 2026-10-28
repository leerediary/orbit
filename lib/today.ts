export const DAY_OFFSET_KEY = 'diary_day_offset_hours'

/**
 * Read the "a new day starts at N:00" offset (hours) from localStorage.
 * Guarded 0–5; SSR/build (no localStorage) → 0.
 */
export function getDayOffsetHours(): number {
  try {
    const raw = parseInt(localStorage.getItem(DAY_OFFSET_KEY) ?? '0', 10)
    if (!isNaN(raw) && raw >= 0 && raw <= 5) return raw
  } catch {
    // localStorage unavailable (e.g. SSR/build) — fall through to 0.
  }
  return 0
}

/**
 * The logical local day (YYYY-MM-DD) an instant belongs to.
 *
 * PURE — no localStorage, no `new Date()` for "now": pass the instant and the
 * DAY_OFFSET explicitly so this stays deterministic and import-testable (callers
 * inside pure tested units thread `offsetHours` through). Uses device-LOCAL
 * fields (getFullYear/Month/Date/Hours), so it follows the phone/browser time
 * zone. DAY_OFFSET then shifts the day on local hours (a tap before N:00 counts
 * as the previous day) — the same rule getTodayStr has always used.
 *
 * This replaces a UTC `iso.slice(0,10)` date prefix, which disagrees with the
 * local "today" and mis-dates near-midnight entries.
 */
export function dayKey(iso: string, offsetHours = 0): string {
  const d = new Date(iso)
  if (d.getHours() < offsetHours) {
    d.setDate(d.getDate() - 1)
  }
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Today's logical local day. = dayKey(now, DAY_OFFSET). */
export function getTodayStr(): string {
  return dayKey(new Date().toISOString(), getDayOffsetHours())
}
