import { describe, expect, it } from 'vitest'
import {
  MAX_TOC_LINES,
  buildImportPayload,
  computeChapters,
  findExistingMilestone,
  parseToc,
  parseTocTree,
} from '@/lib/book-import'
import type { TocRow } from '@/lib/book-import'

/**
 * 书籍目录解析与页数推导契约（D-01 / D-02 / D-03 / D-04）。
 *
 *  - 每行 = 章节名 + 行末阿拉伯起始页；前缀原样保留，不剥离、不重编号。
 *  - 章页数 = 下一个带起始页的章 − 本章起始页；末章 = 全书总页数 − 末章起始页 + 1。
 *  - 缺起始页按 1 页计（missing-start，警告）；非递增标记在后一行（not-increasing，阻断）。
 */

const ROW = (name: string, startPage: number | null): TocRow => ({ name, startPage })

describe('parseToc', () => {
  it('splits each line into chapter name and trailing Arabic start page (D-01)', () => {
    expect(parseToc('第1章 绪论 1')).toEqual([{ name: '第1章 绪论', startPage: 1 }])
  })

  it('keeps Chapter N / N. prefixes verbatim (D-04)', () => {
    expect(parseToc('Chapter 2 The Beginning 25')).toEqual([
      { name: 'Chapter 2 The Beginning', startPage: 25 },
    ])
    expect(parseToc('3. 文明的起点 40')).toEqual([
      { name: '3. 文明的起点', startPage: 40 },
    ])
  })

  it('handles CRLF and skips blank lines', () => {
    const text = '第1章 绪论 1\r\n\r\n第2章 文明的起点 25\r\n'
    expect(parseToc(text)).toEqual([
      { name: '第1章 绪论', startPage: 1 },
      { name: '第2章 文明的起点', startPage: 25 },
    ])
  })

  it('marks a line without a trailing number as missing its start page', () => {
    expect(parseToc('第4章 尾声')).toEqual([{ name: '第4章 尾声', startPage: null }])
  })

  it('falls back to the whole line when a line is only digits', () => {
    expect(parseToc('25')).toEqual([{ name: '25', startPage: null }])
  })

  it('treats a range as the trailing integer only (range syntax is not special-cased)', () => {
    const [row] = parseToc('第3章 1-20')
    expect(row.startPage).toBe(20)
    expect(row.name).toBe('第3章 1-')
  })

  it('returns an empty array for empty input', () => {
    expect(parseToc('')).toEqual([])
  })

  it('truncates input beyond MAX_TOC_LINES', () => {
    const lines = Array.from({ length: 600 }, (_, i) => `第${i + 1}章 ${i + 1}`)
    const rows = parseToc(lines.join('\n'))
    expect(rows).toHaveLength(MAX_TOC_LINES)
    expect(rows).toHaveLength(500)
  })
})

describe('computeChapters', () => {
  it('derives middle chapter pages as the next start page minus this start (D-02)', () => {
    const summary = computeChapters(
      [ROW('第1章', 1), ROW('第2章', 25), ROW('第3章', 60)],
      200,
    )
    expect(summary.rows.map((r) => r.pages)).toEqual([24, 35, 141])
    expect(summary.rows.map((r) => r.issue)).toEqual([null, null, null])
    expect(summary.warningCount).toBe(0)
    expect(summary.blockers).toBe(0)
    expect(summary.totalPagesError).toBeNull()
  })

  it('derives the last chapter as totalPages - lastStart + 1 (D-02)', () => {
    const summary = computeChapters([ROW('末章', 100)], 440)
    expect(summary.rows[0].pages).toBe(341)
  })

  it('counts a missing start page as 1 page with a non-blocking warning (D-03)', () => {
    const summary = computeChapters(
      [ROW('a', 1), ROW('b', null), ROW('c', 25), ROW('d', null)],
      100,
    )
    const missing = summary.rows[1]
    expect(missing.pages).toBe(1)
    expect(missing.issue).toBe('missing-start')
    expect(summary.rows[3].pages).toBe(1)
    expect(summary.rows[3].issue).toBe('missing-start')
    expect(summary.warningCount).toBe(2)
    expect(summary.blockers).toBe(0)
  })

  it('flags the later row when start pages are not increasing', () => {
    const summary = computeChapters([ROW('a', 10), ROW('b', 5)], 100)
    expect(summary.rows[0].issue).toBeNull()
    expect(summary.rows[0].pages).toBe(-5)
    expect(summary.rows[1].issue).toBe('not-increasing')
    expect(summary.blockers).toBe(1)
  })

  it('reports totalPagesError when the last chapter starts beyond totalPages', () => {
    const summary = computeChapters([ROW('末章', 500)], 440)
    expect(summary.totalPagesError).toBe('末章结束页不能小于最后一章的起始页')
    expect(summary.blockers).toBe(0)
  })

  it('returns empty rows and a clean summary for empty input', () => {
    expect(computeChapters([], 200)).toEqual({
      rows: [],
      warningCount: 0,
      blockers: 0,
      totalPagesError: null,
    })
  })

  it('reports totalPagesError when totalPages is not a positive integer', () => {
    const summary = computeChapters([ROW('末章', 100)], 0)
    expect(summary.totalPagesError).toBe('请填写末章结束页')
    expect(summary.rows[0].pages).toBe(0)
  })

  it('count mode reads each trailing number as the chapter count directly', () => {
    const summary = computeChapters(
      [ROW('第1章 绪论', 12), ROW('第2章 背景', 30), ROW('第3章 后记', null)],
      0,
      'count',
    )
    expect(summary.rows.map((r) => r.pages)).toEqual([12, 30, 1])
    expect(summary.rows.map((r) => r.issue)).toEqual([null, null, 'missing-start'])
    expect(summary.warningCount).toBe(1)
    expect(summary.blockers).toBe(0)
    expect(summary.totalPagesError).toBeNull()
  })
})

describe('buildImportPayload', () => {
  it('trims names and derives stable node ids from the key', () => {
    const payload = buildImportPayload(
      ' 人类简史 ',
      [{ key: 'k1', name: ' 第1章 绪论 ', pages: 24, parentKey: null }],
      'book-1',
    )
    expect(payload).toEqual({
      bookId: 'book-1',
      bookName: '人类简史',
      unit: '页',
      nodes: [{ id: 'k1', parentId: null, name: '第1章 绪论', pages: 24 }],
    })
  })

  it('is deterministic so a retry is an idempotent upsert', () => {
    const input = [{ key: 'k1', name: '第1章 绪论', pages: 24, parentKey: null }]
    const first = buildImportPayload('人类简史', input, 'book-1')
    const second = buildImportPayload('人类简史', [...input], 'book-1')
    expect(second).toEqual(first)
  })

  it('carries a custom unit, defaulting to 页 and falling back on empty/whitespace', () => {
    const input = [{ key: 'k1', name: '第1章 绪论', pages: 24, parentKey: null }]
    expect(buildImportPayload('书', input, 'b1', '分钟').unit).toBe('分钟')
    expect(buildImportPayload('书', input, 'b1').unit).toBe('页')
    expect(buildImportPayload('书', input, 'b1', '   ').unit).toBe('页')
  })

  it('preserves parent links for a multi-level tree (container + leaf)', () => {
    const payload = buildImportPayload(
      '异乡人',
      [
        { key: 'p1', name: 'Première partie', pages: null, parentKey: null },
        { key: 'c1', name: 'I', pages: 55, parentKey: 'p1' },
        { key: 'c2', name: 'II', pages: 23, parentKey: 'p1' },
      ],
      'book-1',
      '行',
    )
    expect(payload.nodes).toEqual([
      { id: 'p1', parentId: null, name: 'Première partie', pages: null },
      { id: 'c1', parentId: 'p1', name: 'I', pages: 55 },
      { id: 'c2', parentId: 'p1', name: 'II', pages: 23 },
    ])
  })
})

describe('parseTocTree', () => {
  it('builds a two-level tree from indentation and subtracts the header line', () => {
    const tree = parseTocTree(
      'Première partie\n  I 56\n  II 24\nDeuxième partie\n  I 28',
      { subtractHeader: true },
    )
    expect(tree).toHaveLength(2)
    expect(tree[0].name).toBe('Première partie')
    expect(tree[0].pages).toBeNull()
    expect(tree[0].children.map((c) => c.pages)).toEqual([55, 23])
    expect(tree[1].name).toBe('Deuxième partie')
    expect(tree[1].children.map((c) => c.pages)).toEqual([27])
  })

  it('treats a flat TOC as a list of leaves (single level)', () => {
    const tree = parseTocTree('第1章 绪论 12\n第2章 背景 30')
    expect(tree).toHaveLength(2)
    expect(tree[0].pages).toBe(12)
    expect(tree[0].children).toEqual([])
    expect(tree[1].pages).toBe(30)
  })

  it('marks a numberless leaf as missing-count, not as a container', () => {
    const tree = parseTocTree('第1章 绪论\n第2章 背景 30')
    expect(tree[0].pages).toBe(1)
    expect(tree[0].issue).toBe('missing-count')
    expect(tree[0].children).toEqual([])
    expect(tree[1].pages).toBe(30)
  })

  it('clamps a subtracted count at zero', () => {
    const tree = parseTocTree('第1章 绪论 1', { subtractHeader: true })
    expect(tree[0].pages).toBe(0)
  })
})

describe('findExistingMilestone (T1 idempotency gate)', () => {
  const milestone = (id: string, name: string, deleted: string | null = null) => ({
    id,
    goal_id: 'goal-1',
    name,
    deleted_at: deleted,
  })

  it('finds a live same-name milestone under the goal', () => {
    expect(
      findExistingMilestone([milestone('m1', '白痴')], 'goal-1', ' 白痴 '),
    ).toEqual({ id: 'm1' })
  })

  it('ignores a different goal, a different name, and tombstoned rows', () => {
    const rows = [
      milestone('m1', '白痴', null),
      milestone('m2', '白痴', '2026-11-05T00:00:00.000Z'), // tombstoned
      milestone('m3', '白痴'),
      milestone('m4', '罪与罚'),
    ]
    // m3 has a different goal_id, so only m1 qualifies (m2 tombstoned, m4 different name).
    const goalRows = [
      { ...rows[0], goal_id: 'goal-1' },
      { ...rows[1], goal_id: 'goal-1' },
      { ...rows[2], goal_id: 'goal-2' },
      { ...rows[3], goal_id: 'goal-1' },
    ]
    expect(findExistingMilestone(goalRows, 'goal-1', '白痴')).toEqual({ id: 'm1' })
  })

  it('excludes the given id (a retry of the same import)', () => {
    const rows = [milestone('m1', '白痴')]
    expect(findExistingMilestone(rows, 'goal-1', '白痴', 'm1')).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(findExistingMilestone([milestone('m1', '罪与罚')], 'goal-1', '白痴')).toBeNull()
  })
})
