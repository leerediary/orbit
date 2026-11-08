'use client'

import { useEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from 'react'
import { describeTaskEvent } from '@/lib/habit-auto-checkin'
import { POMODORO_CALENDARS } from '@/lib/calendar'
import { resolveProgressAmount } from '@/lib/pomodoro'

/** One linked task shown in the settlement sheet (multi-task, T8). */
interface SummaryTask {
  id: string
  name: string
  progressType: 'checkbox' | 'quantity'
  unit: string | null
  currentValue: number | null
  targetValue: number | null
  startValue: number | null
  goalName: string | null
  milestoneName: string | null
  goalHabitName: string | null
}

interface PomodoroSummarySheetProps {
  open: boolean
  tasks: SummaryTask[]
  todo: { name: string } | null
  habitName: string | null
  /** Selected calendar write target, or null when unlinked. */
  calendarName: string | null
  /** T23: opens the calendar picker from the summary stage so the target can
   *  be changed or cleared without canceling the settlement. */
  onRequestCalendarChange: () => void
  notes: string[]
  sharedFlags: boolean[]
  saving: boolean
  error: string | null
  onNotesChange: (notes: string[], sharedFlags: boolean[]) => void
  onToggleShare: (index: number) => void
  onConfirm: (
    settlements: Array<{ taskId: string; complete: boolean; amount: number | null }>,
    markedTodoComplete: boolean,
    /** T24: notes/share flags with the settle-stage draft flushed in — the
     *  parent must use THESE (its own state would still be one tick stale). */
    finalNotes: string[],
    finalSharedFlags: boolean[],
  ) => void
  onCancel: () => void
  returnFocusRef: RefObject<HTMLElement | null>
}

const TITLE_ID = 'pomodoro-summary-title'
const AMOUNT_ID = 'pomodoro-summary-amount'
const ARRIVAL_ID = 'pomodoro-summary-arrival'

const FOCUS_RING =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'

const SECTION_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
}

const SECTION_TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.2,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

const META_TEXT_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  overflowWrap: 'anywhere',
}

const INLINE_ERROR_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
}

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  minHeight: '44px',
}

const CHECK_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  minHeight: '44px',
  cursor: 'pointer',
}

const LABEL_STYLE: CSSProperties = {
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--foreground)',
}

const AMOUNT_STYLE: CSSProperties = {
  width: '64px',
  minHeight: '44px',
  padding: '8px 12px',
  boxSizing: 'border-box',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  color: 'var(--foreground)',
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  textAlign: 'center',
  fontVariantNumeric: 'tabular-nums',
}

const NOTE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minHeight: '44px',
}

const NOTE_FIELD_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: '44px',
  padding: '8px 0',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--border)',
  borderRadius: 0,
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

const NOTE_TEXT_BUTTON_STYLE: CSSProperties = {
  ...NOTE_FIELD_STYLE,
  display: 'block',
  textAlign: 'left',
  cursor: 'text',
}

const CHECK_TARGET_STYLE: CSSProperties = {
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
  fontFamily: 'inherit',
  cursor: 'pointer',
}

const DELETE_STYLE: CSSProperties = {
  flex: '0 0 44px',
  width: '44px',
  height: '44px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  background: 'none',
  border: 'none',
  color: 'var(--muted)',
  fontSize: '20px',
  lineHeight: 1,
  fontFamily: 'inherit',
  cursor: 'pointer',
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

const PRIMARY_BUTTON_STYLE: CSSProperties = {
  minHeight: '44px',
  minWidth: '88px',
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

/** 22×22 completion circle, matching the Phase 12 check-in visual. */
function CheckCircle({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="motion-reduce:transition-none"
      style={{
        flex: '0 0 22px',
        width: '22px',
        height: '22px',
        borderRadius: '50%',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: checked ? 'var(--accent)' : 'transparent',
        border: checked ? 'none' : '1.5px solid var(--muted)',
        transition:
          'background-color 120ms ease-out, border-color 120ms ease-out',
      }}
    >
      {checked ? (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <polyline
            points="2 6 5 9 10 3"
            fill="none"
            stroke="#ffffff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </span>
  )
}

/**
 * 总结 sheet (13-UI-SPEC §6 / T8 multi-task).
 *
 * Presentational: the view owns the session, links, drafts, and persistence.
 * Each linked task renders its own row (checkbox completion or quantity
 * 增加量/到达); a standalone todo renders one completion row. `onConfirm`
 * reports the per-task settlement plus the todo completion flag.
 */
export default function PomodoroSummarySheet({
  open,
  tasks,
  todo,
  habitName,
  calendarName,
  onRequestCalendarChange,
  notes,
  sharedFlags,
  saving,
  error,
  onNotesChange,
  onToggleShare,
  onConfirm,
  onCancel,
  returnFocusRef,
}: PomodoroSummarySheetProps) {
  const [taskStates, setTaskStates] = useState<
    Array<{ complete: boolean; incrementText: string; arrivalText: string }>
  >([])
  const [todoComplete, setTodoComplete] = useState(false)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  // T23: settle-stage note composition — draft + append through onNotesChange.
  const [draftNote, setDraftNote] = useState('')

  function appendNote() {
    const text = draftNote.trim()
    if (text === '') return
    onNotesChange([...notes, text], [...alignedFlags(), habitName != null])
    setDraftNote('')
  }
  const [editingValue, setEditingValue] = useState('')
  const cancelEditRef = useRef(false)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Reset the transaction state only on a NEW summary entry (open false→true),
  // so a failed save retry keeps the per-task choices intact.
  useEffect(() => {
    if (!open) return
    setTaskStates(tasks.map(() => ({ complete: false, incrementText: '', arrivalText: '' })))
    setTodoComplete(false)
    setEditingIndex(null)
    setEditingValue('')
    cancelEditRef.current = false
    const frame = requestAnimationFrame(() => panelRef.current?.focus())
    return () => cancelAnimationFrame(frame)
    // tasks is stable while the summary sheet is open (links are locked).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  function updateTaskState(index: number, patch: Partial<{ complete: boolean; incrementText: string; arrivalText: string }>) {
    setTaskStates((previous) => previous.map((state, i) => (i === index ? { ...state, ...patch } : state)))
  }

  function handleIncrementChange(index: number, raw: string) {
    const digits = raw.replace(/\D/g, '')
    const start = tasks[index]?.startValue ?? 0
    updateTaskState(index, {
      incrementText: digits,
      arrivalText: digits === '' ? '' : String(start + Number(digits)),
    })
  }

  function handleArrivalChange(index: number, raw: string) {
    const digits = raw.replace(/\D/g, '')
    const start = tasks[index]?.startValue ?? 0
    const increment = digits === '' ? 0 : Number(digits) - start
    updateTaskState(index, {
      arrivalText: digits,
      incrementText: digits === '' || increment <= 0 ? '' : String(increment),
    })
  }

  const invalidTask = tasks.some((task, index) => {
    if (task.progressType !== 'quantity') return false
    const state = taskStates[index]
    if (!state) return false
    const resolved = resolveProgressAmount(
      task.startValue ?? 0,
      state.incrementText,
      state.arrivalText,
    )
    return resolved.error !== null
  })
  const primaryDisabled = saving || invalidTask

  function finish() {
    if (primaryDisabled) return
    const settlements = tasks.map((task, index) => {
      const state = taskStates[index] ?? { complete: false, incrementText: '', arrivalText: '' }
      const amount =
        task.progressType === 'quantity'
          ? resolveProgressAmount(task.startValue ?? 0, state.incrementText, state.arrivalText).amount
          : null
      return { taskId: task.id, complete: state.complete, amount }
    })
    // T24: flush a pending settle-stage draft straight into the confirm payload
    // — pushing it through state first would race the parent's closure reader.
    const flush = draftNote.trim() !== ''
    const finalNotes = flush ? [...notes, draftNote.trim()] : notes
    const finalSharedFlags = flush ? [...alignedFlags(), habitName != null] : alignedFlags()
    onConfirm(settlements, todoComplete, finalNotes, finalSharedFlags)
  }

  function close() {
    if (saving) return
    onCancel()
    const target = returnFocusRef.current
    if (target) requestAnimationFrame(() => target.focus())
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return

    const root = panelRef.current
    if (!root) return
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'input, textarea, button, [href], [tabindex]:not([tabindex="-1"])',
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

  function alignedFlags(): boolean[] {
    return notes.map((_, index) => sharedFlags[index] ?? true)
  }

  /** Direct-habit preview only; the goal-inherited seam is single-task legacy. */
  function habitNotePreview(): { habit: string; text: string } | null {
    const aligned = alignedFlags()
    const sharedText = notes
      .filter((_, index) => aligned[index] && notes[index].trim() !== '')
      .join(' / ')
    if (habitName != null) {
      return {
        habit: habitName,
        text: sharedText !== '' ? sharedText : '（未分享笔记，将仅打卡）',
      }
    }
    if (tasks.length !== 1) return null
    const task = tasks[0]
    const goalHabitName = task.goalHabitName
    if (goalHabitName == null) return null
    const state = taskStates[0]
    if (task.progressType === 'quantity') {
      const amount = resolveProgressAmount(task.startValue ?? 0, state?.incrementText ?? '', state?.arrivalText ?? '').amount
      if (amount == null) return null
      const start = task.currentValue ?? 0
      return {
        habit: goalHabitName,
        text: describeTaskEvent({
          goalName: task.goalName ?? '',
          milestoneName: task.milestoneName,
          taskName: task.name,
          kind: 'progress',
          startValue: start,
          endValue: start + amount,
          unit: task.unit,
        }),
      }
    }
    if (!state?.complete) return null
    return {
      habit: goalHabitName,
      text: describeTaskEvent({
        goalName: task.goalName ?? '',
        milestoneName: task.milestoneName,
        taskName: task.name,
        kind: 'complete',
        unit: task.unit,
      }),
    }
  }

  function startEdit(index: number) {
    setEditingIndex(index)
    setEditingValue(notes[index] ?? '')
  }

  function commitEdit(index: number) {
    const trimmed = editingValue.trim()
    const nextNotes = [...notes]
    const nextFlags = alignedFlags()
    if (trimmed === '') {
      nextNotes.splice(index, 1)
      nextFlags.splice(index, 1)
    } else {
      nextNotes[index] = trimmed
    }
    onNotesChange(nextNotes, nextFlags)
    setEditingIndex(null)
    setEditingValue('')
  }

  function removeNote(index: number) {
    const nextNotes = notes.filter((_, i) => i !== index)
    const nextFlags = alignedFlags().filter((_, i) => i !== index)
    onNotesChange(nextNotes, nextFlags)
    if (editingIndex === index) {
      setEditingIndex(null)
      setEditingValue('')
    }
  }

  function renderNoteRows() {
    return notes.map((note, index) => {
      const shared = sharedFlags[index] ?? true
      return (
        <div key={index} style={NOTE_ROW_STYLE}>
          {habitName ? (
            <button
              type="button"
              role="checkbox"
              aria-checked={shared}
              aria-label={`将这条笔记分给${habitName}`}
              onClick={() => onToggleShare(index)}
              className={`${FOCUS_RING} motion-reduce:transition-none`}
              style={CHECK_TARGET_STYLE}
            >
              <CheckCircle checked={shared} />
            </button>
          ) : null}
          {editingIndex === index ? (
            <input
              type="text"
              autoFocus
              value={editingValue}
              onChange={(event) => setEditingValue(event.target.value)}
              onBlur={() => {
                if (cancelEditRef.current) {
                  cancelEditRef.current = false
                  return
                }
                commitEdit(index)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                } else if (event.key === 'Escape') {
                  cancelEditRef.current = true
                  setEditingIndex(null)
                  setEditingValue('')
                }
              }}
              style={NOTE_FIELD_STYLE}
            />
          ) : (
            <button
              type="button"
              onClick={() => startEdit(index)}
              className={FOCUS_RING}
              style={NOTE_TEXT_BUTTON_STYLE}
            >
              {note}
            </button>
          )}
          {notes.length > 1 ? (
            <button
              type="button"
              aria-label="删除这条笔记"
              onClick={() => removeNote(index)}
              className={FOCUS_RING}
              style={DELETE_STYLE}
            >
              ×
            </button>
          ) : null}
        </div>
      )
    })
  }

  return (
    <>
      <style>{`
        @keyframes orbit-summary-scrim-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes orbit-summary-sheet-in {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .orbit-summary-scrim { animation: orbit-summary-scrim-in 150ms ease-out both; }
        .orbit-summary-sheet { animation: orbit-summary-sheet-in 200ms ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .orbit-summary-scrim, .orbit-summary-sheet { animation: none !important; }
        }
      `}</style>

      <div
        className="orbit-summary-scrim fixed inset-0 z-50 flex items-end sm:items-center justify-center"
        role="presentation"
        onKeyDown={handleKeyDown}
        onClick={(event) => {
          if (event.target === event.currentTarget) close()
        }}
        style={{ background: 'rgba(0,0,0,0.32)' }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={TITLE_ID}
          tabIndex={-1}
          className="orbit-summary-sheet w-full sm:max-w-[448px] rounded-t-2xl sm:rounded-2xl"
          style={{
            display: 'flex',
            flexDirection: 'column',
            maxHeight: '80vh',
            overflow: 'hidden',
            background: 'var(--card)',
            border: '1px solid var(--border)',
            padding: '16px',
            paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
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
            完成番茄
          </h2>

          <div
            style={{
              marginTop: '16px',
              flex: '1 1 auto',
              minHeight: 0,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '24px',
            }}
          >
            {tasks.map((task, index) => {
              const state = taskStates[index] ?? { complete: false, incrementText: '', arrivalText: '' }
              const isQuantity = task.progressType === 'quantity'
              const startValue = task.startValue ?? 0
              return (
                <section key={task.id} style={SECTION_STYLE}>
                  <p style={SECTION_TITLE_STYLE}>{task.name}</p>
                  {isQuantity ? (
                    <>
                      <p style={META_TEXT_STYLE}>
                        {task.targetValue != null
                          ? `总量 ${task.targetValue} ${task.unit ?? '页'} · `
                          : ''}
                        开始时已完成 {startValue} {task.unit ?? '页'}
                      </p>
                      <div style={ROW_STYLE}>
                        <label htmlFor={`${AMOUNT_ID}-${index}`} style={LABEL_STYLE}>
                          本次增加量
                        </label>
                        <input
                          id={`${AMOUNT_ID}-${index}`}
                          type="text"
                          inputMode="numeric"
                          value={state.incrementText}
                          onChange={(event) => handleIncrementChange(index, event.target.value)}
                          className={FOCUS_RING}
                          style={AMOUNT_STYLE}
                        />
                      </div>
                      <div style={ROW_STYLE}>
                        <label htmlFor={`${ARRIVAL_ID}-${index}`} style={LABEL_STYLE}>
                          本次到达
                        </label>
                        <input
                          id={`${ARRIVAL_ID}-${index}`}
                          type="text"
                          inputMode="numeric"
                          value={state.arrivalText}
                          onChange={(event) => handleArrivalChange(index, event.target.value)}
                          className={FOCUS_RING}
                          style={AMOUNT_STYLE}
                        />
                      </div>
                    </>
                  ) : (
                    <label style={CHECK_ROW_STYLE}>
                      <span style={LABEL_STYLE}>完成了吗</span>
                      <input
                        type="checkbox"
                        checked={state.complete}
                        onChange={(event) => updateTaskState(index, { complete: event.target.checked })}
                        aria-label={`${task.name} 完成了吗`}
                        className="sr-only"
                      />
                      <CheckCircle checked={state.complete} />
                    </label>
                  )}
                </section>
              )
            })}

            {todo ? (
              <section style={SECTION_STYLE}>
                <p style={SECTION_TITLE_STYLE}>{todo.name}</p>
                <label style={CHECK_ROW_STYLE}>
                  <span style={LABEL_STYLE}>完成了吗</span>
                  <input
                    type="checkbox"
                    checked={todoComplete}
                    onChange={(event) => setTodoComplete(event.target.checked)}
                    aria-label={`${todo.name} 完成了吗`}
                    className="sr-only"
                  />
                  <CheckCircle checked={todoComplete} />
                </label>
              </section>
            ) : null}

            {invalidTask ? (
              <p style={INLINE_ERROR_STYLE}>请输入大于 0 的整数</p>
            ) : null}

            <section style={SECTION_STYLE}>
              <p style={META_TEXT_STYLE}>将写入日历</p>
              <button
                type="button"
                onClick={onRequestCalendarChange}
                aria-label="选择写入日历"
                className={FOCUS_RING}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  alignSelf: 'flex-start',
                  minHeight: '32px',
                  padding: '0 12px',
                  background: 'var(--card)',
                  border: '1px solid var(--border)',
                  borderRadius: '9999px',
                  fontSize: '15px',
                  fontWeight: 400,
                  lineHeight: 1.4,
                  color: 'var(--foreground)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {calendarName ? (
                  <>
                    <span
                      aria-hidden="true"
                      style={{
                        width: '10px',
                        height: '10px',
                        borderRadius: '50%',
                        background:
                          POMODORO_CALENDARS.find((c) => c.name === calendarName)?.color ??
                          'var(--muted)',
                      }}
                    />
                    {calendarName}
                  </>
                ) : (
                  <span style={{ color: 'var(--muted)' }}>不关联日历</span>
                )}
              </button>
            </section>

            <section style={SECTION_STYLE}>
              {habitName ? (
                <p style={META_TEXT_STYLE}>将自动打卡「{habitName}」</p>
              ) : null}
              {(() => {
                const preview = habitNotePreview()
                return preview != null ? (
                  <p style={META_TEXT_STYLE}>
                    将写入习惯打卡「{preview.habit}」:{preview.text}
                  </p>
                ) : null
              })()}
              <p style={SECTION_TITLE_STYLE}>笔记</p>
              {notes.length > 0 ? (
                <div className="flex flex-col" style={{ gap: '8px' }}>
                  {renderNoteRows()}
                </div>
              ) : null}
              <div className="flex items-center" style={{ gap: '8px' }}>
                <input
                  value={draftNote}
                  onChange={(event) => setDraftNote(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      appendNote()
                    }
                  }}
                  placeholder="结算前再记一条"
                  aria-label="添加笔记"
                  className={FOCUS_RING}
                  style={{
                    flex: '1 1 auto',
                    minWidth: 0,
                    minHeight: '36px',
                    padding: '0 10px',
                    background: 'var(--card)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    fontSize: '15px',
                    fontWeight: 400,
                    lineHeight: 1.4,
                    color: 'var(--foreground)',
                    fontFamily: 'inherit',
                  }}
                />
                <button
                  type="button"
                  onClick={appendNote}
                  disabled={draftNote.trim() === ''}
                  className={FOCUS_RING}
                  style={{
                    minHeight: '36px',
                    padding: '0 12px',
                    background: 'none',
                    border: 'none',
                    fontSize: '15px',
                    fontWeight: 400,
                    color: 'var(--accent)',
                    cursor: draftNote.trim() === '' ? 'default' : 'pointer',
                    opacity: draftNote.trim() === '' ? 0.4 : 1,
                    fontFamily: 'inherit',
                  }}
                >
                  添加
                </button>
              </div>
            </section>
          </div>

          <div
            style={{
              marginTop: '16px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: '8px',
              flexShrink: 0,
            }}
          >
            {error ? (
              <p style={{ ...INLINE_ERROR_STYLE, width: '100%' }}>
                保存失败，请重试。
              </p>
            ) : null}
            {error ? (
              <button
                type="button"
                onClick={finish}
                disabled={saving}
                className={`self-start ${FOCUS_RING}`}
                style={{
                  ...ACCENT_TEXT_BUTTON_STYLE,
                  opacity: saving ? 0.4 : 1,
                }}
              >
                重试
              </button>
            ) : null}
            <button
              type="button"
              onClick={finish}
              disabled={primaryDisabled}
              aria-busy={saving}
              aria-label="完成番茄"
              className={FOCUS_RING}
              style={{
                ...PRIMARY_BUTTON_STYLE,
                cursor: primaryDisabled ? 'default' : 'pointer',
                opacity: primaryDisabled ? 0.4 : 1,
              }}
            >
              完成
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
