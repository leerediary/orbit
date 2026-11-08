import { nextSortOrder } from '@/lib/goal-order'
import type { Category, Goal, Milestone, SyncMeta, Task } from '@/lib/types'

/**
 * Single source of truth for the v1 → v2 (three-level → four-level) mapping.
 *
 * Mirrors lib/task-order.ts and lib/goal-order.ts: a PURE module — no Dexie, no
 * React, no repository, no browser globals. Both consumers share it so they can
 * never drift:
 *  - `lib/local-db.ts` version(2).upgrade() (in-place DB migration)
 *  - `lib/data-import.ts` version === 1 branch (legacy orbit-export backup)
 *
 * Semantic shift (D-01/D-02): old Goal → Category, old Milestone → Goal,
 * old Task → Milestone. The new leaf Task level starts empty. `description`,
 * `completed` and `completed_at` are intentionally dropped; reviews are dropped
 * with the table.
 *
 * `id` / `updated_at` / `deleted_at` are copied VERBATIM so tombstones and
 * identity survive the migration byte-for-byte.
 *
 * ADDITIONALLY: `normalizeTaskV3` (below) is the single default-fill for the
 * v2 → v3 task shape. It is shared by `lib/local-db.ts` version(3).upgrade()
 * and the v2 import branch in `lib/data-import.ts` — do NOT fork a second copy,
 * or migrated rows and imported rows will drift.
 */

/** Legacy (v1) Goal — the old root row, carrying the now-deleted `description`. */
export interface LegacyGoal extends SyncMeta {
  name: string
  description?: string
  created_at: string
  sort_order?: number
}

/** Legacy (v1) Milestone — old second level, carrying `completed`/`completed_at`. */
export interface LegacyMilestone extends SyncMeta {
  goal_id: string
  name: string
  completed?: boolean
  completed_at?: string | null
  created_at: string
  sort_order?: number
}

/** Legacy (v1) Task — old leaf; `milestone_id` may be null for a direct task. */
export interface LegacyTask extends SyncMeta {
  goal_id: string
  milestone_id: string | null
  name: string
  completed?: boolean
  completed_at?: string | null
  created_at: string
  sort_order?: number
}

/**
 * Legacy (v2) Task row — the pre-Phase-8 leaf: milestone-bound and checkbox-only,
 * with no goal_id/parent_id/progress_type/unit/target_value/current_value.
 * `sort_order` is required in practice but optional here so pre-Phase-3 rows
 * still normalize (falling back to created_at, mirroring `order()`).
 */
export interface LegacyV2Task extends SyncMeta {
  milestone_id: string
  name: string
  completed: boolean
  completed_at: string | null
  created_at: string
  sort_order?: number
}

export interface MigrateLegacyRowsInput {
  goals: LegacyGoal[]
  milestones: LegacyMilestone[]
  tasks: LegacyTask[]
}

export interface MigrateLegacyRowsResult {
  categories: Category[]
  goals: Goal[]
  milestones: Milestone[]
}

/** Order key matching lib/goal-order.ts effectiveOrder (sort_order, else created_at ms). */
function order(row: { sort_order?: number; created_at: string }): number {
  return row.sort_order ?? Date.parse(row.created_at)
}

/**
 * v2 Task → v3 Task default-fill (D-05). Pure: no Dexie, no browser globals.
 *
 * Every pre-Phase-8 task was milestone-bound and checkbox-only, so the new
 * fields take safe defaults: goal_id/parent_id null, progress_type 'checkbox',
 * quantity fields null. `id`/`updated_at`/`deleted_at`/`milestone_id` and the
 * rest are copied verbatim; `sort_order` only falls back when a legacy row
 * omitted it (all live v2 rows have it).
 *
 * NOTE: explicit object (no bare spread) because `LegacyV2Task.sort_order` is
 * optional while `Task.sort_order` is required.
 */
export function normalizeTaskV3(t: LegacyV2Task): Task {
  return {
    ...t,
    goal_id: null,
    parent_id: null,
    progress_type: 'checkbox',
    unit: null,
    target_value: null,
    current_value: null,
    sort_order: t.sort_order ?? Date.parse(t.created_at),
  }
}

/** Id of the synthesized 「未分组」 goal that hosts a legacy category's direct tasks. */
export function unfiledGoalId(categoryId: string): string {
  return `migrated-unfiled-${categoryId}`
}

/**
 * Map legacy v1 rows to the four-level v2 shape.
 *
 * Direct legacy tasks (`milestone_id === null`) have no parent milestone in the
 * new model, so each affected category gets ONE synthesized goal named
 * 「未分组」 that hosts them as milestones. It is created lazily: a category
 * with no direct tasks gains no extra goal.
 */
export function migrateLegacyRows(input: MigrateLegacyRowsInput): MigrateLegacyRowsResult {
  const categories: Category[] = input.goals.map((g) => ({
    id: g.id,
    name: g.name,
    created_at: g.created_at,
    sort_order: order(g),
    updated_at: g.updated_at,
    deleted_at: g.deleted_at,
  }))

  const goals: Goal[] = input.milestones.map((m) => ({
    id: m.id,
    category_id: m.goal_id,
    name: m.name,
    created_at: m.created_at,
    sort_order: order(m),
    updated_at: m.updated_at,
    deleted_at: m.deleted_at,
  }))

  const milestones: Milestone[] = input.tasks.map((t) => ({
    id: t.id,
    goal_id: t.milestone_id ?? unfiledGoalId(t.goal_id),
    name: t.name,
    created_at: t.created_at,
    sort_order: order(t),
    updated_at: t.updated_at,
    deleted_at: t.deleted_at,
  }))

  // Synthesize one 「未分组」 goal per category that actually has direct tasks.
  const directTaskCategories = new Set<string>()
  for (const t of input.tasks) {
    if (t.milestone_id === null) directTaskCategories.add(t.goal_id)
  }

  const nowIso = new Date().toISOString()
  for (const categoryId of directTaskCategories) {
    const siblings = goals.filter((g) => g.category_id === categoryId)
    goals.push({
      id: unfiledGoalId(categoryId),
      category_id: categoryId,
      name: '未分组',
      created_at: nowIso,
      // nextSortOrder falls back to Date.now()+1 on an empty list, so the value
      // is always finite (never -Infinity/NaN from Math.max of []).
      sort_order: nextSortOrder(siblings),
      updated_at: nowIso,
      deleted_at: null,
    })
  }

  return { categories, goals, milestones }
}
