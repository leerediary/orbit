'use client'

import type { CSSProperties } from 'react'
import { monthDateKeys, monthStats } from '@/lib/month-columns'
import type { Habit, HabitCompletion } from '@/lib/types'

interface HabitCalendarProps {
  habit: Habit
  completions: HabitCompletion[]
  year: number
  month: number
  today: string
  onPrev: () => void
  onNext: () => void
}

const FOCUS_RING_OUTSET =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'

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

const GRID_STYLE: CSSProperties = {
  width: '100%',
  maxWidth: '320px',
  borderCollapse: 'separate',
  borderSpacing: '4px',
  tableLayout: 'fixed',
  margin: '0 auto',
}

const WEEKDAY_STYLE: CSSProperties = {
  padding: '4px 0',
  textAlign: 'center',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const DAY_HEADER_STYLE: CSSProperties = {
  padding: 0,
}

const SUMMARY_STYLE: CSSProperties = {
  margin: 0,
  borderTop: '1px solid var(--border)',
  paddingTop: '16px',
  textAlign: 'center',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  fontVariantNumeric: 'tabular-nums',
}

const NOTES_TITLE_STYLE: CSSProperties = {
  margin: 0,
  marginTop: '40px',
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.2,
  color: 'var(--foreground)',
}

const NOTES_LIST_STYLE: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
}

const NOTE_DATE_STYLE: CSSProperties = {
  flex: '0 0 44px',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
}

const NOTE_TEXT_STYLE: CSSProperties = {
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  whiteSpace: 'pre-line',
  overflowWrap: 'anywhere',
}

// Monday-first weekday header (一 … 日).
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

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
 * Per-habit month calendar + note history (12-UI-SPEC §6). Pure rendering over
 * the habit's already-loaded live completions; month stats come from the tested
 * `monthStats`, and the day grid is Monday-first with empty leading/trailing
 * cells padded to whole weeks.
 *
 * The parent owns the displayed month and the current-month cap; this component
 * only renders the disabled affordance (`aria-disabled`, muted, no-op).
 */
export default function HabitCalendar({
  habit,
  completions,
  year,
  month,
  today,
  onPrev,
  onNext,
}: HabitCalendarProps) {
  const monthPrefix = `${year}-${pad2(month)}`
  const monthCompletions = completions.filter((row) => row.date.startsWith(monthPrefix))
  const doneSet = new Set(
    monthCompletions.filter((row) => row.deleted_at == null).map((row) => row.date),
  )
  const keys = monthDateKeys(year, month)
  const stats = monthStats(year, month, doneSet, today)
  const isCurrentMonth = today.slice(0, 7) === monthPrefix
  const nextDisabled = isCurrentMonth

  const firstDay = new Date(year, month - 1, 1).getDay()
  const offset = firstDay === 0 ? 6 : firstDay - 1
  const days: (number | null)[] = []
  for (let leading = 0; leading < offset; leading += 1) days.push(null)
  for (let day = 1; day <= keys.length; day += 1) days.push(day)
  while (days.length % 7 !== 0) days.push(null)
  const weeks: (number | null)[][] = []
  for (let index = 0; index < days.length; index += 7) {
    weeks.push(days.slice(index, index + 7))
  }

  const notesWithText = monthCompletions
    .filter((row) => row.deleted_at == null && (row.note ?? '').trim() !== '')
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  return (
    <section style={CARD_STYLE}>
      <div role="group" aria-label={`按月浏览${habit.name}的打卡记录`} style={PAGER_STYLE}>
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

      <table style={GRID_STYLE}>
        <caption className="sr-only">
          {habit.name} {year}年{month}月打卡日历
        </caption>
        <thead>
          <tr>
            {WEEKDAYS.map((label) => (
              <th key={label} scope="col" style={WEEKDAY_STYLE}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, weekIndex) => (
            <tr key={weekIndex}>
              {week.map((day, dayIndex) => {
                if (day === null) {
                  return <td key={`empty-${weekIndex}-${dayIndex}`} aria-hidden="true" style={DAY_HEADER_STYLE} />
                }
                const dateStr = keys[day - 1]
                const dow = new Date(year, month - 1, day).getDay()
                const isWeekend = dow === 0 || dow === 6
                const done = doneSet.has(dateStr)
                const isFuture = dateStr > today
                const isToday = dateStr === today

                let background = 'transparent'
                let color = 'var(--foreground)'
                let opacity = 1
                if (done) {
                  background = 'var(--accent)'
                  color = '#ffffff'
                } else if (isFuture) {
                  color = 'var(--muted)'
                  opacity = 0.3
                } else if (isWeekend) {
                  color = 'var(--muted)'
                }
                const border = isToday && !done ? '1.5px solid var(--accent)' : 'none'
                const status = done ? '已打卡' : isFuture ? '未到' : '未打卡'

                return (
                  <td
                    key={day}
                    aria-label={`${month}月${day}日 ${status}`}
                    style={DAY_HEADER_STYLE}
                  >
                    <div
                      style={{
                        width: '100%',
                        aspectRatio: '1',
                        borderRadius: '50%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '13px',
                        fontWeight: isToday ? 600 : 400,
                        color,
                        background,
                        border,
                        opacity,
                      }}
                    >
                      <span aria-hidden="true">{day}</span>
                    </div>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <p style={SUMMARY_STYLE}>
        {stats.done} / {stats.past} 天 {stats.pct}%
      </p>

      {notesWithText.length > 0 ? (
        <div>
          <h2 style={NOTES_TITLE_STYLE}>打卡笔记</h2>
          <ul style={NOTES_LIST_STYLE}>
            {notesWithText.map((row, index) => {
              const [, noteMonth, noteDay] = row.date.split('-').map(Number)
              return (
                <li
                  key={row.date}
                  style={{
                    display: 'flex',
                    gap: '16px',
                    padding: '12px 0',
                    borderBottom:
                      index === notesWithText.length - 1
                        ? 'none'
                        : '1px solid var(--border)',
                  }}
                >
                  <span style={NOTE_DATE_STYLE}>
                    {noteMonth}/{noteDay}
                  </span>
                  <span style={NOTE_TEXT_STYLE}>{row.note}</span>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
