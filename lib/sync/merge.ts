// Phase 19 / MERGE-03 — pure field-merge policy shared by the client apply
// path and the server merge. Dependency-free: no React, Dexie, or browser
// globals. server/src/merge.ts is a byte-equivalent mirror asserted by the
// root parity test.

export interface ConflictCopy {
  content: string
  at: string
  device_id: string | null
}

/** Hard cap on the number of retained conflict copies per journal row. */
export const MAX_CONFLICT_COPIES = 20

/**
 * Hard cap on the serialized copy array. The server rejects rows over
 * MAX_PAYLOAD_BYTES (256 KiB); an unbounded history of long bodies would make
 * the row permanently un-syncable.
 */
export const MAX_CONFLICT_COPY_BYTES = 65536

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Deterministic, bounded conflict-copy list.
 *
 * Drops empty content and any content identical to the primary body, dedupes
 * by exact content, sorts by (at asc, content asc), keeps the newest
 * MAX_CONFLICT_COPIES, then drops the oldest entries until the serialized
 * array fits MAX_CONFLICT_COPY_BYTES.
 *
 * Sorting happens BEFORE dedupe so the result is a pure function of the input
 * multiset (order-independent): duplicate content with different `at` values
 * always resolves to the earliest one.
 */
export function canonicalCopies(
  copies: readonly ConflictCopy[],
  primary?: string,
): ConflictCopy[] {
  const sorted = copies
    .filter((c) => typeof c.content === 'string' && c.content !== '' && c.content !== primary)
    .slice()
    .sort((a, b) => {
      if (a.at !== b.at) return compareStrings(a.at, b.at)
      if (a.content !== b.content) return compareStrings(a.content, b.content)
      return compareStrings(a.device_id ?? '', b.device_id ?? '')
    })

  const seen = new Set<string>()
  const deduped: ConflictCopy[] = []
  for (const c of sorted) {
    if (seen.has(c.content)) continue
    seen.add(c.content)
    deduped.push({ content: c.content, at: c.at, device_id: c.device_id })
  }

  let result = deduped.slice(-MAX_CONFLICT_COPIES)
  while (
    result.length > 0 &&
    new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_CONFLICT_COPY_BYTES
  ) {
    result = result.slice(1)
  }
  return result
}

/**
 * Max merge for quantity progress (locked D-01). `current_value` is an
 * absolute value, not a delta, so the greater finite value never loses
 * progress. null / undefined / non-finite count as 0.
 */
export function mergeQuantity(
  a: number | null | undefined,
  b: number | null | undefined,
): number {
  const av = typeof a === 'number' && Number.isFinite(a) ? a : 0
  const bv = typeof b === 'number' && Number.isFinite(b) ? b : 0
  return Math.max(av, bv)
}

export interface JournalBody {
  content: string
  updated_at: string
  device_id?: string | null
  conflict_copies?: readonly ConflictCopy[]
}

export interface JournalMergeResult {
  content: string
  conflict_copies: ConflictCopy[]
}

/**
 * Keep the winner's body and retain the loser's body as a conflict copy
 * (D-02). Both sides' existing copies are carried forward, deduped, and
 * recanonicalized so the merge is idempotent and order-independent.
 */
export function mergeJournalBodies(winner: JournalBody, loser: JournalBody): JournalMergeResult {
  return {
    content: winner.content,
    conflict_copies: canonicalCopies(
      [
        ...(winner.conflict_copies ?? []),
        ...(loser.conflict_copies ?? []),
        { content: loser.content, at: loser.updated_at, device_id: loser.device_id ?? null },
      ],
      winner.content,
    ),
  }
}

/**
 * Habit-completion natural-key merge: keep the base row's identity and fields,
 * but preserve a note from either side, the FIRST check time (min
 * completed_at), and the LATEST write time (max updated_at).
 */
export function mergeHabitCompletion<
  T extends { note: string | null; completed_at: string; updated_at: string },
>(base: T, other: T): T {
  return {
    ...base,
    note: base.note ?? other.note,
    completed_at: base.completed_at < other.completed_at ? base.completed_at : other.completed_at,
    updated_at: base.updated_at > other.updated_at ? base.updated_at : other.updated_at,
  }
}

/**
 * Daily-todo natural-key merge: keep the base row's identity, fill missing
 * fields from the other row, and take the latest write time.
 */
export function mergeDailyTodo<
  T extends { name: string | null; completed: boolean | null; completed_at: string | null; updated_at: string },
>(base: T, other: T): T {
  return {
    ...base,
    name: base.name ?? other.name,
    completed: base.completed ?? other.completed,
    completed_at: base.completed_at ?? other.completed_at,
    updated_at: base.updated_at > other.updated_at ? base.updated_at : other.updated_at,
  }
}
