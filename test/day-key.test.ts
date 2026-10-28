import { describe, it, expect } from 'vitest'
import { dayKey, getTodayStr } from '@/lib/today'

// Tests run under TZ=UTC (pinned in vitest.config.ts), so dayKey's local
// fields == UTC fields and these expectations are deterministic.
describe('dayKey', () => {
  it('returns the local calendar day with no offset', () => {
    expect(dayKey('2026-06-05T02:00:00.000Z', 0)).toBe('2026-06-05')
    expect(dayKey('2026-06-05T23:30:00.000Z', 0)).toBe('2026-06-05')
  })

  it('shifts to the previous day when the hour is before DAY_OFFSET', () => {
    expect(dayKey('2026-06-05T02:00:00.000Z', 4)).toBe('2026-06-04')
    expect(dayKey('2026-06-05T03:59:00.000Z', 4)).toBe('2026-06-04')
  })

  it('does not shift at/after the DAY_OFFSET hour', () => {
    expect(dayKey('2026-06-05T04:00:00.000Z', 4)).toBe('2026-06-05')
    expect(dayKey('2026-06-05T02:00:00.000Z', 0)).toBe('2026-06-05')
  })

  it('rolls over month/year boundaries when shifting', () => {
    expect(dayKey('2026-06-01T01:00:00.000Z', 3)).toBe('2026-05-31')
    expect(dayKey('2026-01-01T00:30:00.000Z', 2)).toBe('2025-12-31')
  })
})

describe('getTodayStr', () => {
  it('returns a YYYY-MM-DD string', () => {
    expect(getTodayStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
