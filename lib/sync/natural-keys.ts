// Phase 19 / MERGE-02 (D-04) — client-owned SOFT natural-key projection.
//
// `habitCompletions` and `dailyTodos` have no database uniqueness constraint
// (habit uniqueness is live-only and validator-owned; a linked daily todo has
// no index), so only the client can notice that two different ids describe the
// SAME logical row. This module detects those duplicates, merges the loser's
// fields into a deterministic base, tombstones the loser, and queues one
// ordinary `delete` intent per loser. No server change is needed: tombstones
// travel through the existing LWW push path and converge both devices.
//
// Browser-side module: no React, no browser global at import time, and no
// Dexie access until `reconcileNaturalKeys` is called.

import type { OrbitDB } from '@/lib/local-db'
import type { SyncEntity } from '@/lib/sync-entities'
import type { DailyTodo, HabitCompletion } from '@/lib/types'
import { enqueueOutbox } from '@/lib/outbox'
import { mergeDailyTodo, mergeHabitCompletion } from '@/lib/sync/merge'

/** The slice of a sync row `naturalKeyOf` needs; values are untrusted at runtime. */
export interface NaturalKeyRow {
  deleted_at: string | null
  habit_id?: unknown
  date?: unknown
  task_id?: unknown
}

type LiveSyncRow = NaturalKeyRow & { id: string; updated_at: string }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * The soft natural key of a live row, or null.
 *
 * - `habitCompletions` → `habit_id::date` (only when live and both fields are
 *   present strings).
 * - `dailyTodos` → `task:<task_id>` (only when live and `task_id` is a
 *   non-empty string; standalone todos have no natural key).
 * - Every other entity → null.
 *
 * Tombstones never carry a natural key: a dead row must not be grouped with a
 * live one, otherwise re-checking would merge into a deleted row.
 */
export function naturalKeyOf(entity: SyncEntity, row: NaturalKeyRow): string | null {
  if (row.deleted_at != null) return null

  if (entity === 'habitCompletions') {
    if (!isNonEmptyString(row.habit_id) || typeof row.date !== 'string') return null
    return `${row.habit_id}::${row.date}`
  }

  if (entity === 'dailyTodos') {
    if (!isNonEmptyString(row.task_id)) return null
    return `task:${row.task_id}`
  }

  return null
}

/**
 * Deterministic base = the greatest `(updated_at, id)` lexicographic pair.
 *
 * Deliberately excludes wall clock and `device_id`: both devices hold the same
 * duplicate rows after a pull, so this max is identical everywhere and does not
 * depend on iteration or arrival order (T-19-01). `reduce` makes it a genuine
 * max — commutative and associative — so input order is irrelevant.
 */
function selectBase<T extends { id: string; updated_at: string }>(rows: readonly T[]): T {
  return rows.reduce((best, row) => {
    if (row.updated_at !== best.updated_at) return row.updated_at > best.updated_at ? row : best
    return row.id > best.id ? row : best
  })
}

/**
 * Group live rows by natural key. Returns only keys whose live count is > 1 —
 * the caller never sees singletons or tombstones.
 */
function groupDuplicates<T extends LiveSyncRow>(
  entity: SyncEntity,
  rows: readonly T[],
): T[][] {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const key = naturalKeyOf(entity, row)
    if (key === null) continue
    const existing = groups.get(key)
    if (existing) existing.push(row)
    else groups.set(key, [row])
  }
  return [...groups.values()].filter((group) => group.length > 1)
}

/** Losers in a stable id order so multi-row field merges are order-independent. */
function losersOf<T extends { id: string }>(rows: readonly T[], base: T): T[] {
  return rows
    .filter((row) => row.id !== base.id)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Tombstone every loser and enqueue exactly one delete intent per loser, all in
 * the caller's active transaction. `deleted_at == updated_at` matches the
 * existing soft-delete contract so the tombstone wins its own key.
 */
async function tombstoneLosers(
  d: OrbitDB,
  entity: 'habitCompletions' | 'dailyTodos',
  losers: readonly (HabitCompletion | DailyTodo)[],
  stamp: string,
): Promise<number> {
  const table = d.table<HabitCompletion | DailyTodo, string>(entity)
  for (const loser of losers) {
    const tombstone = { ...loser, deleted_at: stamp, updated_at: stamp }
    await table.put(tombstone)
    await enqueueOutbox(d, {
      entity,
      row_id: loser.id,
      op: 'delete',
      updated_at: stamp,
    })
  }
  return losers.length
}

/**
 * Merge duplicate live rows that share a soft natural key.
 *
 * One `rw` transaction over the two tables plus `syncOutbox`, so a crash can
 * never leave a loser tombstoned without its queued delete. Returns the number
 * of tombstones enqueued (0 on every run after the first).
 *
 * Relation validators are intentionally NOT run: tombstoning a losing linked
 * daily todo can leave a pomodoro pointing at it, and render-time orphan
 * filtering already tolerates dangling ids (Landmine 7).
 */
export async function reconcileNaturalKeys(
  d: OrbitDB,
  nowIso: () => string = () => new Date().toISOString(),
): Promise<number> {
  let tombstoned = 0

  await d.transaction('rw', [d.habitCompletions, d.dailyTodos, d.syncOutbox], async () => {
    const stamp = nowIso()

    for (const group of groupDuplicates('habitCompletions', await d.habitCompletions.toArray())) {
      const base = selectBase(group)
      const losers = losersOf(group, base)
      const merged = losers.reduce<HabitCompletion>(
        (acc, other) => mergeHabitCompletion(acc, other),
        base,
      )
      if (JSON.stringify(merged) !== JSON.stringify(base)) {
        await d.habitCompletions.put({ ...merged, updated_at: stamp })
        await enqueueOutbox(d, {
          entity: 'habitCompletions',
          row_id: merged.id,
          op: 'upsert',
          updated_at: stamp,
        })
      }
      tombstoned += await tombstoneLosers(d, 'habitCompletions', losers, stamp)
    }

    for (const group of groupDuplicates('dailyTodos', await d.dailyTodos.toArray())) {
      const base = selectBase(group)
      const losers = losersOf(group, base)
      const merged = losers.reduce<DailyTodo>((acc, other) => mergeDailyTodo(acc, other), base)
      if (JSON.stringify(merged) !== JSON.stringify(base)) {
        await d.dailyTodos.put({ ...merged, updated_at: stamp })
        await enqueueOutbox(d, {
          entity: 'dailyTodos',
          row_id: merged.id,
          op: 'upsert',
          updated_at: stamp,
        })
      }
      tombstoned += await tombstoneLosers(d, 'dailyTodos', losers, stamp)
    }
  })

  return tombstoned
}
