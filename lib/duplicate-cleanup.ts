import type { OrbitDB } from '@/lib/local-db'
import type { Repository } from '@/lib/repository'
import type { Category, DailyTodo, Goal, Habit, Milestone, Task } from '@/lib/types'

/**
 * Phase 21 / OPS-03 / D-07 + D-08 — duplicate detection engine.
 *
 * A "duplicate" is only ever same-name (after trim) within the same parent.
 * The six named entities are the only ones that can duplicate: diary days,
 * habit check-ins and pomodoro sessions have natural keys that make same-name
 * siblings impossible, so they are deliberately never read here.
 *
 * This module returns data only. `21-UI-SPEC §6` owns the copy and layout.
 */

export const DUPLICATE_ENTITIES = [
  'categories',
  'goals',
  'milestones',
  'tasks',
  'dailyTodos',
  'habits',
] as const

export type DuplicateEntity = (typeof DUPLICATE_ENTITIES)[number]

export interface DuplicateCandidate {
  id: string
  name: string
  updatedAt: string
  descendantCount: number
}

export interface DuplicateGroup {
  key: string
  entity: DuplicateEntity
  name: string
  parentPath: string
  rows: DuplicateCandidate[]
}

export type DuplicateScan =
  | { ok: true; groups: DuplicateGroup[] }
  | { ok: false; reason: 'local-throw' }

interface Rows {
  categories: Category[]
  goals: Goal[]
  milestones: Milestone[]
  tasks: Task[]
  dailyTodos: DailyTodo[]
  habits: Habit[]
}

/**
 * Read exactly the six duplicate-eligible tables (plus their hierarchy, which
 * is the same set). One rejected read rejects the whole batch — a partial scan
 * would silently hide real duplicates.
 */
async function readRows(db: OrbitDB): Promise<Rows> {
  const [categories, goals, milestones, tasks, dailyTodos, habits] = await Promise.all([
    db.categories.toArray(),
    db.goals.toArray(),
    db.milestones.toArray(),
    db.tasks.toArray(),
    db.dailyTodos.toArray(),
    db.habits.toArray(),
  ])
  return { categories, goals, milestones, tasks, dailyTodos, habits }
}

function isLive(row: { deleted_at: string | null }): boolean {
  return row.deleted_at == null
}

/** A non-empty trimmed name is required; whitespace-only names never group. */
function trimmedName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  return trimmed === '' ? null : trimmed
}

function displayedParent(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return fallback
}

function byId<T extends { id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]))
}

/** Count every live descendant reachable through `parent_id` (cycle-safe). */
function recursiveTaskDescendants(taskId: string, childrenByParent: Map<string, Task[]>): number {
  const seen = new Set<string>()
  const stack = [...(childrenByParent.get(taskId) ?? [])]
  let count = 0
  while (stack.length > 0) {
    const child = stack.pop() as Task
    if (seen.has(child.id)) continue
    seen.add(child.id)
    count += 1
    for (const grandchild of childrenByParent.get(child.id) ?? []) stack.push(grandchild)
  }
  return count
}

interface CandidateSource {
  entity: DuplicateEntity
  id: string
  name: string
  updatedAt: string
  parentKey: string
  parentPath: string
  descendantCount: number
}

function collectCandidates(rows: Rows): CandidateSource[] {
  const categories = byId(rows.categories)
  const goals = byId(rows.goals)
  const milestones = byId(rows.milestones)
  const tasks = byId(rows.tasks)

  const liveGoals = rows.goals.filter(isLive)
  const liveMilestones = rows.milestones.filter(isLive)
  const liveTasks = rows.tasks.filter(isLive)

  const childrenByParent = new Map<string, Task[]>()
  for (const task of liveTasks) {
    if (task.parent_id == null) continue
    const bucket = childrenByParent.get(task.parent_id) ?? []
    bucket.push(task)
    childrenByParent.set(task.parent_id, bucket)
  }

  const out: CandidateSource[] = []

  for (const row of rows.categories.filter(isLive)) {
    const name = trimmedName(row.name)
    if (!name) continue
    out.push({
      entity: 'categories',
      id: row.id,
      name,
      updatedAt: row.updated_at,
      parentKey: 'root',
      parentPath: '全部',
      descendantCount: liveGoals.filter((goal) => goal.category_id === row.id).length,
    })
  }

  for (const row of rows.goals.filter(isLive)) {
    const name = trimmedName(row.name)
    if (!name) continue
    out.push({
      entity: 'goals',
      id: row.id,
      name,
      updatedAt: row.updated_at,
      parentKey: `category:${row.category_id}`,
      parentPath: `分类「${displayedParent(categories.get(row.category_id)?.name, '未分类')}」`,
      descendantCount: 0,
    })
  }

  for (const row of rows.milestones.filter(isLive)) {
    const name = trimmedName(row.name)
    if (!name) continue
    out.push({
      entity: 'milestones',
      id: row.id,
      name,
      updatedAt: row.updated_at,
      parentKey: `goal:${row.goal_id}`,
      parentPath: `目标「${displayedParent(goals.get(row.goal_id)?.name, '未命名父级')}」`,
      descendantCount: 0,
    })
  }

  for (const row of rows.tasks.filter(isLive)) {
    const name = trimmedName(row.name)
    if (!name) continue
    let parentKey = 'root'
    let parentPath = '未命名父级'
    if (row.parent_id != null) {
      parentKey = `parent:${row.parent_id}`
      parentPath = `任务「${displayedParent(tasks.get(row.parent_id)?.name, '未命名父级')}」`
    } else if (row.milestone_id != null) {
      parentKey = `milestone:${row.milestone_id}`
      parentPath = `里程碑「${displayedParent(milestones.get(row.milestone_id)?.name, '未命名父级')}」`
    } else if (row.goal_id != null) {
      parentKey = `goal:${row.goal_id}`
      parentPath = `目标「${displayedParent(goals.get(row.goal_id)?.name, '未命名父级')}」`
    }
    out.push({
      entity: 'tasks',
      id: row.id,
      name,
      updatedAt: row.updated_at,
      parentKey,
      parentPath,
      descendantCount: recursiveTaskDescendants(row.id, childrenByParent),
    })
  }

  for (const row of rows.dailyTodos.filter(isLive)) {
    // A linked row has no name of its own — its content lives on the Task.
    if (row.task_id != null) continue
    const name = trimmedName(row.name)
    if (!name) continue
    out.push({
      entity: 'dailyTodos',
      id: row.id,
      name,
      updatedAt: row.updated_at,
      parentKey: 'root',
      parentPath: '独立待办',
      descendantCount: 0,
    })
  }

  for (const row of rows.habits.filter(isLive)) {
    const name = trimmedName(row.name)
    if (!name) continue
    out.push({
      entity: 'habits',
      id: row.id,
      name,
      updatedAt: row.updated_at,
      parentKey: 'root',
      parentPath: '全部',
      descendantCount: 0,
    })
  }

  // Goal descendant counts are only known once every live milestone/task is
  // indexed. Category and milestone counts are folded in here too so the
  // hierarchy is computed from one consistent live snapshot.
  const milestoneIdsByGoal = new Map<string, Set<string>>()
  for (const m of liveMilestones) {
    const bucket = milestoneIdsByGoal.get(m.goal_id) ?? new Set<string>()
    bucket.add(m.id)
    milestoneIdsByGoal.set(m.goal_id, bucket)
  }

  return out.map((candidate) => {
    if (candidate.entity === 'goals') {
      const milestoneIds = milestoneIdsByGoal.get(candidate.id) ?? new Set<string>()
      const descendantTasks = new Set<string>()
      for (const task of liveTasks) {
        if (task.goal_id === candidate.id) descendantTasks.add(task.id)
        if (task.milestone_id != null && milestoneIds.has(task.milestone_id)) descendantTasks.add(task.id)
      }
      return { ...candidate, descendantCount: descendantTasks.size }
    }
    if (candidate.entity === 'milestones') {
      return {
        ...candidate,
        descendantCount: liveTasks.filter((task) => task.milestone_id === candidate.id).length,
      }
    }
    return candidate
  })
}

function buildGroups(candidates: readonly CandidateSource[]): DuplicateGroup[] {
  const buckets = new Map<string, CandidateSource[]>()
  for (const candidate of candidates) {
    const key = `${candidate.entity}\u0000${candidate.parentKey}\u0000${candidate.name}`
    const bucket = buckets.get(key) ?? []
    bucket.push(candidate)
    buckets.set(key, bucket)
  }

  const groups: DuplicateGroup[] = []
  for (const [key, members] of buckets) {
    if (members.length < 2) continue
    const first = members[0]
    groups.push({
      key,
      entity: first.entity,
      name: first.name,
      parentPath: first.parentPath,
      rows: members
        .map((member) => ({
          id: member.id,
          name: member.name,
          updatedAt: member.updatedAt,
          descendantCount: member.descendantCount,
        }))
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
        ),
    })
  }

  const entityOrder = (entity: DuplicateEntity) => DUPLICATE_ENTITIES.indexOf(entity)
  groups.sort(
    (a, b) =>
      entityOrder(a.entity) - entityOrder(b.entity) ||
      a.name.localeCompare(b.name) ||
      a.parentPath.localeCompare(b.parentPath) ||
      a.key.localeCompare(b.key),
  )
  return groups
}

/**
 * Find every live same-name same-parent group in the six eligible entities.
 * Any table read failure aborts the whole scan as a typed `local-throw`; an
 * empty group list is never silently substituted for a failed read.
 */
export async function scanDuplicates(db: OrbitDB): Promise<DuplicateScan> {
  try {
    const rows = await readRows(db)
    return { ok: true, groups: buildGroups(collectCandidates(rows)) }
  } catch {
    return { ok: false, reason: 'local-throw' }
  }
}

// --- deletion -------------------------------------------------------------

export interface DuplicateSelection {
  entity: DuplicateEntity
  id: string
}

export type DuplicateDeleteResult =
  | { ok: true; deleted: number; cascaded: number }
  | { ok: false; reason: 'empties-group'; groupKey: string }
  | { ok: false; reason: 'local-throw' }
  | { ok: false; reason: 'partial'; deleted: number }

/**
 * Delete the user's duplicate selections as tombstones, cascading a container's
 * live descendants.
 *
 * Safety rules (D-08 / T-21-04-02):
 *  - the scan is re-run before any write, and unknown / already-deleted ids are
 *    silently ignored so a repeated call is idempotent;
 *  - the deletion closure is the selection PLUS every live descendant it would
 *    cascade-delete;
 *  - if that closure would leave any detected duplicate group with zero live
 *    rows, nothing is written (`empties-group`);
 *  - every row goes through `repo.softDelete` (`op:'delete'`), never a purge.
 */
export async function deleteDuplicateRows(
  db: OrbitDB,
  repo: Pick<Repository, 'softDelete'>,
  selected: readonly DuplicateSelection[],
): Promise<DuplicateDeleteResult> {
  const scan = await scanDuplicates(db)
  if (!scan.ok) return { ok: false, reason: 'local-throw' }

  let rows: Rows
  try {
    rows = await readRows(db)
  } catch {
    return { ok: false, reason: 'local-throw' }
  }

  const liveCategories = rows.categories.filter(isLive)
  const liveGoals = rows.goals.filter(isLive)
  const liveMilestones = rows.milestones.filter(isLive)
  const liveTasks = rows.tasks.filter(isLive)
  const liveTodos = rows.dailyTodos.filter(isLive)
  const liveHabits = rows.habits.filter(isLive)

  const liveIds: Record<DuplicateEntity, Set<string>> = {
    categories: new Set(liveCategories.map((row) => row.id)),
    goals: new Set(liveGoals.map((row) => row.id)),
    milestones: new Set(liveMilestones.map((row) => row.id)),
    tasks: new Set(liveTasks.map((row) => row.id)),
    dailyTodos: new Set(liveTodos.map((row) => row.id)),
    habits: new Set(liveHabits.map((row) => row.id)),
  }

  const taskById = new Map(liveTasks.map((row) => [row.id, row]))

  // Validate the raw selection: only live rows in the six eligible entities,
  // deduped by entity:id. Anything else is a no-op for idempotency.
  const validated: DuplicateSelection[] = []
  const selectedKeys = new Set<string>()
  for (const selection of selected) {
    const key = `${selection.entity}:${selection.id}`
    if (selectedKeys.has(key)) continue
    if (!liveIds[selection.entity]?.has(selection.id)) continue
    selectedKeys.add(key)
    validated.push({ entity: selection.entity, id: selection.id })
  }

  // Build the full deletion closure (selection + live descendants) BEFORE any
  // preservation check, so a cascade that empties a different group is caught.
  const closure = new Map<string, DuplicateSelection>()
  const expandingTasks = new Set<string>()

  const add = (entity: DuplicateEntity, id: string) => {
    const key = `${entity}:${id}`
    if (!closure.has(key)) closure.set(key, { entity, id })
  }

  const expandTask = (taskId: string) => {
    if (!liveIds.tasks.has(taskId) || expandingTasks.has(taskId)) return
    expandingTasks.add(taskId)
    add('tasks', taskId)
    for (const todo of liveTodos) {
      if (todo.task_id === taskId) add('dailyTodos', todo.id)
    }
    for (const child of liveTasks) {
      if (child.parent_id === taskId) expandTask(child.id)
    }
    expandingTasks.delete(taskId)
  }

  const expandMilestone = (milestoneId: string) => {
    if (!liveIds.milestones.has(milestoneId)) return
    add('milestones', milestoneId)
    for (const task of liveTasks) {
      if (task.milestone_id === milestoneId) expandTask(task.id)
    }
  }

  const expandGoal = (goalId: string) => {
    if (!liveIds.goals.has(goalId)) return
    add('goals', goalId)
    for (const milestone of liveMilestones) {
      if (milestone.goal_id === goalId) expandMilestone(milestone.id)
    }
    for (const task of liveTasks) {
      if (task.goal_id === goalId) expandTask(task.id)
    }
  }

  const expandCategory = (categoryId: string) => {
    if (!liveIds.categories.has(categoryId)) return
    add('categories', categoryId)
    for (const goal of liveGoals) {
      if (goal.category_id === categoryId) expandGoal(goal.id)
    }
  }

  for (const selection of validated) {
    switch (selection.entity) {
      case 'categories':
        expandCategory(selection.id)
        break
      case 'goals':
        expandGoal(selection.id)
        break
      case 'milestones':
        expandMilestone(selection.id)
        break
      case 'tasks':
        expandTask(selection.id)
        break
      case 'dailyTodos':
        add('dailyTodos', selection.id)
        break
      case 'habits':
        add('habits', selection.id)
        break
    }
  }

  if (closure.size === 0) return { ok: true, deleted: 0, cascaded: 0 }

  // Group preservation must be evaluated against the CLOSURE, not the raw
  // selection: deleting one container can cascade the last live members of an
  // unrelated duplicate group.
  const closureKeys = new Set(closure.keys())
  for (const group of scan.groups) {
    const remaining = group.rows.filter(
      (row) => !closureKeys.has(`${group.entity}:${row.id}`),
    ).length
    if (remaining === 0) {
      return { ok: false, reason: 'empties-group', groupKey: group.key }
    }
  }

  const taskDepth = (taskId: string): number => {
    let depth = 0
    let current = taskById.get(taskId)
    const seen = new Set<string>()
    while (current && current.parent_id != null) {
      if (seen.has(current.id)) break
      seen.add(current.id)
      const parent = taskById.get(current.parent_id)
      if (!parent) break
      depth += 1
      current = parent
    }
    return depth
  }

  const byIdOrder = (a: DuplicateSelection, b: DuplicateSelection) => a.id.localeCompare(b.id)
  const items = [...closure.values()]
  // Child-first: dailyTodos, then deepest tasks, then milestones, goals,
  // categories and finally habits (leaves with no descendants).
  const writeOrder: DuplicateSelection[] = [
    ...items.filter((item) => item.entity === 'dailyTodos').sort(byIdOrder),
    ...items
      .filter((item) => item.entity === 'tasks')
      .sort((a, b) => taskDepth(b.id) - taskDepth(a.id) || a.id.localeCompare(b.id)),
    ...items.filter((item) => item.entity === 'milestones').sort(byIdOrder),
    ...items.filter((item) => item.entity === 'goals').sort(byIdOrder),
    ...items.filter((item) => item.entity === 'categories').sort(byIdOrder),
    ...items.filter((item) => item.entity === 'habits').sort(byIdOrder),
  ]

  let written = 0
  for (const item of writeOrder) {
    try {
      await repo.softDelete(item.entity, item.id)
      written += 1
    } catch {
      return { ok: false, reason: 'partial', deleted: written }
    }
  }

  const deleted = validated.length
  return { ok: true, deleted, cascaded: closure.size - deleted }
}
