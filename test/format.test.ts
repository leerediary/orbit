import { describe, expect, it } from 'vitest'
import { formatProgressCount, formatValue } from '@/lib/format'

/**
 * Display formatting for progress numbers.
 *
 *  - formatProgressCount: integer → plain integer, else one decimal (the
 *    progress bar / "已完成 x / y" counter).
 *  - formatValue: integer → plain integer, else trimmed to at most two decimals
 *    with no trailing zeros (quantity current/target values).
 */

describe('formatProgressCount', () => {
  it('renders integers without a decimal point', () => {
    expect(formatProgressCount(3)).toBe('3')
  })

  it('renders fractions with one decimal', () => {
    expect(formatProgressCount(2.5)).toBe('2.5')
    expect(formatProgressCount(3.333)).toBe('3.3')
  })
})

describe('formatValue', () => {
  it('renders integers without a decimal point', () => {
    expect(formatValue(3)).toBe('3')
  })

  it('keeps up to two decimals', () => {
    expect(formatValue(3.14)).toBe('3.14')
    expect(formatValue(3.146)).toBe('3.15')
  })

  it('trims trailing zeros', () => {
    expect(formatValue(3.1)).toBe('3.1')
    expect(formatValue(3.100)).toBe('3.1')
    expect(formatValue(3.0)).toBe('3')
  })
})
