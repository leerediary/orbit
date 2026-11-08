'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { getRepository } from '@/lib/repository-provider'
import { MODE_RANGES } from '@/lib/pomodoro'
import {
  HISTORY_DAYS,
  buildPomodoroChartData,
  buildPomodoroHistoryGroups,
} from '@/lib/pomodoro-stats'
import { getDayOffsetHours, getTodayStr } from '@/lib/today'
import { useSyncRefresh } from '@/lib/sync-state'
import type { DailyTodo, Habit, PomodoroSession, Task } from '@/lib/types'

const LOAD_ERROR = '番茄统计加载失败。请重新加载；如果仍然失败，刷新页面后再试。'

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

const DETAIL_META_STYLE: CSSProperties = {
  margin: 0,
  marginTop: '8px',
  fontSize: '15px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  fontVariantNumeric: 'tabular-nums',
}

const RANGE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  gap: '16px',
  justifyContent: 'center',
  marginBottom: '16px',
}

const HISTORY_TITLE_STYLE: CSSProperties = {
  margin: 0,
  marginBottom: '16px',
  fontSize: '20px',
  fontWeight: 600,
  lineHeight: 1.2,
  letterSpacing: '-0.02em',
  color: 'var(--foreground)',
}

/** One card in the embedded (desktop sidebar) three-card stack. Reuses the
 *  existing card token; no new shadow is introduced. */
const STATS_CARD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  padding: '16px',
  background: 'var(--card)',
  borderRadius: '12px',
  boxShadow: 'var(--card-shadow)',
}

const CARD_TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.2,
  color: 'var(--foreground)',
}

const BIG_NUMBER_STYLE: CSSProperties = {
  fontSize: '40px',
  fontWeight: 300,
  lineHeight: 1.05,
  letterSpacing: '-0.02em',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--foreground)',
}

const BIG_UNIT_STYLE: CSSProperties = {
  fontSize: '13px',
  color: 'var(--muted)',
}

const CAPTION_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  fontVariantNumeric: 'tabular-nums',
}

const WRAP_SPAN_STYLE: CSSProperties = {
  overflowWrap: 'anywhere',
  minWidth: 0,
}

const WRAP_LINE_STYLE: CSSProperties = {
  color: 'var(--muted)',
  fontSize: '14px',
  overflowWrap: 'anywhere',
  minWidth: 0,
}

const RANGE_OPTIONS = [7, 30, 90] as const
type RangeDays = (typeof RANGE_OPTIONS)[number]

/**
 * 番茄统计 (Phase 14 / STATS-01..02) — a drill-in from the 番茄钟 header.
 *
 * Reads pomodoroSessions + the three link-resolution entities once on mount,
 * then derives both the chart series and the recent-history groups through the
 * pure helpers in lib/pomodoro-stats.ts. Every repository call stays inside the
 * effect / retry handler so the Node prerender pass never touches IndexedDB.
 * History values render as React text nodes only (T-14-05), so user-authored
 * notes can never inject markup.
 */
export default function PomodoroStatsView({
  onBack,
  embedded = false,
}: {
  onBack?: () => void
  embedded?: boolean
}) {
  const [sessions, setSessions] = useState<PomodoroSession[] | null>(null)
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [todos, setTodos] = useState<DailyTodo[] | null>(null)
  const [habits, setHabits] = useState<Habit[] | null>(null)
  // Logical "today" + day offset are resolved inside the mount effect only: the
  // values together touch localStorage, so they must never be read at render.
  const [today, setToday] = useState<string | null>(null)
  const [offsetHours, setOffsetHours] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [rangeDays, setRangeDays] = useState<RangeDays>(30)

  const alive = useRef(false)

  async function load() {
    try {
      const repo = getRepository()
      const [allSessions, allTasks, allTodos, allHabits] = await Promise.all([
        repo.list<PomodoroSession>('pomodoroSessions'),
        repo.list<Task>('tasks'),
        repo.list<DailyTodo>('dailyTodos'),
        repo.list<Habit>('habits'),
      ])
      if (!alive.current) return
      // Defensive tombstone filter mirrors the other views even though the
      // repository already excludes tombstones by default.
      setSessions(allSessions.filter((row) => row.deleted_at == null))
      setTasks(allTasks.filter((row) => row.deleted_at == null))
      setTodos(allTodos.filter((row) => row.deleted_at == null))
      setHabits(allHabits.filter((row) => row.deleted_at == null))
      setLoadError(null)
    } catch {
      if (!alive.current) return
      setLoadError(LOAD_ERROR)
    }
  }

  useEffect(() => {
    alive.current = true
    // Resolve the logical day and offset once, in the effect (never render).
    setToday(getTodayStr())
    setOffsetHours(getDayOffsetHours())
    void load()
    return () => {
      alive.current = false
    }
    // Mount-only: load() only touches stable setters and the repository.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // D-05 / B2: reload the stats when remote rows are applied here or elsewhere.
  useSyncRefresh(() => {
    void load()
  })

  function retryLoad() {
    setLoadError(null)
    setSessions(null)
    setTasks(null)
    setTodos(null)
    setHabits(null)
    void load()
  }

  const chartData = useMemo(() => {
    if (today === null) return []
    return buildPomodoroChartData(sessions ?? [], rangeDays, today, offsetHours)
  }, [sessions, rangeDays, today, offsetHours])

  const historyGroups = useMemo(() => {
    if (today === null) return []
    return buildPomodoroHistoryGroups(
      sessions ?? [],
      tasks ?? [],
      todos ?? [],
      habits ?? [],
      today,
      offsetHours,
      HISTORY_DAYS,
    )
  }, [sessions, tasks, todos, habits, today, offsetHours])

  const lastPoint = chartData.length > 0 ? chartData[chartData.length - 1] : undefined
  const ready =
    sessions !== null &&
    tasks !== null &&
    todos !== null &&
    habits !== null &&
    today !== null

  const sessionsCount = sessions?.length ?? 0

  // Shared chart / history / range fragments: the embedded (desktop sidebar)
  // three-card stack and the mobile drill-in compose the same content so the
  // two layouts can never drift apart.
  const rangeButtons = RANGE_OPTIONS.map((days) => {
    const active = rangeDays === days
    return (
      <button
        key={days}
        type="button"
        aria-pressed={active}
        onClick={() => setRangeDays(days)}
        className={FOCUS_RING_OUTSET}
        style={{
          minHeight: '44px',
          padding: '0 8px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: '15px',
          lineHeight: 1.47,
          color: active ? 'var(--accent)' : 'var(--muted)',
          fontWeight: active ? 600 : 400,
        }}
      >
        {days}天
      </button>
    )
  })

  const chartView = (
    <div role="img" aria-label={`近 ${rangeDays} 天每日番茄次数与累计`}>
      <ResponsiveContainer width="100%" height={embedded ? 160 : 200}>
        <ComposedChart
          data={chartData}
          margin={{ top: 8, right: 32, bottom: 0, left: 32 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 12, fill: 'var(--muted)' }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            yAxisId="left"
            orientation="left"
            allowDecimals={false}
            tick={{ fontSize: 12, fill: 'var(--muted)' }}
            tickLine={false}
            axisLine={false}
            width={24}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            allowDecimals={false}
            tick={{ fontSize: 12, fill: 'var(--muted)' }}
            tickLine={false}
            axisLine={false}
            width={32}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              fontSize: 13,
            }}
            labelStyle={{ color: 'var(--muted)' }}
          />
          <Bar
            name="每日次数"
            yAxisId="left"
            dataKey="daily"
            fill="#0066cc"
            opacity={0.7}
            radius={[2, 2, 0, 0]}
            isAnimationActive={false}
          />
          <Line
            name="累计"
            yAxisId="right"
            dataKey="cumul"
            type="monotone"
            stroke="#0066cc"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )

  const chartEmptyNote =
    sessionsCount === 0 ? (
      <p
        style={{
          margin: 0,
          marginTop: embedded ? 0 : '16px',
          fontSize: '15px',
          textAlign: 'center',
          color: 'var(--muted)',
        }}
      >
        还没有番茄记录
      </p>
    ) : null

  const historyView =
    historyGroups.length === 0 ? (
      <p style={{ margin: 0, fontSize: '15px', color: 'var(--muted)' }}>
        最近 7 天还没有番茄记录
      </p>
    ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {historyGroups.map((group) => (
          <div key={group.date}>
            <h3
              style={{
                margin: 0,
                marginBottom: '12px',
                fontSize: '15px',
                fontWeight: 600,
                lineHeight: 1.2,
                color: 'var(--muted)',
              }}
            >
              {group.label}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {group.rows.map((row) => (
                <div
                  key={row.id}
                  style={{
                    fontSize: '15px',
                    lineHeight: 1.47,
                    color: 'var(--foreground)',
                    overflowWrap: 'anywhere',
                    minWidth: 0,
                  }}
                >
                  <span style={{ ...WRAP_SPAN_STYLE, fontWeight: 500 }}>{row.time}</span>
                  <span style={{ ...WRAP_SPAN_STYLE, color: 'var(--muted)' }}>
                    {' · '}
                    {MODE_RANGES[row.mode].label}
                  </span>
                  {row.linkName ? (
                    <span style={{ ...WRAP_SPAN_STYLE, color: 'var(--muted)' }}>
                      {' · '}
                      {row.linkName}
                      {row.secondaryLinkName ? ` · ${row.secondaryLinkName}` : ''}
                    </span>
                  ) : null}
                  {row.noteLines.length > 0 ? (
                    <div
                      style={{
                        marginTop: '4px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '2px',
                      }}
                    >
                      {row.noteLines.map((line, index) => (
                        <div key={index} style={WRAP_LINE_STYLE}>
                          {line}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    )

  return (
    <div className="flex flex-col" style={{ gap: '24px' }}>
      {embedded ? null : (
        <header className="flex flex-col">
          <div className="flex items-center">
            <button
              type="button"
              onClick={onBack}
              aria-label="返回番茄钟"
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
          <h1 style={HERO_TITLE_STYLE}>统计</h1>
          {today !== null ? (
            <p style={DETAIL_META_STYLE}>
              近 {rangeDays} 天共 {lastPoint?.cumul ?? 0} 个番茄
            </p>
          ) : null}
        </header>
      )}

      {loadError ? (
        <div className="flex flex-col" style={{ gap: '8px' }}>
          <p style={ERROR_STYLE}>{loadError}</p>
          <button
            type="button"
            onClick={retryLoad}
            className={`self-start ${FOCUS_RING_OUTSET} accent-button`}
            style={ACCENT_TEXT_BUTTON_STYLE}
          >
            重新加载番茄统计
          </button>
        </div>
      ) : !ready ? (
        <p style={LOADING_STYLE}>正在加载番茄统计…</p>
      ) : embedded ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <section aria-label="今日番茄" style={STATS_CARD_STYLE}>
            <h2 style={CARD_TITLE_STYLE}>今日番茄</h2>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
              <span style={BIG_NUMBER_STYLE}>{lastPoint?.daily ?? 0}</span>
              <span style={BIG_UNIT_STYLE}>个</span>
            </div>
          </section>

          <section aria-label="番茄统计图" style={STATS_CARD_STYLE}>
            <div
              style={{ ...RANGE_ROW_STYLE, marginBottom: 0 }}
              role="group"
              aria-label="统计范围"
            >
              {rangeButtons}
            </div>
            {chartView}
            {chartEmptyNote}
            <p style={CAPTION_STYLE}>
              近 {rangeDays} 天共 {lastPoint?.cumul ?? 0} 个番茄
            </p>
          </section>

          <section aria-label="番茄历史" style={STATS_CARD_STYLE}>
            <h2 style={HISTORY_TITLE_STYLE}>番茄历史</h2>
            {historyView}
          </section>
        </div>
      ) : (
        <>
          <div style={RANGE_ROW_STYLE} role="group" aria-label="统计范围">
            {rangeButtons}
          </div>

          <section aria-label="番茄统计图">
            {chartView}
            {chartEmptyNote}
          </section>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '32px' }}>
            <div style={{ maxWidth: '360px', margin: '0 auto' }}>
              <h2 style={HISTORY_TITLE_STYLE}>番茄历史</h2>
              {historyView}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
