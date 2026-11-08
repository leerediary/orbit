import { describe, expect, it } from 'vitest'
import {
  validateImportRows,
  validateJournalRelations,
} from '@/lib/entity-schema'
import type { JournalConflictCopy, JournalEntry } from '@/lib/types'

/**
 * Phase 10 / T-10-06: the journal layer's cross-row invariant. Pure (no
 * IndexedDB) — a hand-edited backup must be rejected BEFORE any write so the
 * "one row per local day" guarantee holds on both backends (Dexie throws on a
 * duplicate `&day_key`, SQLite `INSERT OR REPLACE` silently overwrites — the
 * validator must catch duplicates first so the two cannot diverge).
 *
 * The unique index applies to ALL rows, so a tombstoned row still occupies its
 * day (D-04 has no delete/re-create path).
 */

const UPDATED = '2026-01-02T00:00:00.000Z'

function journal(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: 'journal-2026-01-01',
    day_key: '2026-01-01',
    content: '第一篇日记',
    updated_at: UPDATED,
    deleted_at: null,
    ...overrides,
  }
}

describe('validateJournalRelations', () => {
  it('accepts an empty array', () => {
    expect(() => validateJournalRelations([])).not.toThrow()
  })

  it('accepts a single valid row whose content is the empty string', () => {
    expect(() => validateJournalRelations([journal({ content: '' })])).not.toThrow()
  })

  it('accepts one row per distinct day', () => {
    expect(() =>
      validateJournalRelations([
        journal({ id: 'a', day_key: '2026-01-01' }),
        journal({ id: 'b', day_key: '2026-01-02' }),
      ]),
    ).not.toThrow()
  })

  it('rejects two live rows sharing a day_key', () => {
    expect(() =>
      validateJournalRelations([
        journal({ id: 'a', day_key: '2026-01-01' }),
        journal({ id: 'b', day_key: '2026-01-01' }),
      ]),
    ).toThrow(/重复日期/)
  })

  it('rejects a live row and a tombstoned row sharing a day_key', () => {
    expect(() =>
      validateJournalRelations([
        journal({ id: 'live', day_key: '2026-01-01', deleted_at: null }),
        journal({
          id: 'tombstoned',
          day_key: '2026-01-01',
          deleted_at: '2026-02-01T00:00:00.000Z',
        }),
      ]),
    ).toThrow(/重复日期/)
  })

  it('rejects an impossible calendar day', () => {
    expect(() => validateJournalRelations([journal({ day_key: '2026-02-30' })])).toThrow(
      /必须为有效/,
    )
  })
})

describe('validateImportRows for journalEntries', () => {
  it('accepts a row whose content is the empty string', () => {
    expect(() => validateImportRows('journalEntries', [journal({ content: '' })])).not.toThrow()
  })

  it('rejects an unknown key', () => {
    expect(() =>
      validateImportRows('journalEntries', [{ ...journal(), injected_column: 'x' }]),
    ).toThrow(/未知字段/)
  })

  it('rejects a row missing content', () => {
    const { content: _content, ...withoutContent } = journal()
    expect(() => validateImportRows('journalEntries', [withoutContent])).toThrow(/缺少字段/)
  })

  it('rejects an empty day_key', () => {
    expect(() => validateImportRows('journalEntries', [journal({ day_key: '' })])).toThrow(
      /不能为空/,
    )
  })
})

describe('validateImportRows for journalEntries.conflict_copies', () => {
  function copy(overrides: Partial<JournalConflictCopy> = {}): JournalConflictCopy {
    return {
      content: '旧正文',
      at: '2026-01-01T00:00:00.000Z',
      device_id: 'device-a',
      ...overrides,
    }
  }

  it('accepts a legacy row without conflict_copies', () => {
    expect(() => validateImportRows('journalEntries', [journal()])).not.toThrow()
  })

  it('accepts a valid conflict-copy array', () => {
    expect(() =>
      validateImportRows('journalEntries', [
        journal({ conflict_copies: [copy(), copy({ content: '更旧', device_id: null })] }),
      ]),
    ).not.toThrow()
  })

  it('accepts an empty conflict-copy array', () => {
    expect(() =>
      validateImportRows('journalEntries', [journal({ conflict_copies: [] })]),
    ).not.toThrow()
  })

  it('rejects a non-array conflict_copies', () => {
    expect(() =>
      validateImportRows('journalEntries', [
        { ...journal(), conflict_copies: 'not-an-array' },
      ]),
    ).toThrow(/冲突副本数组/)
  })

  it('rejects an array of primitives', () => {
    expect(() =>
      validateImportRows('journalEntries', [
        { ...journal(), conflict_copies: ['nope'] },
      ]),
    ).toThrow(/必须是对象/)
  })

  it('rejects a non-string content', () => {
    expect(() =>
      validateImportRows('journalEntries', [
        journal({ conflict_copies: [{ ...copy(), content: 42 } as never] }),
      ]),
    ).toThrow(/content 必须是字符串/)
  })

  it('rejects an invalid at timestamp', () => {
    expect(() =>
      validateImportRows('journalEntries', [
        journal({ conflict_copies: [copy({ at: 'not-a-date' })] }),
      ]),
    ).toThrow(/at 必须是有效的 ISO 时间戳/)
  })

  it('rejects an unknown element key', () => {
    expect(() =>
      validateImportRows('journalEntries', [
        journal({ conflict_copies: [{ ...copy(), extra: 'x' } as never] }),
      ]),
    ).toThrow(/未知字段/)
  })

  it('rejects more than 20 copies', () => {
    const copies = Array.from({ length: 21 }, (_, i) =>
      copy({ content: `副本 ${i}`, at: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z` }),
    )
    expect(() =>
      validateImportRows('journalEntries', [journal({ conflict_copies: copies })]),
    ).toThrow(/不能超过 20 条/)
  })

  it('rejects an array whose serialized size exceeds 64 KiB', () => {
    const huge = 'x'.repeat(70000)
    expect(() =>
      validateImportRows('journalEntries', [journal({ conflict_copies: [copy({ content: huge })] })]),
    ).toThrow(/64 KiB/)
  })
})
