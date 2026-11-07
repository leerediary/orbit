import { describe, expect, it } from 'vitest'
import {
  deriveSyncStatus,
  formatSyncAbsolute,
  formatSyncRelative,
} from '@/lib/sync-time'

/**
 * Phase 18 / plan 18-04 — the pure UI-facing sync time formatters and the
 * four-state derivation. Runs under TZ=UTC (pinned in vitest.config.ts), so the
 * `Date` local fields equal the UTC fields and the absolute-time expectations
 * are deterministic.
 */

const NOW = Date.UTC(2026, 10, 2, 15, 0, 0) // 2026-11-02T15:00:00Z
const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

describe('formatSyncRelative', () => {
  it('uses the exact 刚刚 / 分钟前 / 小时前 / 天前 boundaries', () => {
    expect(formatSyncRelative(NOW, NOW)).toBe('刚刚')
    expect(formatSyncRelative(NOW - 59_000, NOW)).toBe('刚刚')
    expect(formatSyncRelative(NOW - MINUTE, NOW)).toBe('1 分钟前')
    expect(formatSyncRelative(NOW - 59 * MINUTE, NOW)).toBe('59 分钟前')
    expect(formatSyncRelative(NOW - HOUR, NOW)).toBe('1 小时前')
    expect(formatSyncRelative(NOW - 23 * HOUR, NOW)).toBe('23 小时前')
    expect(formatSyncRelative(NOW - DAY, NOW)).toBe('1 天前')
    expect(formatSyncRelative(NOW - 3 * DAY, NOW)).toBe('3 天前')
  })

  it('clamps a future timestamp to 刚刚', () => {
    expect(formatSyncRelative(NOW + 10 * MINUTE, NOW)).toBe('刚刚')
  })
})

describe('formatSyncAbsolute', () => {
  it('formats the same calendar day as HH:mm with two-digit padding', () => {
    expect(formatSyncAbsolute(Date.UTC(2026, 10, 2, 14, 5), NOW)).toBe('上次同步 14:05')
    expect(formatSyncAbsolute(Date.UTC(2026, 10, 2, 9, 0), NOW)).toBe('上次同步 09:00')
  })

  it('formats the previous calendar day with 昨天', () => {
    expect(formatSyncAbsolute(Date.UTC(2026, 10, 1, 9, 30), NOW)).toBe('上次同步 昨天 09:30')
  })

  it('formats older days as M月D日 without zero padding', () => {
    expect(formatSyncAbsolute(Date.UTC(2026, 9, 31, 14, 32), NOW)).toBe(
      '上次同步 10月31日 14:32',
    )
  })
})

describe('deriveSyncStatus', () => {
  it('returns offline even when the outbox has rows', () => {
    expect(
      deriveSyncStatus({ online: false, outboxCount: 3, lastSyncedAt: Date.now() }),
    ).toBe('offline')
  })

  it('returns pending when online and the outbox is non-empty', () => {
    expect(deriveSyncStatus({ online: true, outboxCount: 2, lastSyncedAt: null })).toBe(
      'pending',
    )
  })

  it('returns synced when online, empty outbox, and a last-sync time exists', () => {
    expect(
      deriveSyncStatus({ online: true, outboxCount: 0, lastSyncedAt: Date.now() }),
    ).toBe('synced')
  })

  it('returns never when online, empty outbox, and no last-sync time', () => {
    expect(deriveSyncStatus({ online: true, outboxCount: 0, lastSyncedAt: null })).toBe(
      'never',
    )
  })
})
