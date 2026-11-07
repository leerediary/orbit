'use client'

import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { Milestone, Task } from '@/lib/types'
import { progressOf } from '@/lib/progress'
import TaskTree from '@/components/TaskTree'
import InlineAddRow from '@/components/InlineAddRow'
import ProgressIndicator from '@/components/ProgressIndicator'

interface MilestoneCardProps {
  milestone: Milestone
  /** Every live task of this milestone (containers and nested leaves included). */
  tasks: Task[]
  /** T10: this milestone's task list is collapsed. */
  collapsed?: boolean
  /** T10: toggle this milestone's collapse. */
  onToggleCollapsed?: () => void
  /** T10: container task ids currently collapsed (prefixed `t:`). */
  collapsedIds?: Set<string>
  /** T10: toggle one container task's collapse. */
  onToggleCollapse?: (id: string) => void
  isDragging?: boolean
  showDropLine?: boolean
  onDragHandlePointerDown?: (
    event: ReactPointerEvent<HTMLButtonElement>,
    milestone: Milestone,
  ) => void
  onOpenMenu?: (milestone: Milestone) => void
  onToggleTask: (task: Task) => void
  onOpenTaskMenu?: (task: Task) => void
  onCreateTask: (name: string) => Promise<void>
  /** Persists this subtree's sibling order; each TaskGroup passes its baseline. */
  onCommitTaskOrder: (finalOrder: Task[], baseline: Task[]) => Promise<void> | void
  /** Task whose add-subtask composer is open (null = none). */
  addSubtaskParentId?: Task['id'] | null
  /** Creates a subtask under the open composer's parent (wired by GoalDetail). */
  onCreateSubtask?: (name: string) => Promise<void>
  onCancelSubtask?: () => void
  /** Toggle failure copy shown below this card's task list. */
  taskError?: string | null
  onOpenAddProgress: (task: Task) => void
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

const INLINE_ERROR_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
}

/**
 * A milestone is a container (D-03): name + controls on top, then its derived
 * progress row (D-05), its recursive subtask tree and a quick-add row
 * underneath. There is deliberately no checkbox, checkmark, or name
 * strikethrough on the milestone itself — full completion is conveyed only by
 * the accent bar.
 *
 * The flat task list was replaced by `TaskTree` (Phase 8, SC-2): each sibling
 * scope owns its own drag hook, so nested groups never cross rows.
 */
export default function MilestoneCard({
  milestone,
  tasks,
  collapsed = false,
  onToggleCollapsed,
  collapsedIds = new Set(),
  onToggleCollapse,
  isDragging = false,
  showDropLine = false,
  onDragHandlePointerDown,
  onOpenMenu,
  onToggleTask,
  onOpenTaskMenu,
  onCreateTask,
  onCommitTaskOrder,
  addSubtaskParentId = null,
  onCreateSubtask = async () => {},
  onCancelSubtask = () => {},
  taskError = null,
  onOpenAddProgress,
}: MilestoneCardProps) {
  // Leaf-aware rollup over every live descendant leaf (containers excluded).
  const progress = progressOf(tasks)

  return (
    <li
      data-milestone-card
      data-milestone-id={milestone.id}
      data-drag-id={milestone.id}
      className="flex flex-col"
      style={{
        position: 'relative',
        gap: '8px',
        padding: '16px',
        minWidth: 0,
        background: 'var(--card)',
        borderRadius: '12px',
        boxShadow: 'var(--card-shadow)',
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

      <div className="flex items-center" style={{ gap: '8px', minHeight: '44px' }}>
        <button
          type="button"
          aria-label={collapsed ? `展开${milestone.name}` : `收起${milestone.name}`}
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
          className={FOCUS_RING_INSET}
          style={{ ...ICON_BUTTON_STYLE, cursor: 'pointer' }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            aria-hidden="true"
            focusable="false"
            style={{
              color: 'var(--muted)',
              transform: collapsed ? 'none' : 'rotate(90deg)',
              transition: 'transform 120ms ease-out',
            }}
          >
            <polyline
              points="6 3 12 9 6 15"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <h3
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            margin: 0,
            fontSize: '17px',
            fontWeight: 600,
            lineHeight: 1.47,
            color: 'var(--foreground)',
            overflowWrap: 'anywhere',
          }}
        >
          {milestone.name}
        </h3>

        <button
          type="button"
          aria-label="调整里程碑顺序"
          onPointerDown={(event) => onDragHandlePointerDown?.(event, milestone)}
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
          data-milestone-more
          aria-label="里程碑操作"
          onClick={() => onOpenMenu?.(milestone)}
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

      {!collapsed ? (
        <>
          {progress.total > 0 ? (
            <ProgressIndicator
              completed={progress.completed}
              total={progress.total}
              label="里程碑进度"
              format="percent"
            />
          ) : null}

          {tasks.length > 0 ? (
            <TaskTree
              tasks={tasks}
              addSubtaskParentId={addSubtaskParentId}
              onToggleTask={onToggleTask}
              onOpenTaskMenu={onOpenTaskMenu ?? (() => {})}
              onCommitTaskOrder={onCommitTaskOrder}
              onCreateSubtask={onCreateSubtask}
              onCancelSubtask={onCancelSubtask}
              onOpenAddProgress={onOpenAddProgress}
              collapsedIds={collapsedIds}
              onToggleCollapse={onToggleCollapse}
            />
          ) : null}

          <InlineAddRow
            placeholder="添加任务"
            ariaLabel="添加任务"
            onCreate={onCreateTask}
            dataAddRow={`milestone:${milestone.id}`}
            errorMessage="添加任务失败，请重试。"
          />
        </>
      ) : null}

      {taskError ? <p style={INLINE_ERROR_STYLE}>{taskError}</p> : null}
    </li>
  )
}
