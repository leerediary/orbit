'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, TouchEvent as ReactTouchEvent } from 'react'
import { getRepository } from '@/lib/repository-provider'
import { sortHabits } from '@/lib/habit'
import {
  MODE_RANGES,
  buildPomodoroSession,
  buildSharedIndices,
} from '@/lib/pomodoro'
import {
  MAX_BREAK_SEC,
  MIN_BREAK_SEC,
  usePomodoroTimer,
  type PomodoroModeKey,
} from '@/lib/pomodoro-timer'
import { settlePomodoroSession } from '@/lib/pomodoro-settlement'
import { getDayOffsetHours, getTodayStr } from '@/lib/today'
import { useSyncRefresh } from '@/lib/sync-state'
import { buildTodayEntries } from '@/lib/today-list'
import { isDesktopElectron, showFloatingWindow } from '@/lib/desktop'
import {
  buildCalendarEventPayload,
  buildSettlementTitle,
  createCalendarEvent,
  loadPomodoroCalendar,
  savePomodoroCalendar,
  type PomodoroCalendarName,
} from '@/lib/calendar'
import { describeTaskEvent } from '@/lib/habit-auto-checkin'
import type { Category, DailyTodo, Goal, Habit, Milestone, Task } from '@/lib/types'
import { type SegmentedOption } from '@/components/SegmentedControl'
import PomodoroDial from '@/components/PomodoroDial'
import PomodoroPickerSheet, {
  type PomodoroPickerGroup,
} from '@/components/PomodoroPickerSheet'
import PomodoroCalendarSheet from '@/components/PomodoroCalendarSheet'
import PomodoroSummarySheet from '@/components/PomodoroSummarySheet'
import PomodoroStatsView from '@/components/PomodoroStatsView'

// Quick task 261101-e27 moved the five-phase timer state machine into
// lib/pomodoro-timer.tsx (mounted in the root layout) so a running session
// survives section switches. This view now only owns the presentation plus the
// drafts, link pickers, statistics drill-in, and summary settlement.
//
// Hydration contract (13-UI-SPEC §2 / RESEARCH Pitfall 4): the first render must
// match the static-export HTML, so it is ALWAYS the 25-minute 番茄 stepper.
// localStorage and matchMedia are only read inside effects or event handlers.

/** A linked task (multi-task, T8). */
type TaskLink = {
  id: string
  name: string
  progressType: 'checkbox' | 'quantity'
  goalName: string | null
}

/** A linked standalone todo (single, XOR with tasks). */
type TodoLink = { id: string; name: string }

/**
 * A leaf task counts as complete when its checkbox is on or its quantity has
 * reached the target (same rule as TaskRow's done state).
 */
function isTaskComplete(task: Task): boolean {
  if (task.progress_type === 'quantity') {
    return (task.current_value ?? 0) >= (task.target_value ?? 0)
  }
  return task.completed === true
}

type HabitLink = { id: string; name: string } | null

const MODE_OPTIONS: readonly SegmentedOption<PomodoroModeKey>[] = [
  { value: 'tomato', label: MODE_RANGES.tomato.label },
  { value: 'cherry', label: MODE_RANGES.cherry.label },
]

const DRAFT_NOTES_KEY = 'orbit_pomodoro_draft_notes'
const LAST_NOTE_KEY = 'orbit_pomodoro_last_note'

// Quick task 261101-epa — one resident dial carries every phase, so the ring
// itself becomes the control hub. 420px diameter on wide screens; the ring
// shrinks responsively (min(420px, 100%)) on narrow columns / mobile.
const DIAL_SIZE = 420

// Wheel art constants — ported from diary-web/app/pomodoro/page.tsx (`:50-66`)
// and shrunk so the wheel column fits inside the 280px dial ring. These are
// migration-exempt from the 8px spacing grid.
const WHEEL_ROW_HEIGHT = 72
const WHEEL_BOX_OPEN = 250
const WHEEL_BOX_IDLE = 76
const WHEEL_BOX_WIDTH = 90
const WHEEL_BASE_FONT = 64
const WHEEL_CENTER_SCALE = 1
const WHEEL_SCALE_FALLOFF = 60
const WHEEL_OPACITY_FALLOFF = 150
const WHEEL_RUBBER_BAND = 0.3
const WHEEL_SETTLE_MS = 350
const WHEEL_SPRING = 'cubic-bezier(0.32, 0.72, 0, 1)'
const WHEEL_PERSPECTIVE_RADIUS = 180
const WHEEL_PERSPECTIVE_ANGLE_PER_ROW = (22 * Math.PI) / 180

// Shared "MM : SS" readout — minutes box + colon + seconds, used by BOTH the
// idle wheel and the running/summary countdown so the digits never jump.
const TIME_BOX_STYLE: CSSProperties = {
  width: `${WHEEL_BOX_WIDTH}px`,
  height: `${WHEEL_BOX_IDLE}px`,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: '14px',
  fontSize: '64px',
  fontWeight: 300,
  lineHeight: 1,
  color: 'var(--foreground)',
  fontVariantNumeric: 'tabular-nums',
}

const TIME_COLON_STYLE: CSSProperties = {
  padding: '0 11.5px 0 5px',
  fontSize: '64px',
  lineHeight: 1,
  userSelect: 'none',
  WebkitUserSelect: 'none',
  fontVariantNumeric: 'tabular-nums',
}

const TIME_SECONDS_STYLE: CSSProperties = {
  fontSize: '64px',
  fontWeight: 300,
  lineHeight: 1,
  color: 'var(--foreground)',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  fontVariantNumeric: 'tabular-nums',
}

const TIME_MINUTES_STYLE: CSSProperties = {
  width: `${WHEEL_BOX_WIDTH}px`,
  height: `${WHEEL_BOX_IDLE}px`,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '64px',
  fontWeight: 300,
  lineHeight: 1,
  color: 'var(--foreground)',
  fontVariantNumeric: 'tabular-nums',
}

const FOCUS_RING_OUTSET =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'

const HERO_TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '48px',
  fontWeight: 600,
  lineHeight: 1.05,
  letterSpacing: '-0.02em',
  color: 'var(--foreground)',
}

const CARD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '24px',
  padding: '16px',
  background: 'var(--card)',
  borderRadius: '12px',
  boxShadow: 'var(--card-shadow)',
}

const DIAL_NUMBER_STYLE: CSSProperties = {
  fontSize: 'clamp(40px, 6vw, 80px)',
  fontWeight: 300,
  lineHeight: 1.05,
  letterSpacing: '-0.02em',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--foreground)',
}

const DIAL_UNIT_STYLE: CSSProperties = {
  fontSize: '16px',
  color: 'var(--muted)',
}

const DIAL_STEPPER_ROW_STYLE: CSSProperties = {
  display: 'flex',
  gap: '24px',
}

/** 32px in-ring stepper button: no border / background, keyboard focus ring. */
const DIAL_STEPPER_ICON_STYLE: CSSProperties = {
  flex: '0 0 32px',
  width: '32px',
  height: '32px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  margin: 0,
  background: 'none',
  border: 'none',
  color: 'var(--foreground)',
  fontFamily: 'inherit',
}

/** White capsule with a 1px border — the only primary button treatment now. */
const PRIMARY_WHITE_PILL_STYLE: CSSProperties = {
  minHeight: '44px',
  padding: '0 20px',
  background: 'var(--card)',
  color: 'var(--foreground)',
  border: '1px solid var(--border)',
  borderRadius: '9999px',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  cursor: 'pointer',
}

/**
 * Desktop-only two-column layout. Kept as a CSS string (not JS resize state) so
 * the static export's first frame matches the hydrated frame on both breakpoints.
 */
const COLUMN_STYLE: CSSProperties = {
  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 340px)',
}

const POMODORO_LAYOUT_CSS = `
  .orbit-pomodoro-layout { display: flex; flex-direction: column; gap: 24px; }
  .orbit-pomodoro-main { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
  .orbit-pomodoro-aside { display: none; }
  @media (min-width: 900px) {
    .orbit-pomodoro-layout {
      display: grid;
      align-items: start;
      gap: 24px;
      grid-template-columns: ${COLUMN_STYLE.gridTemplateColumns};
    }
    .orbit-pomodoro-aside { display: block; min-width: 0; }
  }
  /* Completion celebration (feedback 2026-11-01): the finished dial pops in once. */
  @keyframes orbit-dial-celebrate {
    0% { transform: scale(1.06); opacity: 0.25; }
    60% { transform: scale(0.98); }
    100% { transform: scale(1); opacity: 1; }
  }
  .orbit-dial-celebrate { animation: orbit-dial-celebrate 320ms ease-out both; }
  @media (prefers-reduced-motion: reduce) {
    .orbit-dial-celebrate { animation: none !important; }
  }
`

const MUTED_TEXT_BUTTON_STYLE: CSSProperties = {
  minHeight: '44px',
  padding: '0 4px',
  background: 'none',
  border: 'none',
  color: 'var(--muted)',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  cursor: 'pointer',
}

const ACCENT_TEXT_BUTTON_STYLE: CSSProperties = {
  ...MUTED_TEXT_BUTTON_STYLE,
  color: 'var(--accent)',
}

const SECTION_TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.2,
  color: 'var(--foreground)',
}

const META_TEXT_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  overflowWrap: 'anywhere',
}

const LINK_VALUE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  minHeight: '44px',
}

const MUTED_VALUE_STYLE: CSSProperties = {
  ...LINK_VALUE_STYLE,
  color: 'var(--muted)',
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

const NOTE_DELETE_STYLE: CSSProperties = {
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

/** Single link trigger above the dial — white capsule, same family as the
 *  primary button. Truncates long names so it never widens the card. */
const LINK_PILL_STYLE: CSSProperties = {
  minWidth: 0,
  maxWidth: '100%',
  minHeight: '44px',
  padding: '0 20px',
  background: 'var(--card)',
  color: 'var(--foreground)',
  border: '1px solid var(--border)',
  borderRadius: '9999px',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  fontFamily: 'inherit',
  cursor: 'pointer',
}

const LINK_PILL_LABEL_STYLE: CSSProperties = {
  display: 'block',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const LOAD_ERROR = '番茄钟加载失败。请重新加载；如果仍然失败，刷新页面后再试。'

// ── localStorage readers (only ever called from effects/handlers) ──
function readStoredDraftNotes(): string[] {
  try {
    const raw = localStorage.getItem(DRAFT_NOTES_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    // T-13-13: accept only an array of strings; anything else is discarded.
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) {
      return parsed
    }
  } catch {
    // Corrupt JSON or unavailable storage — start from an empty draft.
  }
  return []
}

function readStoredLastNote(): string {
  try {
    const value = localStorage.getItem(LAST_NOTE_KEY)
    if (value) return value
  } catch {
    // ignore
  }
  return ''
}

export default function PomodoroView() {
  // Shared, layout-mounted timer (survives section switches).
  const {
    phase,
    mode,
    durationMin,
    remaining,
    totalSec,
    breakSec,
    announcement,
    summarySession,
    startFocus,
    earlyFinish,
    cancelFocus,
    startBreak,
    skipBreak,
    enterBreakIdle,
    switchMode,
    changeDuration,
    changeBreakMinutes,
  } = usePomodoroTimer()

  // Ring fill for the 220px dial: fraction of the current session still left.
  const dialRatio = totalSec > 0 ? remaining / totalSec : 0

  const [useWheel, setUseWheel] = useState(false)
  const [notes, setNotes] = useState<string[]>([])
  // Aligned by index with `notes` (Pitfall 7). Every mutation updates both.
  const [draftShared, setDraftShared] = useState<boolean[]>([])
  const [draftInput, setDraftInput] = useState('')
  const [lastNote, setLastNote] = useState('')
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editingValue, setEditingValue] = useState('')
  // True once the mount effect has applied the stored draft, so the persistence
  // effect cannot erase the key in the first commit.
  const [notesReady, setNotesReady] = useState(false)
  // One combined sheet lists tasks (grouped by goal) and habits together.
  const [pickerOpen, setPickerOpen] = useState(false)
  const [taskLinks, setTaskLinks] = useState<TaskLink[]>([])
  const [todoLink, setTodoLink] = useState<TodoLink | null>(null)
  const [habitLink, setHabitLink] = useState<HabitLink>(null)
  // Calendar write target (localStorage-persisted, chosen in idle/running).
  const [calendar, setCalendar] = useState<PomodoroCalendarName | null>(null)
  const [calendarOpen, setCalendarOpen] = useState(false)
  // Best-effort calendar write is non-blocking; when it fails we surface a
  // visible notice instead of failing silently (T-BUG failure visibility).
  const [calendarWriteFailed, setCalendarWriteFailed] = useState(false)
  // Derived association labels (T5: renamed to 关联任务 / 关联日历).
  const linkLabelParts: string[] = [
    ...taskLinks.map((t) => t.name),
    ...(todoLink ? [todoLink.name] : []),
    ...(habitLink ? [habitLink.name] : []),
  ]
  const linkLabel = linkLabelParts.length > 0 ? linkLabelParts.join(' · ') : '关联任务'
  const linkLinked = linkLabelParts.length > 0
  // T6: the linked quantity task's current_value at session start (captured on
  // phase → running), shown + used for the 到达 cross-compute in the summary sheet.
  const [taskStartValues, setTaskStartValues] = useState<Record<string, number>>({})
  // Settlement (13-05): saving state + error shown inside the summary sheet.
  const [saving, setSaving] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)

  // Statistics drill-in (Phase 14 / D-03): client state only, no route.
  const [statsOpen, setStatsOpen] = useState(false)
  // A ref OBJECT (not a captured node): the button remounts when statsOpen flips
  // back to false, so the ref re-attaches to the live node before focus restore.
  const statsTriggerRef = useRef<HTMLButtonElement | null>(null)
  // True only inside the Electron shell (preload sets window.orbitDesktop).
  const [isElectron, setIsElectron] = useState(false)

  useEffect(() => {
    setIsElectron(isDesktopElectron())
  }, [])

  // Clear the calendar-write failure notice once a new focus session starts.
  useEffect(() => {
    if (phase === 'running') setCalendarWriteFailed(false)
  }, [phase])

  // Capture each linked quantity task's current_value the moment focus starts,
  // so the summary sheet can show the true "番茄开始时" completion (T6/T8).
  useEffect(() => {
    if (phase !== 'running') return
    const startValues: Record<string, number> = {}
    for (const link of taskLinks) {
      const linkedTask = (tasks ?? []).find((row) => row.id === link.id)
      if (linkedTask?.progress_type === 'quantity') {
        startValues[link.id] = linkedTask.current_value ?? 0
      }
    }
    setTaskStartValues(startValues)
    // Intentionally keyed on phase only: capture once at session start, not on
    // every task-list reload during the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // Today's data source for the link pickers. Null = still loading.
  const [daily, setDaily] = useState<DailyTodo[] | null>(null)
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [milestones, setMilestones] = useState<Milestone[] | null>(null)
  const [goals, setGoals] = useState<Goal[] | null>(null)
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [habits, setHabits] = useState<Habit[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Logical local day + offset for the picker's completion roll-off (D-04).
  const [today, setToday] = useState('')
  const [offsetHours, setOffsetHours] = useState(0)

  // Async load guard + IME/edit-cancel/picker focus refs.
  const alive = useRef(false)
  const compositionRef = useRef(false)
  const cancelEditRef = useRef(false)
  const pickerReturnFocusRef = useRef<HTMLElement | null>(null)
  const calendarReturnFocusRef = useRef<HTMLElement | null>(null)
  // Same-tick double-tap guard: React state is async, a ref is not.
  const savingRef = useRef(false)
  const summaryReturnFocusRef = useRef<HTMLElement | null>(null)

  // Wheel interaction state (mobile only).
  const [isWheelOpen, setIsWheelOpen] = useState(false)
  const [isSnapping, setIsSnapping] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [dragOffset, setDragOffset] = useState(0)
  const dragStartYRef = useRef<number | null>(null)
  const dragStartDurationRef = useRef<number>(MODE_RANGES.tomato.default)
  const wheelRef = useRef<HTMLDivElement | null>(null)
  const minuteBoxRef = useRef<HTMLDivElement | null>(null)
  const wheelScrollRef = useRef(0)
  const wheelActiveRef = useRef(false)
  const wheelDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // T7: the wheel only responds while the pointer is over the minute box.
  function pointerInMinuteBox(clientX: number, clientY: number): boolean {
    const box = minuteBoxRef.current
    if (!box) return false
    const rect = box.getBoundingClientRect()
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    )
  }

  // Active mode's range drives the stepper clamps and wheel geometry.
  const range = MODE_RANGES[mode]

  // Mouse-wheel / trackpad two-finger scroll drives the wheel continuously
  // (1:1, like the touch drag); a short debounce after the last wheel event
  // snaps to the nearest minute. Non-passive so preventDefault stops page scroll.
  useEffect(() => {
    if (phase !== 'idle') return
    const el = wheelRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      if (!pointerInMinuteBox(event.clientX, event.clientY)) return
      event.preventDefault()
      if (!wheelActiveRef.current) {
        wheelActiveRef.current = true
        wheelScrollRef.current = 0
        dragStartDurationRef.current = durationMin
        setIsWheelOpen(true)
        setIsSnapping(false)
        setIsDragging(true)
        setDragOffset(0)
      }
      wheelScrollRef.current += event.deltaY
      setDragOffset(-wheelScrollRef.current)
      if (wheelDebounceRef.current) clearTimeout(wheelDebounceRef.current)
      wheelDebounceRef.current = setTimeout(() => {
        if (!wheelActiveRef.current) return
        wheelActiveRef.current = false
        const startIndex = dragStartDurationRef.current - range.min
        const valueCount = range.max - range.min + 1
        const rawIndexShift = Math.round(wheelScrollRef.current / WHEEL_ROW_HEIGHT)
        const targetIndex = Math.max(0, Math.min(valueCount - 1, startIndex + rawIndexShift))
        const snappedDuration = range.min + targetIndex
        const actualShift = targetIndex - startIndex
        setIsDragging(false)
        setIsSnapping(true)
        setDragOffset(-actualShift * WHEEL_ROW_HEIGHT)
        setIsWheelOpen(false)
        window.setTimeout(() => {
          changeDuration(snappedDuration)
          setDragOffset(0)
          setIsSnapping(false)
        }, WHEEL_SETTLE_MS)
      }, 160)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (wheelDebounceRef.current) clearTimeout(wheelDebounceRef.current)
    }
  }, [phase, range, durationMin, changeDuration])

  // ── Mount-only draft + capability read (never during render) ──
  useEffect(() => {
    setNotes(readStoredDraftNotes())
    setLastNote(readStoredLastNote())
    setNotesReady(true)
    setCalendar(loadPomodoroCalendar())

    // Pitfall 4: the wheel appears only after hydration. `pointer: coarse`
    // is the natural line between touch (wheel) and mouse (stepper).
    let media: MediaQueryList | null = null
    const onMediaChange = (event: MediaQueryListEvent) => setUseWheel(event.matches)
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      media = window.matchMedia('(pointer: coarse)')
      setUseWheel(media.matches)
      media.addEventListener('change', onMediaChange)
    }
    return () => {
      media?.removeEventListener('change', onMediaChange)
    }
  }, [])

  // ── Today data for the link pickers (one read pass, effects only) ──
  async function load() {
    try {
      const repo = getRepository()
      // Computed here (never during render) because getTodayStr reads localStorage.
      const todayStr = getTodayStr()
      const offset = getDayOffsetHours()
      const [allDaily, allTasks, allMilestones, allGoals, allCategories, allHabits] =
        await Promise.all([
          repo.list<DailyTodo>('dailyTodos'),
          repo.list<Task>('tasks'),
          repo.list<Milestone>('milestones'),
          repo.list<Goal>('goals'),
          repo.list<Category>('categories'),
          repo.list<Habit>('habits'),
        ])
      if (!alive.current) return
      // Defensive tombstone filter mirrors the other views even though the
      // repository already excludes tombstones by default.
      setDaily(allDaily.filter((row) => row.deleted_at == null))
      setTasks(allTasks.filter((row) => row.deleted_at == null))
      setMilestones(allMilestones.filter((row) => row.deleted_at == null))
      setGoals(allGoals.filter((row) => row.deleted_at == null))
      setCategories(allCategories.filter((row) => row.deleted_at == null))
      setHabits(sortHabits(allHabits.filter((row) => row.deleted_at == null)))
      setToday(todayStr)
      setOffsetHours(offset)
      setLoadError(null)
    } catch {
      if (!alive.current) return
      setLoadError(LOAD_ERROR)
    }
  }

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
    }
    // Mount-only: load() only touches stable setters and getRepository.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Day rollover while the view stays open: recompute "today" on focus /
  // visibility so a task completed on a prior day rolls off the picker (D-04).
  useEffect(() => {
    const refreshToday = () => {
      setToday(getTodayStr())
      setOffsetHours(getDayOffsetHours())
    }
    document.addEventListener('visibilitychange', refreshToday)
    window.addEventListener('focus', refreshToday)
    return () => {
      document.removeEventListener('visibilitychange', refreshToday)
      window.removeEventListener('focus', refreshToday)
    }
  }, [])

  // D-05 / B2: reload the link pickers when remote rows are applied.
  useSyncRefresh(() => {
    void load()
  })

  function retryLoad() {
    setLoadError(null)
    setDaily(null)
    setTasks(null)
    setMilestones(null)
    setGoals(null)
    setCategories(null)
    setHabits(null)
    void load()
  }

  /** Leave the statistics drill-in and restore focus to the 统计 trigger. The
   *  button only exists once statsOpen is false, so wait one frame for it to
   *  remount, then focus it if the ref points at a node still in the document. */
  function closeStats() {
    setStatsOpen(false)
    requestAnimationFrame(() => {
      const trigger = statsTriggerRef.current
      if (trigger && document.contains(trigger)) trigger.focus()
    })
  }

  // Draft persistence: every change writes the JSON array; an empty list
  // removes the key (D-03). Skipped until the mount read has applied.
  useEffect(() => {
    if (!notesReady) return
    try {
      if (notes.length > 0) {
        localStorage.setItem(DRAFT_NOTES_KEY, JSON.stringify(notes))
      } else {
        localStorage.removeItem(DRAFT_NOTES_KEY)
      }
    } catch {
      // ignore storage failures
    }
  }, [notes, notesReady])

  // ── Link picker candidates: today's non-container leaves + standalone todos,
  // grouped by goal name (fallback 未分类). Linked daily rows are represented by
  // their Task, never as todo candidates. Habits come from the live list.
  // Completed tasks/todos are not pickable for a NEW pomodoro, but one already
  // linked stays listed so it can still be unlinked (T26). ──
  const taskPicker = useMemo(() => {
    const entries = buildTodayEntries(daily ?? [], tasks ?? [], milestones ?? [], goals ?? [], today, offsetHours)
    const taskById = new Map<string, TaskLink>()
    const todoById = new Map<string, TodoLink>()
    const groupsByTitle = new Map<string, PomodoroPickerGroup>()
    const todoGroup: PomodoroPickerGroup = { title: '独立待办', options: [] }
    const linkedTaskIds = new Set(taskLinks.map((link) => link.id))

    for (const entry of entries) {
      if (entry.kind === 'task' && entry.task && !entry.isContainer) {
        const task = entry.task
        if (isTaskComplete(task) && !linkedTaskIds.has(task.id)) continue
        // The option id is the TASK id (tasks table), not the dailyTodos row id.
        taskById.set(task.id, {
          id: task.id,
          name: task.name,
          progressType: task.progress_type,
          goalName: entry.goalName,
        })
        const title = entry.goalName ?? '未分类'
        let group = groupsByTitle.get(title)
        if (!group) {
          group = { title, options: [] }
          groupsByTitle.set(title, group)
        }
        const label = entry.breadcrumb ? `${entry.breadcrumb} · ${task.name}` : task.name
        group.options.push({ id: task.id, label, kind: 'task' })
      } else if (entry.kind === 'todo' && entry.todo && entry.todo.task_id === null) {
        const todo = entry.todo
        if (todo.completed && todoLink?.id !== todo.id) continue
        const name = todo.name ?? ''
        todoById.set(todo.id, { id: todo.id, name })
        todoGroup.options.push({ id: todo.id, label: name, kind: 'todo' })
      }
    }

    const groups = Array.from(groupsByTitle.values())
    if (todoGroup.options.length > 0) groups.push(todoGroup)
    return { groups, taskById, todoById }
  }, [daily, tasks, milestones, goals, today, offsetHours, taskLinks, todoLink])

  const habitPicker = useMemo(() => {
    const linkById = new Map<string, HabitLink>()
    const options = (habits ?? []).map((habit) => {
      linkById.set(habit.id, { id: habit.id, name: habit.name })
      return { id: habit.id, label: habit.name, kind: 'habit' as const }
    })
    const groups: PomodoroPickerGroup[] =
      options.length > 0 ? [{ title: '习惯', options }] : []
    return { groups, linkById }
  }, [habits])

  const dataLoaded =
    daily !== null &&
    tasks !== null &&
    milestones !== null &&
    goals !== null &&
    categories !== null &&
    habits !== null

  function handlePickerSelect(id: string, kind: 'task' | 'todo' | 'habit') {
    if (kind === 'habit') {
      setHabitLink(habitPicker.linkById.get(id) ?? null)
    } else if (kind === 'todo') {
      // A todo is single and XOR with tasks: picking one clears any task link.
      setTodoLink(taskPicker.todoById.get(id) ?? null)
      setTaskLinks([])
    } else {
      // Tasks are multi-select: toggle the tapped task in/out (T8).
      const link = taskPicker.taskById.get(id)
      if (!link) return
      setTaskLinks((previous) =>
        previous.some((t) => t.id === link.id)
          ? previous.filter((t) => t.id !== link.id)
          : [...previous, link],
      )
      setTodoLink(null)
    }
  }

  /** Choose (or clear) the calendar write target and persist the choice. */
  function handleSelectCalendar(name: PomodoroCalendarName | null) {
    setCalendar(name)
    savePomodoroCalendar(name)
  }

  // ── Draft note mutations: notes and flags always move together (Pitfall 7).
  // A new row defaults to shared when a habit is linked (D-04 / A6). ──
  function appendNote(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    // T25: default notes to SHARE, resolved at settle time — the flag must not
    // be frozen by whether a habit was linked at the moment of writing (a note
    // added before linking would otherwise never reach the check-in).
    setNotes((previous) => [...previous, trimmed])
    setDraftShared((previous) => [...previous, true])
  }

  function deleteNote(index: number) {
    setNotes((previous) => previous.filter((_, i) => i !== index))
    setDraftShared((previous) => previous.filter((_, i) => i !== index))
    if (editingIndex === index) {
      setEditingIndex(null)
      setEditingValue('')
    }
  }

  function commitEdit(index: number, value: string) {
    const trimmed = value.trim()
    if (trimmed === '') {
      deleteNote(index)
    } else {
      setNotes((previous) => previous.map((note, i) => (i === index ? trimmed : note)))
    }
    setEditingIndex(null)
    setEditingValue('')
  }

  function handleAddNote() {
    const text = draftInput.trim()
    if (!text) return
    appendNote(text)
    setDraftInput('')
  }

  /** Apply a summary-sheet note edit, keeping the share flags aligned. */
  function handleSummaryNotesChange(nextNotes: string[], nextShared: boolean[]) {
    setNotes(nextNotes)
    setDraftShared(nextShared)
  }

  /** Toggle one note's share-to-habit flag, normalizing a stale flags array. */
  function handleSummaryToggleShare(index: number) {
    setDraftShared(() =>
      notes.map((_, i) => (i === index ? !(draftShared[i] ?? habitLink !== null) : draftShared[i] ?? habitLink !== null)),
    )
  }

  /** Resolve the persisted rows for the locked summary links. */
  function resolveLinkedRows(): { tasks: Task[]; linkedTodo: DailyTodo | null } {
    const resolvedTasks = taskLinks
      .map((link) => (tasks ?? []).find((task) => task.id === link.id))
      .filter((task): task is Task => task != null)
    const linkedTodo = todoLink
      ? ((daily ?? []).find((todo) => todo.id === todoLink.id) ?? null)
      : null
    return { tasks: resolvedTasks, linkedTodo }
  }

  /** Persist the session and every linked side effect, then enter break-idle. */
  async function handleSummaryConfirm(
    settlements: Array<{ taskId: string; complete: boolean; amount: number | null }>,
    markedTodoComplete: boolean,
    finalNotes: string[],
    finalSharedFlags: boolean[],
  ) {
    // Same-tick double-tap guard: state is async, this ref is not.
    if (savingRef.current) return
    const seed = summarySession
    if (seed === null) return

    savingRef.current = true
    setSaving(true)
    setSummaryError(null)
    try {
      const sharedIndices = buildSharedIndices(finalNotes, finalSharedFlags, habitLink != null)
      const { tasks: resolvedTasks, linkedTodo } = resolveLinkedRows()
      const session = buildPomodoroSession({
        id: seed.id,
        startedAt: seed.startedAt,
        durationSec: seed.durationSec,
        notes: finalNotes,
        habitId: habitLink?.id ?? null,
        taskId: settlements[0]?.taskId ?? null,
        taskIds: settlements.map((s) => s.taskId),
        dailyTodoId: todoLink?.id ?? null,
        markedTaskComplete: markedTodoComplete,
        progressAmount: null,
        sharedIndices,
      })
      await settlePomodoroSession(getRepository(), session, {
        linkedTask: resolvedTasks[0] ?? null,
        tasks: settlements.flatMap((s) => {
          const task = resolvedTasks.find((t) => t.id === s.taskId)
          return task ? [{ task, complete: s.complete, amount: s.amount }] : []
        }),
        linkedTodo,
        offsetHours: getDayOffsetHours(),
        nowIso: new Date().toISOString(),
      })

      // Best-effort calendar write: fire-and-forget so a failure can never
      // affect settlement or the UI (Phase 22 best-effort precedent). The
      // calendar choice is read from state now, before the links are cleared.
      // T20: the title and notes describe what was actually settled — one line
      // per acted task, identical to the habit check-in lines, with the user's
      // own note lines appended.
      if (calendar !== null) {
        const acted = settlements.filter(
          (settlement) => settlement.complete || (settlement.amount ?? 0) > 0,
        )
        const taskById = new Map((tasks ?? []).map((row) => [row.id, row]))
        const noteLines: string[] = []
        const titleChains: string[][] = []
        for (const settlement of acted) {
          const task = taskById.get(settlement.taskId)
          if (!task) continue
          const milestone =
            task.milestone_id != null
              ? (milestones ?? []).find((row) => row.id === task.milestone_id)
              : undefined
          const goal = (goals ?? []).find(
            (row) => row.id === (milestone?.goal_id ?? task.goal_id),
          )
          const ancestors: string[] = []
          let cursor = task.parent_id
          let guard = 0
          while (cursor != null && guard < 8) {
            const parent = taskById.get(cursor)
            if (!parent || parent.deleted_at != null) break
            ancestors.unshift(parent.name)
            cursor = parent.parent_id
            guard += 1
          }
          const isProgress = !settlement.complete && settlement.amount != null
          const startValue = isProgress ? (task.current_value ?? 0) : null
          const endValue =
            isProgress && settlement.amount != null
              ? (startValue ?? 0) + settlement.amount
              : null
          noteLines.push(
            describeTaskEvent({
              goalName: goal?.name ?? '',
              milestoneName: milestone?.name ?? null,
              ancestorNames: ancestors,
              taskName: task.name,
              kind: isProgress ? 'progress' : 'complete',
              startValue,
              endValue,
              unit: task.unit ?? null,
            }),
          )
          titleChains.push([
            ...(milestone ? [milestone.name] : []),
            ...ancestors,
            task.name,
          ])
        }
        void createCalendarEvent(
          buildCalendarEventPayload({
            sessionId: seed.id,
            calendar,
            startedAt: seed.startedAt,
            durationSec: seed.durationSec,
            linkName: taskLinks[0]?.name ?? habitLink?.name ?? null,
            title: buildSettlementTitle(titleChains),
            notes: [...noteLines, ...finalNotes.filter((note) => note.trim() !== '')],
          }),
        ).then((result) => {
          if (result === 'failed') setCalendarWriteFailed(true)
        })
      }

      // Success: remember the last note, clear drafts + links, enter break-idle.
      const lastNoteValue =
        [...finalNotes].reverse().find((note) => note.trim() !== '') ?? ''
      try {
        if (lastNoteValue) localStorage.setItem(LAST_NOTE_KEY, lastNoteValue)
        else localStorage.removeItem(LAST_NOTE_KEY)
        localStorage.removeItem(DRAFT_NOTES_KEY)
      } catch {
        // ignore storage failures
      }
      setLastNote(lastNoteValue)
      setNotes([])
      setDraftShared([])
      setDraftInput('')
      setEditingIndex(null)
      setEditingValue('')
      setTaskLinks([])
      setTodoLink(null)
      setHabitLink(null)
      setSummaryError(null)
      enterBreakIdle()
    } catch {
      // Keep the sheet, drafts, and links; the frozen session id makes a retry
      // a no-op once the commit marker landed.
      setSummaryError('保存失败，请重试。')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  /** Escape / backdrop: leave summary without settlement but keep the drafts. */
  function cancelSummary() {
    if (savingRef.current) return
    setSummaryError(null)
    setTaskLinks([])
    setTodoLink(null)
    setHabitLink(null)
    enterBreakIdle()
  }

  // ── Wheel touch math (ported verbatim; see RESEARCH Pattern 1) ──
  function handleWheelTouchStart(event: ReactTouchEvent<HTMLDivElement>) {
    if (!useWheel || phase !== 'idle') return
    const touch = event.touches[0]
    if (!pointerInMinuteBox(touch.clientX, touch.clientY)) return
    dragStartYRef.current = touch.clientY
    dragStartDurationRef.current = durationMin
    setIsWheelOpen(true)
    setIsSnapping(false)
    setIsDragging(true)
    setDragOffset(0)
  }

  function handleWheelTouchMove(event: ReactTouchEvent<HTMLDivElement>) {
    if (!useWheel || phase !== 'idle') return
    const startY = dragStartYRef.current
    if (startY === null) return
    const dy = event.touches[0].clientY - startY
    const startIndex = dragStartDurationRef.current - range.min
    const valueCount = range.max - range.min + 1
    const maxValidDy = startIndex * WHEEL_ROW_HEIGHT
    const minValidDy = -((valueCount - 1) - startIndex) * WHEEL_ROW_HEIGHT
    let effectiveDy = dy
    if (dy > maxValidDy) effectiveDy = maxValidDy + (dy - maxValidDy) * WHEEL_RUBBER_BAND
    else if (dy < minValidDy) effectiveDy = minValidDy + (dy - minValidDy) * WHEEL_RUBBER_BAND
    setDragOffset(effectiveDy)
  }

  function handleWheelTouchEnd() {
    if (dragStartYRef.current === null) return
    dragStartYRef.current = null
    const startIndex = dragStartDurationRef.current - range.min
    const valueCount = range.max - range.min + 1
    const rawIndexShift = Math.round(-dragOffset / WHEEL_ROW_HEIGHT)
    const targetIndex = Math.max(0, Math.min(valueCount - 1, startIndex + rawIndexShift))
    const snappedDuration = range.min + targetIndex
    const actualShift = targetIndex - startIndex
    setIsDragging(false)
    setIsSnapping(true)
    setDragOffset(-actualShift * WHEEL_ROW_HEIGHT)
    setIsWheelOpen(false)
    window.setTimeout(() => {
      // Context owns the duration state + localStorage persistence.
      changeDuration(snappedDuration)
      setDragOffset(0)
      setIsSnapping(false)
    }, WHEEL_SETTLE_MS)
  }

  function renderModeSwitch() {
    return (
      <div
        role="group"
        aria-label="番茄钟模式"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '2px',
          padding: '2px',
          background: 'var(--background)',
          border: '1px solid var(--border)',
          borderRadius: '9999px',
        }}
      >
        {MODE_OPTIONS.map((option) => {
          const active = mode === option.value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => switchMode(option.value)}
              className={FOCUS_RING_OUTSET}
              style={{
                minHeight: '28px',
                padding: '0 14px',
                borderRadius: '9999px',
                border: 'none',
                background: active ? 'var(--card)' : 'transparent',
                color: active ? 'var(--foreground)' : 'var(--muted)',
                fontSize: '13px',
                fontWeight: active ? 600 : 400,
                lineHeight: 1.2,
                fontFamily: 'inherit',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    )
  }

  function renderTimeReadout(totalSeconds: number) {
    const minutes = Math.floor(Math.max(0, totalSeconds) / 60)
    const seconds = Math.max(0, totalSeconds) % 60
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={TIME_MINUTES_STYLE}>{String(minutes).padStart(2, '0')}</div>
        <span style={TIME_COLON_STYLE}>:</span>
        <span style={TIME_SECONDS_STYLE}>{String(seconds).padStart(2, '0')}</span>
      </div>
    )
  }

  function renderWheel() {
    const valueCount = range.max - range.min + 1
    const values = Array.from({ length: valueCount }, (_, index) => range.min + index)
    const totalColumnHeight = valueCount * WHEEL_ROW_HEIGHT
    const visibleHeight = WHEEL_BOX_IDLE
    const boxCenter = visibleHeight / 2
    const centerIndex = Math.floor(valueCount / 2)
    const indexOfDuration = durationMin - range.min
    const baseTranslateY = (centerIndex - indexOfDuration) * WHEEL_ROW_HEIGHT
    const translateY = baseTranslateY + dragOffset
    const columnNaturalTop = (visibleHeight - totalColumnHeight) / 2
    const rowTransition = isDragging
      ? 'none'
      : `opacity ${WHEEL_SETTLE_MS}ms ${WHEEL_SPRING}, transform ${WHEEL_SETTLE_MS}ms ${WHEEL_SPRING}`
    const columnTransition = isDragging
      ? 'none'
      : `transform ${WHEEL_SETTLE_MS}ms ${WHEEL_SPRING}`

    return (
      <div
        ref={wheelRef}
        onTouchStart={handleWheelTouchStart}
        onTouchMove={handleWheelTouchMove}
        onTouchEnd={handleWheelTouchEnd}
        onTouchCancel={handleWheelTouchEnd}
        aria-label={`时长 ${durationMin} 分钟，滚动或上下拖动调整`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          color: 'var(--foreground)',
          fontFamily: 'inherit',
          fontWeight: 300,
          lineHeight: 1,
          touchAction: 'none',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      >
        <div
          ref={minuteBoxRef}
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: `${WHEEL_BOX_WIDTH}px`,
            height: `${visibleHeight}px`,
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: '14px',
            overflow: 'hidden',
            transition: `height ${WHEEL_SETTLE_MS}ms ${WHEEL_SPRING}`,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              transform: `translateY(${translateY}px)`,
              transition: columnTransition,
              willChange: 'transform',
            }}
          >
            {values.map((value, index) => {
              const rowCenterInColumn = index * WHEEL_ROW_HEIGHT + WHEEL_ROW_HEIGHT / 2
              const rowScreenY = columnNaturalTop + translateY + rowCenterInColumn
              const linearDistSigned = rowScreenY - boxCenter
              const dist = Math.abs(linearDistSigned)
              const angle = Math.max(
                -Math.PI / 2,
                Math.min(
                  Math.PI / 2,
                  (linearDistSigned / WHEEL_ROW_HEIGHT) * WHEEL_PERSPECTIVE_ANGLE_PER_ROW,
                ),
              )
              const visualDistSigned = WHEEL_PERSPECTIVE_RADIUS * Math.sin(angle)
              const perspectiveY = visualDistSigned - linearDistSigned
              const scaleT = Math.max(0, 1 - dist / WHEEL_SCALE_FALLOFF)
              const scale = 1 + (WHEEL_CENTER_SCALE - 1) * scaleT
              const isCurrentCenter = index === indexOfDuration
              const opacity =
                isWheelOpen || isSnapping
                  ? Math.max(0, 1 - dist / WHEEL_OPACITY_FALLOFF)
                  : isCurrentCenter
                    ? 1
                    : 0
              return (
                <div
                  key={value}
                  style={{
                    height: `${WHEEL_ROW_HEIGHT}px`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: `${WHEEL_BASE_FONT}px`,
                    fontWeight: 300,
                    lineHeight: 1,
                    color: 'var(--foreground)',
                    opacity,
                    transform: `translateY(${perspectiveY}px) scale(${scale})`,
                    transformOrigin: 'center center',
                    transition: rowTransition,
                    minWidth: '60px',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {String(value).padStart(2, '0')}
                </div>
              )
            })}
          </div>
        </div>
        <span style={TIME_COLON_STYLE}>:</span>
        <span style={TIME_SECONDS_STYLE}>00</span>
      </div>
    )
  }

  /** One shared in-ring duration control: big number + unit + a −/+ stepper row.
   *  `onStep` receives the requested next value (already clamped by the buttons'
   *  disabled state); callers map it onto their own state setter. */
  function renderDialDuration({
    value,
    unit,
    min,
    max,
    onStep,
    decreaseLabel = '减少时长',
    increaseLabel = '增加时长',
    live = true,
  }: {
    value: number
    unit: string
    min: number
    max: number
    onStep: (next: number) => void
    decreaseLabel?: string
    increaseLabel?: string
    live?: boolean
  }) {
    const atMin = value <= min
    const atMax = value >= max
    return (
      <div className="flex flex-col items-center" style={{ gap: '4px' }}>
        <span
          aria-live={live ? 'polite' : 'off'}
          style={DIAL_NUMBER_STYLE}
        >
          {value}
        </span>
        <span style={DIAL_UNIT_STYLE}>{unit}</span>
        <div style={DIAL_STEPPER_ROW_STYLE}>
          <button
            type="button"
            aria-label={decreaseLabel}
            aria-disabled={atMin}
            disabled={atMin}
            onClick={() => onStep(value - 1)}
            className={FOCUS_RING_OUTSET}
            style={{
              ...DIAL_STEPPER_ICON_STYLE,
              opacity: atMin ? 0.4 : 1,
              cursor: atMin ? 'default' : 'pointer',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
              <line x1="4" y1="9" x2="14" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            aria-label={increaseLabel}
            aria-disabled={atMax}
            disabled={atMax}
            onClick={() => onStep(value + 1)}
            className={FOCUS_RING_OUTSET}
            style={{
              ...DIAL_STEPPER_ICON_STYLE,
              opacity: atMax ? 0.4 : 1,
              cursor: atMax ? 'default' : 'pointer',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
              <line x1="9" y1="4" x2="9" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="4" y1="9" x2="14" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
    )
  }

  /** Task/habit link pill + clear button (fragment; the caller owns the row). */
  function renderLinkTrigger() {
    return (
      <>
        <button
          type="button"
          onClick={(event) => {
            pickerReturnFocusRef.current = event.currentTarget
            setPickerOpen(true)
          }}
          aria-label="选择关联任务或习惯"
          className={FOCUS_RING_OUTSET}
          style={LINK_PILL_STYLE}
        >
          <span style={LINK_PILL_LABEL_STYLE}>{linkLabel}</span>
        </button>
        {linkLinked ? (
          <button
            type="button"
            aria-label="清除关联"
            onClick={() => {
              setTaskLinks([])
              setTodoLink(null)
              setHabitLink(null)
            }}
            className={FOCUS_RING_OUTSET}
            style={NOTE_DELETE_STYLE}
          >
            ×
          </button>
        ) : null}
      </>
    )
  }

  /** Calendar write-target pill + clear button (fragment). */
  function renderCalendarTrigger() {
    return (
      <>
        <button
          type="button"
          onClick={(event) => {
            calendarReturnFocusRef.current = event.currentTarget
            setCalendarOpen(true)
          }}
          aria-label="选择写入日历"
          className={FOCUS_RING_OUTSET}
          style={LINK_PILL_STYLE}
        >
          <span style={LINK_PILL_LABEL_STYLE}>
            关联日历{calendar ? ` · ${calendar}` : ''}
          </span>
        </button>
        {calendar ? (
          <button
            type="button"
            aria-label="清除日历关联"
            onClick={() => handleSelectCalendar(null)}
            className={FOCUS_RING_OUTSET}
            style={NOTE_DELETE_STYLE}
          >
            ×
          </button>
        ) : null}
      </>
    )
  }

  /** Idle association row: task/habit link + calendar side by side (T5). */
  function renderAssociationRow() {
    if (loadError) {
      return (
        <div className="flex flex-col" style={{ gap: '8px', width: '100%' }}>
          <p style={LINK_VALUE_STYLE}>{loadError}</p>
          <button
            type="button"
            onClick={retryLoad}
            className={`self-start ${FOCUS_RING_OUTSET} accent-button`}
            style={ACCENT_TEXT_BUTTON_STYLE}
          >
            重新加载番茄钟
          </button>
        </div>
      )
    }
    if (!dataLoaded) {
      return <p style={META_TEXT_STYLE}>正在加载番茄钟…</p>
    }
    return (
      <div
        className="flex items-center flex-wrap"
        style={{ gap: '8px', width: '100%', justifyContent: 'center' }}
      >
        {renderLinkTrigger()}
        {renderCalendarTrigger()}
      </div>
    )
  }

  /** Running association area: the same pill triggers as idle — a linked task
   *  and the calendar look and behave identically mid-session (tap to change,
   *  × to clear). Links are draft state until settlement, so editing them
   *  while the clock runs is safe. */
  function renderRunningAssociation() {
    return (
      <div
        className="flex items-center flex-wrap"
        style={{ gap: '8px', width: '100%', justifyContent: 'center' }}
      >
        {renderLinkTrigger()}
        {renderCalendarTrigger()}
      </div>
    )
  }

  /** Non-blocking notice for a failed calendar write (T-BUG: never silent). */
  function renderCalendarWriteNotice() {
    if (!calendarWriteFailed) return null
    return (
      <p
        role="status"
        style={{
          ...META_TEXT_STYLE,
          width: '100%',
          textAlign: 'center',
          color: 'var(--foreground)',
        }}
      >
        ⚠️ 日历写入失败，本次番茄未同步到日历
      </p>
    )
  }

  /** Notes now live inside the single main card, separated by a hairline rule
   *  rather than their own card. All note editing/IME handlers are unchanged. */
  function renderNotesSection() {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          width: '100%',
          borderTop: '1px solid var(--border)',
          paddingTop: '16px',
        }}
      >
        <h2 style={SECTION_TITLE_STYLE}>笔记</h2>
        {notes.length > 0 ? (
          <div className="flex flex-col" style={{ gap: '8px' }}>
            {notes.map((note, index) => (
              <div key={index} style={NOTE_ROW_STYLE}>
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
                      commitEdit(index, editingValue)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        event.currentTarget.blur()
                      } else if (event.key === 'Escape') {
                        // Escape cancels without committing (blur guard).
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
                    onClick={() => {
                      setEditingIndex(index)
                      setEditingValue(note)
                    }}
                    className={FOCUS_RING_OUTSET}
                    style={NOTE_TEXT_BUTTON_STYLE}
                  >
                    {note}
                  </button>
                )}
                {notes.length > 1 ? (
                  <button
                    type="button"
                    aria-label="删除这条笔记"
                    onClick={() => deleteNote(index)}
                    className={FOCUS_RING_OUTSET}
                    style={NOTE_DELETE_STYLE}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <div className="flex items-center" style={{ gap: '8px', minHeight: '44px' }}>
          <input
            type="text"
            value={draftInput}
            onChange={(event) => setDraftInput(event.target.value)}
            onCompositionStart={() => {
              compositionRef.current = true
            }}
            onCompositionEnd={() => {
              compositionRef.current = false
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              // Never commit while an IME composition session is active.
              if (event.nativeEvent.isComposing || compositionRef.current) return
              event.preventDefault()
              handleAddNote()
            }}
            placeholder={notes.length === 0 ? '记录一下这个番茄做了什么…' : ''}
            aria-label="新笔记"
            style={NOTE_FIELD_STYLE}
          />
          <button
            type="button"
            onClick={handleAddNote}
            className={`${FOCUS_RING_OUTSET} accent-button`}
            style={ACCENT_TEXT_BUTTON_STYLE}
          >
            添加笔记
          </button>
        </div>
        {lastNote && !notes.includes(lastNote) ? (
          <button
            type="button"
            onClick={() => appendNote(lastNote)}
            className={`self-start ${FOCUS_RING_OUTSET} accent-button`}
            style={ACCENT_TEXT_BUTTON_STYLE}
          >
            再次添加
          </button>
        ) : null}
      </div>
    )
  }

  function renderIdle() {
    return (
      <section style={{ ...CARD_STYLE, alignItems: 'center' }}>
        {renderAssociationRow()}
        {renderCalendarWriteNotice()}
        <PomodoroDial size={DIAL_SIZE} ratio={dialRatio}>
          <>
            <div
              style={{
                position: 'absolute',
                top: '28px',
                left: '50%',
                transform: 'translateX(-50%)',
              }}
            >
              {renderModeSwitch()}
            </div>
            {renderWheel()}
          </>
        </PomodoroDial>
        <button
          type="button"
          onClick={startFocus}
          className={FOCUS_RING_OUTSET}
          style={{ ...PRIMARY_WHITE_PILL_STYLE, width: 'auto', alignSelf: 'center' }}
        >
          开始专注
        </button>
        {renderNotesSection()}
      </section>
    )
  }

  function renderRunning() {
    return (
      <section style={{ ...CARD_STYLE, alignItems: 'center' }}>
        <span role="status" aria-live="polite" className="sr-only">
          {announcement}
        </span>
        {/* Task/habit link is locked while a session runs; calendar stays changeable. */}
        {renderRunningAssociation()}
        <PomodoroDial size={DIAL_SIZE} ratio={dialRatio}>
          {renderTimeReadout(remaining)}
        </PomodoroDial>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            type="button"
            onClick={cancelFocus}
            className={FOCUS_RING_OUTSET}
            style={MUTED_TEXT_BUTTON_STYLE}
          >
            取消
          </button>
          <button
            type="button"
            onClick={earlyFinish}
            className={FOCUS_RING_OUTSET}
            style={MUTED_TEXT_BUTTON_STYLE}
          >
            提前结束
          </button>
        </div>
        {renderNotesSection()}
      </section>
    )
  }

  /** Summary is a bottom sheet (UI-SPEC §6): the tab body shows the finished
   *  timer only, so links and notes are never duplicated behind the modal. */
  function renderSummaryBackdrop() {
    return (
      <section style={{ ...CARD_STYLE, alignItems: 'center' }}>
        <PomodoroDial size={DIAL_SIZE} ratio={0} className="orbit-dial-celebrate">
          {renderTimeReadout(0)}
        </PomodoroDial>
      </section>
    )
  }

  function renderBreakIdle() {
    const breakMinutes = Math.round(breakSec / 60)
    const minMinutes = Math.round(MIN_BREAK_SEC / 60)
    const maxMinutes = Math.round(MAX_BREAK_SEC / 60)
    return (
      <section style={{ ...CARD_STYLE, alignItems: 'center' }}>
        <h2 style={SECTION_TITLE_STYLE}>休息</h2>
        {renderCalendarWriteNotice()}
        {/* D-02 requires an adjustable 1–60 minute break. The control now lives
            inside the dial, mirroring the focus duration hub. */}
        <PomodoroDial size={DIAL_SIZE} ratio={1}>
          {renderDialDuration({
            value: breakMinutes,
            unit: '分钟',
            min: minMinutes,
            max: maxMinutes,
            onStep: (next) => changeBreakMinutes(next - breakMinutes),
            decreaseLabel: '减少休息时长',
            increaseLabel: '增加休息时长',
          })}
        </PomodoroDial>
        <button
          type="button"
          onClick={startBreak}
          className={FOCUS_RING_OUTSET}
          style={{ ...PRIMARY_WHITE_PILL_STYLE, width: 'auto', alignSelf: 'center' }}
        >
          开始休息
        </button>
        <button
          type="button"
          onClick={skipBreak}
          className={FOCUS_RING_OUTSET}
          style={{ ...MUTED_TEXT_BUTTON_STYLE, alignSelf: 'center' }}
        >
          跳过休息
        </button>
      </section>
    )
  }

  function renderBreakRunning() {
    return (
      <section style={{ ...CARD_STYLE, alignItems: 'center' }}>
        <PomodoroDial size={DIAL_SIZE} ratio={dialRatio}>
          {renderTimeReadout(remaining)}
        </PomodoroDial>
        <button
          type="button"
          onClick={skipBreak}
          className={FOCUS_RING_OUTSET}
          style={MUTED_TEXT_BUTTON_STYLE}
        >
          跳过休息
        </button>
      </section>
    )
  }

  function renderPhase() {
    if (phase === 'running') return renderRunning()
    if (phase === 'summary') return renderSummaryBackdrop()
    if (phase === 'break-idle') return renderBreakIdle()
    if (phase === 'break-running') return renderBreakRunning()
    return renderIdle()
  }

  // Statistics drill-in replaces the whole tab body. Only reachable from an
  // idle header, so no running timer is ever hidden (T-14-08).
  if (statsOpen) return <PomodoroStatsView onBack={closeStats} />

  return (
    <div className="flex flex-col" style={{ gap: '24px' }}>
      <style>{POMODORO_LAYOUT_CSS}</style>
      <header
        className="flex items-center justify-between"
        style={{ gap: '8px', marginBottom: '32px' }}
      >
        <h1 style={HERO_TITLE_STYLE}>番茄钟</h1>
        <div className="flex items-center" style={{ gap: '8px' }}>
          {isElectron ? (
            <button
              type="button"
              aria-label="显示番茄浮窗"
              onClick={() => showFloatingWindow()}
              className={`${FOCUS_RING_OUTSET} accent-button`}
              style={ACCENT_TEXT_BUTTON_STYLE}
            >
              浮窗
            </button>
          ) : null}
          {phase === 'idle' || phase === 'break-idle' ? (
            <button
              type="button"
              aria-label="查看番茄统计"
              ref={statsTriggerRef}
              onClick={() => setStatsOpen(true)}
              className={`${FOCUS_RING_OUTSET} accent-button`}
              style={ACCENT_TEXT_BUTTON_STYLE}
            >
              统计
            </button>
          ) : null}
        </div>
      </header>
      <div className="orbit-pomodoro-layout">
        <div className="orbit-pomodoro-main">{renderPhase()}</div>
        {/* Desktop-only statistics sidebar; hidden below 900px, where the
            existing 统计 drill-in remains the entry point. */}
        <aside className="orbit-pomodoro-aside" aria-label="番茄统计侧栏">
          <PomodoroStatsView embedded />
        </aside>
      </div>
      <PomodoroPickerSheet
        open={pickerOpen}
        title="选择关联"
        groups={[...taskPicker.groups, ...habitPicker.groups]}
        selectedIds={[...(habitLink ? [habitLink.id] : []), ...taskLinks.map((t) => t.id)]}
        onSelect={handlePickerSelect}
        onClose={() => setPickerOpen(false)}
        returnFocusRef={pickerReturnFocusRef}
      />
      <PomodoroCalendarSheet
        open={calendarOpen}
        selected={calendar}
        onSelect={handleSelectCalendar}
        onClose={() => setCalendarOpen(false)}
        returnFocusRef={calendarReturnFocusRef}
      />
      <PomodoroSummarySheet
        open={phase === 'summary'}
        calendarName={calendar}
        onRequestCalendarChange={() => setCalendarOpen(true)}
        tasks={taskLinks.map((link) => {
          const linked = tasks?.find((row) => row.id === link.id)
          const goal =
            linked?.goal_id != null
              ? goals?.find((row) => row.id === linked.goal_id)
              : undefined
          const milestone =
            linked?.milestone_id != null
              ? milestones?.find((row) => row.id === linked.milestone_id)
              : undefined
          const goalHabit =
            goal?.habit_id != null
              ? habits?.find((row) => row.id === goal.habit_id && row.deleted_at == null)
              : undefined
          return {
            id: link.id,
            name: link.name,
            progressType: link.progressType,
            unit: linked?.progress_type === 'quantity' ? (linked.unit ?? null) : null,
            currentValue: linked?.current_value ?? null,
            targetValue: linked?.target_value ?? null,
            startValue: taskStartValues[link.id] ?? null,
            goalName: goal?.name ?? null,
            milestoneName: milestone?.name ?? null,
            goalHabitName: goalHabit?.name ?? null,
          }
        })}
        todo={todoLink ? { name: todoLink.name } : null}
        habitName={habitLink?.name ?? null}
        notes={notes}
        sharedFlags={draftShared}
        saving={saving}
        error={summaryError}
        onNotesChange={handleSummaryNotesChange}
        onToggleShare={handleSummaryToggleShare}
        onConfirm={(settlements, markedTodoComplete, finalNotes, finalSharedFlags) => {
          void handleSummaryConfirm(
            settlements,
            markedTodoComplete,
            finalNotes,
            finalSharedFlags,
          )
        }}
        onCancel={cancelSummary}
        returnFocusRef={summaryReturnFocusRef}
      />
    </div>
  )
}
