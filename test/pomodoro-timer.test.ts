import { describe, expect, it } from 'vitest'
import {
  BREAK_KEY,
  DEFAULT_BREAK_SEC,
  DURATION_KEYS,
  MAX_BREAK_SEC,
  MIN_BREAK_SEC,
  clampBreakSec,
  formatMmss,
} from '@/lib/pomodoro-timer'

/**
 * Quick task 261101-e27 — pure-helper contract for the shared pomodoro timer.
 *
 * The provider itself is React + browser state and is exercised manually in the
 * UI (vitest runs in the `node` environment with no DOM). These tests pin the
 * deterministic surface: MM:SS formatting, break-time clamping, and the
 * localStorage key/constant contract the provider and view share.
 */

describe('formatMmss', () => {
  it('formats zero as 00:00', () => {
    expect(formatMmss(0)).toBe('00:00')
  })

  it('zero-pads both sides', () => {
    expect(formatMmss(59)).toBe('00:59')
    expect(formatMmss(65)).toBe('01:05')
  })

  it('supports minute values of 60 and above', () => {
    expect(formatMmss(3599)).toBe('59:59')
    expect(formatMmss(3600)).toBe('60:00')
  })

  it('clamps negative input to 00:00', () => {
    expect(formatMmss(-5)).toBe('00:00')
  })
})

describe('clampBreakSec', () => {
  it('adds a minute above the default', () => {
    expect(clampBreakSec(300, 1)).toBe(360)
  })

  it('never drops below one minute', () => {
    expect(clampBreakSec(60, -1)).toBe(60)
  })

  it('never exceeds sixty minutes', () => {
    expect(clampBreakSec(3600, 1)).toBe(3600)
  })

  it('returns the same value for a zero delta', () => {
    expect(clampBreakSec(300, 0)).toBe(300)
  })
})

describe('timer constants', () => {
  it('uses the documented break bounds', () => {
    expect(DEFAULT_BREAK_SEC).toBe(300)
    expect(MIN_BREAK_SEC).toBe(60)
    expect(MAX_BREAK_SEC).toBe(3600)
  })

  it('uses the documented localStorage keys', () => {
    expect(DURATION_KEYS.tomato).toBe('orbit_pomodoro_duration_min')
    expect(DURATION_KEYS.cherry).toBe('orbit_pomodoro_cherry_duration_min')
    expect(BREAK_KEY).toBe('orbit_pomodoro_break_duration_sec')
  })
})
