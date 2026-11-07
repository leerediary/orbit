'use client'

import type { CSSProperties } from 'react'
import { deriveMonthColumns, monthDateKeys } from '@/lib/month-columns'
import type { Habit, HabitCompletion } from '@/lib/types'

interface MonthlyGridProps {
  liveHabits: Habit[]
  allHabits: Habit[]
  completions: HabitCompletion[]
  year: number
  month: number
  today: string
  onPrev: () => void
  onNext: () => void
  onOpenHabit: (habit: Habit) => void
}

const FOCUS_RING_OUTSET =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'

// Sunday-indexed (Date#getDay) Chinese weekday glyphs.
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

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

const PAGER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
}

const MONTH_LABEL_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.47,
  color: 'var(--foreground)',
}

const SCROLL_STYLE: CSSProperties = {
  overflowX: 'auto',
  WebkitOverflowScrolling: 'touch',
}

const TABLE_STYLE: CSSProperties = {
  borderCollapse: 'separate',
  borderSpacing: 0,
  width: 'max-content',
  minWidth: '100%',
  tableLayout: 'auto',
}

const DATE_HEADER_STYLE: CSSProperties = {
  position: 'sticky',
  left: 0,
  zIndex: 1,
  width: '96px',
  padding: '8px',
  textAlign: 'left',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  background: 'var(--card)',
  borderRight: '1px solid var(--border)',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
}

const HABIT_HEADER_STYLE: CSSProperties = {
  minWidth: '52px',
  padding: '0 4px',
  textAlign: 'center',
  borderBottom: '1px solid var(--border)',
}

const HABIT_BUTTON_STYLE: CSSProperties = {
  minHeight: '44px',
  minWidth: '44px',
  padding: '0 4px',
  background: 'none',
  border: 'none',
  color: 'var(--accent)',
  fontSize: '13px',
  fontWeight: 600,
  lineHeight: 1.4,
  fontFamily: 'inherit',
  cursor: 'pointer',
  overflowWrap: 'anywhere',
}

const HABIT_CELL_STYLE: CSSProperties = {
  minWidth: '52px',
  padding: '4px',
  textAlign: 'center',
  borderBottom: '1px solid var(--border)',
}

const CHEVRON = (
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
)

const CHEVRON_RIGHT = (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
    <polyline
      points="7 4 12 9 7 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 月历总览 card body (12-UI-SPEC §5). The parent owns `year`/`month`; this
 * component is purely presentational over already-loaded rows. All derivation
 * goes through the tested pure helper `deriveMonthColumns` so the live/past
 * column rule cannot drift (T-12-13).
 *
 * Column widths are fixed (96px date column, min 52px per habit). They never
 * divide 100% by the column count, which would produce Infinity/NaN on a
 * zero-completion past month (RESEARCH zero-column pitfall / T-12-16).
 */
export default function MonthlyGrid({
  liveHabits,
  allHabits,
  completions,
  year,
  month,
  today,
  onPrev,
  onNext,
  onOpenHabit,
}: MonthlyGridProps) {
  const monthPrefix = `${year}-${pad2(month)}`
  const monthCompletions = completions.filter((row) => row.date.startsWith(monthPrefix))
  const isCurrentMonth = today.slice(0, 7) === monthPrefix
  const columns = deriveMonthColumns(liveHabits, allHabits, monthCompletions, isCurrentMonth)
  const keys = monthDateKeys(year, month)

  // Exact `date::habit_id` identity; tombstones are never counted.
  const doneSet = new Set(
    monthCompletions
      .filter((row) => row.deleted_at == null)
      .map((row) => `${row.date}::${row.habit_id}`),
  )

  const showCurrentEmpty = isCurrentMonth && liveHabits.length === 0
  const showPastEmpty = !isCurrentMonth && columns.length === 0
  const nextDisabled = isCurrentMonth

  return (
    <section style={CARD_STYLE}>
      <div className="flex items-center" style={{ minHeight: '44px' }}>
        <h2 style={TITLE_STYLE}>月历总览</h2>
      </div>

      <div role="group" aria-label="按月浏览月历总览" style={PAGER_STYLE}>
        <button
          type="button"
          onClick={onPrev}
          aria-label="上个月"
          className={FOCUS_RING_OUTSET}
          style={{
            width: '44px',
            height: '44px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            background: 'none',
            border: 'none',
            color: 'var(--foreground)',
            cursor: 'pointer',
          }}
        >
          {CHEVRON}
        </button>
        <p style={MONTH_LABEL_STYLE}>
          {year}年{month}月
        </p>
        <button
          type="button"
          onClick={() => {
            if (!nextDisabled) onNext()
          }}
          aria-label="下个月"
          aria-disabled={nextDisabled}
          className={FOCUS_RING_OUTSET}
          style={{
            width: '44px',
            height: '44px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            background: 'none',
            border: 'none',
            color: nextDisabled ? 'var(--muted)' : 'var(--foreground)',
            opacity: nextDisabled ? 0.4 : 1,
            cursor: nextDisabled ? 'default' : 'pointer',
          }}
        >
          {CHEVRON_RIGHT}
        </button>
      </div>

      {showCurrentEmpty ? (
        <p style={MUTED_INLINE_STYLE}>这个月还没有习惯。先在上方添加一个。</p>
      ) : showPastEmpty ? (
        <p style={MUTED_INLINE_STYLE}>这个月没有打卡记录。</p>
      ) : (
        <div className="hide-scrollbar" style={SCROLL_STYLE}>
          <table style={TABLE_STYLE}>
            <caption className="sr-only">
              {year}年{month}月打卡总览
            </caption>
            <thead>
              <tr>
                <th scope="col" style={DATE_HEADER_STYLE}>
                  日期
                </th>
                {columns.map((habit) => (
                  <th key={habit.id} scope="col" style={HABIT_HEADER_STYLE}>
                    {/* The column header is the only drill-in trigger.
                        aria-label: 查看{habit.name}的月历 */}
                    <button
                      type="button"
                      data-habit-column={habit.id}
                      onClick={() => onOpenHabit(habit)}
                      aria-label={`查看${habit.name}的月历`}
                      className={`${FOCUS_RING_OUTSET} accent-button`}
                      style={HABIT_BUTTON_STYLE}
                    >
                      {habit.short_name}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => {
                const day = Number(key.slice(-2))
                const dow = new Date(year, month - 1, day).getDay()
                const isWeekend = dow === 0 || dow === 6
                const isToday = key === today
                return (
                  <tr key={key} style={{ background: isToday ? 'var(--background)' : 'transparent' }}>
                    <th
                      scope="row"
                      style={{
                        ...DATE_HEADER_STYLE,
                        fontSize: '13px',
                        fontWeight: isToday ? 600 : 400,
                        color: isWeekend ? 'var(--muted)' : 'var(--foreground)',
                        background: isToday ? 'var(--background)' : 'var(--card)',
                      }}
                    >
                      {day} 周{WEEKDAYS[dow]}
                    </th>
                    {columns.map((habit) => {
                      const isFuture = key > today
                      const done = doneSet.has(`${key}::${habit.id}`)
                      return (
                        <td key={habit.id} style={HABIT_CELL_STYLE}>
                          {isFuture ? (
                            <>
                              <span
                                aria-hidden="true"
                                style={{ fontSize: '13px', color: 'var(--muted)', opacity: 0.3 }}
                              >
                                ·
                              </span>
                              <span className="sr-only">未来</span>
                            </>
                          ) : done ? (
                            <>
                              <span
                                aria-hidden="true"
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  width: '20px',
                                  height: '20px',
                                  fontSize: '14px',
                                  fontWeight: 600,
                                  color: 'var(--foreground)',
                                }}
                              >
                                ✓
                              </span>
                              <span className="sr-only">已打卡</span>
                            </>
                          ) : (
                            <>
                              <span
                                aria-hidden="true"
                                style={{
                                  display: 'inline-flex',
                                  width: '20px',
                                  height: '20px',
                                  borderRadius: '50%',
                                  border: '1.5px solid var(--border)',
                                  opacity: 0.35,
                                }}
                              />
                              <span className="sr-only">未打卡</span>
                            </>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
