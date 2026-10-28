'use client'

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { getRepository } from '@/lib/repository-provider'
import { nextSortOrder, sortByEffectiveOrder } from '@/lib/goal-order'
import { progressOf } from '@/lib/progress'
import { sortReviewsNewestFirst } from '@/lib/review-time'
import { groupTasks, reparentOrder, togglePayload } from '@/lib/task-order'
import { useScopedDrag } from '@/lib/use-scoped-drag'
import type { Goal, Milestone, Review, Task } from '@/lib/types'
import MilestoneCard from '@/components/MilestoneCard'
import ProgressIndicator from '@/components/ProgressIndicator'
import InlineAddRow from '@/components/InlineAddRow'
import ItemSheet from '@/components/ItemSheet'
import ReviewSheet from '@/components/ReviewSheet'
import ReviewTimeline from '@/components/ReviewTimeline'
import TaskRow from '@/components/TaskRow'

const LOAD_ERROR = '里程碑、任务和复盘加载失败。请重新加载；如果仍然失败，刷新页面后再试。'

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

const EMPTY_HEADING_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '20px',
  fontWeight: 600,
  lineHeight: 1.2,
  letterSpacing: '-0.01em',
  color: 'var(--foreground)',
}

const EMPTY_BODY_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--muted)',
}

const LABEL_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const INLINE_ERROR_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
}

const CARD_STYLE: CSSProperties = {
  background: 'var(--card)',
  borderRadius: '12px',
  boxShadow: 'var(--card-shadow)',
  padding: '16px',
  minWidth: 0,
}

const FOCUS_RING = 'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'

interface GoalDetailProps {
  goal: Goal
  onBack: () => void
  onEdit: (goal: Goal) => void
}

/**
 * Goal detail view (D-01 / D-02). Client-side drill-in target: renders the goal
 * header (返回 / 编辑) plus the milestone and direct-task groups. The header
 * shows overall derived progress (D-04/D-06); milestones remain containers —
 * no checkbox, and their progress is derived from their tasks (D-05).
 *
 * All repository access stays inside effects/handlers (Node prerender has no
 * IndexedDB under `output: 'export'`). The page owns drill-in state; this
 * component owns its own data + mutations.
 */
export default function GoalDetail({ goal, onBack, onEdit }: GoalDetailProps) {
  const [milestones, setMilestones] = useState<Milestone[] | null>(null)
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [reviews, setReviews] = useState<Review[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Toggle failure copy, scoped to the containing group (milestone id or null).
  const [toggleError, setToggleError] = useState<{
    milestoneId: string | null
    message: string
  } | null>(null)

  // Item sheet — one at a time. The parent owns persistence for both modes.
  const [editMilestone, setEditMilestone] = useState<Milestone | null>(null)
  const [editTask, setEditTask] = useState<Task | null>(null)
  const [editReview, setEditReview] = useState<Review | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [sheetSaving, setSheetSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // Selectors resolved in order after a re-render (first match wins).
  const [pendingFocus, setPendingFocus] = useState<string[] | null>(null)

  const alive = useRef(false)
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const milestonesListRef = useRef<HTMLUListElement | null>(null)
  const directTasksListRef = useRef<HTMLDivElement | null>(null)

  // Grouping runs every render so both the render tree and the direct-tasks
  // drag hook see the same sorted buckets. Orphan defense lives in groupTasks.
  const liveMilestoneIds = new Set((milestones ?? []).map((milestone) => milestone.id))
  const { direct, byMilestone } = groupTasks(tasks ?? [], liveMilestoneIds)
  // Derived, never stored (D-06): every task in state is live + goal-scoped, so
  // this recomputes in the same render pass as an optimistic toggle.
  const headerProgress = progressOf(tasks ?? [])

  const { dragId, dragOrder, dropIndex, onHandlePointerDown } = useScopedDrag<Milestone>({
    items: milestones ?? [],
    idOf: (milestone) => milestone.id,
    onCommit: commitMilestoneOrder,
    containerRef: milestonesListRef,
    itemSelector: '[data-milestone-card]',
  })

  // Direct-tasks card has its own drag scope (one per list group).
  const {
    dragId: directDragId,
    dragOrder: directDragOrder,
    dropIndex: directDropIndex,
    onHandlePointerDown: onDirectHandlePointerDown,
  } = useScopedDrag<Task>({
    items: direct,
    idOf: (task) => task.id,
    onCommit: commitTaskOrder,
    containerRef: directTasksListRef,
    itemSelector: '[data-task-row]',
  })

  async function load() {
    try {
      const repo = getRepository()
      // All reads are issued together; filtering/grouping happens in memory.
      const [allMilestones, allTasks, allReviews] = await Promise.all([
        repo.list<Milestone>('milestones'),
        repo.list<Task>('tasks'),
        repo.list<Review>('reviews'),
      ])
      if (!alive.current) return
      setMilestones(
        sortByEffectiveOrder(
          allMilestones.filter((m) => m.goal_id === goal.id && m.deleted_at == null),
        ),
      )
      // Kept raw (grouping arrives in 03-03) but scoped to this goal's live rows.
      setTasks(allTasks.filter((t) => t.goal_id === goal.id && t.deleted_at == null))
      // Goal-scoped, tombstone-filtered, sorted newest-first once at load (D-01).
      setReviews(
        sortReviewsNewestFirst(
          allReviews.filter((r) => r.goal_id === goal.id && r.deleted_at == null),
        ),
      )
      setError(null)
    } catch {
      if (!alive.current) return
      setError(LOAD_ERROR)
    }
  }

  useEffect(() => {
    alive.current = true
    void load()
    // Announce the drill-in by moving focus to the heading (no visible outline).
    const frame = requestAnimationFrame(() => {
      titleRef.current?.focus()
    })
    return () => {
      alive.current = false
      cancelAnimationFrame(frame)
    }
    // Mount-only: load() only touches stable setters, refs and getRepository.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function retryLoad() {
    setError(null)
    setMilestones(null)
    setTasks(null)
    setReviews(null)
    void load()
  }

  // Deferred focus: resolve each selector after the sheet closes and the group
  // re-renders. A cross-group move remounts the row, so we re-query by
  // data-task-row rather than relying on the stored invoking node
  // (03-UI-SPEC §9); the group add row is the fallback after a delete.
  useEffect(() => {
    if (!pendingFocus) return
    const frame = requestAnimationFrame(() => {
      for (const selector of pendingFocus) {
        const element = document.querySelector<HTMLElement>(selector)
        if (element && document.contains(element)) {
          element.focus()
          break
        }
      }
      setPendingFocus(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [pendingFocus])

  function milestoneMoreSelector(id: string) {
    return `[data-milestone-card][data-milestone-id="${id}"] [data-milestone-more]`
  }

  function taskMoreSelector(id: string) {
    return `[data-task-row][data-task-id="${id}"] [data-task-more]`
  }

  function reviewMoreSelector(id: string) {
    return `[data-review-entry][data-review-id="${id}"] [data-review-more]`
  }

  function groupAddRowSelector(milestoneId: string | null) {
    return milestoneId === null
      ? '[data-add-row="direct"]'
      : `[data-add-row="milestone:${milestoneId}"]`
  }

  /** Effective parent: a dangling/foreign milestone_id resolves to 直接任务. */
  function effectiveParentId(task: Task): string | null {
    return task.milestone_id && liveMilestoneIds.has(task.milestone_id)
      ? task.milestone_id
      : null
  }

  function openMilestoneMenu(milestone: Milestone) {
    setEditMilestone(milestone)
    setConfirmDelete(false)
    setSaveError(null)
    setDeleteError(null)
  }

  function closeItemSheet() {
    if (!editMilestone) return
    const id = editMilestone.id
    setEditMilestone(null)
    setConfirmDelete(false)
    setSaveError(null)
    setDeleteError(null)
    setPendingFocus([milestoneMoreSelector(id), '[data-add-row="milestones"]'])
  }

  async function saveMilestone(name: string) {
    if (!editMilestone) return
    const id = editMilestone.id
    setSheetSaving(true)
    setSaveError(null)
    try {
      const repo = getRepository()
      // Spread preserves id / goal_id / completed / created_at / sort_order;
      // the repository re-stamps updated_at.
      await repo.upsert<Milestone>('milestones', { ...editMilestone, name })
      setEditMilestone(null)
      setConfirmDelete(false)
      await load()
      setPendingFocus([milestoneMoreSelector(id), '[data-add-row="milestones"]'])
    } catch {
      setSaveError('保存失败，请重试。')
    } finally {
      setSheetSaving(false)
    }
  }

  /**
   * TASK-02: delete a milestone by first re-parenting every live task under it
   * to 直接任务, THEN tombstoning the milestone (re-parent writes must precede
   * the tombstone). reparentOrder assigns each moved task a DISTINCT
   * sort_order so their visual order is preserved. On failure, re-read so the
   * UI reflects whatever persisted.
   */
  async function deleteMilestone() {
    if (!editMilestone) return
    const id = editMilestone.id
    setSheetSaving(true)
    setDeleteError(null)
    try {
      const repo = getRepository()
      const allTasks = await repo.list<Task>('tasks', { includeDeleted: true })
      const moved = sortByEffectiveOrder(
        allTasks.filter(
          (task) => task.goal_id === goal.id && task.milestone_id === id && task.deleted_at == null,
        ),
      )
      const directSiblings = allTasks.filter(
        (task) => task.goal_id === goal.id && task.milestone_id === null,
      )
      const assignments = reparentOrder(directSiblings, moved)
      const byId = new Map(moved.map((task) => [task.id, task]))

      // Re-parent live tasks first: keep completed/completed_at, move to null.
      for (const assignment of assignments) {
        const task = byId.get(assignment.id)
        if (!task) continue
        await repo.upsert<Task>('tasks', {
          ...task,
          milestone_id: null,
          sort_order: assignment.sort_order,
        })
      }

      // Tombstone only — rows are never physically removed.
      await repo.softDelete('milestones', id)
      setEditMilestone(null)
      setConfirmDelete(false)
      await load()
      setPendingFocus(['[data-add-row="direct"]'])
    } catch {
      setDeleteError('删除失败，请重试。')
      await load()
    } finally {
      setSheetSaving(false)
    }
  }

  async function createMilestone(name: string) {
    const repo = getRepository()
    // Fresh read including tombstones so append order sees every sibling.
    const all = await repo.list<Milestone>('milestones', { includeDeleted: true })
    const siblings = all.filter((m) => m.goal_id === goal.id)
    const sort_order = nextSortOrder(siblings)
    await repo.upsert<Milestone>('milestones', {
      goal_id: goal.id,
      name,
      completed: false,
      completed_at: null,
      created_at: new Date().toISOString(),
      sort_order,
    })
    await load()
  }

  async function commitMilestoneOrder(finalOrder: Milestone[], baseline: Milestone[]) {
    try {
      const repo = getRepository()
      const previous = new Map(baseline.map((milestone) => [milestone.id, milestone.sort_order]))
      // Reassign 0..n-1 in visual order; only changed rows are written.
      // Tombstoned siblings keep their old sort_order (they are not in the list).
      for (let index = 0; index < finalOrder.length; index += 1) {
        const milestone = finalOrder[index]
        if (previous.get(milestone.id) !== index) {
          await repo.upsert<Milestone>('milestones', { ...milestone, sort_order: index })
        }
      }
      await load()
    } catch {
      // Persistence failed: re-read so the UI shows the stored order (silent).
      await load()
    }
  }

  /**
   * Persists a task drag within one group: reassign sort_order 0..n-1 over the
   * live siblings in visual order, writing only changed rows (T-03-11).
   * Tombstoned rows keep their old values. Used by milestone cards and the
   * direct-tasks card alike.
   */
  async function commitTaskOrder(finalOrder: Task[], baseline: Task[]) {
    try {
      const repo = getRepository()
      const previous = new Map(baseline.map((task) => [task.id, task.sort_order]))
      for (let index = 0; index < finalOrder.length; index += 1) {
        const task = finalOrder[index]
        if (previous.get(task.id) !== index) {
          await repo.upsert<Task>('tasks', { ...task, sort_order: index })
        }
      }
      await load()
    } catch {
      // Persistence failed: re-read so the UI shows the stored order (silent).
      await load()
    }
  }

  /**
   * TASK-01: optimistic toggle. Flip local state immediately, then persist
   * `completed` + `completed_at`. On failure revert the row and surface the
   * error below its group (T-03-10).
   */
  async function toggleTask(task: Task) {
    const payload = togglePayload(task)
    const groupId = task.milestone_id
    setToggleError(null)
    setTasks(
      (previous) =>
        previous?.map((entry) => (entry.id === task.id ? { ...entry, ...payload } : entry)) ??
        previous,
    )
    try {
      const repo = getRepository()
      await repo.upsert<Task>('tasks', { ...task, ...payload })
    } catch {
      setTasks(
        (previous) =>
          previous?.map((entry) => (entry.id === task.id ? task : entry)) ?? previous,
      )
      setToggleError({ milestoneId: groupId, message: '更新任务失败，请重试。' })
    }
  }

  /**
   * MIL-02: create a task in the given group. A fresh includeDeleted read
   * scopes siblings by goal_id + milestone_id so append order counts tombstones.
   * Rejects on failure so InlineAddRow preserves the typed text.
   */
  async function createTask(milestoneId: string | null, name: string) {
    const repo = getRepository()
    const all = await repo.list<Task>('tasks', { includeDeleted: true })
    const siblings = all.filter(
      (task) => task.goal_id === goal.id && task.milestone_id === milestoneId,
    )
    const sort_order = nextSortOrder(siblings)
    await repo.upsert<Task>('tasks', {
      goal_id: goal.id,
      milestone_id: milestoneId,
      name,
      completed: false,
      completed_at: null,
      created_at: new Date().toISOString(),
      sort_order,
    })
    await load()
  }

  function openTaskMenu(task: Task) {
    setEditTask(task)
    setConfirmDelete(false)
    setSaveError(null)
    setDeleteError(null)
  }

  function closeTaskSheet() {
    if (!editTask) return
    const id = editTask.id
    setEditTask(null)
    setConfirmDelete(false)
    setSaveError(null)
    setDeleteError(null)
    setPendingFocus([taskMoreSelector(id), groupAddRowSelector(effectiveParentId(editTask))])
  }

  /**
   * D-06/D-07: rename and/or move a task. Parent unchanged preserves the
   * existing sort_order; a parent change appends to the destination group with
   * a fresh scoped nextSortOrder. A dangling original id compared against an
   * emitted null counts as a change, repairing the reference.
   */
  async function saveTask(payload: { name: string; milestone_id: string | null }) {
    if (!editTask) return
    const task = editTask
    const id = task.id
    const newParent = payload.milestone_id
    const parentChanged = newParent !== task.milestone_id
    setSheetSaving(true)
    setSaveError(null)
    try {
      const repo = getRepository()
      if (parentChanged) {
        const all = await repo.list<Task>('tasks', { includeDeleted: true })
        const siblings = all.filter(
          (entry) =>
            entry.goal_id === goal.id &&
            entry.milestone_id === newParent &&
            entry.id !== task.id,
        )
        const sort_order = nextSortOrder(siblings)
        await repo.upsert<Task>('tasks', {
          ...task,
          name: payload.name,
          milestone_id: newParent,
          sort_order,
        })
      } else {
        await repo.upsert<Task>('tasks', { ...task, name: payload.name })
      }
      setEditTask(null)
      setConfirmDelete(false)
      await load()
      setPendingFocus([taskMoreSelector(id), groupAddRowSelector(newParent)])
    } catch {
      setSaveError('保存失败，请重试。')
    } finally {
      setSheetSaving(false)
    }
  }

  async function deleteTask() {
    if (!editTask) return
    const task = editTask
    const id = task.id
    const group = effectiveParentId(task)
    setSheetSaving(true)
    setDeleteError(null)
    try {
      const repo = getRepository()
      await repo.softDelete('tasks', id)
      setEditTask(null)
      setConfirmDelete(false)
      await load()
      setPendingFocus([groupAddRowSelector(group)])
    } catch {
      setDeleteError('删除失败，请重试。')
    } finally {
      setSheetSaving(false)
    }
  }

  function openReviewMenu(review: Review) {
    setEditReview(review)
    setSaveError(null)
    setDeleteError(null)
  }

  function closeReviewSheet() {
    if (!editReview) return
    const id = editReview.id
    setEditReview(null)
    setSaveError(null)
    setDeleteError(null)
    setPendingFocus([reviewMoreSelector(id)])
  }

  /**
   * REV-01: append a note stamped with the current time (D-06). No try/catch —
   * a repository failure REJECTS so ReviewTimeline preserves the draft.
   */
  async function createReview(content: string) {
    const repo = getRepository()
    await repo.upsert<Review>('reviews', {
      goal_id: goal.id,
      content,
      created_at: new Date().toISOString(),
    })
    await load()
  }

  /**
   * D-06: the spread preserves id / goal_id / created_at, so editing never
   * re-stamps the note's timeline position.
   */
  async function saveReview(content: string) {
    if (!editReview) return
    const id = editReview.id
    setSheetSaving(true)
    setSaveError(null)
    try {
      const repo = getRepository()
      await repo.upsert<Review>('reviews', { ...editReview, content })
      setEditReview(null)
      await load()
      setPendingFocus([reviewMoreSelector(id)])
    } catch {
      setSaveError('保存失败，请重试。')
    } finally {
      setSheetSaving(false)
    }
  }

  /**
   * D-03: tombstone immediately — no confirmation state. The deleted entry's
   * more button no longer exists, so focus falls back to the composer.
   */
  async function deleteReview() {
    if (!editReview) return
    const id = editReview.id
    setSheetSaving(true)
    setDeleteError(null)
    try {
      const repo = getRepository()
      await repo.softDelete('reviews', id)
      setEditReview(null)
      await load()
      setPendingFocus(['[data-review-composer]'])
    } catch {
      setDeleteError('删除失败，请重试。')
    } finally {
      setSheetSaving(false)
    }
  }

  function renderContent() {
    if (error) {
      return (
        <div className="flex flex-col" style={{ gap: '8px' }}>
          <p style={ERROR_STYLE}>{error}</p>
          <button
            type="button"
            onClick={retryLoad}
            className={`self-start ${FOCUS_RING}`}
            style={ACCENT_TEXT_BUTTON_STYLE}
          >
            重新加载
          </button>
        </div>
      )
    }

    if (milestones === null || tasks === null || reviews === null) {
      return <p style={LOADING_STYLE}>正在加载里程碑、任务和复盘…</p>
    }

    const isEmpty = milestones.length === 0 && tasks.length === 0
    // Mirror app/page.tsx: the dragged order wins while a pointer drag is live.
    const displayed = dragOrder ?? milestones
    const displayedDirect = directDragOrder ?? direct

    return (
      <div className="flex flex-col" style={{ gap: '24px' }}>
        {isEmpty ? (
          <div className="flex flex-col" style={{ gap: '8px' }}>
            <p style={EMPTY_HEADING_STYLE}>还没有里程碑或任务</p>
            <p style={EMPTY_BODY_STYLE}>
              在下面添加第一个里程碑，或直接添加任务，把目标拆成可推进的步骤。
            </p>
          </div>
        ) : null}

        <section className="flex flex-col" style={{ gap: '8px' }}>
          <h2 style={LABEL_STYLE}>里程碑</h2>
          <div className="flex flex-col" style={{ gap: '8px' }}>
            {displayed.length > 0 ? (
              <ul
                ref={milestonesListRef}
                className="flex flex-col"
                style={{ listStyle: 'none', padding: 0, margin: 0, gap: '16px' }}
              >
                {displayed.map((milestone, index) => (
                  <MilestoneCard
                    key={milestone.id}
                    milestone={milestone}
                    tasks={byMilestone.get(milestone.id) ?? []}
                    isDragging={dragId === milestone.id}
                    showDropLine={dropIndex === index}
                    onDragHandlePointerDown={onHandlePointerDown}
                    onOpenMenu={openMilestoneMenu}
                    onToggleTask={toggleTask}
                    onOpenTaskMenu={openTaskMenu}
                    onCreateTask={(name) => createTask(milestone.id, name)}
                    onCommitTaskOrder={commitTaskOrder}
                    taskError={
                      toggleError?.milestoneId === milestone.id ? toggleError.message : null
                    }
                  />
                ))}
              </ul>
            ) : null}
            <InlineAddRow
              placeholder="添加里程碑"
              ariaLabel="添加里程碑"
              onCreate={createMilestone}
              dataAddRow="milestones"
              errorMessage="添加里程碑失败，请重试。"
            />
          </div>
        </section>

        <section className="flex flex-col" style={{ gap: '8px' }}>
          <h2 style={LABEL_STYLE}>直接任务</h2>
          <div className="flex flex-col" style={{ ...CARD_STYLE, gap: '8px' }}>
            {direct.length > 0 ? (
              <div ref={directTasksListRef} data-task-list className="flex flex-col">
                {displayedDirect.map((task, index) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    first={index === 0}
                    isDragging={directDragId === task.id}
                    showDropLine={directDropIndex === index}
                    onToggle={toggleTask}
                    onDragHandlePointerDown={onDirectHandlePointerDown}
                    onOpenMenu={openTaskMenu}
                  />
                ))}
              </div>
            ) : null}
            <InlineAddRow
              placeholder="添加任务"
              ariaLabel="添加任务"
              onCreate={(name) => createTask(null, name)}
              dataAddRow="direct"
              errorMessage="添加任务失败，请重试。"
            />
            {toggleError?.milestoneId === null ? (
              <p style={INLINE_ERROR_STYLE}>{toggleError.message}</p>
            ) : null}
          </div>
        </section>

        {/* Third section「复盘」(D-02) — always rendered, outside the isEmpty block. */}
        <ReviewTimeline
          reviews={reviews}
          onCreate={createReview}
          onOpenEdit={openReviewMenu}
        />
      </div>
    )
  }

  return (
    <div className="orbit-detail flex flex-col" style={{ gap: '32px' }}>
      <style>{`
        @keyframes orbit-detail-in { from { opacity: 0; } to { opacity: 1; } }
        .orbit-detail { animation: orbit-detail-in 150ms ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .orbit-detail { animation: none !important; }
        }
      `}</style>

      <header className="flex flex-col">
        <div className="flex items-center justify-between" style={{ gap: '16px' }}>
          <button
            type="button"
            onClick={onBack}
            aria-label="返回目标列表"
            className={`flex items-center ${FOCUS_RING}`}
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
          <button
            type="button"
            data-goal-edit
            onClick={() => onEdit(goal)}
            className={FOCUS_RING}
            style={ACCENT_TEXT_BUTTON_STYLE}
          >
            编辑
          </button>
        </div>

        <h1
          ref={titleRef}
          data-goal-detail-title
          tabIndex={-1}
          className="break-words"
          style={{
            margin: 0,
            marginTop: '16px',
            fontSize: '20px',
            fontWeight: 600,
            lineHeight: 1.2,
            letterSpacing: '-0.01em',
            color: 'var(--foreground)',
            outline: 'none',
          }}
        >
          {goal.name}
        </h1>

        {goal.description ? (
          <p
            className="break-words line-clamp-2"
            style={{
              margin: 0,
              marginTop: '4px',
              fontSize: '17px',
              fontWeight: 400,
              lineHeight: 1.47,
              color: 'var(--muted)',
            }}
          >
            {goal.description}
          </p>
        ) : null}

        {headerProgress.total > 0 ? (
          <div style={{ marginTop: '16px' }}>
            <ProgressIndicator
              completed={headerProgress.completed}
              total={headerProgress.total}
              label="目标进度"
            />
          </div>
        ) : null}
      </header>

      {renderContent()}

      {editMilestone ? (
        <ItemSheet
          key={editMilestone.id}
          mode="milestone"
          initialName={editMilestone.name}
          liveTaskCount={
            (tasks ?? []).filter((task) => task.milestone_id === editMilestone.id).length
          }
          onSave={saveMilestone}
          onDelete={deleteMilestone}
          onCancel={closeItemSheet}
          saving={sheetSaving}
          saveError={saveError}
          deleteError={deleteError}
          confirmState={confirmDelete}
          onRequestDelete={() => setConfirmDelete(true)}
          onCancelDelete={() => setConfirmDelete(false)}
        />
      ) : null}

      {editTask ? (
        <ItemSheet
          key={`task-${editTask.id}`}
          mode="task"
          initialName={editTask.name}
          initialParentId={effectiveParentId(editTask)}
          parentOptions={[
            { id: null, label: '直接任务' },
            ...(milestones ?? []).map((milestone) => ({
              id: milestone.id,
              label: milestone.name,
            })),
          ]}
          onSave={saveTask}
          onDelete={deleteTask}
          onCancel={closeTaskSheet}
          saving={sheetSaving}
          saveError={saveError}
          deleteError={deleteError}
          confirmState={confirmDelete}
          onRequestDelete={() => setConfirmDelete(true)}
          onCancelDelete={() => setConfirmDelete(false)}
        />
      ) : null}

      {editReview ? (
        <ReviewSheet
          key={editReview.id}
          review={editReview}
          onSave={saveReview}
          onDelete={deleteReview}
          onCancel={closeReviewSheet}
          saving={sheetSaving}
          saveError={saveError}
          deleteError={deleteError}
        />
      ) : null}
    </div>
  )
}
