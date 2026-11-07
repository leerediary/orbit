'use client'

import { useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { defaultShortName } from '@/lib/habit'
import type { Habit } from '@/lib/types'
import { useScopedDrag } from '@/lib/use-scoped-drag'

interface HabitManagementProps {
  habits: Habit[] // live, already sorted by sortHabits
  archived: Habit[] // tombstoned, newest first
  completionCounts: Record<string, number> // live completion count per habit id
  onAdd: (name: string, shortName: string) => Promise<void>
  onRename: (habit: Habit, name: string) => Promise<void>
  onUpdateShortName: (habit: Habit, shortName: string) => Promise<void>
  onReorder: (finalOrder: Habit[], baseline: Habit[]) => Promise<void>
  onArchive: (habit: Habit) => Promise<void>
  onRestore: (habit: Habit) => Promise<void>
  onRefresh: () => Promise<void> // reload stored values after a failure
}

const FOCUS_RING_OUTSET =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'
const FOCUS_RING_INSET =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:-2px]'

const CARD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  padding: '16px',
  background: 'var(--card)',
  borderRadius: '12px',
  boxShadow: 'var(--card-shadow)',
  minWidth: 0,
}

const TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.2,
  color: 'var(--foreground)',
}

const MUTED_INLINE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const INLINE_ERROR_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
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

const SMALL_ACCENT_BUTTON_STYLE: CSSProperties = {
  ...ACCENT_TEXT_BUTTON_STYLE,
  fontSize: '13px',
  lineHeight: 1.4,
}

const SMALL_MUTED_BUTTON_STYLE: CSSProperties = {
  ...SMALL_ACCENT_BUTTON_STYLE,
  color: 'var(--muted)',
}

const UNDERLINE_INPUT_STYLE: CSSProperties = {
  minWidth: 0,
  minHeight: '44px',
  padding: '8px 0',
  background: 'transparent',
  border: 'none',
  borderRadius: 0,
  borderBottom: '1px solid var(--border)',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  color: 'var(--foreground)',
}

const SHORT_INPUT_STYLE: CSSProperties = {
  ...UNDERLINE_INPUT_STYLE,
  flex: '0 0 72px',
  width: '72px',
  textAlign: 'center',
}

const ROW_NAME_INPUT_STYLE: CSSProperties = {
  ...UNDERLINE_INPUT_STYLE,
  flex: '1 1 auto',
  borderBottomColor: 'transparent',
  overflowWrap: 'anywhere',
}

const ICON_BUTTON_STYLE: CSSProperties = {
  flex: '0 0 44px',
  width: '44px',
  height: '44px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  margin: 0,
  background: 'none',
  border: 'none',
  color: 'var(--muted)',
}

const ADD_FORM_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
}

const ADD_SECOND_LINE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '8px',
}

const LIVE_ROWS_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
}

const ROW_LINE_ONE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minHeight: '44px',
  padding: '4px 0',
}

const CONFIRM_LINE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '8px',
  paddingLeft: '52px',
  minHeight: '44px',
}

const CONFIRM_COPY_STYLE: CSSProperties = {
  margin: 0,
  flex: '1 1 auto',
  minWidth: 0,
  overflowWrap: 'anywhere',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const ARCHIVED_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minHeight: '44px',
  padding: '4px 0',
}

const ARCHIVED_NAME_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

/**
 * 习惯管理 card (12-UI-SPEC §4). Purely presentational over the habit data the
 * 习惯打卡 tab owns: every mutation is delegated to a Promise-returning handler,
 * and a rejection is surfaced inline (no toasts / success messages). Reorder
 * uses Orbit's useScopedDrag (pointer) plus ArrowUp/ArrowDown, rewriting
 * sort_order 0..n-1 through onReorder — never diary-web's adjacent swap.
 */
export default function HabitManagement({
  habits,
  archived,
  completionCounts,
  onAdd,
  onRename,
  onUpdateShortName,
  onReorder,
  onArchive,
  onRestore,
  onRefresh,
}: HabitManagementProps) {
  const [name, setName] = useState('')
  const [shortName, setShortName] = useState('')
  const [shortEdited, setShortEdited] = useState(false)
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({})
  const [shortDrafts, setShortDrafts] = useState<Record<string, string>>({})
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)

  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const rowsRef = useRef<HTMLDivElement | null>(null)

  const { dragId, dragOrder, dropIndex, onHandlePointerDown } = useScopedDrag<Habit>({
    items: habits,
    idOf: (habit) => habit.id,
    onCommit: commitReorder,
    containerRef: rowsRef,
    itemSelector: '[data-habit-row]',
  })

  function clearNameDraft(id: string) {
    setNameDrafts((previous) => {
      if (previous[id] === undefined) return previous
      const next = { ...previous }
      delete next[id]
      return next
    })
  }

  function clearShortDraft(id: string) {
    setShortDrafts((previous) => {
      if (previous[id] === undefined) return previous
      const next = { ...previous }
      delete next[id]
      return next
    })
  }

  // ── Add form ──────────────────────────────────────────────────────────────

  function handleNameChange(value: string) {
    setName(value)
    if (!shortEdited) setShortName(Array.from(value).slice(0, 2).join(''))
  }

  async function submitAdd() {
    const trimmed = name.trim()
    if (!trimmed) return
    setAddError(null)
    try {
      await onAdd(trimmed, shortName.trim() || defaultShortName(trimmed))
      setName('')
      setShortName('')
      setShortEdited(false)
      requestAnimationFrame(() => nameInputRef.current?.focus())
    } catch {
      setAddError('添加习惯失败，请重试。')
    }
  }

  function handleAddKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      void submitAdd()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setName('')
      setShortName('')
      setShortEdited(false)
      event.currentTarget.blur()
    }
  }

  // ── Inline name / short-name commits ──────────────────────────────────────

  async function commitName(habit: Habit) {
    const draft = nameDrafts[habit.id]
    if (draft === undefined) return
    const trimmed = draft.trim()
    if (!trimmed || trimmed === habit.name) {
      clearNameDraft(habit.id)
      return
    }
    setSaveError(null)
    try {
      await onRename(habit, trimmed)
      clearNameDraft(habit.id)
    } catch {
      setSaveError('保存失败，请重试。')
      await onRefresh()
      clearNameDraft(habit.id)
    }
  }

  async function commitShort(habit: Habit) {
    const draft = shortDrafts[habit.id]
    if (draft === undefined) return
    const trimmed = draft.trim()
    if (!trimmed || trimmed === habit.short_name) {
      clearShortDraft(habit.id)
      return
    }
    setSaveError(null)
    try {
      await onUpdateShortName(habit, trimmed)
      clearShortDraft(habit.id)
    } catch {
      setSaveError('保存失败，请重试。')
      await onRefresh()
      clearShortDraft(habit.id)
    }
  }

  // ── Reorder ───────────────────────────────────────────────────────────────

  async function commitReorder(finalOrder: Habit[], baseline: Habit[]) {
    setSaveError(null)
    try {
      await onReorder(finalOrder, baseline)
    } catch {
      setSaveError('保存失败，请重试。')
      await onRefresh()
    }
  }

  async function handleReorderKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    habit: Habit,
  ) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    const currentIndex = habits.findIndex((item) => item.id === habit.id)
    if (currentIndex === -1) return
    const delta = event.key === 'ArrowUp' ? -1 : 1
    const nextIndex = currentIndex + delta
    if (nextIndex < 0 || nextIndex >= habits.length) return
    event.preventDefault()

    const reordered = [...habits]
    const [moved] = reordered.splice(currentIndex, 1)
    reordered.splice(nextIndex, 0, moved)
    // No try/catch here: commitReorder owns the 保存失败，请重试。 surface.
    await commitReorder(reordered, habits)

    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          `[data-habit-row][data-drag-id="${habit.id}"] [data-habit-drag]`,
        )
        ?.focus()
    })
  }

  // ── Archive / restore ─────────────────────────────────────────────────────

  async function doArchive(habit: Habit) {
    setArchiveError(null)
    try {
      await onArchive(habit)
    } catch {
      setArchiveError('存档失败，请重试。')
    } finally {
      setConfirmId(null)
    }
  }

  function requestArchive(habit: Habit) {
    const count = completionCounts[habit.id] ?? 0
    if (count > 0) {
      setConfirmId(habit.id)
      return
    }
    void doArchive(habit)
  }

  async function handleRestore(habit: Habit) {
    setRestoreError(null)
    try {
      await onRestore(habit)
    } catch {
      setRestoreError('恢复失败，请重试。')
    }
  }

  const displayed = dragOrder ?? habits

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <section style={CARD_STYLE}>
        <div className="flex items-center" style={{ minHeight: '44px' }}>
          <h2 style={TITLE_STYLE}>习惯管理</h2>
        </div>

      {/* ── Add-habit form ── */}
      <div style={ADD_FORM_STYLE}>
        <div style={ADD_SECOND_LINE_STYLE}>
          <input
            ref={nameInputRef}
            value={name}
            onChange={(event) => handleNameChange(event.target.value)}
            onKeyDown={handleAddKeyDown}
            placeholder="习惯名称"
            aria-label="习惯名称"
            maxLength={100}
            className={FOCUS_RING_INSET}
            style={{ ...UNDERLINE_INPUT_STYLE, flex: '1 1 auto' }}
          />
          <input
            value={shortName}
            onChange={(event) => {
              setShortEdited(true)
              setShortName(event.target.value)
            }}
            onKeyDown={handleAddKeyDown}
            placeholder="简称"
            aria-label="简称（最多 4 字）"
            maxLength={4}
            className={FOCUS_RING_INSET}
            style={SHORT_INPUT_STYLE}
          />
          <button
            type="button"
            onClick={() => void submitAdd()}
            aria-disabled={name.trim() === ''}
            className={`${FOCUS_RING_OUTSET} accent-button`}
            style={{
              ...ACCENT_TEXT_BUTTON_STYLE,
              opacity: name.trim() === '' ? 0.4 : 1,
              cursor: name.trim() === '' ? 'default' : 'pointer',
            }}
          >
            添加习惯
          </button>
        </div>
        {addError ? <p style={INLINE_ERROR_STYLE}>{addError}</p> : null}
      </div>

      {/* ── Empty list guidance ── */}
      {habits.length === 0 ? (
        <p style={MUTED_INLINE_STYLE}>还没有习惯。先添加一个想每天坚持的习惯吧。</p>
      ) : null}

      {/* ── Live habit rows ── */}
      <div ref={rowsRef} style={LIVE_ROWS_STYLE}>
        {displayed.map((habit, index) => {
          const confirming = confirmId === habit.id
          return (
            <div
              key={habit.id}
              data-habit-row
              data-drag-id={habit.id}
              style={{
                borderTop: index === 0 ? 'none' : '1px solid var(--border)',
                position: 'relative',
                opacity: dragId === habit.id ? 0.6 : 1,
              }}
            >
              {dropIndex === index ? (
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: '2px',
                    background: 'var(--accent)',
                  }}
                />
              ) : null}

              <div style={ROW_LINE_ONE_STYLE}>
                <button
                  type="button"
                  data-habit-drag
                  aria-label="调整习惯顺序"
                  onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) =>
                    onHandlePointerDown(event, habit)
                  }
                  onKeyDown={(event) => handleReorderKeyDown(event, habit)}
                  className={FOCUS_RING_INSET}
                  style={{ ...ICON_BUTTON_STYLE, touchAction: 'none', cursor: 'grab' }}
                >
                  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
                    <line
                      x1="3"
                      y1="7"
                      x2="15"
                      y2="7"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                    <line
                      x1="3"
                      y1="11"
                      x2="15"
                      y2="11"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
                <input
                  value={nameDrafts[habit.id] ?? habit.name}
                  onChange={(event) =>
                    setNameDrafts((previous) => ({
                      ...previous,
                      [habit.id]: event.target.value,
                    }))
                  }
                  onBlur={() => void commitName(habit)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return
                    if (event.key === 'Enter') event.currentTarget.blur()
                  }}
                  aria-label={`习惯名称：${habit.name}`}
                  maxLength={100}
                  className={FOCUS_RING_INSET}
                  style={ROW_NAME_INPUT_STYLE}
                />
                <input
                  value={shortDrafts[habit.id] ?? habit.short_name}
                  onChange={(event) =>
                    setShortDrafts((previous) => ({
                      ...previous,
                      [habit.id]: event.target.value,
                    }))
                  }
                  onBlur={() => void commitShort(habit)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return
                    if (event.key === 'Enter') event.currentTarget.blur()
                  }}
                  aria-label={`简称：${habit.name}`}
                  maxLength={4}
                  className={FOCUS_RING_INSET}
                  style={SHORT_INPUT_STYLE}
                />
                <button
                  type="button"
                  onClick={() => requestArchive(habit)}
                  className={`${FOCUS_RING_OUTSET} accent-button`}
                  style={{ ...SMALL_ACCENT_BUTTON_STYLE, flex: '0 0 auto' }}
                >
                  存档
                </button>
              </div>

              {confirming ? (
                <div style={CONFIRM_LINE_STYLE}>
                  <p style={CONFIRM_COPY_STYLE}>存档「{habit.name}」？</p>
                  <button
                    type="button"
                    onClick={() => void doArchive(habit)}
                    className={`${FOCUS_RING_OUTSET} accent-button`}
                    style={SMALL_ACCENT_BUTTON_STYLE}
                  >
                    确定存档
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmId(null)}
                    className={FOCUS_RING_OUTSET}
                    style={SMALL_MUTED_BUTTON_STYLE}
                  >
                    取消
                  </button>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {saveError ? <p style={INLINE_ERROR_STYLE}>{saveError}</p> : null}
      {archiveError ? <p style={INLINE_ERROR_STYLE}>{archiveError}</p> : null}
      </section>

      {/* ── Archived section ── */}
      {archived.length > 0 ? (
        <section style={CARD_STYLE}>
          <div className="flex items-center" style={{ minHeight: '44px' }}>
            <h2 style={TITLE_STYLE}>已存档</h2>
          </div>
          <div style={LIVE_ROWS_STYLE}>
          {archived.map((habit, index) => (
            <div
              key={habit.id}
              style={{
                ...ARCHIVED_ROW_STYLE,
                borderTop: index === 0 ? 'none' : '1px solid var(--border)',
              }}
            >
              <span style={ARCHIVED_NAME_STYLE}>{habit.name}</span>
              <button
                type="button"
                onClick={() => void handleRestore(habit)}
                className={`${FOCUS_RING_OUTSET} accent-button`}
                style={SMALL_ACCENT_BUTTON_STYLE}
              >
                恢复
              </button>
            </div>
          ))}
          </div>
          {restoreError ? <p style={INLINE_ERROR_STYLE}>{restoreError}</p> : null}
        </section>
      ) : null}
    </div>
  )
}
