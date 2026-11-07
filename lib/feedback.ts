/**
 * Shared, pure feedback-widget logic.
 *
 * No React, no browser globals, no localStorage access. Exactly like
 * lib/progress.ts, everything here is deterministic and import-testable: the
 * caller threads in `now`/timestamps so tests never read the wall clock.
 */

export interface FeedbackItem {
  id: string
  text: string
  createdAt: number
}

/** localStorage contract — `orbit_` prefix, never touches Dexie or the export contract. */
export const FEEDBACK_ITEMS_KEY = 'orbit_feedback_items'
export const FEEDBACK_POSITION_KEY = 'orbit_feedback_position'

export interface FeedbackPosition {
  x: number
  y: number
}

export interface FeedbackViewport {
  width: number
  height: number
}

export interface FeedbackSize {
  width: number
  height: number
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * `YYYY-MM-DD` in the device's LOCAL time zone (zero-padded). Returns '' for an
 * invalid Date rather than emitting "Invalid Date" (project D-06 convention,
 * matching formatReviewTimestamp).
 */
export function formatFeedbackDate(date: Date): string {
  const time = date.getTime()
  if (!Number.isFinite(time)) return ''
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * `YYYY-MM-DD HH:mm` in the device's LOCAL time zone (24h, zero-padded).
 * Returns '' for a non-finite/NaN timestamp — never "Invalid Date".
 */
export function formatFeedbackTimestamp(ts: number): string {
  if (!Number.isFinite(ts)) return ''
  const date = new Date(ts)
  if (!Number.isFinite(date.getTime())) return ''
  return `${formatFeedbackDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * Markdown summary for the "copy all" action:
 *
 *   ## 反馈 2026-10-31
 *
 *   - 按钮错位
 *   - 复制无反馈
 *
 * An empty list yields only the heading (no dangling blank lines). Order is
 * preserved (oldest → newest) and no trailing newline is appended.
 */
export function buildFeedbackMarkdown(
  items: ReadonlyArray<{ text: string }>,
  now: Date,
): string {
  const heading = `## 反馈 ${formatFeedbackDate(now)}`
  if (items.length === 0) return heading
  const lines = items.map((item) => `- ${item.text}`)
  return `${heading}\n\n${lines.join('\n')}`
}

/**
 * Parse persisted feedback items. Any parse failure or malformed shape yields
 * `[]` — hostile/corrupt storage must never break rendering (T-261031-02).
 * Only items with a non-empty string `id` + `text` and a finite numeric
 * `createdAt` are kept; order is preserved.
 */
export function parseFeedbackItems(raw: string | null): FeedbackItem[] {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const items: FeedbackItem[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as Record<string, unknown>
    const id = candidate.id
    const text = candidate.text
    const createdAt = candidate.createdAt
    if (typeof id !== 'string' || id.length === 0) continue
    if (typeof text !== 'string' || text.length === 0) continue
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue
    items.push({ id, text, createdAt })
  }
  return items
}

/**
 * Parse the persisted panel position. Anything other than a JSON object with
 * finite numeric `x`/`y` returns `null` (meaning "default dock"), so a corrupt
 * value can never position the panel off-screen (T-261031-02).
 */
export function parseFeedbackPosition(raw: string | null): FeedbackPosition | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const candidate = parsed as Record<string, unknown>
  const x = candidate.x
  const y = candidate.y
  if (typeof x !== 'number' || !Number.isFinite(x)) return null
  if (typeof y !== 'number' || !Number.isFinite(y)) return null
  return { x, y }
}

/**
 * Clamp a free-floating panel position so at least `margin` px stays inside the
 * viewport on every side. When the panel is larger than the viewport the
 * minimum wins, guaranteeing the drag handle remains reachable (T-261031-04).
 */
export function clampFeedbackPosition(
  pos: FeedbackPosition,
  viewport: FeedbackViewport,
  size: FeedbackSize,
  margin = 8,
): FeedbackPosition {
  const maxX = Math.max(margin, viewport.width - size.width - margin)
  const maxY = Math.max(margin, viewport.height - size.height - margin)
  return {
    x: Math.min(Math.max(pos.x, margin), maxX),
    y: Math.min(Math.max(pos.y, margin), maxY),
  }
}
