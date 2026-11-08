'use client'

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { getRepository } from '@/lib/repository-provider'
import { defaultShortName, nextHabitSortOrder, sortHabits } from '@/lib/habit'
import { getTodayStr } from '@/lib/today'
import { useSyncRefresh } from '@/lib/sync-state'
import type { Habit, HabitCompletion } from '@/lib/types'
import HabitManagement from '@/components/HabitManagement'
import MonthlyGrid from '@/components/MonthlyGrid'
import HabitCalendar from '@/components/HabitCalendar'

const LOAD_ERROR = '习惯打卡加载失败。请重新加载；如果仍然失败，刷新页面后再试。'
const DETAIL_LOAD_ERROR = '打卡记录加载失败。请重新加载；如果仍然失败，刷新页面后再试。'

const HERO_TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '48px',
  fontWeight: 600,
  lineHeight: 1.05,
  letterSpacing: '-0.02em',
  color: 'var(--foreground)',
}

const LOADING_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const ERROR_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
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

const DETAIL_TITLE_STYLE: CSSProperties = {
  margin: 0,
  marginTop: '16px',
  fontSize: '20px',
  fontWeight: 600,
  lineHeight: 1.2,
  letterSpacing: '-0.01em',
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

const DETAIL_META_STYLE: CSSProperties = {
  margin: 0,
  marginTop: '8px',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  fontVariantNumeric: 'tabular-nums',
}

const FOCUS_RING_OUTSET =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'

interface MonthCursor {
  year: number
  month: number
}

function monthPrefixOf(cursor: MonthCursor): string {
  return `${cursor.year}-${String(cursor.month).padStart(2, '0')}`
}

/** Local Date arithmetic for year/month rollover (month is 1-12). */
function shiftMonth(cursor: MonthCursor, delta: number): MonthCursor {
  const index = cursor.year * 12 + (cursor.month - 1) + delta
  return {
    year: Math.floor(index / 12),
    month: (((index % 12) + 12) % 12) + 1,
  }
}

/**
 * 习惯打卡 tab container (Phase 12, HABIT-01/04). Owns every habit read and
 * every persistence handler so the management card stays presentational, plus
 * the monthly overview and the per-habit drill-in state.
 *
 * This component renders ONLY while `section === 'checkin'` (app/page.tsx), so
 * switching sections unmounts it and no drill-in or grid state can leak across
 * tabs (T-12-15). All repository access stays inside effects/handlers — the Node
 * prerender pass has no IndexedDB under `output: 'export'`.
 */
export default function HabitCheckInView() {
  const [habits, setHabits] = useState<Habit[] | null>(null)
  const [archived, setArchived] = useState<Habit[] | null>(null)
  const [completions, setCompletions] = useState<HabitCompletion[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Logical "today" is resolved once on mount so month pagination stays stable.
  const [today, setToday] = useState<string | null>(null)
  // Overview month, and the per-habit detail month (independent pagers).
  const [overview, setOverview] = useState<MonthCursor | null>(null)
  const [selectedHabit, setSelectedHabit] = useState<Habit | null>(null)
  const [detailMonth, setDetailMonth] = useState<MonthCursor | null>(null)
  // Management vs monthly-overview surface (both are sub-views of the tab).
  const [managing, setManaging] = useState(false)

  const alive = useRef(false)
  // Drill-in restoration: the triggering column header and the pre-drill scroll.
  const overviewTriggerRef = useRef<HTMLElement | null>(null)
  const scrollRef = useRef(0)

  async function load() {
    try {
      const repo = getRepository()
      // All three reads issued together; load() re-runs after every mutation.
      const [liveHabits, allHabits, liveCompletions] = await Promise.all([
        repo.list<Habit>('habits'),
        repo.list<Habit>('habits', { includeDeleted: true }),
        repo.list<HabitCompletion>('habitCompletions'),
      ])
      if (!alive.current) return

      setHabits(sortHabits(liveHabits.filter((habit) => habit.deleted_at == null)))
      setArchived(
        allHabits
          .filter((habit) => habit.deleted_at != null)
          .sort((a, b) => (b.deleted_at! > a.deleted_at! ? 1 : -1)),
      )
      // Live completions only; retained for the calendars and the count caption.
      setCompletions(liveCompletions.filter((row) => row.deleted_at == null))
      setError(null)
    } catch {
      if (!alive.current) return
      setError(LOAD_ERROR)
    }
  }

  useEffect(() => {
    alive.current = true
    const todayStr = getTodayStr()
    setToday(todayStr)
    const [year, month] = todayStr.split('-').map(Number)
    setOverview({ year, month })
    void load()
    return () => {
      alive.current = false
    }
    // Mount-only: load() only touches stable setters, refs and getRepository.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // D-05 / B2: reload when remote rows are applied here or in another tab.
  useSyncRefresh(() => {
    void load()
  })

  function retryLoad() {
    setError(null)
    setHabits(null)
    setArchived(null)
    setCompletions(null)
    void load()
  }

  // ── Month pagination (never past the current month) ───────────────────────

  function overviewPrev() {
    setOverview((current) => (current ? shiftMonth(current, -1) : current))
  }

  function overviewNext() {
    if (!today) return
    setOverview((current) => {
      if (!current) return current
      if (monthPrefixOf(current) >= today.slice(0, 7)) return current
      return shiftMonth(current, 1)
    })
  }

  function detailPrev() {
    setDetailMonth((current) => (current ? shiftMonth(current, -1) : current))
  }

  function detailNext() {
    if (!today) return
    setDetailMonth((current) => {
      if (!current) return current
      if (monthPrefixOf(current) >= today.slice(0, 7)) return current
      return shiftMonth(current, 1)
    })
  }

  // ── Drill-in / back (client state only; no route) ─────────────────────────

  function openHabit(habit: Habit) {
    if (!overview) return
    scrollRef.current = window.scrollY
    const active = document.activeElement
    overviewTriggerRef.current = active instanceof HTMLElement ? active : null
    setDetailMonth({ year: overview.year, month: overview.month })
    // Resolve from the tombstone-inclusive set so archived habits can open.
    const allHabits = [...(habits ?? []), ...(archived ?? [])]
    setSelectedHabit(allHabits.find((row) => row.id === habit.id) ?? habit)
  }

  function backToOverview() {
    const habitId = selectedHabit?.id ?? ''
    void load()
    setSelectedHabit(null)
    setDetailMonth(null)
    requestAnimationFrame(() => {
      window.scrollTo(0, scrollRef.current)
      const target = habitId
        ? document.querySelector<HTMLElement>(`[data-habit-column="${habitId}"]`)
        : null
      if (target && document.contains(target)) {
        target.focus()
      } else if (
        overviewTriggerRef.current &&
        document.contains(overviewTriggerRef.current)
      ) {
        overviewTriggerRef.current.focus()
      }
    })
  }

  // ── Persistence handlers (all reload on success) ──────────────────────────

  async function addHabit(name: string, shortName: string) {
    const repo = getRepository()
    // Fresh tombstone-inclusive read so append order sees every sibling.
    const all = await repo.list<Habit>('habits', { includeDeleted: true })
    await repo.upsert<Habit>('habits', {
      id: crypto.randomUUID(),
      name: name.trim(),
      short_name: shortName.trim() || defaultShortName(name.trim()),
      sort_order: nextHabitSortOrder(all),
    })
    await load()
  }

  async function renameHabit(habit: Habit, name: string) {
    const repo = getRepository()
    // Spread preserves id / short_name / sort_order / tombstone; the repository
    // re-stamps updated_at.
    await repo.upsert<Habit>('habits', { ...habit, name: name.trim() })
    await load()
  }

  async function updateHabitShortName(habit: Habit, shortName: string) {
    const repo = getRepository()
    await repo.upsert<Habit>('habits', { ...habit, short_name: shortName.trim() })
    await load()
  }

  async function archiveHabit(habit: Habit) {
    const repo = getRepository()
    await repo.softDelete('habits', habit.id)
    await load()
  }

  async function restoreHabit(habit: Habit) {
    const repo = getRepository()
    await repo.upsert<Habit>('habits', { ...habit, deleted_at: null })
    await load()
  }

  async function reorderHabits(finalOrder: Habit[], baseline: Habit[]) {
    try {
      const repo = getRepository()
      const previous = new Map(baseline.map((habit) => [habit.id, habit.sort_order]))
      // Reassign 0..n-1 in visual order; only changed rows are written.
      for (let index = 0; index < finalOrder.length; index += 1) {
        const habit = finalOrder[index]
        if (previous.get(habit.id) !== index) {
          await repo.upsert<Habit>('habits', { ...habit, sort_order: index })
        }
      }
      await load()
    } catch (failure) {
      // Re-read so the UI shows the stored order, then rethrow for the card's
      // 保存失败，请重试。 line.
      await load()
      throw failure
    }
  }

  function completionCountsFor(rows: HabitCompletion[]): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const row of rows) {
      if (row.deleted_at != null) continue
      counts[row.habit_id] = (counts[row.habit_id] ?? 0) + 1
    }
    return counts
  }

  const detailOpen = selectedHabit !== null && detailMonth !== null
  const detailCompletions = selectedHabit
    ? (completions ?? []).filter((row) => row.habit_id === selectedHabit.id)
    : []
  const detailTotal = detailCompletions.filter((row) => row.deleted_at == null).length

  function renderDetail() {
    const habit = selectedHabit!
    const month = detailMonth!
    return (
      <div className="orbit-habit-detail flex flex-col" style={{ gap: '32px' }}>
        <style>{`
          @keyframes orbit-detail-in { from { opacity: 0; } to { opacity: 1; } }
          .orbit-habit-detail { animation: orbit-detail-in 150ms ease-out both; }
          @media (prefers-reduced-motion: reduce) {
            .orbit-habit-detail { animation: none !important; }
          }
        `}</style>

        <header className="flex flex-col">
          <div className="flex items-center">
            <button
              type="button"
              onClick={backToOverview}
              aria-label="返回习惯打卡"
              className={`flex items-center ${FOCUS_RING_OUTSET} accent-button`}
              style={{ ...ACCENT_TEXT_BUTTON_STYLE, display: 'flex', alignItems: 'center', gap: '8px' }}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
                <polyline
                  points="11 4 6 9 11 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              返回
            </button>
          </div>
          <h1 style={DETAIL_TITLE_STYLE}>{habit.name}</h1>
          <p style={DETAIL_META_STYLE}>共打卡 {detailTotal} 天</p>
        </header>

        {error ? (
          <div className="flex flex-col" style={{ gap: '8px' }}>
            <p style={ERROR_STYLE}>{DETAIL_LOAD_ERROR}</p>
            <button
              type="button"
              onClick={retryLoad}
              className={`self-start ${FOCUS_RING_OUTSET} accent-button`}
              style={ACCENT_TEXT_BUTTON_STYLE}
            >
              重新加载打卡记录
            </button>
          </div>
        ) : completions === null ? (
          <p style={LOADING_STYLE}>正在加载打卡记录…</p>
        ) : (
          <HabitCalendar
            habit={habit}
            completions={detailCompletions}
            year={month.year}
            month={month.month}
            today={today!}
            onPrev={detailPrev}
            onNext={detailNext}
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col" style={{ gap: '24px' }}>
      {detailOpen ? (
        renderDetail()
      ) : (
        <>
          <header
            className="flex items-center justify-between"
            style={{ gap: '16px', marginBottom: '32px' }}
          >
            <h1 style={HERO_TITLE_STYLE}>习惯打卡</h1>
            <button
              type="button"
              onClick={() => setManaging((current) => !current)}
              className={`${FOCUS_RING_OUTSET} primary-button`}
            >
              {managing ? '返回' : '习惯管理'}
            </button>
          </header>

          {error ? (
            <div className="flex flex-col" style={{ gap: '8px' }}>
              <p style={ERROR_STYLE}>{error}</p>
              <button
                type="button"
                onClick={retryLoad}
                className={`self-start ${FOCUS_RING_OUTSET} accent-button`}
                style={ACCENT_TEXT_BUTTON_STYLE}
              >
                重新加载习惯打卡
              </button>
            </div>
          ) : habits === null || archived === null || today === null || overview === null ? (
            <p style={LOADING_STYLE}>正在加载习惯打卡…</p>
          ) : managing ? (
            <HabitManagement
              habits={habits}
              archived={archived}
              completionCounts={completionCountsFor(completions ?? [])}
              onAdd={addHabit}
              onRename={renameHabit}
              onUpdateShortName={updateHabitShortName}
              onReorder={reorderHabits}
              onArchive={archiveHabit}
              onRestore={restoreHabit}
              onRefresh={load}
            />
          ) : (
            <MonthlyGrid
              liveHabits={habits}
              allHabits={[...habits, ...archived]}
              completions={completions ?? []}
              year={overview.year}
              month={overview.month}
              today={today}
              onPrev={overviewPrev}
              onNext={overviewNext}
              onOpenHabit={openHabit}
            />
          )}
        </>
      )}
    </div>
  )
}
