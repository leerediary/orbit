import { describe, expect, it } from 'vitest'
import { addedAgeLabel, dayDiff } from '@/lib/today'

/**
 * D-02 ladder contract (09-UI-SPEC §6). Tests run under TZ=UTC, so the
 * instant → logical-day mapping is deterministic.
 */

describe('dayDiff', () => {
  it('counts whole calendar days forward', () => {
    expect(dayDiff('2026-06-09', '2026-06-10')).toBe(1)
    expect(dayDiff('2026-06-01', '2026-06-30')).toBe(29)
  })

  it('handles month and year rollovers', () => {
    expect(dayDiff('2026-05-31', '2026-06-01')).toBe(1)
    expect(dayDiff('2025-12-31', '2026-01-01')).toBe(1)
    expect(dayDiff('2025-12-31', '2026-01-10')).toBe(10)
  })

  it('is zero for the same day and negative going backwards', () => {
    expect(dayDiff('2026-06-10', '2026-06-10')).toBe(0)
    expect(dayDiff('2026-06-11', '2026-06-10')).toBe(-1)
  })
})

describe('addedAgeLabel', () => {
  it('returns null for an entry added today', () => {
    expect(addedAgeLabel('2026-06-10T08:00:00.000Z', '2026-06-10')).toBeNull()
  })

  it('returns null for a clock-skewed future entry', () => {
    expect(addedAgeLabel('2026-06-11T08:00:00.000Z', '2026-06-10')).toBeNull()
  })

  it("returns '昨天' for a one-day-old entry", () => {
    expect(addedAgeLabel('2026-06-09T08:00:00.000Z', '2026-06-10')).toBe('昨天')
  })

  it('uses Chinese numerals across the 2–7 day ladder', () => {
    expect(addedAgeLabel('2026-06-08T08:00:00.000Z', '2026-06-10')).toBe('两天前')
    expect(addedAgeLabel('2026-06-07T08:00:00.000Z', '2026-06-10')).toBe('三天前')
    expect(addedAgeLabel('2026-06-06T08:00:00.000Z', '2026-06-10')).toBe('四天前')
    expect(addedAgeLabel('2026-06-05T08:00:00.000Z', '2026-06-10')).toBe('五天前')
    expect(addedAgeLabel('2026-06-04T08:00:00.000Z', '2026-06-10')).toBe('六天前')
    expect(addedAgeLabel('2026-06-03T08:00:00.000Z', '2026-06-10')).toBe('七天前')
  })

  it('switches to the unpadded date at 8 days in the same year', () => {
    expect(addedAgeLabel('2026-06-02T08:00:00.000Z', '2026-06-10')).toBe('6月2日')
  })

  it('prefixes the year when the added date is from another year', () => {
    expect(addedAgeLabel('2025-12-31T08:00:00.000Z', '2026-01-10')).toBe('2025年12月31日')
  })

  it('honors the day-start offset when resolving the added logical day', () => {
    // 02:00 with DAY_OFFSET=4 belongs to the PREVIOUS logical day.
    expect(addedAgeLabel('2026-06-05T02:00:00.000Z', '2026-06-05', 4)).toBe('昨天')
    expect(addedAgeLabel('2026-06-05T02:00:00.000Z', '2026-06-05', 0)).toBeNull()
  })
})
