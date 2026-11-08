'use client'

import type { CSSProperties } from 'react'
import type { DailyTodo } from '@/lib/types'
import TodayRemoveButton from '@/components/TodayRemoveButton'

interface TodayRowProps {
  todo: DailyTodo
  /** First row in its group renders no top divider. */
  first: boolean
  /** Pre-formatted `添加于 …` caption; null for entries added today (D-02). */
  caption: string | null
  onToggle: (todo: DailyTodo) => void
  onRemove: (todo: DailyTodo) => void
}

const NAME_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  overflowWrap: 'anywhere',
}

const CAPTION_STYLE: CSSProperties = {
  margin: 0,
  paddingLeft: '52px',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  overflowWrap: 'anywhere',
}

/**
 * Standalone 今日 todo row (09-UI-SPEC §4/§7): the same two-line shell as a
 * linked checkbox row, difference only in persistence. Line 1 is
 * [44×44 checkbox][name][44×44 remove]; line 2 is the muted added-date caption
 * when the entry is older than today. The name is a JSX text node only
 * (T-09-12 — never innerHTML).
 */
export default function TodayRow({
  todo,
  first,
  caption,
  onToggle,
  onRemove,
}: TodayRowProps) {
  const done = todo.completed === true
  const name = todo.name ?? ''

  return (
    <div
      data-today-row
      data-entry-id={todo.id}
      className="flex flex-col"
      style={{ minWidth: 0, borderTop: first ? 'none' : '1px solid var(--border)' }}
    >
      <div
        className="flex items-center"
        style={{ gap: '8px', minHeight: '44px', padding: '4px 0', minWidth: 0 }}
      >
        <label
          className="has-[:focus-visible]:[outline:2px_solid_var(--accent)] has-[:focus-visible]:[outline-offset:-2px]"
          style={{
            flex: '0 0 44px',
            width: '44px',
            height: '44px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={done}
            onChange={() => onToggle(todo)}
            aria-label={name}
            className="sr-only"
          />
          <span
            aria-hidden="true"
            className="motion-reduce:transition-none"
            style={{
              width: '22px',
              height: '22px',
              borderRadius: '50%',
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: done ? 'var(--accent)' : 'transparent',
              border: done ? 'none' : '1.5px solid var(--muted)',
              transition: 'background-color 120ms ease-out, border-color 120ms ease-out',
            }}
          >
            {done ? (
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
        </label>

        <span
          style={{
            ...NAME_STYLE,
            color: done ? 'var(--muted)' : 'var(--foreground)',
            textDecoration: done ? 'line-through' : 'none',
          }}
        >
          {name}
        </span>

        <TodayRemoveButton name={name} action="delete" onRemove={() => onRemove(todo)} />
      </div>

      {caption ? <p style={CAPTION_STYLE}>{caption}</p> : null}
    </div>
  )
}
