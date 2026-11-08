'use client'

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { getRepository } from '@/lib/repository-provider'
import { autoCheckinForTask } from '@/lib/habit-auto-checkin'
import { sortHabits } from '@/lib/habit'
import { nextSortOrder, sortByEffectiveOrder } from '@/lib/goal-order'
import { progressOf } from '@/lib/progress'
import { togglePayload } from '@/lib/task-order'
import { addProgress } from '@/lib/task-progress'
import { buildTaskTree, descendantIds, taskDepth } from '@/lib/task-tree'
import { useScopedDrag } from '@/lib/use-scoped-drag'
import { useSyncRefresh } from '@/lib/sync-state'
import type { Goal, Milestone, Task, Habit } from '@/lib/types'
import type { BookImportPayload } from '@/lib/book-import'
import { findExistingMilestone } from '@/lib/book-import'
import MilestoneCard from '@/components/MilestoneCard'
import ProgressIndicator from '@/components/ProgressIndicator'
import ProgressSheet from '@/components/ProgressSheet'
import TaskRow from '@/components/TaskRow'
import InlineAddRow from '@/components/InlineAddRow'
import ItemSheet from '@/components/ItemSheet'
import type { GoalSavePayload } from '@/components/ItemSheet'
import BookImportSheet from '@/components/BookImportSheet'

const LOAD_ERROR = '里程碑和任务加载失败。请重新加载；如果仍然失败，刷新页面后再试。'

const COLLAPSE_KEY_PREFIX = 'orbit_goal_collapsed:'

/** Collapsed milestones (`m:<id>`) and container tasks (`t:<id>`) for a goal. */
function loadCollapsed(goalId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${COLLAPSE_KEY_PREFIX}${goalId}`)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((value): value is string => typeof value === 'string'))
    }
  } catch {
    // ignore corrupt storage
  }
  return new Set()
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

// Per-section empty line (13px muted), matching the home page's inline empty
// precedent. The Phase 7 20px page-level empty heading is retired because the
// detail now has two sections and either one may be empty.
const EMPTY_LINE_STYLE: CSSProperties = {
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

const LABEL_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const FOCUS_RING = 'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'

interface GoalDetailProps {
  goal: Goal
  onBack: () => void
}

/**
 * Inline goal detail (07-UI-SPEC): renders the goal header (返回 / 编辑) plus a
 * vertical list of milestone containers, each with its own tasks underneath.
 * There is no milestone drill-in, no separate task bucket, no note timeline and
 * no goal blurb — editing and cascade deletion live in the header's ItemSheet.
 *
 * All repository access stays inside effects/handlers (Node prerender has no
 * IndexedDB under `output: 'export'`). The page owns drill-in state; this
 * component owns its own data + mutations.
 */
export default function GoalDetail({ goal, onBack }: GoalDetailProps) {
  const [milestones, setMilestones] = useState<Milestone[] | null>(null)
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Local title state so a rename from the goal sheet shows in the same render
  // (the `goal` prop does not change when we only rewrite the stored row).
  const [goalName, setGoalName] = useState(goal.name)
  // Draft habit link mirrored from the sheet save (same reason as goalName).
  const [goalHabitId, setGoalHabitId] = useState<string | null>(goal.habit_id ?? null)
  // Toggle failure copy, scoped to the containing group: a milestone id for
  // milestone tasks, or the goal id for direct tasks (D-01).
  const [toggleError, setToggleError] = useState<{
    scopeId: string
    message: string
  } | null>(null)
  // Quantity add-progress: one open form at a time across both sections, plus
  // the persistence-failure copy tagged with the offending task id.
  const [addingProgressId, setAddingProgressId] = useState<Task['id'] | null>(null)
  const [progressError, setProgressError] = useState<{
    taskId: string
    message: string
  } | null>(null)

  // Item sheet — one at a time. This component owns persistence for every mode.
  const [goalSheetOpen, setGoalSheetOpen] = useState(false)
  const [editMilestone, setEditMilestone] = useState<Milestone | null>(null)
  const [editTask, setEditTask] = useState<Task | null>(null)
  // Parent task whose add-subtask composer is open (null = none). One at a time.
  const [addSubtaskParentId, setAddSubtaskParentId] = useState<Task['id'] | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Book TOC import sheet (entry B): one batch milestone + chapter-task write.
  const [bookImportOpen, setBookImportOpen] = useState(false)
  // T1: a same-name milestone already exists under this goal — pending the
  // user's skip/overwrite/create choice before we write anything.
  const [duplicate, setDuplicate] = useState<{
    payload: BookImportPayload
    existingId: string
  } | null>(null)
  const [sheetSaving, setSheetSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // T10: collapsed milestone/container ids (prefixed `m:` / `t:`), persisted per
  // goal. Loaded in a mount effect (never during render — hydration contract).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  useEffect(() => {
    setCollapsed(loadCollapsed(goal.id))
  }, [goal.id])

  function toggleCollapsed(id: string) {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(`${COLLAPSE_KEY_PREFIX}${goal.id}`, JSON.stringify([...next]))
      } catch {
        // ignore storage failures — the collapse simply won't survive a reload
      }
      return next
    })
  }
  // Active habits for the goal sheet's 关联习惯 field. Null until first load;
  // failures stay scoped to the field (T-22-11 — the detail stays usable).
  const [habits, setHabits] = useState<Habit[] | null>(null)
  const [habitsLoading, setHabitsLoading] = useState(false)
  const [habitsError, setHabitsError] = useState<string | null>(null)
  // Selectors resolved in order after a re-render (first match wins).
  const [pendingFocus, setPendingFocus] = useState<string[] | null>(null)

  const alive = useRef(false)
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const milestonesListRef = useRef<HTMLUListElement | null>(null)
  const directTasksRef = useRef<HTMLDivElement | null>(null)

  // Derived, never stored (D-06): every task in state is live + goal-scoped, so
  // this recomputes in the same render pass as an optimistic toggle. Direct
  // tasks are leaves in the same goal scope, so the header aggregates both.
  const headerProgress = progressOf(tasks ?? [])
  // §2 direct tasks — goal-scoped leaves (milestone_id null), display order.
  const directTasks = sortByEffectiveOrder(
    (tasks ?? []).filter((task) => task.milestone_id == null),
  )
  // Shared tree relation: containers decide their read-only row variant, and
  // cascade delete walks descendants. Both must agree with the UI tree (A5).
  const taskChildren = buildTaskTree(tasks ?? []).children
  const taskById = new Map((tasks ?? []).map((task) => [task.id, task]))
  // The quantity task whose progress sheet is open (null = none). One at a time,
  // shared across the milestone and direct-task sections.
  const editingProgressTask =
    addingProgressId != null ? (taskById.get(addingProgressId) ?? null) : null

  const { dragId, dragOrder, dropIndex, onHandlePointerDown } = useScopedDrag<Milestone>({
    items: milestones ?? [],
    idOf: (milestone) => milestone.id,
    onCommit: commitMilestoneOrder,
    containerRef: milestonesListRef,
    itemSelector: '[data-milestone-card]',
  })

  // §2 owns its own pointer-drag scope (UI-SPEC Interaction Contract): each
  // section has one, otherwise direct-task 44px handles would be dead controls.
  const {
    dragId: directDragId,
    dragOrder: directDragOrder,
    dropIndex: directDropIndex,
    onHandlePointerDown: onDirectHandlePointerDown,
  } = useScopedDrag<Task>({
    items: directTasks,
    idOf: (task) => task.id,
    onCommit: commitDirectTaskOrder,
    containerRef: directTasksRef,
    itemSelector: '[data-task-row]',
  })

  async function load() {
    try {
      const repo = getRepository()
      // Both reads are issued together; filtering/grouping happens in memory.
      const [allMilestones, allTasks] = await Promise.all([
        repo.list<Milestone>('milestones'),
        repo.list<Task>('tasks'),
      ])
      if (!alive.current) return
      const liveMilestones = sortByEffectiveOrder(
        allMilestones.filter((m) => m.goal_id === goal.id && m.deleted_at == null),
      )
      setMilestones(liveMilestones)
      // Task scope is the UNION of (a) tasks under one of this goal's live
      // milestones and (b) goal-scoped direct tasks (milestone_id null). Without
      // the direct branch a direct task would silently disappear / be orphaned
      // (Pitfall 2, T-08-15).
      const milestoneIds = new Set(liveMilestones.map((m) => m.id))
      setTasks(
        sortByEffectiveOrder(
          allTasks.filter(
            (t) =>
              t.deleted_at == null &&
              (milestoneIds.has(t.milestone_id ?? '') ||
                (t.milestone_id == null && t.goal_id === goal.id)),
          ),
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

  // D-05 / B2: a remote edit to the open goal must appear without navigating
  // away — reload this drilled-in detail when remote rows are applied.
  useSyncRefresh(() => {
    void load()
  })

  function retryLoad() {
    setError(null)
    setMilestones(null)
    setTasks(null)
    void load()
  }

  // Deferred focus: resolve each selector after the sheet closes and the list
  // re-renders. A cross-render move remounts the row, so we re-query by
  // data-task-row / data-milestone-card rather than relying on the invoking node.
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

  function milestoneAddRowSelector() {
    return `[data-add-row="goal:${goal.id}"]`
  }

  function taskAddRowSelector(milestoneId: string) {
    return `[data-add-row="milestone:${milestoneId}"]`
  }

  function taskNameSelector(id: string) {
    return `[data-task-row][data-task-id="${id}"] [data-task-name]`
  }

  function directTaskAddRowSelector() {
    return `[data-add-row="goal-direct:${goal.id}"]`
  }

  /** The owning add row for a task: direct tasks return to §2, milestone tasks
   *  return to their milestone card. */
  function owningAddRowSelector(task: Task) {
    return task.milestone_id == null
      ? directTaskAddRowSelector()
      : taskAddRowSelector(task.milestone_id)
  }

  /**
   * Reads the active habit list for the goal sheet's 关联习惯 field. Archived
   * habits (deleted_at != null) are excluded; sortHabits matches the habit
   * views' order. A failure is surfaced only inside the field (T-22-11).
   */
  async function loadHabits() {
    setHabitsLoading(true)
    setHabitsError(null)
    try {
      const rows = await getRepository().list<Habit>('habits')
      if (!alive.current) return
      setHabits(sortHabits(rows.filter((habit) => habit.deleted_at == null)))
    } catch {
      if (!alive.current) return
      setHabitsError('习惯列表加载失败，请重试。')
    } finally {
      if (alive.current) setHabitsLoading(false)
    }
  }

  function openGoalMenu() {
    setGoalSheetOpen(true)
    setConfirmDelete(false)
    setSaveError(null)
    setDeleteError(null)
    void loadHabits()
  }

  function closeGoalSheet() {
    setGoalSheetOpen(false)
    setConfirmDelete(false)
    setSaveError(null)
    setDeleteError(null)
    setPendingFocus(['[data-goal-edit]'])
  }

  async function saveGoal(payload: GoalSavePayload) {
    setSheetSaving(true)
    setSaveError(null)
    try {
      const repo = getRepository()
      // Spread preserves id / category_id / created_at / sort_order; the
      // repository re-stamps updated_at. Name + habit link land in one upsert
      // (D-01 / T-22-08 — never a partial field drop).
      await repo.upsert<Goal>('goals', {
        ...goal,
        name: payload.name,
        habit_id: payload.habit_id,
      })
      setGoalName(payload.name)
      setGoalHabitId(payload.habit_id)
      setGoalSheetOpen(false)
      setConfirmDelete(false)
      setPendingFocus(['[data-goal-edit]'])
    } catch {
      setSaveError('保存失败，请重试。')
    } finally {
      setSheetSaving(false)
    }
  }

  /**
   * Cascade tombstone: soft-delete every live task under this goal's live
   * milestones, then those milestones, then the goal itself, then return home.
   */
  async function deleteGoal() {
    setSheetSaving(true)
    setDeleteError(null)
    try {
      const repo = getRepository()
      const [allMilestones, allTasks] = await Promise.all([
        repo.list<Milestone>('milestones', { includeDeleted: true }),
        repo.list<Task>('tasks', { includeDeleted: true }),
      ])
      const goalMilestones = allMilestones.filter(
        (m) => m.goal_id === goal.id && m.deleted_at == null,
      )
      const goalMilestoneIds = new Set(goalMilestones.map((m) => m.id))
      const goalTasks = allTasks.filter(
        (t) => goalMilestoneIds.has(t.milestone_id ?? '') && t.deleted_at == null,
      )
      // Direct tasks are goal-scoped (milestone_id null) and must cascade with
      // the goal, or they would become orphan leaves (T-08-13 / T-08-15).
      const goalDirectTasks = allTasks.filter(
        (t) => t.deleted_at == null && t.milestone_id == null && t.goal_id === goal.id,
      )
      // Descendants first so no live row is ever orphaned.
      for (const task of [...goalTasks, ...goalDirectTasks]) {
        await repo.softDelete('tasks', task.id)
      }
      for (const milestone of goalMilestones) await repo.softDelete('milestones', milestone.id)
      await repo.softDelete('goals', goal.id)
      setGoalSheetOpen(false)
      setConfirmDelete(false)
      onBack()
    } catch {
      setDeleteError('删除失败，请重试。')
    } finally {
      setSheetSaving(false)
    }
  }

  function openMilestoneMenu(milestone: Milestone) {
    setEditMilestone(milestone)
    setConfirmDelete(false)
    setSaveError(null)
    setDeleteError(null)
  }

  function closeMilestoneSheet() {
    if (!editMilestone) return
    const id = editMilestone.id
    setEditMilestone(null)
    setConfirmDelete(false)
    setSaveError(null)
    setDeleteError(null)
    setPendingFocus([milestoneMoreSelector(id), milestoneAddRowSelector()])
  }

  /** Close the book import sheet and return focus to the milestone-section entry. */
  function closeBookImport() {
    setBookImportOpen(false)
    setPendingFocus(['[data-book-import-entry]'])
  }

  /**
   * Entry B (D-06 / D-07 / D-08): import a book TOC as one milestone under this
   * goal plus one quantity task per chapter. ids come pre-generated in the
   * payload, so a failed-and-retried import upserts/merges instead of
   * duplicating chapters (T-15-14). Rejects on bad payload or write failure so
   * BookImportSheet keeps the review table open with its retry copy.
   */
  async function handleBookImport(payload: BookImportPayload): Promise<void> {
    const leaves = payload.nodes.filter((node) => node.pages != null)
    if (leaves.length === 0 || leaves.some((node) => (node.pages ?? 0) <= 0)) {
      throw new Error('导入数据无效')
    }

    // T1: a same-name live milestone already exists → surface a choice instead
    // of silently writing a second structure.
    const repo = getRepository()
    const all = await repo.list<Milestone>('milestones', { includeDeleted: true })
    const existing = findExistingMilestone(all, goal.id, payload.bookName, payload.bookId)
    if (existing) {
      setDuplicate({ payload, existingId: existing.id })
      return
    }

    await doBookImport(payload, payload.bookId, null)
  }

  /**
   * Persist the book milestone + its chapter tasks. `existing` is non-null for
   * an overwrite: tombstone its live chapters first and reuse its id/order.
   */
  async function doBookImport(
    payload: BookImportPayload,
    milestoneId: string,
    existing: Milestone | null,
  ): Promise<void> {
    const repo = getRepository()
    // Fresh read including tombstones so append order sees every sibling (D-08).
    const all = await repo.list<Milestone>('milestones', { includeDeleted: true })
    const siblings = all.filter((m) => m.goal_id === goal.id)
    const createdAt = new Date().toISOString()

    if (existing) {
      const allTasks = await repo.list<Task>('tasks', { includeDeleted: true })
      const liveTasks = allTasks.filter(
        (task) => task.milestone_id === milestoneId && task.deleted_at == null,
      )
      for (const task of liveTasks) await repo.softDelete('tasks', task.id)
    }

    await repo.upsert<Milestone>('milestones', {
      id: milestoneId,
      goal_id: goal.id,
      name: payload.bookName,
      created_at: existing?.created_at ?? createdAt,
      sort_order: existing?.sort_order ?? nextSortOrder(siblings),
    })

    // Pre-order flat nodes: containers (部) become group tasks (checkbox-less),
    // leaves (章) become quantity tasks under their parent.
    for (let index = 0; index < payload.nodes.length; index += 1) {
      const node = payload.nodes[index]
      const isContainer = node.pages == null
      await repo.upsert<Task>('tasks', {
        id: node.id,
        milestone_id: milestoneId,
        goal_id: null,
        parent_id: node.parentId,
        name: node.name,
        progress_type: isContainer ? 'checkbox' : 'quantity',
        unit: isContainer ? null : payload.unit,
        target_value: isContainer ? null : node.pages,
        current_value: isContainer ? null : 0,
        completed: false,
        completed_at: null,
        created_at: createdAt,
        sort_order: index,
      })
    }

    setDuplicate(null)
    setBookImportOpen(false)
    await load()
    setPendingFocus(['[data-book-import-entry]'])
  }

  /** Skip / overwrite / create after a duplicate book name was detected. */
  async function resolveDuplicate(choice: 'skip' | 'overwrite' | 'create'): Promise<void> {
    if (!duplicate) return
    if (choice === 'skip') {
      setDuplicate(null)
      return
    }
    if (choice === 'overwrite') {
      const repo = getRepository()
      const all = await repo.list<Milestone>('milestones', { includeDeleted: true })
      const existing = all.find((m) => m.id === duplicate.existingId) ?? null
      await doBookImport(duplicate.payload, duplicate.existingId, existing)
      return
    }
    // create: a parallel milestone with a fresh id, same name.
    await doBookImport(duplicate.payload, duplicate.payload.bookId, null)
  }

  async function saveMilestone(name: string) {
    if (!editMilestone) return
    const id = editMilestone.id
    setSheetSaving(true)
    setSaveError(null)
    try {
      const repo = getRepository()
      // Spread preserves id / goal_id / created_at / sort_order; the repository
      // re-stamps updated_at.
      await repo.upsert<Milestone>('milestones', { ...editMilestone, name })
      setEditMilestone(null)
      setConfirmDelete(false)
      await load()
      setPendingFocus([milestoneMoreSelector(id), milestoneAddRowSelector()])
    } catch {
      setSaveError('保存失败，请重试。')
    } finally {
      setSheetSaving(false)
    }
  }

  /**
   * Cascade tombstone: soft-delete every live task under the milestone, then the
   * milestone. Nothing is re-parented and the detail view stays open.
   */
  async function deleteMilestone() {
    if (!editMilestone) return
    const id = editMilestone.id
    setSheetSaving(true)
    setDeleteError(null)
    try {
      const repo = getRepository()
      const allTasks = await repo.list<Task>('tasks', { includeDeleted: true })
      const liveTasks = allTasks.filter(
        (task) => task.milestone_id === id && task.deleted_at == null,
      )
      for (const task of liveTasks) await repo.softDelete('tasks', task.id)
      await repo.softDelete('milestones', id)
      setEditMilestone(null)
      setConfirmDelete(false)
      await load()
      setPendingFocus([milestoneAddRowSelector()])
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
   * Persists a task drag within one milestone: reassign sort_order 0..n-1 over
   * the live siblings in visual order, writing only changed rows (T-03-11).
   * Tombstoned rows keep their old values.
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
   * Persists a direct-task drag within §2 (its own scope): reassign sort_order
   * 0..n-1 over the direct siblings in visual order, writing only changed rows.
   * The includeDeleted read guards the scope so only this goal's direct tasks
   * are ever touched. Failure re-reads silently (same as the other scopes).
   */
  async function commitDirectTaskOrder(finalOrder: Task[], baseline: Task[]) {
    try {
      const repo = getRepository()
      const all = await repo.list<Task>('tasks', { includeDeleted: true })
      const directIds = new Set(
        all
          .filter((task) => task.milestone_id == null && task.goal_id === goal.id)
          .map((task) => task.id),
      )
      const previous = new Map(baseline.map((task) => [task.id, task.sort_order]))
      for (let index = 0; index < finalOrder.length; index += 1) {
        const task = finalOrder[index]
        if (!directIds.has(task.id) || previous.get(task.id) === index) continue
        await repo.upsert<Task>('tasks', { ...task, sort_order: index })
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
   * error below its milestone (T-03-10).
   */
  async function toggleTask(task: Task) {
    const payload = togglePayload(task)
    // Error scope: the owning milestone, or the goal for a direct task (D-01).
    const scopeId = task.milestone_id ?? task.goal_id ?? ''
    setToggleError(null)
    setTasks(
      (previous) =>
        previous?.map((entry) => (entry.id === task.id ? { ...entry, ...payload } : entry)) ??
        previous,
    )
    try {
      const repo = getRepository()
      await repo.upsert<Task>('tasks', { ...task, ...payload })
      // D-03 completion trigger: after the task write succeeds, best-effort
      // check in the owning goal's habit. Its own catch keeps a habit failure
      // from reaching the revert path below (D-06 / T-22-13).
      if (payload.completed === true) {
        try {
          await autoCheckinForTask({
            task,
            kind: 'complete',
            nowIso: payload.completed_at ?? new Date().toISOString(),
            repo,
          })
        } catch {
          // best effort: the task toggle already succeeded
        }
      }
    } catch {
      setTasks(
        (previous) =>
          previous?.map((entry) => (entry.id === task.id ? task : entry)) ?? previous,
      )
      setToggleError({ scopeId, message: '更新任务失败，请重试。' })
    }
  }

  /**
   * D-04/SC-3: open the inline add-progress form for one quantity leaf. Only one
   * form is open at a time (shared state across the milestone and direct-task
   * sections); opening clears any prior persistence error.
   */
  function openAddProgress(task: Task) {
    setProgressError(null)
    setAddingProgressId(task.id)
  }

  function cancelAddProgress() {
    const id = addingProgressId
    setAddingProgressId(null)
    setProgressError(null)
    if (id != null) setPendingFocus([taskNameSelector(id)])
  }

  /**
   * SC-3/SC-4: optimistic increment. Add the amount to local `current_value` in
   * the same render (so every ring/bar/count reflects it immediately), then
   * persist through the reusable `addProgress` primitive (D-04 — no repository
   * writes buried in the UI). On failure revert just that row's value, keep the
   * form open with the typed amount, and surface the copy beneath the row.
   */
  async function submitProgress(task: Task, amount: number) {
    setProgressError(null)
    setTasks(
      (previous) =>
        previous?.map((entry) =>
          entry.id === task.id
            ? { ...entry, current_value: (entry.current_value ?? 0) + amount }
            : entry,
        ) ?? previous,
    )
    try {
      await addProgress(task.id, amount)
      setAddingProgressId(null)
      setProgressError(null)
      setPendingFocus([taskNameSelector(task.id)])
    } catch {
      // Roll the optimistic increment back to the pre-submit snapshot.
      setTasks(
        (previous) =>
          previous?.map((entry) =>
            entry.id === task.id
              ? { ...entry, current_value: task.current_value }
              : entry,
          ) ?? previous,
      )
      setProgressError({ taskId: task.id, message: '更新进度失败，请重试。' })
    }
  }

  /**
   * MIL-02: create a task under the given milestone. A fresh includeDeleted read
   * scopes siblings by milestone_id so append order counts tombstones. Rejects
   * on failure so InlineAddRow preserves the typed text.
   */
  async function createTask(milestoneId: string, name: string) {
    const repo = getRepository()
    const all = await repo.list<Task>('tasks', { includeDeleted: true })
    const siblings = all.filter((task) => task.milestone_id === milestoneId)
    const sort_order = nextSortOrder(siblings)
    await repo.upsert<Task>('tasks', {
      milestone_id: milestoneId,
      goal_id: null,
      parent_id: null,
      progress_type: 'checkbox',
      unit: null,
      target_value: null,
      current_value: null,
      name,
      completed: false,
      completed_at: null,
      created_at: new Date().toISOString(),
      sort_order,
    })
    await load()
  }

  /**
   * D-01/SC-1: create a direct task under the goal (milestone_id null, always a
   * leaf, no subtask path). A fresh includeDeleted read scopes siblings by the
   * direct bucket so append order counts tombstones. Rejects on failure so
   * InlineAddRow preserves the typed text.
   */
  async function createDirectTask(name: string) {
    const repo = getRepository()
    const all = await repo.list<Task>('tasks', { includeDeleted: true })
    const siblings = all.filter((task) => task.milestone_id == null && task.goal_id === goal.id)
    const sort_order = nextSortOrder(siblings)
    await repo.upsert<Task>('tasks', {
      milestone_id: null,
      goal_id: goal.id,
      parent_id: null,
      progress_type: 'checkbox',
      unit: null,
      target_value: null,
      current_value: null,
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

  /**
   * Creates a subtask under `parentTask` (D-01/SC-2). Subtasks inherit the
   * parent's milestone (goal_id stays null) and start as checkbox leaves
   * (T-08-16: the full v3 payload is written on insert). Rejects on failure so
   * the composer preserves the typed text; the composer stays open on success
   * for rapid entry.
   */
  async function createSubtask(parentTask: Task, name: string) {
    const repo = getRepository()
    const all = await repo.list<Task>('tasks', { includeDeleted: true })
    const siblings = all.filter((task) => task.parent_id === parentTask.id)
    const sort_order = nextSortOrder(siblings)
    await repo.upsert<Task>('tasks', {
      milestone_id: parentTask.milestone_id,
      goal_id: null,
      parent_id: parentTask.id,
      progress_type: 'checkbox',
      unit: null,
      target_value: null,
      current_value: null,
      name,
      completed: false,
      completed_at: null,
      created_at: new Date().toISOString(),
      sort_order,
    })
    await load()
  }

  /**
   * Wires the TaskTree composer to a concrete parent resolved from state. The
   * composer is only open when `addSubtaskParentId` is set, so the lookup is
   * always present; a defensive no-op keeps the promise type stable.
   */
  async function createSubtaskFromComposer(name: string) {
    if (addSubtaskParentId == null) return
    const parent = taskById.get(addSubtaskParentId)
    if (!parent) return
    await createSubtask(parent, name)
  }

  /** Sheet `添加子任务`: close the sheet without focus-return, open the
   *  composer under this task and focus its input (UI-SPEC §9 focus table). */
  function openAddSubtask(task: Task) {
    setAddSubtaskParentId(task.id)
    setEditTask(null)
    setConfirmDelete(false)
    setSaveError(null)
    setDeleteError(null)
    setPendingFocus([`[data-add-row="task:${task.id}"]`])
  }

  function closeSubtaskComposer() {
    setAddSubtaskParentId(null)
  }

  function closeTaskSheet() {
    if (!editTask) return
    const task = editTask
    const id = task.id
    setEditTask(null)
    setConfirmDelete(false)
    setSaveError(null)
    setDeleteError(null)
    setPendingFocus([taskMoreSelector(id), owningAddRowSelector(task)])
  }

  /**
   * D-02/D-06: rename + progress-mode edit. A task's parent is fixed to its
   * milestone — there is no move between milestones this phase.
   *
   * Type-switch semantics (08-UI-SPEC §9):
   *  勾选 → 数量: store unit/target/current, clear completed/completed_at.
   *  数量 → 勾选: null the quantity fields, completed=false (user re-checks).
   *  Same type: only the name changes (a completed checkbox stays completed).
   */
  async function saveTask(payload: {
    name: string
    progress_type: 'checkbox' | 'quantity'
    unit: string | null
    target_value: number | null
    current_value: number | null
  }) {
    if (!editTask) return
    const task = editTask
    const id = task.id
    setSheetSaving(true)
    setSaveError(null)
    try {
      const repo = getRepository()
      const isQuantity = payload.progress_type === 'quantity'
      const wasQuantity = task.progress_type === 'quantity'
      const next: Task = isQuantity
        ? {
            ...task,
            name: payload.name,
            progress_type: 'quantity',
            unit: payload.unit,
            target_value: payload.target_value,
            current_value: payload.current_value,
            completed: false,
            completed_at: null,
          }
        : {
            ...task,
            name: payload.name,
            progress_type: 'checkbox',
            unit: null,
            target_value: null,
            current_value: null,
            completed: wasQuantity ? false : task.completed,
            completed_at: wasQuantity ? null : task.completed_at,
          }
      await repo.upsert<Task>('tasks', next)
      setEditTask(null)
      setConfirmDelete(false)
      await load()
      setPendingFocus([taskMoreSelector(id), owningAddRowSelector(task)])
    } catch {
      setSaveError('保存失败，请重试。')
    } finally {
      setSheetSaving(false)
    }
  }

  /**
   * Cascade tombstone for a task (UI-SPEC Delete semantics): tombstone every
   * live descendant depth-first, then the task itself, so no live row is
   * orphaned (T-08-17). Focus returns to the parent's ⋯ button when the task
   * was nested and that parent is still live, otherwise to the owning add row.
   */
  async function deleteTask() {
    if (!editTask) return
    const task = editTask
    const id = task.id
    setSheetSaving(true)
    setDeleteError(null)
    try {
      const repo = getRepository()
      const descendants = descendantIds(id, taskChildren)
      for (const descendantId of descendants) {
        await repo.softDelete('tasks', descendantId)
      }
      await repo.softDelete('tasks', id)
      setEditTask(null)
      setConfirmDelete(false)
      await load()
      // Container/subtask delete → parent ⋯ first, else the owning add row.
      if (editTask.parent_id != null && taskById.has(editTask.parent_id)) {
        setPendingFocus([
          taskMoreSelector(editTask.parent_id),
          taskAddRowSelector(editTask.milestone_id ?? ''),
        ])
      } else {
        setPendingFocus([owningAddRowSelector(task)])
      }
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
            className={`self-start ${FOCUS_RING} accent-button`}
            style={ACCENT_TEXT_BUTTON_STYLE}
          >
            重新加载里程碑与任务
          </button>
        </div>
      )
    }

    if (milestones === null || tasks === null) {
      return <p style={LOADING_STYLE}>正在加载里程碑与任务…</p>
    }

    // Mirror app/page.tsx: the dragged order wins while a pointer drag is live.
    const displayed = dragOrder ?? milestones
    const displayedDirect = directDragOrder ?? directTasks

    return (
      <div className="flex flex-col" style={{ gap: '24px' }}>
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
                    tasks={tasks.filter((task) => task.milestone_id === milestone.id)}
                    collapsed={collapsed.has(`m:${milestone.id}`)}
                    onToggleCollapsed={() => toggleCollapsed(`m:${milestone.id}`)}
                    collapsedIds={collapsed}
                    onToggleCollapse={toggleCollapsed}
                    isDragging={dragId === milestone.id}
                    showDropLine={dropIndex === index}
                    onDragHandlePointerDown={onHandlePointerDown}
                    onOpenMenu={openMilestoneMenu}
                    onToggleTask={toggleTask}
                    onOpenTaskMenu={openTaskMenu}
                    onCreateTask={(name) => createTask(milestone.id, name)}
                    onCommitTaskOrder={commitTaskOrder}
                    addSubtaskParentId={addSubtaskParentId}
                    onCreateSubtask={createSubtaskFromComposer}
                    onCancelSubtask={closeSubtaskComposer}
                    onOpenAddProgress={openAddProgress}
                    taskError={
                      toggleError?.scopeId === milestone.id ? toggleError.message : null
                    }
                  />
                ))}
              </ul>
            ) : (
              <p style={EMPTY_LINE_STYLE}>还没有里程碑，在下面添加第一个。</p>
            )}
            <InlineAddRow
              placeholder="添加里程碑"
              ariaLabel="添加里程碑"
              onCreate={createMilestone}
              dataAddRow={`goal:${goal.id}`}
              errorMessage="添加里程碑失败，请重试。"
            />
            <button
              type="button"
              data-book-import-entry
              onClick={() => setBookImportOpen(true)}
              aria-label="从书籍目录导入里程碑"
              className={`${FOCUS_RING} accent-button`}
              style={{ ...ACCENT_TEXT_BUTTON_STYLE, alignSelf: 'flex-start' }}
            >
              从书籍目录导入
            </button>
          </div>
        </section>

        {/* §2 直接任务 — one grouped white card of leaf rows (D-01). It owns its
            own add row and its own pointer-drag scope. */}
        <section className="flex flex-col" style={{ gap: '8px' }}>
          <h2 style={LABEL_STYLE}>直接任务</h2>
          <div
            className="flex flex-col"
            style={{
              gap: '8px',
              padding: '16px',
              minWidth: 0,
              background: 'var(--card)',
              borderRadius: '12px',
              boxShadow: 'var(--card-shadow)',
            }}
          >
            {directTasks.length > 0 ? (
              <div
                ref={directTasksRef}
                data-task-group
                className="flex flex-col"
              >
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
                    onOpenAddProgress={openAddProgress}
                  />
                ))}
              </div>
            ) : (
              <p style={EMPTY_LINE_STYLE}>还没有直接任务。</p>
            )}
            <InlineAddRow
              placeholder="添加直接任务"
              ariaLabel="添加直接任务"
              onCreate={createDirectTask}
              dataAddRow={`goal-direct:${goal.id}`}
              errorMessage="添加直接任务失败，请重试。"
            />
            {toggleError?.scopeId === goal.id ? (
              <p style={INLINE_ERROR_STYLE}>{toggleError.message}</p>
            ) : null}
          </div>
        </section>
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
            className={`flex items-center ${FOCUS_RING} accent-button`}
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
            onClick={openGoalMenu}
            className={`${FOCUS_RING} accent-button`}
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
            overflowWrap: 'anywhere',
          }}
        >
          {goalName}
        </h1>

        {headerProgress.total > 0 ? (
          <div style={{ marginTop: '16px' }}>
            <ProgressIndicator
              completed={headerProgress.completed}
              total={headerProgress.total}
              label="目标进度"
              format="percent"
            />
          </div>
        ) : null}
      </header>

      {renderContent()}

      {goalSheetOpen ? (
        <ItemSheet
          key={`goal-${goal.id}`}
          mode="goal"
          initialName={goalName}
          liveMilestoneCount={(milestones ?? []).length}
          liveDirectTaskCount={(tasks ?? []).filter((task) => task.milestone_id == null).length}
          habits={habits ?? []}
          habitsLoading={habitsLoading}
          habitsError={habitsError}
          onRetryHabits={() => void loadHabits()}
          initialHabitId={goalHabitId}
          onSave={saveGoal}
          onDelete={deleteGoal}
          onCancel={closeGoalSheet}
          saving={sheetSaving}
          saveError={saveError}
          deleteError={deleteError}
          confirmState={confirmDelete}
          onRequestDelete={() => setConfirmDelete(true)}
          onCancelDelete={() => setConfirmDelete(false)}
        />
      ) : null}

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
          onCancel={closeMilestoneSheet}
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
          isContainer={(taskChildren.get(editTask.id)?.length ?? 0) > 0}
          canAddSubtask={
            editTask.milestone_id != null && taskDepth(editTask, taskById) <= 2
          }
          onAddSubtask={() => openAddSubtask(editTask)}
          liveTaskCount={descendantIds(editTask.id, taskChildren).length}
          initialProgressType={editTask.progress_type}
          initialUnit={editTask.unit}
          initialTarget={editTask.target_value}
          initialCurrent={editTask.current_value}
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

      {bookImportOpen ? (
        <BookImportSheet
          onImport={handleBookImport}
          onCancel={closeBookImport}
          duplicate={duplicate !== null}
          onResolveDuplicate={(choice) => void resolveDuplicate(choice)}
        />
      ) : null}

      {editingProgressTask ? (
        <ProgressSheet
          task={editingProgressTask}
          onConfirm={(amount) => submitProgress(editingProgressTask, amount)}
          onCancel={cancelAddProgress}
          error={
            progressError?.taskId === editingProgressTask.id ? progressError.message : null
          }
        />
      ) : null}
    </div>
  )
}
