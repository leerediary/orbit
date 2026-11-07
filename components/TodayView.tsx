'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { getRepository } from '@/lib/repository-provider'
import { addProgress } from '@/lib/task-progress'
import { autoCheckinForTask } from '@/lib/habit-auto-checkin'
import { togglePayload } from '@/lib/task-order'
import { buildTaskTree, subtreeProgress } from '@/lib/task-tree'
import { sortByEffectiveOrder } from '@/lib/goal-order'
import { buildTodayEntries, pickableLeaves, sortGoalGroupIds } from '@/lib/today-list'
import type { PickableLeaf, TodayEntry } from '@/lib/today-list'
import { useScopedDrag } from '@/lib/use-scoped-drag'
import { addedAgeLabel, getDayOffsetHours, getTodayStr } from '@/lib/today'
import { sortHabits } from '@/lib/habit'
import { buildTodayPomodoroRows } from '@/lib/pomodoro'
import { useSyncRefresh } from '@/lib/sync-state'
import type { TodayPomodoroRow } from '@/lib/pomodoro'
import type {
  Category,
  DailyTodo,
  Goal,
  Habit,
  HabitCompletion,
  Milestone,
  PomodoroSession,
  Task,
} from '@/lib/types'
import BalancedColumns from '@/components/BalancedColumns'
import HabitChecklist from '@/components/HabitChecklist'
import InlineAddRow from '@/components/InlineAddRow'
import JournalView from '@/components/JournalView'
import ProgressSheet from '@/components/ProgressSheet'
import TaskRow from '@/components/TaskRow'
import TodayRemoveButton from '@/components/TodayRemoveButton'
import TodayRow from '@/components/TodayRow'
import TodayPickerSheet from '@/components/TodayPickerSheet'
import type {
  PickerCategoryGroup,
  PickerGoalGroup,
  PickerMilestoneGroup,
} from '@/components/TodayPickerSheet'

const LOAD_ERROR = '今日待办加载失败。请重新加载；如果仍然失败，刷新页面后再试。'

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

const INLINE_ERROR_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
}

const HERO_TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '48px',
  fontWeight: 600,
  lineHeight: 1.05,
  letterSpacing: '-0.02em',
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

const CARD_STYLE: CSSProperties = {
  padding: '16px',
  minWidth: 0,
  gap: '12px',
  background: 'var(--card)',
  borderRadius: '12px',
  boxShadow: 'var(--card-shadow)',
}

// A card's source header (独立待办, or the linked task's owning goal name).
const CARD_HEADER_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.2,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

// A goal's nested card inside the 长期计划 card (方案 B): parchment on white.
const NESTED_CARD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  padding: '8px 12px',
  background: 'var(--background)',
  borderRadius: '8px',
  minWidth: 0,
}

const NESTED_GOAL_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 600,
  lineHeight: 1.4,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

// T28: group reorder handle (≡). Same 44px hit target and grab cursor as
// TaskRow's drag handle; negative margins let the header row bleed into the
// nested card's 8px side padding.
const GROUP_DRAG_HANDLE_STYLE: CSSProperties = {
  flex: '0 0 44px',
  width: '44px',
  height: '44px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'none',
  border: 'none',
  padding: 0,
  margin: 0,
  color: 'var(--muted)',
  fontFamily: 'inherit',
  cursor: 'grab',
  touchAction: 'none',
}

const LIST_STYLE: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
}

// 今日番茄 card row typography (§7): [time 44px][link flex][mode+duration].
const POMO_TIME_STYLE: CSSProperties = {
  flex: '0 0 44px',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  fontVariantNumeric: 'tabular-nums',
}

const POMO_LINK_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

const POMO_SECONDARY_STYLE: CSSProperties = {
  flex: '0 0 auto',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const POMO_META_STYLE: CSSProperties = {
  flex: '0 0 auto',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  fontVariantNumeric: 'tabular-nums',
}

const POMO_NOTE_STYLE: CSSProperties = {
  margin: 0,
  paddingLeft: '52px',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  whiteSpace: 'pre-line',
  overflowWrap: 'anywhere',
}

const POMO_NOTE_EDIT_STYLE: CSSProperties = {
  ...POMO_NOTE_STYLE,
  display: 'block',
  marginLeft: '52px',
  width: 'calc(100% - 52px)',
  boxSizing: 'border-box',
  padding: '2px 6px',
  color: 'var(--foreground)',
  background: 'var(--background)',
  border: '1px solid var(--accent)',
  borderRadius: '6px',
  outline: 'none',
  resize: 'none',
}

const FOCUS_RING_OUTSET =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'

/**
 * 今日 view (Phase 9, DAILY-01..04; 09-UI-SPEC).
 *
 * One mixed list: standalone todos plus linked long-term leaf tasks. Linked
 * content is always read from `Task` (never duplicated on the membership row),
 * so completion/progress stay single-sourced and long-term rollups are
 * untouched. A linked task that gained children renders TaskRow's non-
 * interactive container variant (09-UI-SPEC §Edge cases) and can only be
 * removed.
 *
 * All repository access stays inside effects/handlers — the Node prerender pass
 * has no IndexedDB under `output: 'export'`, and `getTodayStr` reads
 * localStorage, so it is never called during render/module scope.
 */
export default function TodayView() {
  const [daily, setDaily] = useState<DailyTodo[] | null>(null)
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [milestones, setMilestones] = useState<Milestone[] | null>(null)
  const [goals, setGoals] = useState<Goal[] | null>(null)
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [habits, setHabits] = useState<Habit[] | null>(null)
  const [completions, setCompletions] = useState<HabitCompletion[] | null>(null)
  const [pomodoroSessions, setPomodoroSessions] = useState<PomodoroSession[] | null>(null)
  // 20261104: inline note editing on 今日番茄 rows (click a note line to edit).
  const [pomoEditing, setPomoEditing] = useState<{ id: string; index: number } | null>(null)
  const [pomoEditingValue, setPomoEditingValue] = useState('')
  const pomoNoteCancelRef = useRef(false)
  const [offsetHours, setOffsetHours] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [today, setToday] = useState<string | null>(null)
  const [addingProgressId, setAddingProgressId] = useState<string | null>(null)
  const [progressError, setProgressError] = useState<{
    taskId: string
    message: string
  } | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const alive = useRef(false)
  const addButtonRef = useRef<HTMLButtonElement | null>(null)

  async function load() {
    try {
      const repo = getRepository()
      // Computed here (never during render) because getTodayStr reads
      // localStorage. The habit card filters completions by this day key.
      const todayStr = getTodayStr()
      // The offset is read here too: the pomodoro card filters sessions by the
      // same local-day boundary as the rest of the "today" layer.
      const offset = getDayOffsetHours()
      // One read pass: the view never refetches on interaction.
      const [
        allDaily,
        allTasks,
        allMilestones,
        allGoals,
        allCategories,
        allHabits,
        allCompletions,
        allPomodoroSessions,
      ] = await Promise.all([
        repo.list<DailyTodo>('dailyTodos'),
        repo.list<Task>('tasks'),
        repo.list<Milestone>('milestones'),
        repo.list<Goal>('goals'),
        repo.list<Category>('categories'),
        repo.list<Habit>('habits'),
        repo.list<HabitCompletion>('habitCompletions', { includeDeleted: true }),
        repo.list<PomodoroSession>('pomodoroSessions'),
      ])
      if (!alive.current) return
      // Defensive tombstone filter mirrors the other views even though the
      // repository already excludes tombstones by default.
      setDaily(allDaily.filter((row) => row.deleted_at == null))
      setTasks(allTasks.filter((task) => task.deleted_at == null))
      setMilestones(allMilestones.filter((milestone) => milestone.deleted_at == null))
      setGoals(allGoals.filter((goal) => goal.deleted_at == null))
      setCategories(allCategories.filter((category) => category.deleted_at == null))
      setHabits(sortHabits(allHabits.filter((habit) => habit.deleted_at == null)))
      // ALL completions (tombstones included, not date-filtered): the card
      // filters by the current `today` at render time, so a rollover while the
      // view stays open never shows yesterday's check-ins.
      setCompletions(allCompletions)
      // Filter tombstones defensively, matching the other slices.
      setPomodoroSessions(allPomodoroSessions.filter((row) => row.deleted_at == null))
      setOffsetHours(offset)
      setToday(todayStr)
      setError(null)
    } catch {
      if (!alive.current) return
      setError(LOAD_ERROR)
    }
  }

  useEffect(() => {
    alive.current = true
    void load()
    // Day rollover while the view stays open: recompute "today" on focus /
    // visibility instead of running a midnight timer (09-UI-SPEC §Edge cases).
    // The day-offset setting is re-read too so a changed offset takes effect
    // without a reload.
    const refreshToday = () => {
      setToday(getTodayStr())
      setOffsetHours(getDayOffsetHours())
    }
    document.addEventListener('visibilitychange', refreshToday)
    window.addEventListener('focus', refreshToday)
    return () => {
      alive.current = false
      document.removeEventListener('visibilitychange', refreshToday)
      window.removeEventListener('focus', refreshToday)
    }
    // Mount-only: load() only touches stable setters and getRepository.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // D-05 / B2: reload when remote rows are applied here or in another tab.
  useSyncRefresh(() => {
    void load()
  })

  // Derived each render so optimistic mutations show immediately.
  const entries = buildTodayEntries(
    daily ?? [],
    tasks ?? [],
    milestones ?? [],
    goals ?? [],
    today ?? '',
    offsetHours ?? 0,
  )
  const taskTree = buildTaskTree(tasks ?? [])

  // T28: goal groups of the 长期计划 card + manual order. These live at top
  // level (not in the renderCard closure) because the drag hook must run
  // unconditionally. A group's rank is the MIN sort_order of its member rows.
  const linkedGroups = new Map<string, TodayEntry[]>()
  for (const entry of entries) {
    if (entry.kind !== 'task' || entry.goalId == null) continue
    const list = linkedGroups.get(entry.goalId)
    if (list) list.push(entry)
    else linkedGroups.set(entry.goalId, [entry])
  }
  const orderedGoalIds = sortGoalGroupIds(linkedGroups)
  const planListRef = useRef<HTMLDivElement | null>(null)
  const {
    dragId: groupDragId,
    dragOrder: groupDragOrder,
    dropIndex: groupDropIndex,
    onHandlePointerDown: onGroupHandlePointerDown,
  } = useScopedDrag<string>({
    items: orderedGoalIds,
    idOf: (goalId) => goalId,
    onCommit: (finalOrder) => void commitGoalOrder(finalOrder),
    containerRef: planListRef,
    itemSelector: '[data-goal-group]',
  })

  async function commitGoalOrder(finalOrder: string[]) {
    const repo = getRepository()
    const now = new Date().toISOString()
    try {
      // One shared rank per group (the members' MIN), 0..n-1 in visual order;
      // only changed rows are written.
      for (let index = 0; index < finalOrder.length; index += 1) {
        for (const entry of linkedGroups.get(finalOrder[index]) ?? []) {
          const row = daily?.find((candidate) => candidate.id === entry.id)
          if (!row || row.deleted_at != null || row.sort_order === index) continue
          await repo.upsert<DailyTodo>('dailyTodos', {
            ...row,
            sort_order: index,
            updated_at: now,
          })
        }
      }
      await load()
    } catch {
      setListError('调整顺序失败，请重试。')
    }
  }

  // The quantity task whose progress sheet is open (null = none).
  const editingProgressTask =
    addingProgressId != null
      ? (tasks?.find((task) => task.id === addingProgressId) ?? null)
      : null

  // Picker candidates: live reachable leaves not already in today, grouped by
  // goal and ordered like the long-term plan (category → goal → milestone →
  // task). A null data slice yields an empty picker.
  const pickerGroups = useMemo<PickerCategoryGroup[]>(() => {
    if (
      daily === null ||
      tasks === null ||
      milestones === null ||
      goals === null ||
      categories === null
    ) {
      return []
    }

    // Tasks that already have a live linked row are omitted, so the same task
    // can never be added twice from this path (T-09-16).
    const excludeIds = new Set<string>()
    for (const row of daily) {
      if (row.deleted_at == null && row.task_id !== null) excludeIds.add(row.task_id)
    }

    const leaves = pickableLeaves(tasks, milestones, goals, excludeIds)
    if (leaves.length === 0) return []

    const leavesByGoal = new Map<string, PickableLeaf[]>()
    for (const leaf of leaves) {
      const list = leavesByGoal.get(leaf.goal.id)
      if (list) list.push(leaf)
      else leavesByGoal.set(leaf.goal.id, [leaf])
    }

    const liveMilestones = sortByEffectiveOrder(
      milestones.filter((milestone) => milestone.deleted_at == null),
    )
    const liveGoals = sortByEffectiveOrder(
      goals.filter((goal) => goal.deleted_at == null),
    )
    const liveCategories = sortByEffectiveOrder(
      categories.filter((category) => category.deleted_at == null),
    )

    // Category display order first, then each category's goals by sort_order.
    // Goals whose category is missing/archived trail everything in a 未分类 group.
    const goalsByCategory = new Map<string, Goal[]>()
    for (const category of liveCategories) goalsByCategory.set(category.id, [])
    const orphanGoals: Goal[] = []
    for (const goal of liveGoals) {
      const bucket = goal.category_id ? goalsByCategory.get(goal.category_id) : undefined
      if (bucket) bucket.push(goal)
      else orphanGoals.push(goal)
    }

    const buildGoalGroups = (goalList: Goal[]): PickerGoalGroup[] => {
      const result: PickerGoalGroup[] = []
      for (const goal of goalList) {
        const goalLeaves = leavesByGoal.get(goal.id)
        if (!goalLeaves || goalLeaves.length === 0) continue

        const byTaskId = new Map(goalLeaves.map((leaf) => [leaf.task.id, leaf]))
        const milestoneBuckets = new Map<string, Task[]>()
        const directTasks: Task[] = []
        for (const leaf of goalLeaves) {
          if (leaf.milestone === null) {
            directTasks.push(leaf.task)
            continue
          }
          const bucket = milestoneBuckets.get(leaf.milestone.id)
          if (bucket) bucket.push(leaf.task)
          else milestoneBuckets.set(leaf.milestone.id, [leaf.task])
        }

        const milestoneGroups: PickerMilestoneGroup[] = []
        // Milestones in display order, then each milestone's scoped task order.
        for (const milestone of liveMilestones) {
          if (milestone.goal_id !== goal.id) continue
          const bucket = milestoneBuckets.get(milestone.id)
          if (!bucket || bucket.length === 0) continue
          const leavesInMilestone = sortByEffectiveOrder(bucket)
            .map((task) => byTaskId.get(task.id))
            .filter((leaf): leaf is PickableLeaf => leaf !== undefined)
          milestoneGroups.push({ milestoneId: milestone.id, milestoneName: milestone.name, leaves: leavesInMilestone })
        }
        // Direct tasks trail the milestones as a synthetic 直接任务 group.
        if (directTasks.length > 0) {
          const directLeaves = sortByEffectiveOrder(directTasks)
            .map((task) => byTaskId.get(task.id))
            .filter((leaf): leaf is PickableLeaf => leaf !== undefined)
          milestoneGroups.push({ milestoneId: null, milestoneName: null, leaves: directLeaves })
        }

        if (milestoneGroups.length === 0) continue
        result.push({ goalId: goal.id, goalName: goal.name, milestoneGroups })
      }
      return result
    }

    const groups: PickerCategoryGroup[] = []
    for (const category of liveCategories) {
      const goalGroups = buildGoalGroups(goalsByCategory.get(category.id) ?? [])
      if (goalGroups.length === 0) continue
      groups.push({ categoryId: category.id, categoryName: category.name, goals: goalGroups })
    }
    if (orphanGoals.length > 0) {
      const goalGroups = buildGoalGroups(orphanGoals)
      if (goalGroups.length > 0) {
        groups.push({ categoryId: '__orphan__', categoryName: '未分类', goals: goalGroups })
      }
    }

    return groups
  }, [daily, tasks, milestones, goals, categories])

  function captionFor(entry: TodayEntry): string | null {
    // `today` is null until the mount effect runs (and during prerender), which
    // keeps localStorage out of render. TaskRow joins this caption with the
    // ancestor breadcrumb into one muted line (`添加于 … · …`).
    const label = today ? addedAgeLabel(entry.addedAt, today, getDayOffsetHours()) : null
    return label ? `添加于 ${label}` : null
  }

  function containerRatio(taskId: string): number {
    const progress = subtreeProgress(taskId, taskTree.children)
    return progress.total > 0 ? progress.completed / progress.total : 0
  }

  function retryLoad() {
    setError(null)
    setDaily(null)
    setTasks(null)
    setMilestones(null)
    setGoals(null)
    setHabits(null)
    setCompletions(null)
    setPomodoroSessions(null)
    setOffsetHours(null)
    void load()
  }

  async function createStandalone(name: string) {
    const repo = getRepository()
    // No try/catch: a rejection flows to InlineAddRow, which preserves the
    // draft and shows 添加待办失败，请重试。 (D-04, name-only todo).
    await repo.upsert<DailyTodo>('dailyTodos', {
      task_id: null,
      name,
      completed: false,
      completed_at: null,
      added_at: new Date().toISOString(),
    })
    await load()
  }

  async function addLinked(ids: string[]) {
    const repo = getRepository()
    // One shared timestamp for the whole batch (same-day rows share added_at).
    const addedAt = new Date().toISOString()
    // Re-read the live rows so a retry after a partial failure cannot create a
    // duplicate membership (T-09-16).
    const currentRows = await repo.list<DailyTodo>('dailyTodos')
    const liveRows = currentRows.filter((row) => row.deleted_at == null)
    const existing = new Set(
      liveRows
        .filter((row) => row.task_id !== null)
        .map((row) => row.task_id as string),
    )
    // T28: once ANY row carries a manual group rank, the user has ordered the
    // card — new entries take max+1 so they land last instead of disturbing
    // the hand-ordered groups. Before the first drag every row is null and
    // the legacy added_at ordering stays untouched.
    const manualRanks = liveRows
      .map((row) => row.sort_order)
      .filter((value): value is number => typeof value === 'number')
    const nextSortOrder =
      manualRanks.length > 0 ? Math.max(...manualRanks) + 1 : null
    for (const id of ids) {
      if (existing.has(id)) continue
      await repo.upsert<DailyTodo>('dailyTodos', {
        task_id: id,
        name: null,
        completed: null,
        completed_at: null,
        added_at: addedAt,
        sort_order: nextSortOrder,
      })
      existing.add(id)
    }
    // Refresh before the sheet unmounts so the new rows are present when it
    // closes. A rejection stays uncaught: the sheet keeps its selection and
    // shows 加入今天失败，请重试。
    await load()
    requestAnimationFrame(() => addButtonRef.current?.focus())
  }

  /** 20261104: persist one 今日番茄 note-line edit (clearing the text deletes the line). */
  async function savePomodoroNote(sessionId: string, noteIndex: number, text: string) {
    const session = pomodoroSessions?.find((row) => row.id === sessionId)
    if (!session) return
    const trimmed = text.trim()
    const nextNotes =
      trimmed === ''
        ? session.notes.filter((_, index) => index !== noteIndex)
        : session.notes.map((note, index) => (index === noteIndex ? trimmed : note))
    const previousNotes = session.notes
    setPomodoroSessions(
      (previous) =>
        previous?.map((row) =>
          row.id === sessionId ? { ...row, notes: nextNotes } : row,
        ) ?? previous,
    )
    setPomoEditing(null)
    try {
      await getRepository().upsert<PomodoroSession>('pomodoroSessions', {
        ...session,
        notes: nextNotes,
        updated_at: new Date().toISOString(),
      })
    } catch {
      setPomodoroSessions(
        (previous) =>
          previous?.map((row) =>
            row.id === sessionId ? { ...row, notes: previousNotes } : row,
          ) ?? previous,
      )
      setListError('更新笔记失败，请重试。')
    }
  }

  async function toggleStandalone(todo: DailyTodo) {
    const payload = togglePayload({ completed: todo.completed ?? false })
    setListError(null)
    setDaily(
      (previous) =>
        previous?.map((entry) =>
          entry.id === todo.id ? { ...entry, ...payload } : entry,
        ) ?? previous,
    )
    try {
      const repo = getRepository()
      await repo.upsert<DailyTodo>('dailyTodos', { ...todo, ...payload })
    } catch {
      setDaily(
        (previous) =>
          previous?.map((entry) => (entry.id === todo.id ? todo : entry)) ?? previous,
      )
      setListError('更新待办失败，请重试。')
    }
  }

  async function toggleLinked(task: Task) {
    const payload = togglePayload(task)
    setListError(null)
    setTasks(
      (previous) =>
        previous?.map((entry) =>
          entry.id === task.id ? { ...entry, ...payload } : entry,
        ) ?? previous,
    )
    try {
      const repo = getRepository()
      await repo.upsert<Task>('tasks', { ...task, ...payload })
      // D-03 completion trigger: check in the owning goal's habit after the
      // task write succeeds. Its own catch keeps a habit failure from reaching
      // the revert path below (D-06 / T-22-13).
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
      setListError('更新任务失败，请重试。')
    }
  }

  function openAddProgress(task: Task) {
    setProgressError(null)
    setAddingProgressId(task.id)
  }

  function cancelAddProgress() {
    setAddingProgressId(null)
    setProgressError(null)
  }

  async function submitProgress(task: Task, amount: number) {
    setProgressError(null)
    // Optimistic: every ring/row reflects the new value in this render pass.
    setTasks(
      (previous) =>
        previous?.map((entry) =>
          entry.id === task.id
            ? { ...entry, current_value: (entry.current_value ?? 0) + amount }
            : entry,
        ) ?? previous,
    )
    try {
      // Reusable primitive (D-04) — never a repository write buried in the UI.
      const updated = await addProgress(task.id, amount)
      setTasks(
        (previous) =>
          previous?.map((entry) => (entry.id === task.id ? updated : entry)) ?? previous,
      )
      setAddingProgressId(null)
    } catch {
      setTasks(
        (previous) =>
          previous?.map((entry) =>
            entry.id === task.id
              ? { ...entry, current_value: task.current_value }
              : entry,
          ) ?? previous,
      )
      // Keep the form open with the typed amount (09-UI-SPEC State Matrix).
      setProgressError({ taskId: task.id, message: '更新进度失败，请重试。' })
    }
  }

  async function removeEntry(entry: TodayEntry) {
    const snapshot = daily
    const index = entries.findIndex((candidate) => candidate.id === entry.id)
    // Focus destination resolved BEFORE the optimistic drop: next row, else the
    // previous row, else the add input (09-UI-SPEC Focus management).
    const nextEntry =
      (index >= 0 ? entries[index + 1] : undefined) ??
      (index > 0 ? entries[index - 1] : undefined) ??
      null
    setListError(null)
    setDaily((previous) => previous?.filter((row) => row.id !== entry.id) ?? previous)
    try {
      const repo = getRepository()
      // Linked removal deletes only the membership row; the Task and its
      // long-term placement are untouched (D-04). Standalone is a tombstone.
      await repo.softDelete('dailyTodos', entry.id)
    } catch {
      setDaily(snapshot)
      setListError(
        entry.kind === 'todo' ? '删除待办失败，请重试。' : '移出今天失败，请重试。',
      )
      return
    }
    requestAnimationFrame(() => {
      if (nextEntry) {
        const button = document.querySelector<HTMLElement>(
          `[data-entry-id="${nextEntry.id}"] [data-remove-today]`,
        )
        if (button && document.contains(button)) {
          button.focus()
          return
        }
      }
      document.querySelector<HTMLElement>('[data-add-row="today"]')?.focus()
    })
  }

  function renderEntry(entry: TodayEntry, index: number, hoistedBreadcrumb: string | null = null) {
    return (
      <li key={entry.id} data-today-row data-entry-id={entry.id}>
        {entry.kind === 'task' ? (
          <TaskRow
            task={entry.task!}
            first={index === 0}
            isContainer={entry.isContainer}
            progressRatio={entry.isContainer ? containerRatio(entry.task!.id) : 0}
            showDragHandle={false}
            showMenu={false}
            metaCaption={captionFor(entry)}
            nameSuffix={hoistedBreadcrumb ? null : entry.breadcrumb}
            trailingAction={
              <TodayRemoveButton
                name={entry.task!.name}
                action="unmark"
                onRemove={() => removeEntry(entry)}
              />
            }
            onToggle={toggleLinked}
            {...(entry.isContainer
              ? {}
              : {
                  onOpenAddProgress: openAddProgress,
                })}
          />
        ) : (
          <TodayRow
            todo={entry.todo!}
            first={index === 0}
            caption={captionFor(entry)}
            onToggle={toggleStandalone}
            onRemove={() => removeEntry(entry)}
          />
        )}
      </li>
    )
  }

  function renderCard() {
    // renderCard is a closure, so TypeScript cannot narrow the state here.
    const liveHabits = habits ?? []
    const allCompletions = completions ?? []
    // Group by source: standalone todos in one card; linked tasks grouped by
    // their owning goal (one card per goal, labeled with the goal name). Group
    // ORDER comes from the top-level sortGoalGroupIds + live drag state (T28).
    const standalone = entries.filter((entry) => entry.kind === 'todo')
    const linkedByGoal = linkedGroups
    const goalIds = groupDragOrder ?? orderedGoalIds

    const cards: Array<{ key: string; node: ReactNode }> = []
    // Read-only today pomodoros. The pure helper derives ordering, the
    // offset-adjusted day filter, fallback names, mode, and rounded duration; the
    // component only renders. renderCard is a closure invoked only in the loaded
    // branch, so a hook (useMemo) would violate the rules of hooks — the
    // derivation is cheap and pure.
    const pomodoroRows: TodayPomodoroRow[] = buildTodayPomodoroRows(
      pomodoroSessions ?? [],
      tasks ?? [],
      daily ?? [],
      liveHabits,
      today ?? '',
      offsetHours ?? 0,
    )
    if (liveHabits.length > 0) {
      cards.push({
        key: 'habits',
        node: (
          <div className="flex flex-col" style={CARD_STYLE}>
            <div className="flex items-center" style={{ minHeight: '44px' }}>
              <h2 style={CARD_HEADER_STYLE}>习惯打卡</h2>
            </div>
            <HabitChecklist
              habits={liveHabits}
              date={today ?? ''}
              completions={allCompletions.filter(
                (completion) => completion.date === today,
              )}
            />
          </div>
        ),
      })
    }
    cards.push({
      key: 'plan',
      node: (
        <div className="flex flex-col" style={CARD_STYLE}>
          <div className="flex items-center" style={{ minHeight: '44px' }}>
            <h2 style={CARD_HEADER_STYLE}>长期计划</h2>
          </div>

          <div ref={planListRef} className="flex flex-col" style={{ gap: '12px', minWidth: 0 }}>
            {goalIds.map((goalId, displayIndex) => {
              const goalEntries = linkedByGoal.get(goalId)!
              const goalName = goalEntries[0].goalName ?? '未分类'
              // Every row in a group usually shares one ancestor path (e.g. all
              // chapters of 白痴·第二部). Hoist a unanimous breadcrumb into the
              // group header instead of repeating it under every task; mixed
              // groups keep per-row crumbs.
              const crumbs = new Set(
                goalEntries.map((entry) => entry.breadcrumb).filter(Boolean),
              )
              const sharedBreadcrumb = crumbs.size === 1 ? [...crumbs][0] : null
              const dragging = groupDragId === goalId
              return (
                <div
                  key={goalId}
                  data-goal-group
                  data-drag-id={goalId}
                  className="flex flex-col"
                  style={{
                    ...NESTED_CARD_STYLE,
                    position: 'relative',
                    opacity: dragging ? 0.6 : 1,
                  }}
                >
                  {groupDragId !== null && groupDropIndex === displayIndex ? (
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
                  <div
                    className="flex items-center"
                    style={{ gap: '4px', minWidth: 0, minHeight: '44px', margin: '0 -8px' }}
                  >
                    <button
                      type="button"
                      aria-label={`调整「${goalName}」组的顺序`}
                      onPointerDown={(event) => onGroupHandlePointerDown(event, goalId)}
                      className={FOCUS_RING_OUTSET}
                      style={GROUP_DRAG_HANDLE_STYLE}
                    >
                      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
                        <line x1="3" y1="7" x2="15" y2="7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        <line x1="3" y1="11" x2="15" y2="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </button>
                    <span style={{ ...NESTED_GOAL_STYLE, flex: '1 1 auto', minWidth: 0 }}>
                      {goalName}
                      {sharedBreadcrumb ? (
                        <span style={{ fontWeight: 400, color: 'var(--muted)' }}>
                          {' · '}
                          {sharedBreadcrumb}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <ul className="flex flex-col" style={LIST_STYLE}>
                    {goalEntries.map((entry, index) =>
                      renderEntry(entry, index, sharedBreadcrumb),
                    )}
                  </ul>
                </div>
              )
            })}
          </div>

          <button
            ref={addButtonRef}
            type="button"
            onClick={() => {
              setListError(null)
              setPickerOpen(true)
            }}
            disabled={daily === null}
            className={`${FOCUS_RING_OUTSET} accent-button-glyph`}
            style={{
              ...ACCENT_TEXT_BUTTON_STYLE,
              alignSelf: 'flex-start',
              opacity: daily === null ? 0.4 : 1,
              cursor: daily === null ? 'default' : 'pointer',
            }}
          >
            <span aria-hidden="true">+ </span>
            <span className="accent-button-glyph__label">添加今日目标</span>
          </button>
        </div>
      ),
    })
    cards.push({
      key: 'standalone',
      node: (
        <div className="flex flex-col" style={CARD_STYLE}>
          <div className="flex items-center" style={{ minHeight: '44px' }}>
            <h2 style={CARD_HEADER_STYLE}>独立待办</h2>
          </div>
          {standalone.length > 0 ? (
            <ul className="flex flex-col" style={LIST_STYLE}>
              {standalone.map((entry, index) => renderEntry(entry, index))}
            </ul>
          ) : null}
          <InlineAddRow
            placeholder="添加今日待办"
            ariaLabel="添加今日待办"
            onCreate={createStandalone}
            dataAddRow="today"
            errorMessage="添加待办失败，请重试。"
          />
        </div>
      ),
    })
    // 今日番茄 is a retrospective log — keep it last so the actionable cards
    // (习惯打卡 → 长期计划 → 独立待办) stay on top.
    if (pomodoroRows.length > 0) {
      cards.push({
        key: 'pomodoro',
        node: (
          <div className="flex flex-col" style={CARD_STYLE}>
            <div className="flex items-center" style={{ minHeight: '44px' }}>
              <h2 style={CARD_HEADER_STYLE}>今日番茄</h2>
            </div>
            <ul className="flex flex-col" style={LIST_STYLE}>
              {pomodoroRows.map((row, index) => (
                <li
                  key={row.id}
                  className="flex flex-col"
                  style={{
                    borderTop: index === 0 ? 'none' : '1px solid var(--border)',
                  }}
                >
                  <div
                    className="flex items-center"
                    style={{ minHeight: '44px', gap: '8px' }}
                  >
                    <span style={POMO_TIME_STYLE}>{row.time}</span>
                    <span style={POMO_LINK_STYLE}>{row.linkName}</span>
                    {row.secondaryLinkName ? (
                      <span style={POMO_SECONDARY_STYLE}>
                        · {row.secondaryLinkName}
                      </span>
                    ) : null}
                    <span style={POMO_META_STYLE}>
                      {row.mode === 'tomato' ? '番茄' : '圣女果'} {row.durationMin} 分
                    </span>
                  </div>
                  {row.noteLines.map((note, noteIndex) =>
                    note.trim() !== '' ? (
                      pomoEditing?.id === row.id &&
                      pomoEditing.index === noteIndex ? (
                        <textarea
                          key={noteIndex}
                          autoFocus
                          value={pomoEditingValue}
                          onChange={(event) => setPomoEditingValue(event.target.value)}
                          onBlur={() => {
                            if (!pomoNoteCancelRef.current) {
                              void savePomodoroNote(
                                row.id,
                                noteIndex,
                                pomoEditingValue,
                              )
                            }
                            pomoNoteCancelRef.current = false
                          }}
                          onKeyDown={(event) => {
                            if (
                              event.key === 'Enter' &&
                              !event.nativeEvent.isComposing
                            ) {
                              event.preventDefault()
                              void savePomodoroNote(
                                row.id,
                                noteIndex,
                                pomoEditingValue,
                              )
                            } else if (event.key === 'Escape') {
                              pomoNoteCancelRef.current = true
                              setPomoEditing(null)
                            }
                          }}
                          rows={1}
                          style={POMO_NOTE_EDIT_STYLE}
                          aria-label="编辑番茄笔记"
                        />
                      ) : (
                        <p
                          key={noteIndex}
                          style={{ ...POMO_NOTE_STYLE, cursor: 'text' }}
                          title="点击编辑"
                          onClick={() => {
                            pomoNoteCancelRef.current = false
                            setPomoEditing({ id: row.id, index: noteIndex })
                            setPomoEditingValue(note)
                          }}
                        >
                          {note}
                        </p>
                      )
                    ) : null,
                  )}
                </li>
              ))}
            </ul>
          </div>
        ),
      })
    }

    return (
      <div className="flex flex-col" style={{ gap: '16px' }}>
        <BalancedColumns items={cards} />
        {listError ? <p style={INLINE_ERROR_STYLE}>{listError}</p> : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col" style={{ gap: '24px' }}>
      <header style={{ marginBottom: '32px' }}>
        <h1 style={HERO_TITLE_STYLE}>今日待办</h1>
      </header>

      {error ? (
        <div className="flex flex-col" style={{ gap: '8px' }}>
          <p style={ERROR_STYLE}>{error}</p>
          <button
            type="button"
            onClick={retryLoad}
            className={`self-start ${FOCUS_RING_OUTSET} accent-button`}
            style={ACCENT_TEXT_BUTTON_STYLE}
          >
            重新加载今日待办
          </button>
        </div>
      ) : daily === null ||
        tasks === null ||
        milestones === null ||
        goals === null ||
        habits === null ||
        completions === null ||
        pomodoroSessions === null ||
        offsetHours === null ? (
        <p style={LOADING_STYLE}>正在加载今日待办…</p>
      ) : (
        // One stable tree for empty and non-empty lists: the card keeps its
        // position (slot 1) so InlineAddRow is never remounted when the first
        // todo is created — that is what keeps focus for rapid entry.
        <div className="flex flex-col" style={{ gap: '16px' }}>
          {renderCard()}
        </div>
      )}

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

      <TodayPickerSheet
        open={pickerOpen}
        groups={pickerGroups}
        onClose={() => setPickerOpen(false)}
        onConfirm={addLinked}
        returnFocusRef={addButtonRef}
      />

      <JournalView embedded />
    </div>
  )
}
