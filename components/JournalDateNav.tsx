'use client'

import type { ChangeEvent, CSSProperties } from 'react'
import { journalDayLabel } from '@/lib/journal'

interface JournalDateNavProps {
  /** The selected logical day (YYYY-MM-DD), already clamped to ≤ today. */
  day: string
  /** Today's logical day (YYYY-MM-DD) from getTodayStr(). */
  today: string
  onPrev: () => void
  onNext: () => void
  onDayChange: (day: string) => void
}

const FOCUS_RING_VISIBLE =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'
const FOCUS_RING_WITHIN =
  'focus-within:[outline:2px_solid_var(--accent)] focus-within:[outline-offset:2px]'

const ARROW_STYLE: CSSProperties = {
  flex: '0 0 44px',
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
}

const DISABLED_ARROW_STYLE: CSSProperties = {
  ...ARROW_STYLE,
  color: 'var(--muted)',
  opacity: 0.4,
  cursor: 'default',
}

const DATE_CONTROL_STYLE: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
  minHeight: '44px',
  padding: '0 8px',
  flex: '0 1 auto',
  minWidth: 0,
  borderRadius: '8px',
}

const DATE_LABEL_STYLE: CSSProperties = {
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  whiteSpace: 'nowrap',
  maxWidth: '100%',
  pointerEvents: 'none',
}

const DATE_INPUT_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  margin: 0,
  padding: 0,
  opacity: 0,
  cursor: 'pointer',
  border: 'none',
  background: 'none',
  fontFamily: 'inherit',
}

/**
 * Journal date pager (10-UI-SPEC §2): two 44×44 chevron arrows and a centered
 * date control whose visible label is `aria-hidden`; a transparent native
 * `<input type="date">` overlays the label (the single tab stop) and opens the
 * platform calendar. `max={today}` blocks future days natively and the change
 * handler clamps defensively. Purely presentational — all state lives in
 * JournalView.
 */
export default function JournalDateNav({
  day,
  today,
  onPrev,
  onNext,
  onDayChange,
}: JournalDateNavProps) {
  const atToday = day >= today

  function handleDateChange(event: ChangeEvent<HTMLInputElement>) {
    const value = event.target.value
    // A cleared picker ('' ) is ignored; the current day stays selected.
    if (!value) return
    // Lexicographic comparison is valid for YYYY-MM-DD. Clamp future → today.
    onDayChange(value > today ? today : value)
  }

  return (
    <div
      role="group"
      aria-label="按日期浏览日记"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
      }}
    >
      <button
        type="button"
        aria-label="上一天"
        onClick={onPrev}
        className={FOCUS_RING_VISIBLE}
        style={ARROW_STYLE}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          aria-hidden="true"
          focusable="false"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M11 4 L6 9 L11 14" />
        </svg>
      </button>

      <div className={FOCUS_RING_WITHIN} style={DATE_CONTROL_STYLE}>
        <span aria-hidden="true" style={DATE_LABEL_STYLE}>
          {journalDayLabel(day, today)}
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden="true"
          focusable="false"
          fill="none"
          stroke="var(--muted)"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flex: '0 0 auto', pointerEvents: 'none' }}
        >
          <path d="M3 5 L7 9 L11 5" />
        </svg>
        <input
          type="date"
          value={day}
          max={today}
          aria-label="选择日期"
          onChange={handleDateChange}
          style={DATE_INPUT_STYLE}
        />
      </div>

      <button
        type="button"
        aria-label="下一天"
        aria-disabled={atToday ? 'true' : undefined}
        onClick={atToday ? undefined : onNext}
        className={FOCUS_RING_VISIBLE}
        style={atToday ? DISABLED_ARROW_STYLE : ARROW_STYLE}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          aria-hidden="true"
          focusable="false"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M7 4 L12 9 L7 14" />
        </svg>
      </button>
    </div>
  )
}
