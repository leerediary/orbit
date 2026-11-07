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

// Locked 2–7 day ladder (D-02). Chinese numerals, not digits — the product copy
// specifies 两天前/三天前/….
const DAY_WORDS: Record<number, string> = {
  2: '两天前',
  3: '三天前',
  4: '四天前',
  5: '五天前',
  6: '六天前',
  7: '七天前',
}

/**
 * Whole calendar-day difference between two YYYY-MM-DD keys.
 *
 * Both days are parsed as UTC midnight so DST transitions cannot produce a
 * fractional/off-by-one day (the value is rounded defensively anyway).
 */
export function dayDiff(fromDay: string, toDay: string): number {
  const [fy, fm, fd] = fromDay.split('-').map(Number)
  const [ty, tm, td] = toDay.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

/**
 * Relative "added" label for the 今日 list (D-02). Returns the LABEL ONLY — the
 * UI prefixes 添加于.
 *
 *   diff <= 0 → null (today, or a clock-skewed future timestamp)
 *   diff === 1 → 昨天
 *   diff 2..7 → 两天前 … 七天前
 *   diff >= 8 → M月D日, prefixed `YYYY年` when the added year differs
 *
 * `today` is passed in so this never reads the wall clock, and `offsetHours`
 * threads the DAY_OFFSET through `dayKey` so near-midnight additions stay on the
 * correct logical day.
 */
export function addedAgeLabel(
  addedAt: string,
  today: string,
  offsetHours = 0,
): string | null {
  const addedDay = dayKey(addedAt, offsetHours)
  const diff = dayDiff(addedDay, today)
  if (diff <= 0) return null
  if (diff === 1) return '昨天'
  if (diff >= 2 && diff <= 7) return DAY_WORDS[diff]

  const [addedYear, month, day] = addedDay.split('-').map(Number)
  const [todayYear] = today.split('-').map(Number)
  const dateLabel = `${month}月${day}日`
  return addedYear === todayYear ? dateLabel : `${addedYear}年${dateLabel}`
}
