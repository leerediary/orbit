'use client'

import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react'
import type { Task } from '@/lib/types'
import { formatValue } from '@/lib/format'
import { leafFraction } from '@/lib/task-tree'
import ProgressRing from '@/components/ProgressRing'

interface TaskRowProps {
  task: Task
  /** First row in its group renders no top divider. */
  first?: boolean
  isDragging?: boolean
  showDropLine?: boolean
  /** Container task (has live children): non-interactive ring, no checkbox. */
  isContainer?: boolean
  /** Derived fraction for the leading ring (container / quantity variants). */
  progressRatio?: number
  onToggle: (task: Task) => void
  onDragHandlePointerDown?: (
    event: ReactPointerEvent<HTMLButtonElement>,
    task: Task,
  ) => void
  onOpenMenu?: (task: Task) => void
  onOpenAddProgress?: (task: Task) => void
  /** Render the drag handle in the default trailing pair (default true). */
  showDragHandle?: boolean
  /** Render the ⋯ menu in the default trailing pair (default true). */
  showMenu?: boolean
  /** Optional muted caption rendered BELOW line 1 (今日 added-date row). */
  metaCaption?: string | null
  /** Optional muted ancestor path rendered INLINE after the task name (今日). */
  nameSuffix?: string | null
  /** Replaces the default drag + ⋯ pair in the trailing slot (今日 remove-only). */
  trailingAction?: ReactNode
  /** Optional collapse chevron rendered before the leading slot (T10 containers). */
  collapseControl?: ReactNode
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

const RING_SLOT_STYLE: CSSProperties = {
  flex: '0 0 44px',
  width: '44px',
  height: '44px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const QUANTITY_COUNT_STYLE: CSSProperties = {
  flex: '0 0 auto',
  minWidth: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

const PROGRESS_BAR_TRACK_STYLE: CSSProperties = {
  height: '4px',
  width: '100%',
  background: 'var(--border)',
  borderRadius: '2px',
  overflow: 'hidden',
}

// 09-UI-SPEC §4-§6: added-date caption stacked under line 1, indented past the
// 44px leading control slot. Text content only (never innerHTML).
const META_CAPTION_STYLE: CSSProperties = {
  margin: 0,
  marginBottom: '4px',
  paddingLeft: '52px',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  overflowWrap: 'break-word',
}

/**
 * One task row (03-UI-SPEC §6 / 08-UI-SPEC §4-§7). Presentational: the toggle,
 * drag, menu, and add-progress callbacks are owned by GoalDetail (it performs
 * the repository writes).
 *
 * Three variants share the row shell: a checkable checkbox leaf, a quantity leaf
 * (two lines: ring + name, then meta + 加进度 with a conditional inline form),
 * and a container whose leading slot is a non-interactive 22px ProgressRing
 * (D-02 — containers are never checkable). Completion is conveyed by the
 * control AND the muted strikethrough name (never color alone). Task names and
 * units render as JSX text nodes only (T-08-22: no innerHTML).
 */
export default function TaskRow({
  task,
  first = false,
  isDragging = false,
  showDropLine = false,
  isContainer = false,
  progressRatio = 0,
  onToggle,
  onDragHandlePointerDown,
  onOpenMenu,
  onOpenAddProgress,
  showDragHandle = true,
  showMenu = true,
  metaCaption = null,
  nameSuffix = null,
  trailingAction,
  collapseControl,
}: TaskRowProps) {
  // Legacy rows are normalized to 'checkbox' at migration/import time, so the
  // field is always present on live tasks.
  const isQuantity = task.progress_type === 'quantity' && !isContainer
  const quantityComplete =
    isQuantity && (task.current_value ?? 0) >= (task.target_value ?? 0)
  const isDone = isContainer ? false : isQuantity ? quantityComplete : task.completed
  const leadingSlot = isContainer ? (
    <span aria-hidden="true" style={RING_SLOT_STYLE}>
      <ProgressRing ratio={progressRatio} />
    </span>
  ) : isQuantity ? (
    <span aria-hidden="true" style={RING_SLOT_STYLE}>
      <ProgressRing ratio={leafFraction(task)} />
    </span>
  ) : (
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
  )

  // 17px name clamped to two lines: Latin wraps at word boundaries
  // (break-word), overlong tokens still cannot overflow. The ancestor
  // breadcrumb no longer rides inline — it joins the meta caption below.
  const nameStyle: CSSProperties = {
    flex: '1 1 auto',
    minWidth: 0,
    fontSize: '17px',
    fontWeight: 400,
    lineHeight: 1.47,
    color: isDone ? 'var(--muted)' : 'var(--foreground)',
    textDecoration: isDone ? 'line-through' : 'none',
    overflowWrap: 'break-word',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  }

  const nameNode = <span style={nameStyle}>{task.name}</span>

  const quantityNameButton = (
    <button
      type="button"
      data-task-name
      onClick={() => onOpenAddProgress?.(task)}
      className={FOCUS_RING_INSET}
      style={{
        ...nameStyle,
        textAlign: 'left',
        background: 'none',
        border: 'none',
        padding: 0,
        margin: 0,
        fontFamily: 'inherit',
        cursor: 'pointer',
      }}
    >
      {task.name}
    </button>
  )

  const dragButton = (
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
  )

  const moreButton = (
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
  )

  const unitText = (task.unit ?? '').trim()

  // The ancestor breadcrumb (今日) shares the muted caption line with the
  // added-date text: `添加于 三天前 · Le Petit Prince`, breadcrumb alone when
  // there is no caption.
  const captionText = [metaCaption, nameSuffix].filter(Boolean).join(' · ')
  const captionNode = captionText ? <p style={META_CAPTION_STYLE}>{captionText}</p> : null

  const quantityCount = (
    <span style={QUANTITY_COUNT_STYLE}>
      {formatValue(task.current_value ?? 0)}/{formatValue(task.target_value ?? 0)}
      {unitText ? ` ${unitText}` : ''}
    </span>
  )

  // The trailing slot is either the caller's control (今日: remove only) or the
  // default drag + ⋯ pair. Both render branches share it, so GoalDetail's
  // existing usage is unchanged (both flags default true).
  const trailing = trailingAction ?? (
    <>
      {showDragHandle ? dragButton : null}
      {showMenu ? moreButton : null}
    </>
  )

  return (
    <div
      data-task-row
      data-task-id={task.id}
      data-drag-id={task.id}
      className="flex flex-col"
      style={{
        position: 'relative',
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

      {isQuantity ? (
        <>
          {/* Line 1 — ring + clickable name + drag/menu. The count lives on
              line 2 so a narrow column never squeezes the name. */}
          <div
            className="flex items-center"
            style={{ gap: '8px', minHeight: '44px', padding: '4px 0', minWidth: 0 }}
          >
            {leadingSlot}
            {quantityNameButton}
            {trailing}
          </div>

          {/* Line 2 — bare progress bar + count (no completion text). */}
          <div
            className="flex items-center"
            style={{ paddingLeft: '52px', paddingBottom: '4px', minWidth: 0, gap: '8px' }}
          >
            <div style={{ ...PROGRESS_BAR_TRACK_STYLE, flex: '1 1 0', minWidth: 0, width: 'auto' }}>
              <div
                aria-hidden="true"
                className="motion-reduce:transition-none"
                style={{
                  height: '100%',
                  width: `${Math.min(leafFraction(task), 1) * 100}%`,
                  borderRadius: '2px',
                  background: quantityComplete ? 'var(--accent)' : 'var(--muted)',
                  transition: 'width 120ms ease-out, background-color 120ms ease-out',
                }}
              />
            </div>
            {quantityCount}
          </div>

          {/* Line 3 (conditional) — added-date caption + breadcrumb (今日). */}
          {captionNode}
        </>
      ) : (
        <>
          <div
            className="flex items-center"
            style={{ gap: '8px', minHeight: '44px', padding: '4px 0', minWidth: 0 }}
          >
            {collapseControl}
            {leadingSlot}
            {nameNode}
            {trailing}
          </div>
          {captionNode}
        </>
      )}
    </div>
  )
}
