import { describe, it, expect } from 'vitest'
import {
  shiftDayKey,
  isValidDayKey,
  journalDayLabel,
  formatSavedTime,
} from '@/lib/journal'

// Tests run under TZ=UTC (pinned in vitest.config.ts). shiftDayKey/isValidDayKey
// use Date.UTC/getUTC* only, so these expectations are deterministic.

describe('shiftDayKey', () => {
  it('steps forward within a month', () => {
    expect(shiftDayKey('2026-10-30', 1)).toBe('2026-10-31')
  })

  it('rolls over a month end', () => {
    expect(shiftDayKey('2026-10-31', 1)).toBe('2026-11-01')
  })

  it('rolls over a year end in both directions', () => {
    expect(shiftDayKey('2025-12-31', 1)).toBe('2026-01-01')
    expect(shiftDayKey('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('handles leap-day boundaries', () => {
    expect(shiftDayKey('2024-02-28', 1)).toBe('2024-02-29')
    expect(shiftDayKey('2024-03-01', -1)).toBe('2024-02-29')
  })

  it('skips Feb 29 in a non-leap year', () => {
    expect(shiftDayKey('2025-02-28', 1)).toBe('2025-03-01')
  })

  it('supports deltas larger than one day', () => {
    expect(shiftDayKey('2026-10-30', 3)).toBe('2026-11-02')
    expect(shiftDayKey('2026-10-30', -40)).toBe('2026-09-20')
  })
})

describe('isValidDayKey', () => {
  it('accepts real calendar dates', () => {
    expect(isValidDayKey('2026-10-30')).toBe(true)
    expect(isValidDayKey('2024-02-29')).toBe(true)
  })

  it('rejects impossible calendar dates', () => {
    expect(isValidDayKey('2026-02-30')).toBe(false)
    expect(isValidDayKey('2025-02-29')).toBe(false)
    expect(isValidDayKey('2026-13-01')).toBe(false)
    expect(isValidDayKey('2026-00-10')).toBe(false)
    expect(isValidDayKey('2026-04-31')).toBe(false)
  })

  it('rejects malformed shapes', () => {
    expect(isValidDayKey('2026-1-1')).toBe(false)
    expect(isValidDayKey('2026/10/30')).toBe(false)
    expect(isValidDayKey('')).toBe(false)
  })

  it('returns false for non-string input instead of throwing', () => {
    expect(isValidDayKey(null as unknown as string)).toBe(false)
    expect(isValidDayKey(undefined as unknown as string)).toBe(false)
    expect(isValidDayKey(20261030 as unknown as string)).toBe(false)
  })
})

describe('journalDayLabel', () => {
  it('labels today with 今天 and the absolute date', () => {
    expect(journalDayLabel('2026-10-30', '2026-10-30')).toBe('今天 · 10月30日')
  })

  it('labels yesterday with 昨天, including across a month end', () => {
    expect(journalDayLabel('2026-10-29', '2026-10-30')).toBe('昨天 · 10月29日')
    expect(journalDayLabel('2026-03-01', '2026-03-02')).toBe('昨天 · 3月1日')
  })

  it('labels older same-year days without 今天/昨天', () => {
    expect(journalDayLabel('2026-10-05', '2026-10-30')).toBe('10月5日')
    expect(journalDayLabel('2026-01-05', '2026-10-30')).toBe('1月5日')
  })

  it('prefixes the year for older days in a different year', () => {
    expect(journalDayLabel('2025-12-31', '2026-10-30')).toBe('2025年12月31日')
    expect(journalDayLabel('2025-01-05', '2026-10-30')).toBe('2025年1月5日')
  })

  it('keeps the yesterday label across a year boundary', () => {
    expect(journalDayLabel('2025-12-31', '2026-01-01')).toBe('昨天 · 12月31日')
  })
})

describe('formatSavedTime', () => {
  it('formats a saved timestamp as device-local HH:mm under TZ=UTC', () => {
    expect(formatSavedTime('2026-10-30T14:32:00.000Z')).toBe('14:32')
  })

  it('zero-pads hours and minutes', () => {
    expect(formatSavedTime('2026-10-30T09:05:00.000Z')).toBe('09:05')
    expect(formatSavedTime('2026-10-30T00:00:00.000Z')).toBe('00:00')
  })

  it('returns an empty string for unparseable input', () => {
    expect(formatSavedTime('not-a-date')).toBe('')
    expect(formatSavedTime('')).toBe('')
  })
})
