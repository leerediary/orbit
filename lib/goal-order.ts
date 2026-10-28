import type { Goal } from '@/lib/types'

/**
 * Pure ordering helpers for the Goals UI (D-02 / D-08) and, from Phase 3, the
 * Milestone/Task hierarchy (D-05 / D-06).
 *
 * The helpers are entity-agnostic: any row with `sort_order` + `created_at`
 * (Goals, Milestones, Tasks) sorts through the same code. `sort_order` is the
 * user-controlled display order. Legacy rows (the Phase 1 seed
 * `seed-goal-orbit-v1`, and pre-Phase-3 milestones/tasks) have no sort_order at
 * runtime, so every read goes through `effectiveOrder`, which falls back to
 * created_at. Keeping the fallback in one place means list rendering, drag
 * reorder, and "append at the end" all agree on what the current order is.
 *
 * SCOPING: these helpers sort whatever array they are given. Sibling scopes
 * (one goal's milestones, one milestone's tasks, one goal's direct tasks) are
 * the CALLER's responsibility — pre-filter to live + deleted siblings of the
 * same parent before calling `sortByEffectiveOrder` / `nextSortOrder`.
 */

/**
 * The order key for any orderable row: explicit sort_order, else created_at in
 * ms. Structural so it accepts Goal, Milestone, and Task without a union.
 */
export function effectiveOrder(item: { sort_order?: number; created_at: string }): number {
  return item.sort_order ?? Date.parse(item.created_at)
}

/**
 * Ascending display order. Tie-break deterministically on created_at then id
 * (ISO-8601 timestamps sort chronologically as plain strings) so equal
 * sort_order values never shuffle between renders. Returns a new array and
 * leaves the input untouched.
 */
export function sortByEffectiveOrder<
  T extends { sort_order?: number; created_at: string; id: string },
>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const byOrder = effectiveOrder(a) - effectiveOrder(b)
    if (byOrder !== 0) return byOrder
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
    if (a.id !== b.id) return a.id < b.id ? -1 : 1
    return 0
  })
}

/**
 * Goals-only alias kept for existing callers (`app/page.tsx`,
 * `test/goal-order.test.ts`). Equivalent to `sortByEffectiveOrder`.
 */
export function sortGoals(goals: readonly Goal[]): Goal[] {
  return sortByEffectiveOrder(goals)
}

/**
 * The sort_order for a row appended after every existing sibling. Considers ALL
 * passed rows (including archived/tombstoned), per the UI-SPEC: when the list
 * is empty, start from Date.now() so new rows keep drifting upward instead of
 * colliding with a legacy created_at-based fallback.
 *
 * Scoping is the CALLER's job: pass only the siblings of the target parent
 * (filter to live + deleted rows of the same goal_id / milestone_id first).
 */
export function nextSortOrder(items: readonly { sort_order?: number; created_at: string }[]): number {
  return (items.length === 0 ? Date.now() : Math.max(...items.map(effectiveOrder))) + 1
}
