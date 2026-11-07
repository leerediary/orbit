'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'

import { buildImportPayload, computeChapters, parseToc, parseTocTree } from '@/lib/book-import'
import type { BookImportPayload, ImportNodeInput, TocNode, TocRow } from '@/lib/book-import'
import { bookImportDrafts } from '@/lib/book-import-draft'

interface BookImportSheetProps {
  /** Parent persists the whole book as a milestone; resolve unloads, reject keeps review. */
  onImport: (payload: BookImportPayload) => Promise<void>
  /** Cancel / Escape; parent owns unmount and focus restoration. */
  onCancel: () => void
  /** True when a same-name milestone already exists under the goal (T1). */
  duplicate: boolean
  onResolveDuplicate: (choice: 'skip' | 'overwrite' | 'create') => void
}

/** One editable node in the review step. A container (部) has children and no count. */
interface EditableNode {
  key: string
  name: string
  startPage: string
  children: EditableNode[]
}

/** Flatten an editable tree into a pre-order node list with parent links. */
function flattenTree(nodes: EditableNode[], parentKey: string | null): ImportNodeInput[] {
  const out: ImportNodeInput[] = []
  for (const node of nodes) {
    const isContainer = node.children.length > 0
    const pages = isContainer ? null : node.startPage === '' ? 1 : Number(node.startPage)
    out.push({ key: node.key, name: node.name, pages, parentKey })
    out.push(...flattenTree(node.children, node.key))
  }
  return out
}

const TITLE_ID = 'book-import-sheet-title'
const BOOK_ID = 'book-import-sheet-book'
const TOTAL_ID = 'book-import-sheet-total'
const UNIT_ID = 'book-import-sheet-unit'
const TOC_ID = 'book-import-sheet-toc'

const FOCUS_RING = 'focus:[outline:2px_solid_var(--accent)] focus:[outline-offset:2px]'

const INPUT_STYLE: CSSProperties = {
  minHeight: '44px',
  padding: '12px',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  color: 'var(--foreground)',
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
}

const TEXTAREA_STYLE: CSSProperties = {
  ...INPUT_STYLE,
  minHeight: '160px',
  resize: 'vertical',
  overflowWrap: 'anywhere',
}

const LABEL_STYLE: CSSProperties = {
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const HELPER_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const ERROR_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
}

const BLOCKING_STYLE: CSSProperties = {
  ...ERROR_STYLE,
  fontWeight: 600,
}

const PRIMARY_BUTTON_STYLE: CSSProperties = {
  width: '100%',
  minHeight: '44px',
  padding: '0 16px',
  background: 'var(--accent)',
  color: '#ffffff',
  border: 'none',
  borderRadius: '8px',
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.47,
  fontFamily: 'inherit',
}

const SECONDARY_BUTTON_STYLE: CSSProperties = {
  width: '100%',
  minHeight: '44px',
  padding: '0 16px',
  background: 'none',
  border: 'none',
  color: 'var(--foreground)',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
}

const ACCENT_TEXT_BUTTON_STYLE: CSSProperties = {
  minHeight: '44px',
  padding: '0 4px',
  background: 'none',
  border: 'none',
  color: 'var(--accent)',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  cursor: 'pointer',
}

const DELETE_BUTTON_STYLE: CSSProperties = {
  width: '44px',
  height: '44px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  background: 'none',
  border: 'none',
  color: 'var(--muted)',
  cursor: 'pointer',
}

/**
 * Two-step book TOC import sheet shared by both entry points (new goal /
 * milestone). Step 1 pastes a book name, total pages, and a chapter list; step
 * 2 reviews an editable chapter table with live page-count recalculation, then
 * hands a single payload to the parent via `onImport`. Purely presentational —
 * it never touches the repository. Chrome and focus trap mirror GoalSheet;
 * backdrop click / Escape close the sheet and the session draft (book-import-draft)
 * survives the close. Independent `orbit-book-*` animation names let it mount
 * alongside another sheet without clashing keyframes.
 */
export default function BookImportSheet({
  onImport,
  onCancel,
  duplicate,
  onResolveDuplicate,
}: BookImportSheetProps) {
  // Session draft (book-import-draft) survives an unmount from backdrop-click /
  // Escape close and restores on reopen; a committed import clears it.
  const saved = bookImportDrafts.milestone
  const [step, setStep] = useState<'paste' | 'review'>(saved?.step ?? 'paste')
  const [bookName, setBookName] = useState(saved?.bookName ?? '')
  const [totalPagesText, setTotalPagesText] = useState(saved?.totalPagesText ?? '')
  const [unit, setUnit] = useState(saved?.unit ?? '页')
  const [parseMode, setParseMode] = useState<'start-page' | 'count'>(saved?.parseMode ?? 'start-page')
  const [tocText, setTocText] = useState(saved?.tocText ?? '')

  const [bookNameError, setBookNameError] = useState<string | null>(null)
  const [totalPagesError, setTotalPagesError] = useState<string | null>(null)
  const [tocError, setTocError] = useState<string | null>(null)

  const [rows, setRows] = useState<EditableNode[]>(saved?.rows ?? [])
  const [saving, setSaving] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  const dialogRef = useRef<HTMLDivElement | null>(null)
  const bookNameRef = useRef<HTMLInputElement | null>(null)
  const totalPagesRef = useRef<HTMLInputElement | null>(null)
  const tocRef = useRef<HTMLTextAreaElement | null>(null)
  const rowNameRefs = useRef<Array<HTMLInputElement | null>>([])
  const deleteButtonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const returnButtonRef = useRef<HTMLButtonElement | null>(null)
  const bookIdRef = useRef<string | null>(null)

  // Focus the book name input when the sheet opens (paste step, §6).
  useEffect(() => {
    bookNameRef.current?.focus()
  }, [])

  // After a successful parse, focus the first chapter name input.
  useEffect(() => {
    if (step === 'review') {
      requestAnimationFrame(() => {
        rowNameRefs.current[0]?.focus()
      })
    }
  }, [step])

  // Persist the whole draft on every change (session-scoped, keyed by mode).
  useEffect(() => {
    bookImportDrafts.milestone = {
      step,
      bookName,
      totalPagesText,
      unit,
      parseMode,
      tocText,
      rows,
    }
  }, [step, bookName, totalPagesText, unit, parseMode, tocText, rows])

  const totalPagesValue = Number(totalPagesText)

  const tocRows = useMemo<TocRow[]>(
    () =>
      rows.map((row) => ({
        name: row.name,
        startPage: row.startPage === '' ? null : Number(row.startPage),
      })),
    [rows],
  )

  const summary = useMemo(
    () => computeChapters(tocRows, totalPagesValue, parseMode),
    [tocRows, totalPagesValue, parseMode],
  )

  // count 模式的多级树统计（叶子数 / 总行数 / 缺行数叶子数）。
  const countStats = useMemo(() => {
    let leaves = 0
    let total = 0
    let missing = 0
    const walk = (nodes: EditableNode[]): void => {
      for (const node of nodes) {
        if (node.children.length > 0) {
          walk(node.children)
        } else {
          leaves++
          const pages = node.startPage === '' ? 1 : Number(node.startPage)
          total += Number.isFinite(pages) && pages > 0 ? pages : 1
          if (node.startPage === '') missing++
        }
      }
    }
    walk(rows)
    return { leaves, total, missing }
  }, [rows])

  const totalChapterPages =
    parseMode === 'count'
      ? countStats.total
      : summary.rows.reduce((sum, row) => sum + row.pages, 0)

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!saving) onCancel()
      return
    }
    if (event.key !== 'Tab') return

    // Hand-rolled focus trap: cycle Tab/Shift+Tab within the dialog.
    const root = dialogRef.current
    if (!root) return
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'input, textarea, button, select, [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1)
    if (focusable.length === 0) return

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const current = document.activeElement
    const inside = current instanceof Node && root.contains(current)

    if (event.shiftKey) {
      if (!inside || current === first) {
        event.preventDefault()
        last.focus()
      }
    } else if (!inside || current === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function handleParse() {
    const trimmedBookName = bookName.trim()
    if (!trimmedBookName) {
      setBookNameError('请填写书名')
      bookNameRef.current?.focus()
      return
    }

    if (parseMode === 'start-page') {
      const totalPages = Number(totalPagesText)
      if (!Number.isInteger(totalPages) || totalPages <= 0) {
        setTotalPagesError('请填写末章结束页')
        totalPagesRef.current?.focus()
        return
      }
    }

    if (tocText.trim() === '') {
      setTocError('请粘贴目录内容')
      tocRef.current?.focus()
      return
    }

    if (parseMode === 'count') {
      const tree = parseTocTree(tocText, { subtractHeader: true })
      if (tree.length === 0) {
        setTocError('没有识别到章节行，请检查每行是否包含章节名和页数。')
        tocRef.current?.focus()
        return
      }
      const withKeys = (nodes: TocNode[]): EditableNode[] =>
        nodes.map((node) => ({
          key: crypto.randomUUID(),
          name: node.name,
          startPage: node.pages == null || node.issue === 'missing-count' ? '' : String(node.pages),
          children: withKeys(node.children),
        }))
      setRows(withKeys(tree))
    } else {
      const parsed = parseToc(tocText)
      if (parsed.length === 0) {
        setTocError('没有识别到章节行，请检查每行是否包含章节名和起始页。')
        tocRef.current?.focus()
        return
      }
      setRows(
        parsed.map((row) => ({
          key: crypto.randomUUID(),
          name: row.name,
          startPage: row.startPage === null ? '' : String(row.startPage),
          children: [],
        })),
      )
    }
    setBookNameError(null)
    setTotalPagesError(null)
    setTocError(null)
    setImportError(null)
    setStep('review')
  }

  function mapNode(
    nodes: EditableNode[],
    key: string,
    fn: (node: EditableNode) => EditableNode,
  ): EditableNode[] {
    return nodes.map((node) =>
      node.key === key ? fn(node) : { ...node, children: mapNode(node.children, key, fn) },
    )
  }

  function filterNode(nodes: EditableNode[], key: string): EditableNode[] {
    return nodes
      .filter((node) => node.key !== key)
      .map((node) => ({ ...node, children: filterNode(node.children, key) }))
  }

  function updateRowName(key: string, name: string) {
    setRows((current) => mapNode(current, key, (node) => ({ ...node, name })))
  }

  function updateRowStartPage(key: string, value: string) {
    const digits = value.replace(/\D/g, '')
    setRows((current) => mapNode(current, key, (node) => ({ ...node, startPage: digits })))
  }

  function handleDeleteRow(key: string) {
    setRows((current) => filterNode(current, key))
    requestAnimationFrame(() => {
      returnButtonRef.current?.focus()
    })
  }

  function handleReturn() {
    if (summary.totalPagesError) {
      setTotalPagesError('末章结束页不能小于最后一章的起始页')
    }
    setImportError(null)
    setStep('paste')
    requestAnimationFrame(() => {
      tocRef.current?.focus()
    })
  }

  const canImport =
    bookName.trim() !== '' &&
    summary.totalPagesError === null &&
    rows.length > 0 &&
    summary.blockers === 0 &&
    !saving

  async function handleImport() {
    if (saving) return
    setImportError(null)
    setSaving(true)
    try {
      if (bookIdRef.current === null) {
        bookIdRef.current = crypto.randomUUID()
      }
      const nodes: ImportNodeInput[] =
        parseMode === 'count'
          ? flattenTree(rows, null)
          : summary.rows.map((row, i) => ({
              key: rows[i].key,
              name: row.name,
              pages: row.pages,
              parentKey: null,
            }))
      const payload = buildImportPayload(bookName.trim(), nodes, bookIdRef.current, unit)
      await onImport(payload)
      bookImportDrafts.milestone = null
    } catch {
      setImportError('导入失败，请重试。')
    } finally {
      setSaving(false)
    }
  }

  // Enter inside paste inputs must never submit; the buttons are explicit.
  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
  }

  function renderCountNodes(nodes: EditableNode[], depth: number): ReactNode[] {
    return nodes.flatMap((node) => {
      const isContainer = node.children.length > 0
      const row = (
        <li
          key={node.key}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            minWidth: 0,
            padding: '12px',
            marginLeft: depth > 0 ? '16px' : undefined,
            background: isContainer ? 'var(--background)' : 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <input
              type="text"
              value={node.name}
              onChange={(event) => updateRowName(node.key, event.target.value)}
              aria-label={isContainer ? `${node.name} 部` : `${node.name} 章`}
              className={FOCUS_RING}
              style={{
                ...INPUT_STYLE,
                flex: '1 1 auto',
                width: '100%',
                overflowWrap: 'anywhere',
                fontWeight: isContainer ? 600 : 400,
              }}
            />
            {isContainer ? null : (
              <>
                <input
                  type="text"
                  inputMode="numeric"
                  value={node.startPage}
                  onChange={(event) => updateRowStartPage(node.key, event.target.value)}
                  aria-label={`${node.name} 页数`}
                  className={FOCUS_RING}
                  style={{ ...INPUT_STYLE, width: '88px', height: '44px', flex: '0 0 auto' }}
                />
                <span
                  style={{
                    flex: '0 0 auto',
                    fontSize: '13px',
                    fontWeight: 400,
                    lineHeight: 1.4,
                    color: 'var(--muted)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {`${node.startPage === '' ? 1 : Number(node.startPage)} ${unit}`}
                </span>
              </>
            )}
            <button
              type="button"
              onClick={() => handleDeleteRow(node.key)}
              aria-label={`删除 ${node.name}`}
              className={FOCUS_RING}
              style={DELETE_BUTTON_STYLE}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 18 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M4 4l10 10M14 4L4 14" />
              </svg>
            </button>
          </div>
          {isContainer ? null : node.startPage === '' ? (
            <p style={ERROR_STYLE}>{`缺行数，按 1 ${unit}计算`}</p>
          ) : null}
        </li>
      )
      return [row, ...renderCountNodes(node.children, depth + 1)]
    })
  }

  return (
    <>
      <style>{`
        @keyframes orbit-book-scrim-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes orbit-book-sheet-in {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .orbit-book-scrim { animation: orbit-book-scrim-in 150ms ease-out both; }
        .orbit-book-sheet { animation: orbit-book-sheet-in 200ms ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .orbit-book-scrim, .orbit-book-sheet { animation: none !important; }
        }
      `}</style>

      <div
        className="orbit-book-scrim fixed inset-0 z-50 flex items-end sm:items-center justify-center"
        role="presentation"
        onKeyDown={handleKeyDown}
        onClick={onCancel}
        style={{ background: 'rgba(0,0,0,0.32)' }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={TITLE_ID}
          className="orbit-book-sheet w-full sm:max-w-[448px] max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl"
          onClick={(event) => event.stopPropagation()}
          style={{
            background: 'var(--card)',
            border: '1px solid var(--border)',
            padding: '24px',
            paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
          }}
        >
          <h2
            id={TITLE_ID}
            style={{
              margin: 0,
              fontSize: '20px',
              fontWeight: 600,
              lineHeight: 1.2,
              letterSpacing: '-0.01em',
              color: 'var(--foreground)',
            }}
          >
            从目录导入里程碑
          </h2>

          {step === 'paste' ? (
            <form onSubmit={handleFormSubmit} noValidate>
              <div
                style={{
                  marginTop: '24px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '16px',
                }}
              >
                <div role="radiogroup" aria-label="目录解析样式" style={{ display: 'flex', gap: '8px' }}>
                  {(['start-page', 'count'] as const).map((m) => {
                    const selected = parseMode === m
                    const label = m === 'start-page' ? '起始页' : '每章页数'
                    return (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => {
                          setParseMode(m)
                          if (m === 'count') setTotalPagesError(null)
                        }}
                        className={FOCUS_RING}
                        style={{
                          flex: '1 1 0',
                          minHeight: '44px',
                          padding: '0 12px',
                          background: selected ? 'var(--accent)' : 'var(--card)',
                          color: selected ? '#ffffff' : 'var(--foreground)',
                          border: '1px solid var(--border)',
                          borderRadius: '8px',
                          fontSize: '15px',
                          fontWeight: selected ? 600 : 400,
                          lineHeight: 1.47,
                          fontFamily: 'inherit',
                          cursor: 'pointer',
                        }}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <label htmlFor={BOOK_ID} style={LABEL_STYLE}>
                    书名
                  </label>
                  <input
                    id={BOOK_ID}
                    ref={bookNameRef}
                    type="text"
                    value={bookName}
                    onChange={(event) => {
                      setBookName(event.target.value)
                      if (bookNameError) setBookNameError(null)
                    }}
                    maxLength={100}
                    placeholder="例如：人类简史"
                    aria-required="true"
                    aria-invalid={bookNameError !== null}
                    className={FOCUS_RING}
                    style={INPUT_STYLE}
                  />
                  <p style={HELPER_STYLE}>
                    将作为里程碑名称
                  </p>
                  {bookNameError ? <p style={ERROR_STYLE}>{bookNameError}</p> : null}
                </div>

                {parseMode === 'start-page' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <label htmlFor={TOTAL_ID} style={LABEL_STYLE}>
                      末章结束页
                    </label>
                    <input
                      id={TOTAL_ID}
                      ref={totalPagesRef}
                      type="text"
                      inputMode="numeric"
                      value={totalPagesText}
                      onChange={(event) => {
                        setTotalPagesText(event.target.value.replace(/\D/g, ''))
                        if (totalPagesError) setTotalPagesError(null)
                      }}
                      maxLength={6}
                      placeholder="例如：440"
                      aria-required="true"
                      aria-invalid={totalPagesError !== null}
                      className={FOCUS_RING}
                      style={INPUT_STYLE}
                    />
                    <p style={HELPER_STYLE}>最后一章的结束页码（注释/参考文献已忽略）</p>
                    {totalPagesError ? <p style={ERROR_STYLE}>{totalPagesError}</p> : null}
                  </div>
                ) : null}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <label htmlFor={UNIT_ID} style={LABEL_STYLE}>
                    单位
                  </label>
                  <input
                    id={UNIT_ID}
                    type="text"
                    value={unit}
                    onChange={(event) => setUnit(event.target.value)}
                    maxLength={12}
                    placeholder="页"
                    className={FOCUS_RING}
                    style={INPUT_STYLE}
                  />
                  <p style={HELPER_STYLE}>每章进度单位，默认「页」，可改成「章」「分钟」等</p>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <label htmlFor={TOC_ID} style={LABEL_STYLE}>
                    粘贴目录
                  </label>
                  <textarea
                    id={TOC_ID}
                    ref={tocRef}
                    value={tocText}
                    onChange={(event) => {
                      setTocText(event.target.value)
                      if (tocError) setTocError(null)
                    }}
                    placeholder={'第1章 绪论 1\n第2章 文明的起点 25'}
                    aria-invalid={tocError !== null}
                    className={FOCUS_RING}
                    style={TEXTAREA_STYLE}
                  />
                  {tocError ? <p style={ERROR_STYLE}>{tocError}</p> : null}
                </div>
              </div>

              <div
                style={{
                  marginTop: '24px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <button
                  type="button"
                  onClick={handleParse}
                  className={FOCUS_RING}
                  style={{ ...PRIMARY_BUTTON_STYLE, cursor: 'pointer' }}
                >
                  解析目录
                </button>
                <button
                  type="button"
                  onClick={onCancel}
                  className={FOCUS_RING}
                  style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
                >
                  取消导入
                </button>
              </div>
            </form>
          ) : (
            <>
              <h3
                style={{
                  margin: '24px 0 0',
                  fontSize: '17px',
                  fontWeight: 600,
                  lineHeight: 1.2,
                  color: 'var(--foreground)',
                }}
              >
                确认章节
              </h3>

              <div
                style={{
                  marginTop: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '8px',
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    flex: '1 1 auto',
                    minWidth: 0,
                    fontSize: '13px',
                    fontWeight: 400,
                    lineHeight: 1.4,
                    color: 'var(--muted)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {`共 ${parseMode === 'count' ? countStats.leaves : rows.length} 章 · 合计 ${totalChapterPages} ${unit}`}
                </span>
                <button
                  ref={returnButtonRef}
                  type="button"
                  onClick={handleReturn}
                  className={FOCUS_RING}
                  style={{ ...ACCENT_TEXT_BUTTON_STYLE, flex: '0 0 auto' }}
                >
                  返回修改
                </button>
              </div>

              {(parseMode === 'count' ? countStats.missing : summary.warningCount) > 0 ? (
                <p style={{ ...ERROR_STYLE, marginTop: '8px' }}>
                  {`${parseMode === 'count' ? countStats.missing : summary.warningCount} 行缺少${parseMode === 'start-page' ? '起始页' : '页数'}，按 1 ${unit}计算`}
                </p>
              ) : null}

              {rows.length === 0 ? (
                <p style={{ ...HELPER_STYLE, marginTop: '16px' }}>
                  还没有章节。返回上一步，重新粘贴目录。
                </p>
              ) : (
                <ul
                  role="list"
                  style={{
                    marginTop: '16px',
                    marginBottom: 0,
                    padding: 0,
                    listStyle: 'none',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                  }}
                >
                  {parseMode === 'count' ? renderCountNodes(rows, 0) : rows.map((row, index) => {
                    const chapter = summary.rows[index]
                    const isMissingStart = chapter?.issue === 'missing-start'
                    const isNotIncreasing = chapter?.issue === 'not-increasing'
                    const rowBackground =
                      isMissingStart || isNotIncreasing ? 'var(--background)' : 'var(--card)'

                    return (
                      <li
                        key={row.key}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '8px',
                          minWidth: 0,
                          padding: '12px',
                          background: rowBackground,
                          border: '1px solid var(--border)',
                          borderRadius: '8px',
                        }}
                      >
                        <input
                          ref={(el) => {
                            rowNameRefs.current[index] = el
                          }}
                          type="text"
                          value={row.name}
                          onChange={(event) => updateRowName(row.key, event.target.value)}
                          aria-label={`第 ${index + 1} 章名称`}
                          className={FOCUS_RING}
                          style={{ ...INPUT_STYLE, width: '100%', overflowWrap: 'anywhere' }}
                        />

                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            gap: '8px',
                            minWidth: 0,
                          }}
                        >
                          <span style={{ ...LABEL_STYLE, flex: '0 0 auto' }}>
                            {parseMode === 'start-page' ? '起始页' : '每章页数'}
                          </span>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={row.startPage}
                            onChange={(event) =>
                              updateRowStartPage(row.key, event.target.value)
                            }
                            aria-label={`第 ${index + 1} 章${parseMode === 'start-page' ? '起始页' : '页数'}`}
                            aria-invalid={isNotIncreasing}
                            className={FOCUS_RING}
                            style={{
                              ...INPUT_STYLE,
                              width: '88px',
                              height: '44px',
                              flex: '0 0 auto',
                            }}
                          />
                          <span
                            style={{
                              flex: '0 0 auto',
                              fontSize: '13px',
                              fontWeight: 400,
                              lineHeight: 1.4,
                              color: 'var(--muted)',
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {`${chapter?.pages ?? 0} ${unit}`}
                          </span>
                          <span style={{ flex: '1 1 auto' }} />
                          <button
                            ref={(el) => {
                              deleteButtonRefs.current[index] = el
                            }}
                            type="button"
                            onClick={() => handleDeleteRow(row.key)}
                            aria-label={`删除第 ${index + 1} 章`}
                            className={FOCUS_RING}
                            style={DELETE_BUTTON_STYLE}
                          >
                            <svg
                              width="18"
                              height="18"
                              viewBox="0 0 18 18"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              aria-hidden="true"
                              focusable="false"
                            >
                              <path d="M4 4l10 10M14 4L4 14" />
                            </svg>
                          </button>
                        </div>

                        {isMissingStart ? (
                          <p style={ERROR_STYLE}>
                            {parseMode === 'start-page' ? '缺起始页' : '缺页数'}，按 1 {unit}计算
                          </p>
                        ) : null}
                        {isNotIncreasing ? (
                          <p style={BLOCKING_STYLE}>起始页需大于上一章</p>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}

              {summary.totalPagesError ? (
                <p style={{ ...ERROR_STYLE, marginTop: '16px' }}>
                  {summary.totalPagesError}
                </p>
              ) : null}

              {importError ? (
                <p style={{ ...ERROR_STYLE, marginTop: '16px' }}>{importError}</p>
              ) : null}

              <div
                style={{
                  marginTop: '24px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                {duplicate ? (
                  <>
                    <p style={{ ...ERROR_STYLE, fontWeight: 600 }}>
                      已存在同名里程碑「{bookName.trim()}」
                    </p>
                    <button
                      type="button"
                      onClick={() => onResolveDuplicate('skip')}
                      className={FOCUS_RING}
                      style={{ ...PRIMARY_BUTTON_STYLE, cursor: 'pointer' }}
                    >
                      跳过（保留现有）
                    </button>
                    <button
                      type="button"
                      onClick={() => onResolveDuplicate('overwrite')}
                      className={FOCUS_RING}
                      style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
                    >
                      覆盖（替换现有章节）
                    </button>
                    <button
                      type="button"
                      onClick={() => onResolveDuplicate('create')}
                      className={FOCUS_RING}
                      style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
                    >
                      并列新建（保留两份）
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={handleImport}
                      disabled={!canImport}
                      aria-busy={saving}
                      className={FOCUS_RING}
                      style={{
                        ...PRIMARY_BUTTON_STYLE,
                        cursor: canImport ? 'pointer' : 'default',
                        opacity: canImport ? 1 : 0.4,
                      }}
                    >
                      {`导入 ${parseMode === 'count' ? countStats.leaves : rows.length} 章`}
                    </button>
                    <button
                      type="button"
                      onClick={onCancel}
                      className={FOCUS_RING}
                      style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
                    >
                      取消导入
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
