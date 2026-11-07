'use client'

import { useRef } from 'react'
import type { CSSProperties } from 'react'
import type { Task } from '@/lib/types'
import { buildTaskTree, subtreeProgress } from '@/lib/task-tree'
import { useScopedDrag } from '@/lib/use-scoped-drag'
import TaskRow from '@/components/TaskRow'
import InlineAddRow from '@/components/InlineAddRow'

interface TaskTreeProps {
  /** Every live task of one milestone, containers and leaves included. */
  tasks: Task[]
  /** Parent task whose add-subtask composer is currently open, or null. */
  addSubtaskParentId?: Task['id'] | null
  /** T10: container task ids currently collapsed (prefixed `t:`). */
  collapsedIds?: Set<string>
  /** T10: toggle one container task's collapse. */
  onToggleCollapse?: (id: string) => void
  onToggleTask: (task: Task) => void
  onOpenTaskMenu: (task: Task) => void
  /** Persists one sibling group's order; receives that group's baseline. */
  onCommitTaskOrder: (finalOrder: Task[], baseline: Task[]) => Promise<void> | void
  /** Creates a subtask under the currently open composer's parent. */
  onCreateSubtask: (name: string) => Promise<void>
  onCancelSubtask: () => void
  onOpenAddProgress: (task: Task) => void
}

interface TaskGroupProps {
  /** null for the milestone's top-level group. */
  parentId: Task['id'] | null
  /** 0-based nesting of the siblings this group renders (roots = 0). */
  depth: number
  /** Siblings in this group. */
  siblings: Task[]
  /** Full parent → children relation for the milestone. */
  children: Map<string, Task[]>
  addSubtaskParentId?: Task['id'] | null
  collapsedIds?: Set<string>
  onToggleCollapse?: (id: string) => void
  onToggleTask: (task: Task) => void
  onOpenTaskMenu: (task: Task) => void
  onCommitTaskOrder: (finalOrder: Task[], baseline: Task[]) => Promise<void> | void
  onCreateSubtask: (name: string) => Promise<void>
  onCancelSubtask: () => void
  onOpenAddProgress: (task: Task) => void
}

const UL_BASE: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  paddingTop: 0,
  paddingRight: 0,
  paddingBottom: 0,
}

const SUBTASK_COMPOSER_STYLE: CSSProperties = {
  paddingLeft: '16px',
}

/**
 * One sibling scope. Hooks run per component instance (never in a loop), so each
 * nested group owns an independent `useScopedDrag` — a drag can never cross from
 * one parent's children to another's (UI-SPEC Interaction Contract).
 */
function TaskGroup({
  parentId,
  depth,
  siblings,
  children,
  addSubtaskParentId = null,
  collapsedIds = new Set(),
  onToggleCollapse,
  onToggleTask,
  onOpenTaskMenu,
  onCommitTaskOrder,
  onCreateSubtask,
  onCancelSubtask,
  onOpenAddProgress,
}: TaskGroupProps) {
  const listRef = useRef<HTMLUListElement | null>(null)

  const { dragId, dragOrder, dropIndex, onHandlePointerDown } = useScopedDrag<Task>({
    items: siblings,
    idOf: (task) => task.id,
    onCommit: onCommitTaskOrder,
    containerRef: listRef,
    itemSelector: '[data-task-row]',
  })

  // Mirror app/page.tsx: the dragged order wins while a pointer drag is live.
  const displayed = dragOrder ?? siblings

  return (
    <ul
      ref={listRef}
      data-task-group
      className="flex flex-col"
      style={{
        ...UL_BASE,
        paddingLeft: parentId === null ? 0 : 16,
      }}
    >
      {displayed.map((task, index) => {
        const kids = children.get(task.id) ?? []
        const isContainer = kids.length > 0
        const progress = isContainer ? subtreeProgress(task.id, children) : null
        const progressRatio =
          progress && progress.total > 0 ? progress.completed / progress.total : 0
        const canAddHere = depth < 2
        const isCollapsed = isContainer && collapsedIds.has(`t:${task.id}`)

        return (
          <li key={task.id} style={{ listStyle: 'none', minWidth: 0 }}>
            <TaskRow
              task={task}
              first={index === 0}
              isDragging={dragId === task.id}
              showDropLine={dropIndex === index}
              isContainer={isContainer}
              progressRatio={progressRatio}
              onToggle={onToggleTask}
              onDragHandlePointerDown={onHandlePointerDown}
              onOpenMenu={onOpenTaskMenu}
              onOpenAddProgress={onOpenAddProgress}
              collapseControl={
                isContainer && onToggleCollapse ? (
                  <button
                    type="button"
                    aria-label={isCollapsed ? `展开${task.name}` : `收起${task.name}`}
                    aria-expanded={!isCollapsed}
                    onClick={() => onToggleCollapse(`t:${task.id}`)}
                    className="focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:-2px]"
                    style={{
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
                      cursor: 'pointer',
                    }}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 18 18"
                      aria-hidden="true"
                      focusable="false"
                      style={{
                        color: 'var(--muted)',
                        transform: isCollapsed ? 'none' : 'rotate(90deg)',
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
                ) : undefined
              }
            />

            {/* L3 is the leaf ceiling: no fourth level is ever rendered. */}
            {isContainer && depth < 2 && !isCollapsed ? (
              <TaskGroup
                parentId={task.id}
                depth={depth + 1}
                siblings={kids}
                children={children}
                addSubtaskParentId={addSubtaskParentId}
                collapsedIds={collapsedIds}
                onToggleCollapse={onToggleCollapse}
                onToggleTask={onToggleTask}
                onOpenTaskMenu={onOpenTaskMenu}
                onCommitTaskOrder={onCommitTaskOrder}
                onCreateSubtask={onCreateSubtask}
                onCancelSubtask={onCancelSubtask}
                onOpenAddProgress={onOpenAddProgress}
              />
            ) : null}

            {/* Composer sits at the end of the parent's child subtree, indented
                one level deeper. Escape collapses it without writing. */}
            {canAddHere && addSubtaskParentId === task.id ? (
              <div
                style={SUBTASK_COMPOSER_STYLE}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') onCancelSubtask()
                }}
              >
                <InlineAddRow
                  placeholder="添加子任务"
                  ariaLabel="添加子任务"
                  dataAddRow={`task:${task.id}`}
                  errorMessage="添加子任务失败，请重试。"
                  onCreate={onCreateSubtask}
                />
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Recursive milestone task renderer (08-UI-SPEC §3). Builds the parent → child
 * relation from `parent_id` and renders one `TaskGroup` per sibling scope.
 * Orphan defense (a task whose parent is missing or crosses a milestone) is
 * handled by `buildTaskTree` — such nodes are dropped, never rendered.
 */
export default function TaskTree({
  tasks,
  addSubtaskParentId = null,
  collapsedIds = new Set(),
  onToggleCollapse,
  onToggleTask,
  onOpenTaskMenu,
  onCommitTaskOrder,
  onCreateSubtask,
  onCancelSubtask,
  onOpenAddProgress,
}: TaskTreeProps) {
  const { roots, children } = buildTaskTree(tasks)

  return (
    <TaskGroup
      parentId={null}
      depth={0}
      siblings={roots}
      children={children}
      addSubtaskParentId={addSubtaskParentId}
      collapsedIds={collapsedIds}
      onToggleCollapse={onToggleCollapse}
      onToggleTask={onToggleTask}
      onOpenTaskMenu={onOpenTaskMenu}
      onCommitTaskOrder={onCommitTaskOrder}
      onCreateSubtask={onCreateSubtask}
      onCancelSubtask={onCancelSubtask}
      onOpenAddProgress={onOpenAddProgress}
    />
  )
}
