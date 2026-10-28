import type { Review } from '@/lib/types'

/**
 * Pure timeline helpers for Phase 5 (D-01 / D-06, REV-01 / REV-02). Mirrors
 * lib/progress.ts and lib/task-order.ts: no React, no repository, no browser
 * globals — unit-testable in isolation and deterministic by construction.
 *
 * `Review.created_at` is the single source for both ordering and display;
 * reviews have no user-controlled `sort_order` (D-01).
 */

/**
 * Newest-first ordering for a goal's review timeline (D-01).
 *
 * Descending by `created_at` (ISO-8601 strings sort chronologically), with an
 * ascending `id` tie-break so notes saved in the same millisecond never shuffle
 * between renders. Returns a NEW array and leaves the caller's array untouched
 * (it is usually React state).
 */
export function sortReviewsNewestFirst(reviews: readonly Review[]): Review[] {
  return [...reviews].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
    if (a.id !== b.id) return a.id < b.id ? -1 : 1
    return 0
  })
}

/**
 * Absolute device-local timestamp for a review entry (D-06): zero-padded
 * `YYYY-MM-DD HH:mm`, 24-hour, no seconds, no timezone suffix. Unparseable
 * input returns '' so the UI can never render "Invalid Date" or a relative
 * label. Uses the same local getters as lib/today.ts dayKey().
 */
export function formatReviewTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''

  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day} ${hh}:${mm}`
}
