'use client'

import { useEffect, useRef } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from 'react'

/** One selectable value in the pomodoro link picker. */
export interface PomodoroPickerOption {
  id: string
  label: string
  kind: 'task' | 'todo' | 'habit'
}

/** A titled group of options (goal name for tasks, 独立待办, 习惯). */
export interface PomodoroPickerGroup {
  title: string
  options: PomodoroPickerOption[]
}

interface PomodoroPickerSheetProps {
  open: boolean
  title: string
  groups: PomodoroPickerGroup[]
  /** Ids currently linked — task rows may be many (multi-select). */
  selectedIds: string[]
  /** Task taps toggle without closing (multi-select); todo/habit tap selects and closes. */
  onSelect: (id: string, kind: 'task' | 'todo' | 'habit') => void
  onClose: () => void
  returnFocusRef: RefObject<HTMLElement | null>
  /** Copy shown when no group has options. Defaults to 暂无可选项。 */
  emptyText?: string
}

const TITLE_ID = 'pomodoro-picker-title'

const FOCUS_RING =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'

const GROUP_TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 600,
  lineHeight: 1.4,
  letterSpacing: '0.02em',
  color: 'var(--muted)',
  overflowWrap: 'anywhere',
}

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
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

const EMPTY_STYLE: CSSProperties = {
  margin: '24px 0 0',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
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

/**
 * Single-value bottom sheet for the pomodoro 关联任务 / 关联习惯 pickers.
 *
 * Reuses TodayPickerSheet's shell semantics (scrim, bottom slide, Escape close,
 * focus trap, return focus) with unique animation names. Purely presentational:
 * the parent owns candidates, selection, and link state. Names render as JSX
 * text nodes only (T-13-14 — never innerHTML).
 */
export default function PomodoroPickerSheet({
  open,
  title,
  groups,
  selectedIds,
  onSelect,
  onClose,
  returnFocusRef,
  emptyText,
}: PomodoroPickerSheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  // T17: task rows toggle live (multi-select), so the footer says 完成; a
  // habit/todo-only picker keeps its pick-one-and-close 取消 copy.
  const hasTaskOptions = groups.some((group) =>
    group.options.some((option) => option.kind === 'task'),
  )

  // Opened: land focus on the first option (or the panel when there are none).
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLButtonElement>('[data-picker-option]')
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

    // Hand-rolled focus trap: same algorithm as ItemSheet / TodayPickerSheet.
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

  const hasOptions = groups.some((group) => group.options.length > 0)

  return (
    <>
      <style>{`
        @keyframes orbit-pomodoro-picker-scrim-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes orbit-pomodoro-picker-sheet-in {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .orbit-pomodoro-picker-scrim { animation: orbit-pomodoro-picker-scrim-in 150ms ease-out both; }
        .orbit-pomodoro-picker-sheet { animation: orbit-pomodoro-picker-sheet-in 200ms ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .orbit-pomodoro-picker-scrim, .orbit-pomodoro-picker-sheet { animation: none !important; }
        }
      `}</style>

      <div
        className="orbit-pomodoro-picker-scrim fixed inset-0 z-[60] flex items-end sm:items-center justify-center"
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
          className="orbit-pomodoro-picker-sheet w-full sm:max-w-[448px] rounded-t-2xl sm:rounded-2xl"
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
            {title}
          </h2>

          {hasOptions ? (
            <div
              style={{
                marginTop: '24px',
                flex: '1 1 auto',
                minHeight: 0,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '24px',
              }}
            >
              {groups.map((group) =>
                group.options.length === 0 ? null : (
                  <section
                    key={group.title}
                    style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
                  >
                    <h3 style={GROUP_TITLE_STYLE}>{group.title}</h3>
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                      {group.options.map((option, index) => {
                        const selected = selectedIds.includes(option.id)
                        return (
                          <li
                            key={`${option.kind}:${option.id}`}
                            style={{
                              borderTop: index === 0 ? 'none' : '1px solid var(--border)',
                            }}
                          >
                            <button
                              type="button"
                              data-picker-option
                              onClick={() => {
                                onSelect(option.id, option.kind)
                                // T17: tasks are multi-select — the sheet stays
                                // open so more tasks can be checked; todo/habit
                                // remain pick-one-and-close.
                                if (option.kind !== 'task') close()
                              }}
                              aria-pressed={selected}
                              className={FOCUS_RING}
                              style={ROW_STYLE}
                            >
                              <span
                                aria-hidden="true"
                                style={{
                                  flex: '0 0 18px',
                                  width: '18px',
                                  fontSize: '14px',
                                  fontWeight: 600,
                                  lineHeight: 1,
                                  color: 'var(--accent)',
                                }}
                              >
                                {selected ? '✓' : ''}
                              </span>
                              <span style={ROW_LABEL_STYLE}>{option.label}</span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </section>
                ),
              )}
            </div>
          ) : (
            <p style={EMPTY_STYLE}>{emptyText ?? '暂无可选项。'}</p>
          )}

          <div style={{ marginTop: '24px', flexShrink: 0 }}>
            <button type="button" onClick={close} className={FOCUS_RING} style={SECONDARY_BUTTON_STYLE}>
              {hasTaskOptions ? '完成' : '取消'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
