'use client'

import { useEffect, useRef } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from 'react'
import { POMODORO_CALENDARS, type PomodoroCalendarName } from '@/lib/calendar'

interface PomodoroCalendarSheetProps {
  open: boolean
  selected: PomodoroCalendarName | null
  onSelect: (name: PomodoroCalendarName | null) => void
  onClose: () => void
  returnFocusRef: RefObject<HTMLElement | null>
}

const TITLE_ID = 'pomodoro-calendar-title'

const FOCUS_RING =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  width: '100%',
  minHeight: '44px',
  padding: '4px 0',
  background: 'none',
  border: 'none',
  color: 'var(--foreground)',
  textAlign: 'left',
  fontFamily: 'inherit',
  cursor: 'pointer',
}

const ROW_LABEL_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
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
  cursor: 'pointer',
}

/** Single-value bottom sheet for the pomodoro 写入日历 picker. Five colored-dot
 *  rows (one per iCloud calendar) plus a clear (不关联) row. Reuses the same
 *  shell semantics as PomodoroPickerSheet: scrim, bottom slide, Escape close,
 *  focus trap, return focus. */
export default function PomodoroCalendarSheet({
  open,
  selected,
  onSelect,
  onClose,
  returnFocusRef,
}: PomodoroCalendarSheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLButtonElement>('[data-calendar-option]')
      ;(first ?? panelRef.current)?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  function close() {
    onClose()
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

  if (!open) return null

  return (
    <>
      <style>{`
        @keyframes orbit-calendar-scrim-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes orbit-calendar-sheet-in {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .orbit-calendar-scrim { animation: orbit-calendar-scrim-in 150ms ease-out both; }
        .orbit-calendar-sheet { animation: orbit-calendar-sheet-in 200ms ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .orbit-calendar-scrim, .orbit-calendar-sheet { animation: none !important; }
        }
      `}</style>

      <div
        className="orbit-calendar-scrim fixed inset-0 z-[60] flex items-end sm:items-center justify-center"
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
          className="orbit-calendar-sheet w-full sm:max-w-[448px] rounded-t-2xl sm:rounded-2xl"
          style={{
            display: 'flex',
            flexDirection: 'column',
            maxHeight: '70vh',
            overflow: 'hidden',
            background: 'var(--card)',
            border: '1px solid var(--border)',
            padding: '24px',
            paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
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
            写入日历
          </h2>

          <div
            style={{
              marginTop: '24px',
              flex: '1 1 auto',
              minHeight: 0,
              overflowY: 'auto',
            }}
          >
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {POMODORO_CALENDARS.map((calendar, index) => {
                const isSelected = calendar.name === selected
                return (
                  <li
                    key={calendar.name}
                    style={{
                      borderTop: index === 0 ? 'none' : '1px solid var(--border)',
                    }}
                  >
                    <button
                      type="button"
                      data-calendar-option
                      onClick={() => {
                        onSelect(calendar.name)
                        close()
                      }}
                      aria-pressed={isSelected}
                      className={FOCUS_RING}
                      style={ROW_STYLE}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          flex: '0 0 12px',
                          width: '12px',
                          height: '12px',
                          borderRadius: '50%',
                          background: calendar.color,
                        }}
                      />
                      <span style={ROW_LABEL_STYLE}>{calendar.name}</span>
                      <span
                        aria-hidden="true"
                        style={{
                          flex: '0 0 18px',
                          width: '18px',
                          fontSize: '14px',
                          fontWeight: 600,
                          lineHeight: 1,
                          color: 'var(--accent)',
                          textAlign: 'right',
                        }}
                      >
                        {isSelected ? '✓' : ''}
                      </span>
                    </button>
                  </li>
                )
              })}
              <li style={{ borderTop: '1px solid var(--border)' }}>
                <button
                  type="button"
                  data-calendar-option
                  onClick={() => {
                    onSelect(null)
                    close()
                  }}
                  aria-pressed={selected === null}
                  className={FOCUS_RING}
                  style={ROW_STYLE}
                >
                  <span
                    aria-hidden="true"
                    style={{ flex: '0 0 12px', width: '12px', height: '12px' }}
                  />
                  <span style={ROW_LABEL_STYLE}>不关联</span>
                  <span
                    aria-hidden="true"
                    style={{
                      flex: '0 0 18px',
                      width: '18px',
                      fontSize: '14px',
                      fontWeight: 600,
                      lineHeight: 1,
                      color: 'var(--accent)',
                      textAlign: 'right',
                    }}
                  >
                    {selected === null ? '✓' : ''}
                  </span>
                </button>
              </li>
            </ul>
          </div>

          <div style={{ marginTop: '24px', flexShrink: 0 }}>
            <button type="button" onClick={close} className={FOCUS_RING} style={SECONDARY_BUTTON_STYLE}>
              取消
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
