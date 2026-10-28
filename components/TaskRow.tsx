'use client'

import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { Task } from '@/lib/types'

interface TaskRowProps {
  task: Task
  /** First row in its group renders no top divider. */
  first?: boolean
  isDragging?: boolean
  showDropLine?: boolean
  onToggle: (task: Task) => void
  onDragHandlePointerDown?: (
    event: ReactPointerEvent<HTMLButtonElement>,
    task: Task,
  ) => void
  onOpenMenu?: (task: Task) => void
}

const FOCUS_RING_INSET =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:-2px]'

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

/**
 * One task row (03-UI-SPEC §6 / TASK-01). Presentational: the toggle, drag, and
 * menu callbacks are owned by GoalDetail (it performs the repository writes).
 *
 * Only the checkbox toggles — the name is not interactive. Completed state is
 * conveyed by the filled checkbox AND the muted strikethrough name (never color
 * alone). Task names render as JSX text nodes only (T-03-08: no innerHTML).
 */
export default function TaskRow({
  task,
  first = false,
  isDragging = false,
  showDropLine = false,
  onToggle,
  onDragHandlePointerDown,
  onOpenMenu,
}: TaskRowProps) {
  return (
    <div
      data-task-row
      data-task-id={task.id}
      data-drag-id={task.id}
      className="flex items-center"
      style={{
        position: 'relative',
        gap: '8px',
        minHeight: '44px',
        padding: '4px 0',
        minWidth: 0,
        borderTop: first ? 'none' : '1px solid var(--border)',
        opacity: isDragging ? 0.6 : 1,
      }}
    >
      {showDropLine ? (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '2px',
            background: 'var(--accent)',
          }}
        />
      ) : null}

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
          checked={task.completed}
          onChange={() => onToggle(task)}
          aria-label={task.name}
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
            background: task.completed ? 'var(--accent)' : 'transparent',
            border: task.completed ? 'none' : '1.5px solid var(--muted)',
            transition: 'background-color 120ms ease-out, border-color 120ms ease-out',
          }}
        >
          {task.completed ? (
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
          flex: '1 1 auto',
          minWidth: 0,
          fontSize: '17px',
          fontWeight: 400,
          lineHeight: 1.47,
          color: task.completed ? 'var(--muted)' : 'var(--foreground)',
          textDecoration: task.completed ? 'line-through' : 'none',
          overflowWrap: 'anywhere',
        }}
      >
        {task.name}
      </span>

      <button
        type="button"
        aria-label="调整任务顺序"
        onPointerDown={(event) => onDragHandlePointerDown?.(event, task)}
        className={FOCUS_RING_INSET}
        style={{ ...ICON_BUTTON_STYLE, touchAction: 'none', cursor: 'grab' }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
          <line
            x1="3"
            y1="7"
            x2="15"
            y2="7"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="3"
            y1="11"
            x2="15"
            y2="11"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>

      <button
        type="button"
        data-task-more
        aria-label="任务操作"
        onClick={() => onOpenMenu?.(task)}
        className={FOCUS_RING_INSET}
        style={{ ...ICON_BUTTON_STYLE, cursor: 'pointer' }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
          <circle cx="9" cy="4" r="1.5" fill="currentColor" />
          <circle cx="9" cy="9" r="1.5" fill="currentColor" />
          <circle cx="9" cy="14" r="1.5" fill="currentColor" />
        </svg>
      </button>
    </div>
  )
}
