'use client'

import { useEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  CompositionEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { getRepository } from '@/lib/repository-provider'
import { buildHabitDayState, habitCompletionId } from '@/lib/habit'
import type { Habit, HabitCompletion } from '@/lib/types'

interface HabitChecklistProps {
  habits: Habit[] // live, sorted by sortHabits
  date: string // getTodayStr(), YYYY-MM-DD
  completions: HabitCompletion[] // ALL rows for this date, including tombstones
}

interface HabitSeed {
  completedIds: string[]
  notes: Record<string, string>
  rowsById: Map<string, HabitCompletion>
  completedAtByHabit: Map<string, string>
  noteCache: Map<string, string>
}

/**
 * One-time seed derived from the props. The component owns its display state
 * after mount, so every optimistic toggle/keystroke renders without a refetch.
 * Tombstone-inclusive rows are kept in `rowsById` / `noteCache` so an unchecked
 * habit's stored note can be restored on re-check.
 */
function buildSeed(
  habits: Habit[],
  completions: HabitCompletion[],
  date: string,
): HabitSeed {
  const dayState = buildHabitDayState(habits, completions, date)
  const rowsById = new Map<string, HabitCompletion>()
  const completedAtByHabit = new Map<string, string>()
  const noteCache = new Map<string, string>()

  for (const row of completions) {
    if (row.date !== date) continue
    rowsById.set(row.id, row)
    completedAtByHabit.set(row.habit_id, row.completed_at)
    noteCache.set(row.habit_id, row.note ?? '')
  }

  return {
    completedIds: dayState.completedIds,
    notes: dayState.notes,
    rowsById,
    completedAtByHabit,
    noteCache,
  }
}

const DEBOUNCE_MS = 600

const FOCUS_RING_OUTSET =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'
const FOCUS_RING_INSET =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:-2px]'

const LIST_STYLE: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
}

const ROW_LINE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minHeight: '44px',
  padding: '4px 0',
}

const CHECK_LABEL_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '0 0 44px',
  width: '44px',
  height: '44px',
  cursor: 'pointer',
}

const CHECK_CIRCLE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '22px',
  height: '22px',
  borderRadius: '50%',
  flexShrink: 0,
  transition: 'background-color 120ms ease-out, border-color 120ms ease-out',
}

const NOTE_BLOCK_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  marginTop: '8px',
  paddingLeft: '52px',
  paddingBottom: '8px',
  minWidth: 0,
}

const NOTE_LINE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minHeight: '44px',
}

const NOTE_INPUT_STYLE: CSSProperties = {
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

const FOOTER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minHeight: '44px',
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

const SAVE_STATUS_STYLE: CSSProperties = {
  marginLeft: 'auto',
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

const ERROR_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '8px',
}

const RETRY_BUTTON_STYLE: CSSProperties = {
  minHeight: '44px',
  padding: '0 4px',
  background: 'none',
  border: 'none',
  color: 'var(--accent)',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  fontFamily: 'inherit',
  cursor: 'pointer',
}

/**
 * Today-view habit checklist (Phase 12, HABIT-02/03/05; 12-UI-SPEC §3).
 *
 * Rows are optimistic: the circle/name flip before the write settles, and a
 * rejected write rolls the row back and shows 更新打卡失败，请重试。 Notes are
 * per-line single-line inputs joined by "\n"; each habit debounces its own
 * 600ms save, serialized per habit, flushed on blur / visibility hidden /
 * pagehide / unmount, and never fired mid-IME composition.
 *
 * The completion id is deterministic (`habitCompletionId`), so unchecking
 * soft-deletes the same row that checking upserts — and a re-check resumes the
 * tombstoned note instead of starting blank.
 */
export default function HabitChecklist({
  habits,
  date,
  completions,
}: HabitChecklistProps) {
  const [seed] = useState<HabitSeed>(() => buildSeed(habits, completions, date))
  const [completedIds, setCompletedIds] = useState<Set<string>>(
    () => new Set(seed.completedIds),
  )
  const [notes, setNotes] = useState<Record<string, string>>(
    () => ({ ...seed.notes }),
  )
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saveErrors, setSaveErrors] = useState<Set<string>>(() => new Set())
  const [toggleError, setToggleError] = useState<string | null>(null)
  const [pendingFocus, setPendingFocus] = useState<{
    habitId: string
    lineIndex: number
  } | null>(null)

  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const pendingNoteRef = useRef<Map<string, string>>(new Map())
  const composingRef = useRef<Set<string>>(new Set())
  const chainsRef = useRef<Map<string, Promise<void>>>(new Map())
  const rowsRef = useRef<Map<string, HabitCompletion>>(seed.rowsById)
  const completedAtByHabitRef = useRef<Map<string, string>>(seed.completedAtByHabit)
  const noteCacheRef = useRef<Map<string, string>>(seed.noteCache)

  function clearSaving(habitId: string) {
    setSaving((previous) => {
      if (previous[habitId] === undefined) return previous
      const next = { ...previous }
      delete next[habitId]
      return next
    })
  }

  function markSaveError(habitId: string) {
    setSaveErrors((previous) => {
      if (previous.has(habitId)) return previous
      const next = new Set(previous)
      next.add(habitId)
      return next
    })
  }

  // Persist one habit's note. Writes are serialized per habit and the payload
  // is captured by the caller so a debounce timer never reads React state.
  function persistNote(habitId: string, note: string): Promise<void> {
    // Never write a partial IME composition.
    if (composingRef.current.has(habitId)) return Promise.resolve()

    setSaving((previous) => ({ ...previous, [habitId]: true }))

    const id = habitCompletionId(habitId, date)
    const existing = rowsRef.current.get(id)
    const completedAt =
      existing?.completed_at ??
      completedAtByHabitRef.current.get(habitId) ??
      new Date().toISOString()

    const previousChain = chainsRef.current.get(habitId) ?? Promise.resolve()
    const nextChain = previousChain
      .then(async () => {
        await getRepository().upsert<HabitCompletion>('habitCompletions', {
          id,
          habit_id: habitId,
          date,
          note,
          completed_at: completedAt,
        })
        rowsRef.current.set(id, {
          id,
          habit_id: habitId,
          date,
          note,
          completed_at: completedAt,
          updated_at: new Date().toISOString(),
          deleted_at: null,
        })
        noteCacheRef.current.set(habitId, note)
        clearSaving(habitId)
        setSaveErrors((previous) => {
          if (!previous.has(habitId)) return previous
          const next = new Set(previous)
          next.delete(habitId)
          return next
        })
      })
      .catch(() => {
        clearSaving(habitId)
        markSaveError(habitId)
      })

    chainsRef.current.set(habitId, nextChain)
    return nextChain
  }

  function scheduleSave(habitId: string, note: string) {
    pendingNoteRef.current.set(habitId, note)
    setSaving((previous) => ({ ...previous, [habitId]: true }))

    const existingTimer = timersRef.current.get(habitId)
    if (existingTimer !== undefined) clearTimeout(existingTimer)

    const timer = setTimeout(() => {
      timersRef.current.delete(habitId)
      const pending = pendingNoteRef.current.get(habitId)
      if (pending === undefined) return
      pendingNoteRef.current.delete(habitId)
      void persistNote(habitId, pending)
    }, DEBOUNCE_MS)

    timersRef.current.set(habitId, timer)
  }

  async function flushPendingNote(habitId: string): Promise<void> {
    const timer = timersRef.current.get(habitId)
    if (timer !== undefined) {
      clearTimeout(timer)
      timersRef.current.delete(habitId)
    }
    const pending = pendingNoteRef.current.get(habitId)
    if (pending === undefined) return
    pendingNoteRef.current.delete(habitId)
    await persistNote(habitId, pending)
  }

  // Flush every pending note on visibility hidden / pagehide / unmount. These
  // callbacks read only refs, so the first-render closure cannot write stale
  // text.
  useEffect(() => {
    const flushAll = () => {
      for (const habitId of Array.from(pendingNoteRef.current.keys())) {
        void flushPendingNote(habitId)
      }
    }
    const handleVisibility = () => {
      if (document.hidden) flushAll()
    }
    const handlePageHide = () => flushAll()

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('pagehide', handlePageHide)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('pagehide', handlePageHide)
      flushAll()
    }
    // Refs-only; flushPendingNote reads refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Focus the line Enter / 添加笔记 just inserted, after it mounts. Done in an
  // effect — never inside a ref callback.
  useEffect(() => {
    if (pendingFocus === null) return
    const selector = `[data-note-input="${pendingFocus.habitId}-${pendingFocus.lineIndex}"]`
    const frame = requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(selector)
      if (input) {
        input.focus()
        const end = input.value.length
        input.setSelectionRange(end, end)
      }
      setPendingFocus(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [pendingFocus])

  // ── Toggle ────────────────────────────────────────────────────────────────

  function handleToggle(habit: Habit) {
    setToggleError(null)
    if (completedIds.has(habit.id)) {
      void uncheck(habit)
    } else {
      void check(habit)
    }
  }

  async function check(habit: Habit) {
    const previousCompleted = new Set(completedIds)
    const previousRows = rowsRef.current
    const previousCompletedAt = new Map(completedAtByHabitRef.current)

    const id = habitCompletionId(habit.id, date)
    const existingRow = rowsRef.current.get(id)
    const restoredNote =
      existingRow?.note ?? noteCacheRef.current.get(habit.id) ?? null
    const completedAt = new Date().toISOString()

    // Optimistic: circle + name + note block flip in this render pass.
    setCompletedIds((previous) => new Set(previous).add(habit.id))
    setNotes((previous) =>
      previous[habit.id] !== undefined
        ? previous
        : { ...previous, [habit.id]: restoredNote ?? '' },
    )

    const nextRows = new Map(previousRows)
    nextRows.set(id, {
      id,
      habit_id: habit.id,
      date,
      note: restoredNote,
      completed_at: completedAt,
      updated_at: completedAt,
      deleted_at: null,
    })
    rowsRef.current = nextRows
    completedAtByHabitRef.current.set(habit.id, completedAt)

    try {
      // `deleted_at: null` is REQUIRED: a bare upsert would keep a tombstone
      // from a previous uncheck and the row would stay hidden.
      await getRepository().upsert<HabitCompletion>('habitCompletions', {
        id,
        habit_id: habit.id,
        date,
        note: restoredNote,
        completed_at: completedAt,
        deleted_at: null,
      })
    } catch {
      setCompletedIds(previousCompleted)
      rowsRef.current = previousRows
      completedAtByHabitRef.current = previousCompletedAt
      setToggleError('更新打卡失败，请重试。')
    }
  }

  async function uncheck(habit: Habit) {
    const previousCompleted = new Set(completedIds)

    // The latest note must land before the tombstone, or the note saved after
    // the soft-delete would be merged into a hidden row.
    await flushPendingNote(habit.id)

    setCompletedIds((previous) => {
      const next = new Set(previous)
      next.delete(habit.id)
      return next
    })

    try {
      await getRepository().softDelete(
        'habitCompletions',
        habitCompletionId(habit.id, date),
      )
    } catch {
      setCompletedIds(previousCompleted)
      setToggleError('更新打卡失败，请重试。')
    }
  }

  // ── Note editing ──────────────────────────────────────────────────────────

  function linesOf(habitId: string): string[] {
    const note = notes[habitId] ?? ''
    return note === '' ? [''] : note.split('\n')
  }

  function applyNote(habitId: string, note: string) {
    setNotes((previous) => ({ ...previous, [habitId]: note }))
    noteCacheRef.current.set(habitId, note)
    scheduleSave(habitId, note)
  }

  function handleLineChange(habitId: string, index: number, value: string) {
    const lines = linesOf(habitId)
    lines[index] = value
    const note = lines.join('\n')
    setNotes((previous) => ({ ...previous, [habitId]: note }))
    noteCacheRef.current.set(habitId, note)
    // Save only after the IME composition commits (compositionend schedules).
    if (composingRef.current.has(habitId)) return
    scheduleSave(habitId, note)
  }

  function insertLineAfter(habitId: string, index: number) {
    const lines = linesOf(habitId)
    lines.splice(index + 1, 0, '')
    setPendingFocus({ habitId, lineIndex: index + 1 })
    applyNote(habitId, lines.join('\n'))
  }

  function addLine(habitId: string) {
    const lines = linesOf(habitId)
    lines.push('')
    setPendingFocus({ habitId, lineIndex: lines.length - 1 })
    applyNote(habitId, lines.join('\n'))
  }

  function removeLine(habitId: string, index: number) {
    const lines = linesOf(habitId)
    // The × is not rendered for a single-line note; guard anyway.
    if (lines.length <= 1) return
    lines.splice(index, 1)
    const focusIndex = Math.min(index, lines.length - 1)
    setPendingFocus({ habitId, lineIndex: focusIndex })
    applyNote(habitId, lines.join('\n'))
  }

  function handleLineKeyDown(
    event: ReactKeyboardEvent<HTMLInputElement>,
    habitId: string,
    index: number,
  ) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      insertLineAfter(habitId, index)
    }
  }

  function handleCompositionStart(habitId: string) {
    composingRef.current.add(habitId)
  }

  function handleCompositionEnd(
    event: CompositionEvent<HTMLInputElement>,
    habitId: string,
  ) {
    composingRef.current.delete(habitId)
    const value = event.currentTarget.value
    setNotes((previous) => ({ ...previous, [habitId]: value }))
    noteCacheRef.current.set(habitId, value)
    scheduleSave(habitId, value)
  }

  function retrySave(habitId: string) {
    const latest = noteCacheRef.current.get(habitId) ?? notes[habitId] ?? ''
    setSaveErrors((previous) => {
      if (!previous.has(habitId)) return previous
      const next = new Set(previous)
      next.delete(habitId)
      return next
    })
    void persistNote(habitId, latest)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{`
        @media (prefers-reduced-motion: reduce) {
          .habit-check-circle { transition: none !important; }
        }
      `}</style>
      <ul style={LIST_STYLE}>
        {habits.map((habit, index) => {
          const done = completedIds.has(habit.id)
          const lines = linesOf(habit.id)
          const isSaving = saving[habit.id] === true
          const hasError = saveErrors.has(habit.id)
          return (
            <li
              key={habit.id}
              style={{
                borderTop: index === 0 ? 'none' : '1px solid var(--border)',
                minWidth: 0,
              }}
            >
              <div style={ROW_LINE_STYLE}>
                <label
                  className="focus-within:[outline:2px_solid_var(--accent)] focus-within:[outline-offset:2px]"
                  style={CHECK_LABEL_STYLE}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    aria-label={habit.name}
                    checked={done}
                    onChange={() => handleToggle(habit)}
                  />
                  <span
                    aria-hidden="true"
                    className="habit-check-circle"
                    style={{
                      ...CHECK_CIRCLE_STYLE,
                      ...(done
                        ? { background: 'var(--accent)', border: 'none' }
                        : {
                            background: 'transparent',
                            border: '1.5px solid var(--muted)',
                          }),
                    }}
                  >
                    {done ? (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        aria-hidden="true"
                        focusable="false"
                      >
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
                </label>
                <span
                  style={{
                    minWidth: 0,
                    fontSize: '17px',
                    fontWeight: 400,
                    lineHeight: 1.47,
                    overflowWrap: 'anywhere',
                    color: done ? 'var(--muted)' : 'var(--foreground)',
                    textDecoration: done ? 'line-through' : 'none',
                  }}
                >
                  {habit.name}
                </span>
              </div>

              {done ? (
                <div style={NOTE_BLOCK_STYLE}>
                  {lines.map((line, lineIndex) => (
                    <div key={lineIndex} style={NOTE_LINE_STYLE}>
                      <input
                        value={line}
                        data-note-input={`${habit.id}-${lineIndex}`}
                        aria-label={`${habit.name} 第 ${lineIndex + 1} 行笔记`}
                        placeholder={
                          lineIndex === 0 ? '记录一下今天做了什么…' : ''
                        }
                        onChange={(event) =>
                          handleLineChange(
                            habit.id,
                            lineIndex,
                            event.target.value,
                          )
                        }
                        onKeyDown={(event) =>
                          handleLineKeyDown(event, habit.id, lineIndex)
                        }
                        onCompositionStart={() =>
                          handleCompositionStart(habit.id)
                        }
                        onCompositionEnd={(event) =>
                          handleCompositionEnd(event, habit.id)
                        }
                        onBlur={() => void flushPendingNote(habit.id)}
                        className={`${FOCUS_RING_OUTSET} placeholder:text-[var(--muted)]`}
                        style={NOTE_INPUT_STYLE}
                      />
                      {lines.length > 1 ? (
                        <button
                          type="button"
                          onClick={() => removeLine(habit.id, lineIndex)}
                          aria-label={`删除${habit.name}的第 ${lineIndex + 1} 行笔记`}
                          className={FOCUS_RING_INSET}
                          style={ICON_BUTTON_STYLE}
                        >
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 18 18"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <line
                              x1="5"
                              y1="5"
                              x2="13"
                              y2="13"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                            />
                            <line
                              x1="13"
                              y1="5"
                              x2="5"
                              y2="13"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                            />
                          </svg>
                        </button>
                      ) : null}
                    </div>
                  ))}

                  <div aria-live="polite" style={FOOTER_STYLE}>
                    <button
                      type="button"
                      onClick={() => addLine(habit.id)}
                      aria-label={`为${habit.name}添加笔记`}
                      className={`${FOCUS_RING_OUTSET} accent-button-glyph`}
                      style={ACCENT_TEXT_BUTTON_STYLE}
                    >
                      <span aria-hidden="true">+ </span>
                      <span className="accent-button-glyph__label">添加笔记</span>
                    </button>
                    <span style={SAVE_STATUS_STYLE}>
                      {isSaving ? '保存中…' : ''}
                    </span>
                  </div>

                  {hasError ? (
                    <div style={ERROR_ROW_STYLE}>
                      <p style={INLINE_ERROR_STYLE}>保存失败，请重试。</p>
                      <button
                        type="button"
                        onClick={() => retrySave(habit.id)}
                        className={`${FOCUS_RING_OUTSET} accent-button`}
                        style={RETRY_BUTTON_STYLE}
                      >
                        重试保存
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>

      {toggleError ? <p style={INLINE_ERROR_STYLE}>{toggleError}</p> : null}
    </>
  )
}
