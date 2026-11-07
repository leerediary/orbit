'use client'

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { getLocalRepository, getRepository } from '@/lib/repository-provider'
import { nextSortOrder, sortByEffectiveOrder } from '@/lib/goal-order'
import { rollupProgress } from '@/lib/hierarchy'
import type { TaskProgress } from '@/lib/progress'
import type { Category, Goal, Milestone, Task } from '@/lib/types'
import { useScopedDrag } from '@/lib/use-scoped-drag'
import { useSyncRefresh } from '@/lib/sync-state'
import CategoryCard from '@/components/CategoryCard'
import CategorySheet from '@/components/CategorySheet'
import GoalDetail from '@/components/GoalDetail'
import GoalSheet from '@/components/GoalSheet'
import GoalSummaryCard from '@/components/GoalSummaryCard'
import ProgressIndicator from '@/components/ProgressIndicator'
import SettingsSheet from '@/components/SettingsSheet'
import HabitCheckInView from '@/components/HabitCheckInView'
import PomodoroView from '@/components/PomodoroView'
import TopNav, { type Section } from '@/components/TopNav'
import TodayView from '@/components/TodayView'

// Home controller for the four-level hierarchy (07-UI-SPEC is the authoritative
// visual/interaction contract): 分类 → 目标 (horizontal cards) → milestone/task
// detail is delegated to the inline GoalDetail.
//
// All repository access happens inside effects/handlers — never module scope or
// render — because the Node prerender pass has no IndexedDB under
// `output: 'export'`. This page deliberately never seeds.

const LOAD_ERROR = '长期计划加载失败。请重新加载；如果仍然失败，刷新页面后再试。'

type SheetState = { mode: 'create' } | { mode: 'edit'; category: Category }

type PendingFocus =
  | { type: 'invoker' }
  | { type: 'last-category' }
  | { type: 'category'; id: string }
  | { type: 'goal'; id: string }

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

const MUTED_INLINE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
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

const HERO_TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '48px',
  fontWeight: 600,
  lineHeight: 1.05,
  letterSpacing: '-0.02em',
  color: 'var(--foreground)',
}

const CATEGORY_HEADING_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  margin: 0,
  fontSize: '28px',
  fontWeight: 600,
  lineHeight: 1.2,
  letterSpacing: '-0.01em',
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

const ARCHIVED_HEADING_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.2,
  color: 'var(--foreground)',
}

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

const FOCUS_RING_OUTSET =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'
const FOCUS_RING_INSET =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:-2px]'

export default function GoalsPage() {
  const [active, setActive] = useState<Category[] | null>(null)
  const [archived, setArchived] = useState<Category[] | null>(null)
  const [goalsByCategory, setGoalsByCategory] = useState<Map<string, Goal[]>>(new Map())
  const [goalProgress, setGoalProgress] = useState<Map<string, TaskProgress>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [section, setSection] = useState<Section>('goals')

  const [sheet, setSheet] = useState<SheetState | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [goalSheet, setGoalSheet] = useState<{ categoryId: string } | null>(null)
  const [goalSaving, setGoalSaving] = useState(false)
  const [goalSaveError, setGoalSaveError] = useState<string | null>(null)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [confirmClearArchived, setConfirmClearArchived] = useState(false)
  // Session drafts for the create naming sheets (2026-11-01): survive a
  // backdrop-click / Escape close and restore on reopen.
  const [goalDraft, setGoalDraft] = useState('')
  const [categoryDraft, setCategoryDraft] = useState('')

  // Data portability + install guidance live in one settings sheet.
  const [settingsOpen, setSettingsOpen] = useState(false)

  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null)

  // Drill-in (D-06): client-side view state only — no route, no popstate.
  const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null)

  /**
   * Section switch (Phase 9): leaving a drilled-in goal must clear every view
   * overlay, otherwise the detail would keep rendering over the new section.
   * The list refreshes when the detail was open because GoalDetail owns edits.
   */
  function changeSection(next: Section) {
    if (next === section) return
    const wasInDetail = selectedGoal !== null
    setSelectedGoal(null)
    setSheet(null)
    setGoalSheet(null)
    setSettingsOpen(false)
    setConfirmClearArchived(false)
    setSection(next)
    if (wasInDetail) void load()
  }

  // The floating mini pomodoro dispatches this when tapped (never after a drag)
  // so a glance at the countdown anywhere can jump back to the 番茄钟 tab.
  useEffect(() => {
    const handler = () => changeSection('pomodoro')
    window.addEventListener('orbit:goto-pomodoro', handler)
    return () => window.removeEventListener('orbit:goto-pomodoro', handler)
    // changeSection closes over the current section; re-bind when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section])

  const alive = useRef(false)
  const categoriesListRef = useRef<HTMLDivElement | null>(null)
  const newCategoryButtonRef = useRef<HTMLButtonElement | null>(null)
  const invokerRef = useRef<HTMLElement | null>(null)
  // The home list unmounts on drill-in, collapsing its scroll. Stash it so 返回
  // can restore the exact position unless the list data actually changed.
  const listScrollRef = useRef(0)
  const listMutatedRef = useRef(false)

  const { dragId, dragOrder, dropIndex, onHandlePointerDown } = useScopedDrag<Category>({
    items: active ?? [],
    idOf: (category) => category.id,
    onCommit: commitCategoryOrder,
    containerRef: categoriesListRef,
    itemSelector: '[data-category-section]',
  })

  async function load() {
    try {
      const repo = getRepository()
      // All five reads are issued together: switching views never refetches.
      const [liveCategories, allCategories, liveGoals, liveMilestones, liveTasks] =
        await Promise.all([
          repo.list<Category>('categories'),
          repo.list<Category>('categories', { includeDeleted: true }),
          repo.list<Goal>('goals'),
          repo.list<Milestone>('milestones'),
          repo.list<Task>('tasks'),
        ])
      if (!alive.current) return

      const goals = liveGoals.filter((goal) => goal.deleted_at == null)
      const milestones = liveMilestones.filter((milestone) => milestone.deleted_at == null)
      const tasks = liveTasks.filter((task) => task.deleted_at == null)
      // Derived-only progress: one pass rolls task → milestone → goal. The
      // category bar is a goal count (see renderCategories), not a task rollup.
      const rollup = rollupProgress(tasks, milestones, goals)
      setGoalProgress(rollup.goal)

      // Goals grouped by category, each bucket in stored display order.
      const byCategory = new Map<string, Goal[]>()
      for (const goal of goals) {
        const bucket = byCategory.get(goal.category_id)
        if (bucket) bucket.push(goal)
        else byCategory.set(goal.category_id, [goal])
      }
      for (const [categoryId, list] of byCategory) {
        byCategory.set(categoryId, sortByEffectiveOrder(list))
      }
      setGoalsByCategory(byCategory)

      setActive(sortByEffectiveOrder(liveCategories.filter((c) => c.deleted_at == null)))
      setArchived(
        allCategories
          .filter((category) => category.deleted_at != null)
          .sort((a, b) => (b.deleted_at! > a.deleted_at! ? 1 : -1)),
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
    return () => {
      alive.current = false
    }
    // Mount-only: load() only touches stable setters, refs and getRepository.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // D-05 / B2: when the engine (or another tab) applies remote rows, reload this
  // view's own data so the change appears without a manual refresh. The mount
  // effect above still owns the initial load; this only fires on an applied-seq
  // advance.
  useSyncRefresh(() => {
    void load()
  })

  // Deferred focus: the target DOM node only exists after the list re-renders,
  // so resolve it on the next frame instead of racing the commit.
  useEffect(() => {
    if (!pendingFocus) return
    const frame = requestAnimationFrame(() => {
      let element: HTMLElement | null = null
      if (pendingFocus.type === 'goal') {
        element = document.querySelector<HTMLElement>(
          `[data-goal-summary][data-goal-summary-id="${pendingFocus.id}"]`,
        )
      } else if (pendingFocus.type === 'category') {
        element = document.querySelector<HTMLElement>(
          `[data-category-section][data-category-id="${pendingFocus.id}"] h2`,
        )
      } else if (pendingFocus.type === 'last-category') {
        const nodes = document.querySelectorAll<HTMLElement>('[data-category-section] h2')
        element = nodes.length > 0 ? nodes[nodes.length - 1] : null
      } else if (pendingFocus.type === 'invoker') {
        const invoker = invokerRef.current
        element =
          invoker && document.contains(invoker) ? invoker : newCategoryButtonRef.current
      }
      if (element && document.contains(element)) element.focus()
      setPendingFocus(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [pendingFocus, active, archived, goalsByCategory])

  function retryLoad() {
    setError(null)
    setActive(null)
    setArchived(null)
    void load()
  }

  function openDetail(goal: Goal) {
    // Remember who opened the detail so focus can return on 返回, and stash the
    // list scroll because the list unmounts during the drill-in.
    invokerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    listScrollRef.current = window.scrollY
    listMutatedRef.current = false
    setSelectedGoal(goal)
  }

  function handleBack() {
    if (!selectedGoal) return
    const goalId = selectedGoal.id
    const shouldRestoreScroll = !listMutatedRef.current
    setSelectedGoal(null)
    // A goal may have been renamed/edited from the detail header.
    void load()
    if (shouldRestoreScroll) {
      const y = listScrollRef.current
      requestAnimationFrame(() => window.scrollTo(0, y))
    }
    setPendingFocus({ type: 'goal', id: goalId })
  }

  function openSettings() {
    setSettingsOpen(true)
  }

  function closeSettings() {
    setSettingsOpen(false)
    // The sheet unmounts; return focus to the nav gear control that opened it.
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-settings-button]')?.focus()
    })
  }

  function openCreate() {
    invokerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSaveError(null)
    setArchiveError(null)
    setSheet({ mode: 'create' })
  }

  function openEditCategory(category: Category) {
    invokerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSaveError(null)
    setArchiveError(null)
    setSheet({ mode: 'edit', category })
  }

  function openGoalSheet(categoryId: string) {
    invokerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setGoalSaveError(null)
    setGoalSheet({ categoryId })
  }

  function closeGoalSheet() {
    if (goalSaving) return
    setGoalSheet(null)
    setGoalSaveError(null)
    setPendingFocus({ type: 'invoker' })
  }

  async function handleSaveGoal(payload: { name: string }) {
    if (!goalSheet) return
    setGoalSaving(true)
    setGoalSaveError(null)
    try {
      await createGoal(goalSheet.categoryId, payload.name)
      setGoalSheet(null)
      setGoalDraft('')
      setPendingFocus({ type: 'invoker' })
    } catch {
      setGoalSaveError('保存失败，请重试。')
    } finally {
      setGoalSaving(false)
    }
  }

  function handleCancel() {
    if (saving) return
    setSheet(null)
    setSaveError(null)
    setArchiveError(null)
    setPendingFocus({ type: 'invoker' })
  }

  async function handleSave(payload: { name: string }) {
    if (!sheet) return
    setSaving(true)
    setSaveError(null)
    try {
      const repo = getRepository()
      if (sheet.mode === 'create') {
        // Read a fresh max (including archived rows) inside the handler so the
        // new category is appended after every existing row.
        const all = await repo.list<Category>('categories', { includeDeleted: true })
        const sort_order = nextSortOrder(all)
        await repo.upsert<Category>('categories', {
          name: payload.name,
          created_at: new Date().toISOString(),
          sort_order,
        })
        setSheet(null)
        setCategoryDraft('')
        await load()
        setPendingFocus({ type: 'last-category' })
      } else {
        const category = sheet.category
        // Spread preserves id / created_at / sort_order / tombstone; the
        // repository re-stamps updated_at.
        await repo.upsert<Category>('categories', { ...category, name: payload.name })
        setSheet(null)
        await load()
        setPendingFocus({ type: 'category', id: category.id })
      }
    } catch {
      // Keep the sheet open with the draft intact.
      setSaveError('保存失败，请重试。')
    } finally {
      setSaving(false)
    }
  }

  async function handleArchive() {
    if (!sheet || sheet.mode !== 'edit' || saving) return
    const category = sheet.category
    setSaving(true)
    setArchiveError(null)
    try {
      // Reversible tombstone — no confirmation dialog.
      const repo = getRepository()
      await repo.softDelete('categories', category.id)
      setSheet(null)
      await load()
      // The invoking 分类操作 button unmounts with the section.
      setPendingFocus({ type: 'invoker' })
    } catch {
      setArchiveError('归档失败，请重试。')
    } finally {
      setSaving(false)
    }
  }

  async function handleRestore(category: Category) {
    if (restoringId !== null) return
    setRestoringId(category.id)
    setRestoreError(null)
    try {
      const repo = getRepository()
      await repo.upsert<Category>('categories', { ...category, deleted_at: null })
      await load()
      setPendingFocus({ type: 'category', id: category.id })
    } catch {
      setRestoreError('恢复失败，请重试。')
    } finally {
      setRestoringId(null)
    }
  }

  /**
   * Permanently purge every archived category AND its goals/milestones/tasks
   * (hardDelete — irreversible). Descendants are removed first to avoid
   * orphans; the confirmation pair is the only guard.
   */
  async function clearArchivedCategories() {
    const targets = archived ?? []
    if (targets.length === 0) return
    const repo = getLocalRepository()
    try {
      const [allGoals, allMilestones, allTasks] = await Promise.all([
        repo.list<Goal>('goals', { includeDeleted: true }),
        repo.list<Milestone>('milestones', { includeDeleted: true }),
        repo.list<Task>('tasks', { includeDeleted: true }),
      ])
      for (const category of targets) {
        const goals = allGoals.filter((goal) => goal.category_id === category.id)
        const goalIds = new Set(goals.map((goal) => goal.id))
        const milestones = allMilestones.filter((m) => goalIds.has(m.goal_id))
        const milestoneIds = new Set(milestones.map((m) => m.id))
        // Union: milestone tasks + goal-scoped direct tasks (milestone_id null).
        // Without the direct branch an archived goal's direct tasks would be
        // orphaned and survive the purge (Pitfall 2 / T-08-15).
        const tasks = allTasks.filter(
          (task) =>
            milestoneIds.has(task.milestone_id ?? '') ||
            (task.milestone_id == null && task.goal_id != null && goalIds.has(task.goal_id)),
        )
        for (const goal of goals) await repo.hardDelete('goals', goal.id)
        for (const milestone of milestones) await repo.hardDelete('milestones', milestone.id)
        for (const task of tasks) await repo.hardDelete('tasks', task.id)
        await repo.hardDelete('categories', category.id)
      }
      setConfirmClearArchived(false)
      await load()
    } catch {
      setRestoreError('删除失败，请重试。')
    }
  }

  async function commitCategoryOrder(finalOrder: Category[], baseline: Category[]) {
    try {
      const repo = getRepository()
      const previous = new Map(baseline.map((category) => [category.id, category.sort_order]))
      // Reassign 0..n-1 in visual order; only changed rows are written.
      // Tombstoned categories keep their old sort_order (they are not here).
      for (let index = 0; index < finalOrder.length; index += 1) {
        const category = finalOrder[index]
        if (previous.get(category.id) !== index) {
          await repo.upsert<Category>('categories', { ...category, sort_order: index })
        }
      }
      await load()
    } catch {
      // Persistence failed: re-read so the UI shows the stored order.
      await load()
    }
  }

  async function createGoal(categoryId: string, name: string) {
    const repo = getRepository()
    // Fresh read including tombstones so append order sees every sibling.
    const all = await repo.list<Goal>('goals', { includeDeleted: true })
    const siblings = all.filter((goal) => goal.category_id === categoryId)
    const sort_order = nextSortOrder(siblings)
    // No try/catch: a rejection flows to handleSaveGoal so the sheet stays open
    // and 保存失败，请重试。 is shown.
    await repo.upsert<Goal>('goals', {
      category_id: categoryId,
      name,
      created_at: new Date().toISOString(),
      sort_order,
    })
    await load()
  }

  /**
   * Keyboard reorder fallback for categories (required this phase; the drag
   * hook is pointer-only). ArrowUp/ArrowDown moves one slot, no-op at the ends,
   * writes 0..n-1 immediately, then re-focuses this category's handle.
   */
  async function handleCategoryKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    category: Category,
  ) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    if (!active) return
    const currentIndex = active.findIndex((item) => item.id === category.id)
    if (currentIndex === -1) return
    const delta = event.key === 'ArrowUp' ? -1 : 1
    const nextIndex = currentIndex + delta
    if (nextIndex < 0 || nextIndex >= active.length) return
    event.preventDefault()

    const reordered = [...active]
    const [moved] = reordered.splice(currentIndex, 1)
    reordered.splice(nextIndex, 0, moved)

    try {
      const repo = getRepository()
      for (let index = 0; index < reordered.length; index += 1) {
        const item = reordered[index]
        if (item.sort_order !== index) {
          await repo.upsert<Category>('categories', { ...item, sort_order: index })
        }
      }
      await load()
    } catch {
      await load()
    }
    // Re-query by id after the re-render and keep focus on this category.
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-category-id="${category.id}"] [data-category-drag]`)
        ?.focus()
    })
  }

  function renderLoadError() {
    return (
      <div className="flex flex-col" style={{ gap: '8px' }}>
        <p style={ERROR_STYLE}>{error ?? LOAD_ERROR}</p>
        <button
          type="button"
          onClick={retryLoad}
          className={`self-start ${FOCUS_RING_OUTSET} accent-button`}
          style={ACCENT_TEXT_BUTTON_STYLE}
        >
          重新加载长期计划
        </button>
      </div>
    )
  }

  function renderCategories() {
    if (error) return renderLoadError()
    if (active === null) return <p style={LOADING_STYLE}>正在加载分类…</p>

    if (active.length === 0 && (archived === null || archived.length === 0)) {
      return (
        <div className="flex flex-col" style={{ gap: '8px' }}>
          <h2 style={EMPTY_HEADING_STYLE}>还没有分类</h2>
          <p style={EMPTY_BODY_STYLE}>
            新建你的第一个分类，把长期想推进的事按主题归到一起。点击右上角「新建分类」开始。
          </p>
        </div>
      )
    }

    // During a pointer drag render the provisional order so the dropped card
    // slot is visible; the hook measures the pre-drag rects, not this order.
    const displayed = dragOrder ?? active

    return (
      <div ref={categoriesListRef} className="flex flex-col" style={{ gap: '40px' }}>
        {displayed.map((category, index) => {
          const goals = goalsByCategory.get(category.id) ?? []
          // Category bar counts completed goals (all leaves done), not task
          // fractions — a goal is a binary unit here.
          const completedGoals = goals.filter((goal) => {
            const progress = goalProgress.get(goal.id)
            return progress != null && progress.total > 0 && progress.completed >= progress.total
          }).length
          return (
            <section
              key={category.id}
              data-category-section
              data-category-id={category.id}
              data-drag-id={category.id}
              className="flex flex-col"
              style={{
                gap: '16px',
                position: 'relative',
                opacity: dragId === category.id ? 0.6 : 1,
              }}
            >
              {dropIndex === index ? (
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
                <h2 tabIndex={-1} style={CATEGORY_HEADING_STYLE}>
                  {category.name}
                </h2>
                <button
                  type="button"
                  data-category-drag
                  aria-label="调整分类顺序"
                  onPointerDown={(event) => onHandlePointerDown(event, category)}
                  onKeyDown={(event) => handleCategoryKeyDown(event, category)}
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
                  data-category-more
                  aria-label="分类操作"
                  onClick={() => openEditCategory(category)}
                  className={FOCUS_RING_INSET}
                  style={{ ...ICON_BUTTON_STYLE, cursor: 'pointer' }}
                >
                  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
                    <circle cx="4" cy="9" r="1.5" fill="currentColor" />
                    <circle cx="9" cy="9" r="1.5" fill="currentColor" />
                    <circle cx="14" cy="9" r="1.5" fill="currentColor" />
                  </svg>
                </button>
              </div>

              <ProgressIndicator
                completed={completedGoals}
                total={goals.length}
                label="分类进度"
              />

              {goals.length === 0 ? (
                <p style={MUTED_INLINE_STYLE}>还没有目标。</p>
              ) : null}

              <div
                className="hide-scrollbar"
                style={{
                  display: 'flex',
                  gap: '12px',
                  overflowX: 'auto',
                  paddingBottom: '16px',
                  WebkitOverflowScrolling: 'touch',
                  // Apple symmetric full-bleed: when there are more cards than
                  // fit, the row breaks out to both viewport edges while
                  // padding keeps the first/last card aligned to the content
                  // boundaries. The trailing 「新建目标」 card counts as one.
                  ...(goals.length >= 4
                    ? {
                        marginLeft: 'calc(50% - 50vw)',
                        marginRight: 'calc(50% - 50vw)',
                        paddingLeft: 'calc(50vw - 50%)',
                        paddingRight: 'calc(50vw - 50%)',
                      }
                    : {}),
                }}
              >
                {goals.map((goal) => {
                  const goalTasks = goalProgress.get(goal.id)
                  return (
                    <GoalSummaryCard
                      key={goal.id}
                      goal={goal}
                      completed={goalTasks?.completed ?? 0}
                      total={goalTasks?.total ?? 0}
                      onClick={() => openDetail(goal)}
                    />
                  )
                })}

                <button
                  type="button"
                  data-new-goal-card
                  onClick={() => openGoalSheet(category.id)}
                  className="goal-summary-card focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:-2px] active:opacity-60"
                  style={{
                    aspectRatio: '5 / 4',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    padding: '16px',
                    background: 'var(--card)',
                    borderRadius: '12px',
                    boxShadow: 'var(--card-shadow)',
                    border: 'none',
                    color: 'var(--muted)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
                    <line x1="16" y1="6" x2="16" y2="26" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    <line x1="6" y1="16" x2="26" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  <span
                    style={{
                      margin: 0,
                      fontSize: '13px',
                      fontWeight: 400,
                      lineHeight: 1.4,
                      color: 'var(--muted)',
                    }}
                  >
                    新建目标
                  </span>
                </button>
              </div>
            </section>
          )
        })}

        {archived !== null && archived.length > 0 ? (
          <section className="flex flex-col" style={{ gap: '16px' }}>
            {confirmClearArchived ? (
              <p style={MUTED_INLINE_STYLE}>
                将永久删除所有已归档分类及其下的目标、里程碑和任务（含直接任务与子任务）。
              </p>
            ) : null}
            <div className="flex items-center justify-between" style={{ gap: '16px' }}>
              <h2 style={ARCHIVED_HEADING_STYLE}>已归档</h2>
              {confirmClearArchived ? (
                <div className="flex items-center" style={{ gap: '12px' }}>
                  <button
                    type="button"
                    onClick={() => clearArchivedCategories()}
                    className={`${FOCUS_RING_OUTSET} accent-button`}
                    style={ACCENT_TEXT_BUTTON_STYLE}
                  >
                    确认清空
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClearArchived(false)}
                    className={FOCUS_RING_OUTSET}
                    style={{ ...ACCENT_TEXT_BUTTON_STYLE, color: 'var(--muted)' }}
                  >
                    取消清空
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmClearArchived(true)}
                  className={`${FOCUS_RING_OUTSET} accent-button`}
                  style={ACCENT_TEXT_BUTTON_STYLE}
                >
                  清空已归档
                </button>
              )}
            </div>
            {restoreError ? <p style={INLINE_ERROR_STYLE}>{restoreError}</p> : null}
            <ul
              className="flex flex-col"
              style={{ listStyle: 'none', padding: 0, margin: 0, gap: '16px' }}
            >
              {archived.map((category) => (
                <CategoryCard
                  key={category.id}
                  category={category}
                  onRestore={handleRestore}
                />
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col" style={{ gap: '24px' }}>
      <div
        className="flex items-center justify-center"
        style={{
          marginLeft: 'calc(50% - 50vw)',
          marginRight: 'calc(50% - 50vw)',
          paddingTop: '12px',
          paddingBottom: '32px',
        }}
      >
        <TopNav value={section} onChange={changeSection} onSettings={openSettings} />
      </div>

      {selectedGoal && section === 'goals' ? (
        // Goal editing/deletion lives inside GoalDetail's ItemSheet (07-03);
        // the home page only owns drill-in state. The section guard keeps a
        // drilled-in detail from leaking into another section.
        <GoalDetail goal={selectedGoal} onBack={handleBack} />
      ) : section === 'today' ? <TodayView /> : section === 'checkin' ? <HabitCheckInView /> : section === 'goals' ? (
        <>
          <header className="flex items-center justify-between" style={{ gap: '16px', marginBottom: '32px' }}>
            <h1 style={HERO_TITLE_STYLE}>长期计划</h1>
            <button
              ref={newCategoryButtonRef}
              type="button"
              onClick={openCreate}
              className={`${FOCUS_RING_OUTSET} primary-button`}
            >
              新建分类
            </button>
          </header>
          {renderCategories()}
        </>
      ) : section === 'pomodoro' ? (
        <PomodoroView />
      ) : null}

      {settingsOpen ? (
        <SettingsSheet onClose={closeSettings} onImported={load} />
      ) : null}

      {sheet ? (
        <CategorySheet
          key={sheet.mode === 'edit' ? sheet.category.id : 'create'}
          mode={sheet.mode}
          initialCategory={sheet.mode === 'edit' ? sheet.category : undefined}
          onSave={handleSave}
          onArchive={sheet.mode === 'edit' ? handleArchive : undefined}
          onCancel={handleCancel}
          saving={saving}
          saveError={saveError}
          archiveError={archiveError}
          {...(sheet.mode === 'create'
            ? { value: categoryDraft, onValueChange: setCategoryDraft }
            : {})}
        />
      ) : null}

      {goalSheet ? (
        <GoalSheet
          onSave={handleSaveGoal}
          onCancel={closeGoalSheet}
          saving={goalSaving}
          saveError={goalSaveError}
          value={goalDraft}
          onValueChange={setGoalDraft}
        />
      ) : null}
    </div>
  )
}
