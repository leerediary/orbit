/**
 * Pure display formatting for progress numbers. No React, no repository, no
 * browser globals — unit-testable in isolation.
 */

/**
 * Progress counter formatter: integers stay integers, fractions show one
 * decimal (e.g. "2.5" for a 3-leaf scope with 2.5 leaves' worth done).
 */
export function formatProgressCount(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

/**
 * Quantity value formatter: integers stay integers; otherwise trim to at most
 * two decimals with no trailing zeros (e.g. 3.10 → "3.1").
 */
export function formatValue(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)))
}
