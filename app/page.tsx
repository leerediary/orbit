'use client'

import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { getLocalRepository, getRepository } from '@/lib/repository-provider'
import { nextSortOrder, sortByEffectiveOrder, sortGoals } from '@/lib/goal-order'
import { progressOf } from '@/lib/progress'
import type { Goal, Milestone, Review, Task } from '@/lib/types'
import GoalCard from '@/components/GoalCard'
import GoalSheet from '@/components/GoalSheet'
import GoalDetail from '@/components/GoalDetail'
import SettingsSheet from '@/components/SettingsSheet'
import TopNav, { type Section } from '@/components/TopNav'
import MilestoneSummaryCard from '@/components/MilestoneSummaryCard'

// Goals UI (02-UI-SPEC.md is the authoritative visual/interaction contract).
// All repository access happens inside effects/handlers — never module scope or
// render — because the Node prerender pass has no IndexedDB under
// `output: 'export'`. This page deliberately never seeds: the Phase 1 seed row
// is ordinary data (no sort_order → effectiveOrder fallback), never re-created
// or deleted here.

const LOAD_ERROR = '目标加载失败。请重新加载；如果仍然失败，刷新页面后再试。'

type SheetState = { mode: 'create' } | { mode: 'edit'; goal: Goal }

type PendingFocus =
  | { type: 'invoker' }
  | { type: 'last' }
  | { type: 'goal'; id: string }
  | { type: 'detail-edit' }

interface DragSession {
  goal: Goal
  original: Goal[]
  rects: Array<{ id: string; mid: number }>
  startY: number
  started: boolean
  order: Goal[] | null
  dropIndex: number | null
}

const LOADING_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const ERROR_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--foreground)',
}

const INLINE_ERROR_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
}

const ACCENT_TEXT_BUTTON_STYLE: React.CSSProperties = {
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

const EMPTY_HEADING_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: '20px',
  fontWeight: 600,
  lineHeight: 1.2,
  letterSpacing: '-0.01em',
  color: 'var(--foreground)',
}

const EMPTY_BODY_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--muted)',
}

const HERO_TITLE_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: '48px',
  fontWeight: 600,
  lineHeight: 1.05,
  letterSpacing: '-0.02em',
  color: 'var(--foreground)',
}

const GOAL_HEADING_STYLE: React.CSSProperties = {
  margin: 0,
  padding: 0,
  background: 'none',
  border: 'none',
  color: 'var(--foreground)',
  fontSize: '28px',
  fontWeight: 600,
  lineHeight: 1.2,
  letterSpacing: '-0.01em',
  fontFamily: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}

export default function GoalsPage() {
  const [active, setActive] = useState<Goal[] | null>(null)
  const [archived, setArchived] = useState<Goal[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progressByGoal, setProgressByGoal] = useState<
    Map<string, { completed: number; total: number }>
  >(new Map())
  const [milestonesByGoal, setMilestonesByGoal] = useState<Map<string, Milestone[]>>(
    new Map(),
  )
  const [milestoneProgress, setMilestoneProgress] = useState<
    Map<string, { completed: number; total: number }>
  >(new Map())
  const [section, setSection] = useState<Section>('goals')

  const [sheet, setSheet] = useState<SheetState | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [confirmClearArchived, setConfirmClearArchived] = useState(false)

  // Data portability + install guidance live in one settings sheet.
  const [settingsOpen, setSettingsOpen] = useState(false)

  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null)

  // Drill-in (D-01): client-side view state only — no route, no popstate.
  const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null)

  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOrder, setDragOrder] = useState<Goal[] | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const alive = useRef(false)
  const listRef = useRef<HTMLUListElement | null>(null)
  const newGoalButtonRef = useRef<HTMLButtonElement | null>(null)
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null)
  const invokerRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<DragSession | null>(null)
  // The list unmounts on drill-in, collapsing its scroll. Stash it so 返回 can
  // restore the exact position unless the list data actually changed.
  const listScrollRef = useRef(0)
  const listMutatedRef = useRef(false)

  async function load() {
    try {
      const repo = getRepository()
      // All four reads are issued together: switching sections never refetches.
      const [live, all, allTasks, allMilestones] = await Promise.all([
        repo.list<Goal>('goals'),
        repo.list<Goal>('goals', { includeDeleted: true }),
        repo.list<Task>('tasks'),
        repo.list<Milestone>('milestones'),
      ])
      if (!alive.current) return
      const liveTasks = allTasks.filter((task) => task.deleted_at == null)
      // Group live tasks by goal so each goal derives its own progress through
      // the single progressOf helper (D-07; tombstones excluded).
      const grouped = new Map<string, Task[]>()
      for (const t of liveTasks) {
        const bucket = grouped.get(t.goal_id)
        if (bucket) bucket.push(t)
        else grouped.set(t.goal_id, [t])
      }
      setProgressByGoal(
        new Map([...grouped].map(([goalId, list]) => [goalId, progressOf(list)])),
      )
      // Per-milestone progress (for the flat summary cards) — keyed by milestone id.
      const tasksByMilestone = new Map<string, Task[]>()
      for (const t of liveTasks) {
        if (!t.milestone_id) continue
        const bucket = tasksByMilestone.get(t.milestone_id)
        if (bucket) bucket.push(t)
        else tasksByMilestone.set(t.milestone_id, [t])
      }
      setMilestoneProgress(
        new Map([...tasksByMilestone].map(([mid, list]) => [mid, progressOf(list)])),
      )
      // Live milestones grouped by goal, sorted by effective order.
      const byGoal = new Map<string, Milestone[]>()
      for (const m of allMilestones.filter((milestone) => milestone.deleted_at == null)) {
        const bucket = byGoal.get(m.goal_id)
        if (bucket) bucket.push(m)
        else byGoal.set(m.goal_id, [m])
      }
      for (const [goalId, list] of byGoal) byGoal.set(goalId, sortByEffectiveOrder(list))
      setMilestonesByGoal(byGoal)
      setActive(sortGoals(live))
      setArchived(
        all
          .filter((goal) => goal.deleted_at != null)
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

  // Deferred focus: the target DOM node only exists after the list re-renders,
  // so resolve it on the next frame instead of racing the commit.
  useEffect(() => {
    if (!pendingFocus) return
    const frame = requestAnimationFrame(() => {
      let element: HTMLElement | null = null
      if (pendingFocus.type === 'goal') {
        element = document.querySelector<HTMLElement>(
          `[data-goal-main][data-goal-id="${pendingFocus.id}"]`,
        )
      } else if (pendingFocus.type === 'last') {
        const nodes = document.querySelectorAll<HTMLElement>(
          '#goals-panel-active [data-goal-main]',
        )
        element = nodes.length > 0 ? nodes[nodes.length - 1] : null
      } else if (pendingFocus.type === 'invoker') {
        const invoker = invokerRef.current
        element =
          invoker && document.contains(invoker) ? invoker : newGoalButtonRef.current
      } else if (pendingFocus.type === 'detail-edit') {
        // Edit-from-detail: focus the 编辑 button, falling back to the heading.
        element =
          document.querySelector<HTMLElement>('[data-goal-edit]') ??
          document.querySelector<HTMLElement>('[data-goal-detail-title]')
      }
      if (element && document.contains(element)) element.focus()
      setPendingFocus(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [pendingFocus, active, archived])

  function retryLoad() {
    setError(null)
    setActive(null)
    setArchived(null)
    void load()
  }

  function openDetail(goal: Goal) {
    // Remember who opened the detail so focus can return on archive, and stash
    // the list scroll because the list is unmounted during the drill-in.
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
    // A goal may have been renamed/archived from the detail header.
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
    // The sheet unmounts; return focus to the header control that opened it.
    requestAnimationFrame(() => settingsButtonRef.current?.focus())
  }

  function openCreate() {
    invokerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSaveError(null)
    setArchiveError(null)
    setSheet({ mode: 'create' })
  }

  function openEdit(goal: Goal) {
    invokerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSaveError(null)
    setArchiveError(null)
    setSheet({ mode: 'edit', goal })
  }

  function handleCancel() {
    if (saving) return
    setSheet(null)
    setSaveError(null)
    setArchiveError(null)
    setPendingFocus({ type: 'invoker' })
  }

  async function handleSave(payload: { name: string; description: string }) {
    if (!sheet) return
    setSaving(true)
    setSaveError(null)
    try {
      const repo = getRepository()
      if (sheet.mode === 'create') {
        // Read a fresh max (including archived rows) inside the handler so the
        // new goal is appended after every existing goal, legacy rows included.
        const all = await repo.list<Goal>('goals', { includeDeleted: true })
        const sort_order = nextSortOrder(all)
        await repo.upsert<Goal>('goals', {
          name: payload.name,
          description: payload.description,
          created_at: new Date().toISOString(),
          sort_order,
        })
        setSheet(null)
        await load()
        setPendingFocus({ type: 'last' })
      } else {
        const goal = sheet.goal
        // Spread preserves id / created_at / sort_order / tombstone; the
        // repository re-stamps updated_at.
        await repo.upsert<Goal>('goals', {
          ...goal,
          name: payload.name,
          description: payload.description,
        })
        setSheet(null)
        await load()
        if (selectedGoal && selectedGoal.id === goal.id) {
          // Edit-from-detail: re-read so the header reflects the new name and
          // description immediately, then focus the 编辑 button again.
          listMutatedRef.current = true
          const live = await repo.list<Goal>('goals')
          const refreshed = live.find((item) => item.id === goal.id)
          if (refreshed) setSelectedGoal(refreshed)
          setPendingFocus({ type: 'detail-edit' })
        } else {
          setPendingFocus({ type: 'goal', id: goal.id })
        }
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
    const goal = sheet.goal
    setSaving(true)
    setArchiveError(null)
    try {
      // Reversible tombstone — no confirmation dialog (D-06).
      const repo = getRepository()
      const archivedFromDetail = selectedGoal?.id === goal.id
      await repo.softDelete('goals', goal.id)
      setSheet(null)
      if (archivedFromDetail) {
        // Return to the list on the 活跃 tab; 新建目标 receives focus because the
        // invoking 编辑 button unmounts with the detail view.
        listMutatedRef.current = true
        setSelectedGoal(null)
      }
      await load()
      setPendingFocus({ type: 'invoker' })
    } catch {
      setArchiveError('归档失败，请重试。')
    } finally {
      setSaving(false)
    }
  }

  async function handleRestore(goal: Goal) {
    if (restoringId !== null) return
    setRestoringId(goal.id)
    setRestoreError(null)
    try {
      const repo = getRepository()
      await repo.upsert<Goal>('goals', { ...goal, deleted_at: null })
      await load()
    } catch {
      setRestoreError('恢复失败，请重试。')
    } finally {
      setRestoringId(null)
    }
  }

  /**
   * Permanently purge every archived goal AND its milestones/tasks/reviews
   * (hardDelete — no tombstone, irreversible). Descendants are live rows, so
   * they must be removed first to avoid orphans.
   */
  async function clearArchivedGoals() {
    const targets = archived ?? []
    if (targets.length === 0) return
    const repo = getLocalRepository()
    try {
      const [allMilestones, allTasks, allReviews] = await Promise.all([
        repo.list<Milestone>('milestones', { includeDeleted: true }),
        repo.list<Task>('tasks', { includeDeleted: true }),
        repo.list<Review>('reviews', { includeDeleted: true }),
      ])
      for (const goal of targets) {
        for (const milestone of allMilestones.filter((m) => m.goal_id === goal.id)) {
          await repo.hardDelete('milestones', milestone.id)
        }
        for (const task of allTasks.filter((t) => t.goal_id === goal.id)) {
          await repo.hardDelete('tasks', task.id)
        }
        for (const review of allReviews.filter((r) => r.goal_id === goal.id)) {
          await repo.hardDelete('reviews', review.id)
        }
        await repo.hardDelete('goals', goal.id)
      }
      setConfirmClearArchived(false)
      await load()
    } catch {
      setRestoreError('删除失败，请重试。')
    }
  }

  function resetDrag() {
    dragRef.current = null
    setDragId(null)
    setDragOrder(null)
    setDropIndex(null)
  }

  async function commitOrder(finalOrder: Goal[], baseline: Goal[]) {
    try {
      const repo = getRepository()
      const previous = new Map(baseline.map((goal) => [goal.id, goal.sort_order]))
      // Reassign 0..n-1 in visual order; only changed rows are written.
      // Archived rows keep their old sort_order (they are not in this list).
      for (let index = 0; index < finalOrder.length; index += 1) {
        const goal = finalOrder[index]
        if (previous.get(goal.id) !== index) {
          await repo.upsert<Goal>('goals', { ...goal, sort_order: index })
        }
      }
      await load()
    } catch {
      // Persistence failed: re-read so the UI shows the stored order.
      await load()
    }
  }

  function handleDragHandlePointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    goal: Goal,
  ) {
    if (!active || dragRef.current) return
    if (event.pointerType === 'mouse' && event.button !== 0) return

    const cards = listRef.current
      ? Array.from(listRef.current.querySelectorAll<HTMLElement>('[data-goal-card]'))
      : []
    const rects = cards
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return { id: element.dataset.goalId ?? '', mid: rect.top + rect.height / 2 }
      })
      .filter((rect) => rect.id !== '' && rect.id !== goal.id)
    if (rects.length === 0) return

    event.preventDefault()

    const session: DragSession = {
      goal,
      original: active,
      rects,
      startY: event.clientY,
      started: false,
      order: null,
      dropIndex: null,
    }
    dragRef.current = session

    function onMove(moveEvent: PointerEvent) {
      const current = dragRef.current
      if (!current) return

      // 4px movement threshold prevents accidental drags.
      if (!current.started) {
        if (Math.abs(moveEvent.clientY - current.startY) < 4) return
        current.started = true
        setDragId(current.goal.id)
      }

      // Insertion index is over the OTHER cards only; counting the dragged
      // card's own midpoint shifts downward drags one slot too far.
      let target = current.rects.length
      for (let index = 0; index < current.rects.length; index += 1) {
        if (moveEvent.clientY < current.rects[index].mid) {
          target = index
          break
        }
      }

      if (current.dropIndex === target && current.order) return

      const others = current.original.filter((item) => item.id !== current.goal.id)
      others.splice(target, 0, current.goal)
      current.order = others
      current.dropIndex = target
      setDragOrder(others)
      setDropIndex(target)
    }

    function cleanup() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey)
    }

    function onUp() {
      cleanup()
      const current = dragRef.current
      if (!current) return
      if (!current.started || !current.order) {
        // Below the threshold or no valid position: cancel with no writes.
        resetDrag()
        return
      }
      const finalOrder = current.order
      const baseline = current.original
      resetDrag()
      void commitOrder(finalOrder, baseline)
    }

    function onCancel() {
      cleanup()
      resetDrag()
    }

    function onKey(keyEvent: KeyboardEvent) {
      if (keyEvent.key !== 'Escape') return
      keyEvent.preventDefault()
      cleanup()
      resetDrag()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey)
  }

  function renderLoadError() {
    return (
      <div className="flex flex-col" style={{ gap: '8px' }}>
        <p style={ERROR_STYLE}>{error ?? LOAD_ERROR}</p>
        <button
          type="button"
          onClick={retryLoad}
          className="self-start focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
          style={ACCENT_TEXT_BUTTON_STYLE}
        >
          重新加载目标
        </button>
      </div>
    )
  }

  function renderFlatGoals() {
    if (error) return renderLoadError()
    if (active === null) return <p style={LOADING_STYLE}>正在加载目标…</p>

    if (active.length === 0) {
      return (
        <div className="flex flex-col" style={{ gap: '8px' }}>
          <h2 style={EMPTY_HEADING_STYLE}>还没有目标</h2>
          <p style={EMPTY_BODY_STYLE}>
            新建你的第一个长期目标，把想推进的事写下来。点击右上角「新建目标」开始。
          </p>
        </div>
      )
    }

    return (
      <div className="flex flex-col" style={{ gap: '40px' }}>
        {active.map((goal) => {
          const milestones = milestonesByGoal.get(goal.id) ?? []
          return (
            <section key={goal.id} className="flex flex-col" style={{ gap: '16px' }}>
              <button
                type="button"
                onClick={() => openDetail(goal)}
                className="break-words focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
                style={GOAL_HEADING_STYLE}
              >
                {goal.name}
              </button>
              {milestones.length > 0 ? (
                <div
                  className="hide-scrollbar"
                  style={{
                    display: 'flex',
                    gap: '12px',
                    overflowX: 'auto',
                    paddingBottom: '16px',
                    WebkitOverflowScrolling: 'touch',
                    // Apple symmetric full-bleed: when there are more cards than
                    // fit, the scroll row breaks out to BOTH viewport edges, while
                    // padding keeps the first/last card aligned to the 75% content
                    // boundaries. So far-right stops the last card at the 75% right
                    // edge, and far-left breaks through on the left.
                    ...(milestones.length > 4
                      ? {
                          marginLeft: 'calc(50% - 50vw)',
                          marginRight: 'calc(50% - 50vw)',
                          paddingLeft: 'calc(50vw - 50%)',
                          paddingRight: 'calc(50vw - 50%)',
                        }
                      : {}),
                  }}
                >
                  {milestones.map((milestone) => {
                    const progress = milestoneProgress.get(milestone.id)
                    return (
                      <MilestoneSummaryCard
                        key={milestone.id}
                        milestone={milestone}
                        completed={progress?.completed ?? 0}
                        total={progress?.total ?? 0}
                        onClick={() => openDetail(goal)}
                      />
                    )
                  })}
                </div>
              ) : null}
            </section>
          )
        })}

        {archived !== null && archived.length > 0 ? (
          <section className="flex flex-col" style={{ gap: '16px' }}>
            <div className="flex items-center justify-between" style={{ gap: '16px' }}>
              <h2 style={{ ...EMPTY_HEADING_STYLE, fontSize: '17px' }}>已归档</h2>
              {confirmClearArchived ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <button
                    type="button"
                    onClick={() => clearArchivedGoals()}
                    className="focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
                    style={ACCENT_TEXT_BUTTON_STYLE}
                  >
                    确认清空
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClearArchived(false)}
                    className="focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
                    style={{ ...ACCENT_TEXT_BUTTON_STYLE, color: 'var(--muted)' }}
                  >
                    取消
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmClearArchived(true)}
                  className="focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
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
              {archived.map((goal) => (
                <GoalCard
                  key={goal.id}
                  goal={goal}
                  variant="archived"
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
          paddingBottom: '10px',
        }}
      >
        <TopNav value={section} onChange={setSection} />
      </div>

      {selectedGoal ? (
        <GoalDetail goal={selectedGoal} onBack={handleBack} onEdit={openEdit} />
      ) : section === 'goals' ? (
        <>
          <header className="flex items-center justify-between" style={{ gap: '16px', marginBottom: '32px' }}>
            <h1 style={HERO_TITLE_STYLE}>长期计划</h1>
            <div className="flex items-center" style={{ gap: '16px' }}>
              <button
                ref={settingsButtonRef}
                type="button"
                data-settings-button
                onClick={openSettings}
                className="focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
                style={ACCENT_TEXT_BUTTON_STYLE}
              >
                设置
              </button>
              <button
                ref={newGoalButtonRef}
                type="button"
                onClick={openCreate}
                className="focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
                style={ACCENT_TEXT_BUTTON_STYLE}
              >
                新建目标
              </button>
            </div>
          </header>
          {renderFlatGoals()}
        </>
      ) : (
        <div className="flex flex-col" style={{ gap: '8px' }}>
          <h1 style={HERO_TITLE_STYLE}>
            {section === 'pomodoro' ? '番茄钟' : '早起打卡'}
          </h1>
          <p style={EMPTY_BODY_STYLE}>敬请期待</p>
        </div>
      )}

      {settingsOpen ? (
        <SettingsSheet onClose={closeSettings} onImported={load} />
      ) : null}

      {sheet ? (
        <GoalSheet
          key={sheet.mode === 'edit' ? sheet.goal.id : 'create'}
          mode={sheet.mode}
          initialGoal={sheet.mode === 'edit' ? sheet.goal : undefined}
          onSave={handleSave}
          onArchive={sheet.mode === 'edit' ? handleArchive : undefined}
          onCancel={handleCancel}
          saving={saving}
          saveError={saveError}
          archiveError={archiveError}
        />
      ) : null}
    </div>
  )
}
