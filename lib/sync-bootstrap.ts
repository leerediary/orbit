/**
 * First-sync bootstrap state machine (Phase 20 / BOOT-02).
 *
 * This module is deliberately domain-pure: no React, Dexie, fetch, window,
 * document, or storage access. Every decision is a function of the values passed
 * in, so the branch truth table is unit-testable without a browser or database.
 *
 * The one invariant that matters most: a failed read is ALWAYS `ERROR`. A
 * local throw or a server 401 / 5xx / network / malformed response must never
 * collapse into "zero rows", because that would offer "download the cloud
 * dataset" and replace a device's real data with nothing (T-20-02).
 */

import { EXPORT_ENTITIES } from '@/lib/data-export'
import type { SyncEntity } from '@/lib/sync-entities'

export { needsBootstrap } from '@/lib/sync-store'

/** Live row counts per entity, for one side of a bootstrap read. */
export type BootstrapCounts = Record<SyncEntity, number>

/** A successful read of both sides, or a typed failure that names its side. */
export type BootstrapRead =
  | { ok: true; local: BootstrapCounts; server: BootstrapCounts }
  | {
      ok: false
      where: 'local' | 'server'
      reason: 'auth' | 'network' | 'server' | 'malformed' | 'local-throw'
    }

/** The classified device state. ERROR carries the failing read, nothing else. */
export type BootstrapBranch =
  | { kind: 'A'; localLive: number }
  | { kind: 'B'; serverLive: number }
  | { kind: 'C'; localLive: number; serverLive: number }
  | { kind: 'D' }
  | { kind: 'ERROR'; read: Extract<BootstrapRead, { ok: false }> }

/** Ordered entity list for count tables — mirrors the export contract. */
export const ENTITY_ORDER: readonly SyncEntity[] = EXPORT_ENTITIES

/** The locked Chinese labels, in EXPORT_ENTITIES order (20-UI-SPEC). */
export const ENTITY_LABELS: Record<SyncEntity, string> = {
  categories: '分类',
  goals: '目标',
  milestones: '里程碑',
  tasks: '任务',
  dailyTodos: '今日待办',
  journalEntries: '日记',
  habits: '习惯',
  habitCompletions: '打卡',
  pomodoroSessions: '番茄',
}

/**
 * Classify a device from a read result.
 *
 * Order matters: any `ok: false` short-circuits to ERROR BEFORE counts are
 * examined, so a partial/failed read can never be interpreted as empty data.
 */
export function detectBranch(read: BootstrapRead): BootstrapBranch {
  if (!read.ok) return { kind: 'ERROR', read }

  const localLive = totalCounts(read.local)
  const serverLive = totalCounts(read.server)

  if (localLive === 0 && serverLive === 0) return { kind: 'D' }
  if (localLive > 0 && serverLive === 0) return { kind: 'A', localLive }
  if (localLive === 0 && serverLive > 0) return { kind: 'B', serverLive }
  return { kind: 'C', localLive, serverLive }
}

/** Sum live counts across all nine entities. */
export function totalCounts(counts: BootstrapCounts): number {
  let total = 0
  for (const entity of ENTITY_ORDER) total += counts[entity]
  return total
}

/**
 * Server ids absent locally, in server order. Used by "use local" to purge the
 * rows only the cloud has (the manifest is the source, not a full pull).
 */
export function serverOnlyIds(
  serverIds: readonly string[],
  localIds: readonly string[],
): string[] {
  const local = new Set(localIds)
  return serverIds.filter((id) => !local.has(id))
}

/** Branch C choices. Keep-both is the default and is never destructive. */
export type BootstrapChoice = 'keep-both' | 'use-local' | 'use-cloud'

/** Both destructive C choices require a second confirmation screen. */
export function requiresSecondConfirm(choice: BootstrapChoice): boolean {
  return choice === 'use-local' || choice === 'use-cloud'
}
