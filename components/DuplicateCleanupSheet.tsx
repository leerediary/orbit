'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  deleteDuplicateRows,
  scanDuplicates,
  type DuplicateGroup,
  type DuplicateSelection,
} from '@/lib/duplicate-cleanup'
import { db } from '@/lib/local-db'
import { getLocalRepository } from '@/lib/repository-provider'
import { ENTITY_LABELS } from '@/lib/sync-bootstrap'
import { formatDiagnosticTime } from '@/lib/sync-diagnostics'

/**
 * Phase 21 / OPS-03 — duplicate cleanup assistant (21-UI-SPEC §6).
 *
 * A z-60 sibling of SettingsSheet, opened from the 重复清理 entry row. Unlike
 * the diagnostics panel this surface renders entity names by design: it is the
 * only place same-name siblings are shown, and the user selects which copies to
 * tombstone. All writes go through `deleteDuplicateRows` (soft delete only).
 *
 * The sheet is local-only, so it stays usable while sync is paused. Every read
 * failure is a typed error view — never an empty list — and every destructive
 * action takes a second screen before a tombstone is written.
 */

const TITLE_ID = 'orbit-duplicate-title'

const FOCUS_RING =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'

const TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '20px',
  fontWeight: 600,
  lineHeight: 1.2,
  letterSpacing: '-0.01em',
  color: 'var(--foreground)',
}

const HELPER_STYLE: CSSProperties = {
  margin: '8px 0 0',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  overflowWrap: 'anywhere',
}

const BODY_STYLE: CSSProperties = {
  margin: '16px 0 0',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

/** The fixed group rule, always shown above the list (21-UI-SPEC §6). */
const FIXED_LINE_STYLE: CSSProperties = {
  margin: '16px 0 0',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const STATUS_LINE_STYLE: CSSProperties = {
  margin: '16px 0 0',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

const GROUP_STYLE: CSSProperties = {
  padding: '16px 0',
  borderBottom: '1px solid var(--border)',
}

const GROUP_TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

const GROUP_SUBTITLE_STYLE: CSSProperties = {
  margin: '4px 0 0',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  overflowWrap: 'anywhere',
}

const GROUP_LIST_STYLE: CSSProperties = {
  margin: '8px 0 0',
  padding: 0,
  listStyle: 'none',
}

const ROW_LABEL_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minHeight: '44px',
  borderRadius: '8px',
}

const ROW_TEXT_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

const COUNT_LINE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const FOOTER_STYLE: CSSProperties = {
  marginTop: '24px',
}

const BUTTON_GROUP_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  marginTop: '24px',
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

/** Destructive confirm: destructive text + 1px outline, never a red fill. */
const DESTRUCTIVE_CONFIRM_STYLE: CSSProperties = {
  width: '100%',
  minHeight: '44px',
  padding: '0 16px',
  background: 'none',
  border: '1px solid var(--destructive)',
  borderRadius: '8px',
  color: 'var(--destructive)',
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.47,
  fontFamily: 'inherit',
}

function checkboxCircleStyle(checked: boolean, disabled: boolean): CSSProperties {
  return {
    flex: '0 0 22px',
    width: '22px',
    height: '22px',
    borderRadius: '9999px',
    boxSizing: 'border-box',
    border: checked ? 'none' : '1.5px solid var(--muted)',
    background: checked ? 'var(--accent)' : 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: disabled ? 0.4 : 1,
    transition: 'background 120ms ease-out',
  }
}

function rowKey(entity: DuplicateGroup['entity'], id: string): string {
  return `${entity}:${id}`
}

interface DuplicateCleanupSheetProps {
  onClose: () => void
}

type View = 'select' | 'confirm'

export default function DuplicateCleanupSheet({ onClose }: DuplicateCleanupSheetProps) {
  const [view, setView] = useState<View>('select')
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState(false)
  const [groups, setGroups] = useState<DuplicateGroup[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [statusLine, setStatusLine] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [confirmSnapshot, setConfirmSnapshot] = useState<{ k: number; g: number } | null>(null)

  const panelRef = useRef<HTMLDivElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const busyRef = useRef(false)

  /** Re-read every group. A failed scan is an error state, never an empty list. */
  const loadGroups = useCallback(async () => {
    setLoading(true)
    setReadError(false)
    const result = await scanDuplicates(db)
    if (result.ok) {
      setGroups(result.groups)
      setReadError(false)
    } else {
      setGroups([])
      setReadError(true)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void loadGroups()
    // Initial focus lands on the panel itself (21-UI-SPEC §6).
    panelRef.current?.focus()
  }, [loadGroups])

  // Focus follows the view: the safe action (取消) on the confirmation screen,
  // the panel everywhere else.
  useEffect(() => {
    if (view === 'confirm') cancelButtonRef.current?.focus()
    else panelRef.current?.focus()
  }, [view])

  function handleToggle(key: string, nextChecked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (nextChecked) next.add(key)
      else next.delete(key)
      return next
    })
  }

  /** Selected rows plus the group counts that feed the confirmation copy. */
  function selectionDetails(): {
    selections: DuplicateSelection[]
    k: number
    g: number
  } {
    const selections: DuplicateSelection[] = []
    const groupKeys = new Set<string>()
    for (const group of groups) {
      for (const row of group.rows) {
        if (!selected.has(rowKey(group.entity, row.id))) continue
        selections.push({ entity: group.entity, id: row.id })
        groupKeys.add(group.key)
      }
    }
    return { selections, k: selections.length, g: groupKeys.size }
  }

  function openConfirm() {
    const { k, g } = selectionDetails()
    if (k === 0) return
    setConfirmSnapshot({ k, g })
    setDeleteError(null)
    setStatusLine(null)
    setView('confirm')
  }

  async function handleDelete() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setDeleteError(null)
    setStatusLine(null)

    const { selections } = selectionDetails()
    try {
      const result = await deleteDuplicateRows(db, getLocalRepository(), selections)
      if (result.ok) {
        const total = result.deleted + result.cascaded
        setSelected(new Set())
        await loadGroups()
        setStatusLine(`已删除 ${total} 条重复条目。`)
      } else if (result.reason === 'empties-group') {
        // Nothing was written: keep the selection so the user can adjust it.
        await loadGroups()
        setDeleteError('删除会使某个重复组一条不剩，请调整选择后重试。')
      } else {
        // `partial` and `local-throw` both report a partial outcome honestly.
        setSelected(new Set())
        await loadGroups()
        setDeleteError('部分条目未删除，请重试。')
      }
      setView('select')
      requestAnimationFrame(() => panelRef.current?.focus())
    } catch {
      setSelected(new Set())
      await loadGroups()
      setView('select')
      setDeleteError('部分条目未删除，请重试。')
      requestAnimationFrame(() => panelRef.current?.focus())
    } finally {
      busyRef.current = false
      setBusy(false)
      setConfirmSnapshot(null)
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    // This sheet is a sibling of Settings but owns its own scope: never let the
    // Settings trap observe Escape or Tab.
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.stopPropagation()
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      if (busyRef.current) return
      if (view === 'confirm') {
        // Back to the selection with every checkbox preserved.
        setView('select')
        return
      }
      onClose()
      return
    }

    if (event.key !== 'Tab') return

    // Hand-rolled focus trap scoped to this panel (never Settings' dialogRef).
    const root = panelRef.current
    if (!root) return
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'input, textarea, button, select, [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1)

    if (focusable.length === 0) {
      event.preventDefault()
      root.focus()
      return
    }

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

  const { k: selectedCount } = selectionDetails()
  const confirmK = confirmSnapshot?.k ?? 0
  const confirmG = confirmSnapshot?.g ?? 0
  const heading = view === 'confirm' ? `删除 ${confirmK} 条重复条目？` : '重复清理'

  return (
    <div
      className="orbit-duplicate-scrim fixed inset-0 z-[60] flex items-end sm:items-center justify-center"
      role="presentation"
      onKeyDown={handleKeyDown}
      style={{ background: 'rgba(0,0,0,0.32)' }}
    >
      <style>{`
        @keyframes orbit-duplicate-scrim-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes orbit-duplicate-sheet-in {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .orbit-duplicate-scrim { animation: orbit-duplicate-scrim-in 150ms ease-out both; }
        .orbit-duplicate-sheet { animation: orbit-duplicate-sheet-in 200ms ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .orbit-duplicate-scrim, .orbit-duplicate-sheet { animation: none !important; }
        }
      `}</style>

      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-busy={busy ? true : undefined}
        className="orbit-duplicate-sheet w-full sm:max-w-[448px] max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl"
        style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          padding: '24px',
          paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
          boxShadow: 'none',
        }}
      >
        <h2 id={TITLE_ID} style={TITLE_STYLE}>
          {heading}
        </h2>

        {view === 'confirm' ? (
          <div>
            <p style={BODY_STYLE}>
              {`将从 ${confirmG} 组中删除 ${confirmK} 条；若选中条目包含子项，其下子条目也会一并删除，因此实际删除数量可能多于 ${confirmK} 条。删除会同步到其他设备，且无法撤销。`}
            </p>
            <div style={BUTTON_GROUP_STYLE}>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={busy}
                aria-busy={busy}
                className={FOCUS_RING}
                style={{
                  ...DESTRUCTIVE_CONFIRM_STYLE,
                  opacity: busy ? 0.4 : 1,
                  cursor: busy ? 'default' : 'pointer',
                }}
              >
                {busy ? '正在删除…' : `永久删除 ${confirmK} 条`}
              </button>
              <button
                ref={cancelButtonRef}
                type="button"
                onClick={() => setView('select')}
                disabled={busy}
                className={FOCUS_RING}
                style={{
                  ...SECONDARY_BUTTON_STYLE,
                  opacity: busy ? 0.4 : 1,
                  cursor: busy ? 'default' : 'pointer',
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : loading ? (
          <p role="status" aria-live="polite" style={STATUS_LINE_STYLE}>
            正在查找重复条目…
          </p>
        ) : readError ? (
          <div>
            <p role="alert" style={STATUS_LINE_STYLE}>
              无法查找重复条目，请重试。
            </p>
            <div style={BUTTON_GROUP_STYLE}>
              <button
                type="button"
                onClick={() => void loadGroups()}
                className={FOCUS_RING}
                style={{ ...PRIMARY_BUTTON_STYLE, cursor: 'pointer' }}
              >
                重试
              </button>
              <button
                type="button"
                onClick={onClose}
                className={FOCUS_RING}
                style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
              >
                返回
              </button>
            </div>
          </div>
        ) : groups.length === 0 ? (
          <div>
            <p style={BODY_STYLE}>没有发现重复条目。</p>
            <p style={HELPER_STYLE}>同名且同一父级的条目会出现在这里。</p>
            {statusLine ? (
              <p role="status" aria-live="polite" style={STATUS_LINE_STYLE}>
                {statusLine}
              </p>
            ) : null}
            {deleteError ? (
              <p role="alert" style={STATUS_LINE_STYLE}>
                {deleteError}
              </p>
            ) : null}
            <div style={BUTTON_GROUP_STYLE}>
              <button
                type="button"
                onClick={onClose}
                className={FOCUS_RING}
                style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
              >
                返回
              </button>
            </div>
          </div>
        ) : (
          <div>
            <p style={HELPER_STYLE}>
              同名且同一父级的条目会被分到一组。勾选要删除的条目，每组至少保留一条。
            </p>
            <p style={FIXED_LINE_STYLE}>每组至少保留一条。</p>

            {groups.map((group) => {
              const unchecked = group.rows.filter(
                (row) => !selected.has(rowKey(group.entity, row.id)),
              )
              const lastUncheckedId = unchecked.length === 1 ? unchecked[0].id : null
              return (
                <section key={group.key} style={GROUP_STYLE}>
                  <h3 style={GROUP_TITLE_STYLE}>{group.name}</h3>
                  <p style={GROUP_SUBTITLE_STYLE}>
                    {`${ENTITY_LABELS[group.entity]} · ${group.parentPath}`}
                  </p>
                  <ul style={GROUP_LIST_STYLE}>
                    {group.rows.map((row) => {
                      const key = rowKey(group.entity, row.id)
                      const checked = selected.has(key)
                      const isLastUnchecked = lastUncheckedId === row.id
                      const time = formatDiagnosticTime(row.updatedAt)
                      return (
                        <li key={row.id}>
                          <label
                            className="has-[:focus-visible]:[outline:2px_solid_var(--accent)] has-[:focus-visible]:[outline-offset:2px]"
                            style={{
                              ...ROW_LABEL_STYLE,
                              cursor: isLastUnchecked ? 'default' : 'pointer',
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={isLastUnchecked}
                              aria-disabled={isLastUnchecked || undefined}
                              aria-label={`${row.name}，更新于 ${time}`}
                              onChange={(event) => handleToggle(key, event.target.checked)}
                              className="sr-only"
                            />
                            <span
                              aria-hidden="true"
                              style={checkboxCircleStyle(checked, isLastUnchecked)}
                            >
                              {checked ? (
                                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                                  <polyline
                                    points="2.4 6.2 4.9 8.7 9.6 3.4"
                                    fill="none"
                                    stroke="#ffffff"
                                    strokeWidth="1.6"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              ) : null}
                            </span>
                            <span style={ROW_TEXT_STYLE}>
                              {`更新于 ${time}`}
                              {row.descendantCount > 0
                                ? ` · 含 ${row.descendantCount} 项`
                                : ''}
                            </span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}

            {statusLine ? (
              <p role="status" aria-live="polite" style={STATUS_LINE_STYLE}>
                {statusLine}
              </p>
            ) : null}
            {deleteError ? (
              <p role="alert" style={STATUS_LINE_STYLE}>
                {deleteError}
              </p>
            ) : null}

            <div style={FOOTER_STYLE}>
              <p style={COUNT_LINE_STYLE}>{`已选择 ${selectedCount} 条`}</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                <button
                  type="button"
                  onClick={openConfirm}
                  disabled={selectedCount === 0}
                  className={FOCUS_RING}
                  style={{
                    ...PRIMARY_BUTTON_STYLE,
                    opacity: selectedCount === 0 ? 0.4 : 1,
                    cursor: selectedCount === 0 ? 'default' : 'pointer',
                  }}
                >
                  {`删除 ${selectedCount} 条`}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className={FOCUS_RING}
                  style={{ ...SECONDARY_BUTTON_STYLE, cursor: 'pointer' }}
                >
                  返回
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
