/**
 * 书籍目录批量导入的纯解析与页数推导（D-01 / D-02 / D-03 / D-04）。
 *
 * 本模块不依赖 React、Repository 或任何浏览器全局，只做纯字符串/数值推导，
 * 组件只消费这里的输出，不得各自重算页数。落点 A / B 共用同一种导入 payload。
 */

/** 单次粘贴最多处理的目录行数（T-15-02：截断超长粘贴，避免大数组/长渲染）。 */
export const MAX_TOC_LINES = 500

/** 一行目录文本：章节名 + 行末阿拉伯起始页（缺省为 null）。 */
export interface TocRow {
  name: string
  startPage: number | null
}

/** 目录解析样式：`start-page` 每行数字是起始页；`count` 每行数字就是本章页数。 */
export type TocMode = 'start-page' | 'count'

/** 一章的推导结果：页数以及解析时发现的问题。 */
export interface ChapterRow {
  name: string
  startPage: number | null
  pages: number
  issue: 'missing-start' | 'not-increasing' | null
}

/** computeChapters 的汇总：行结果 + 警告数 + 阻断数 + 总页数字段错误。 */
export interface ChapterSummary {
  rows: ChapterRow[]
  warningCount: number
  blockers: number
  totalPagesError: string | null
}

/** 调用方预生成 key 的扁平节点输入（key 稳定才能在重试时幂等 upsert）。 */
export interface ImportNodeInput {
  key: string
  name: string
  /** 叶子章的行/页数；容器（部）为 null。 */
  pages: number | null
  /** 父节点的 key；顶层（直接挂在里程碑下）为 null。 */
  parentKey: string | null
}

/** 多级目录节点：叶子（章，有 pages）或容器（部，有 children）。 */
export interface TocNode {
  name: string
  /** 叶子章的行/页数（已扣章标题行）；容器为 null。 */
  pages: number | null
  issue: 'missing-count' | null
  children: TocNode[]
}

/** payload 里的扁平节点（树的前序展开），parentId 为 null 表示顶层。 */
export interface BookImportNode {
  id: string
  parentId: string | null
  name: string
  pages: number | null
}

/** 两种落点共用的导入 payload。 */
export interface BookImportPayload {
  bookId: string
  bookName: string
  /** 章节任务的进度单位，默认「页」，可自定义（如「章」「分钟」）。 */
  unit: string
  nodes: BookImportNode[]
}

/** 把单行拆成「章节名 + 行末阿拉伯数字起始页」，拆不出名称时回退为整行无页码。 */
function stripTrailingPage(line: string): { name: string; startPage: number | null } {
  const match = /(\d+)\s*$/.exec(line)
  if (!match) return { name: line, startPage: null }
  const name = line.slice(0, match.index).trim()
  // 整行只有数字（例如 "25"）时无法拆出章节名，回退为整行、无起始页。
  if (name === '') return { name: line, startPage: null }
  return { name, startPage: Number(match[1]) }
}

/**
 * 解析粘贴的目录文本（D-01 / D-04）。
 *
 * 按 CRLF/LF 拆行，trim 后跳过空行；每行用行末阿拉伯数字作为起始页，
 * 其前的部分原样作为章节名（「第N章 / Chapter N / N.」前缀不剥离、不重编号）。
 * 超过 {@link MAX_TOC_LINES} 行后直接丢弃。
 */
export function parseToc(text: string): TocRow[] {
  const rows: TocRow[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (rows.length >= MAX_TOC_LINES) break
    const line = raw.trim()
    if (line === '') continue
    rows.push(stripTrailingPage(line))
  }
  return rows
}

/**
 * 按 D-02 公式推导每章页数并标记问题。
 *
 * - 缺起始页：按 1 页计，标记 missing-start（D-03，警告不阻断）。
 * - 有起始页：页数 = 下一个带起始页章节的起始页 − 本章起始页；末章 = 全书总页数 − 末章起始页 + 1。
 * - 相邻带起始页章节后者 ≤ 前者：后者标记 not-increasing（阻断）。
 * - 末章起始页 > 全书总页数：返回 totalPagesError 阻断。
 * - totalPages 非正整数：totalPagesError = "请填写全书总页数"，末章页数用 0。
 */
export function computeChapters(
  rows: TocRow[],
  totalPages: number,
  mode: TocMode = 'start-page',
): ChapterSummary {
  // count 模式：每行数字直接就是本章页数，不推导、不校验递增、无需总页数。
  if (mode === 'count') {
    const chapterRows: ChapterRow[] = []
    for (const row of rows) {
      if (row.startPage === null) {
        chapterRows.push({ name: row.name, startPage: null, pages: 1, issue: 'missing-start' })
      } else {
        chapterRows.push({ name: row.name, startPage: row.startPage, pages: row.startPage, issue: null })
      }
    }
    const warningCount = chapterRows.filter((r) => r.issue === 'missing-start').length
    return { rows: chapterRows, warningCount, blockers: 0, totalPagesError: null }
  }

  const totalPagesValid = Number.isInteger(totalPages) && totalPages > 0
  let totalPagesError: string | null = totalPagesValid ? null : '请填写末章结束页'

  const chapterRows: ChapterRow[] = []
  let warningCount = 0
  let blockers = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    let pages: number
    let issue: ChapterRow['issue'] = null

    if (row.startPage === null) {
      pages = 1
      issue = 'missing-start'
      warningCount++
    } else {
      // 其后第一个带起始页的行（跳过缺起始页行）。
      let nextStart: number | null = null
      for (let j = i + 1; j < rows.length; j++) {
        if (rows[j].startPage !== null) {
          nextStart = rows[j].startPage
          break
        }
      }

      if (nextStart !== null) {
        pages = nextStart - row.startPage
      } else if (totalPagesValid) {
        pages = totalPages - row.startPage + 1
        if (row.startPage > totalPages) {
          totalPagesError = '末章结束页不能小于最后一章的起始页'
        }
      } else {
        pages = 0
      }

      // 前驱 = 本行之前最近的带起始页行（跳过缺起始页行），问题标记在本行。
      let prevStart: number | null = null
      for (let j = i - 1; j >= 0; j--) {
        if (rows[j].startPage !== null) {
          prevStart = rows[j].startPage
          break
        }
      }
      if (prevStart !== null && row.startPage <= prevStart) {
        issue = 'not-increasing'
        blockers++
      }
    }

    chapterRows.push({ name: row.name, startPage: row.startPage, pages, issue })
  }

  return { rows: chapterRows, warningCount, blockers, totalPagesError }
}

/**
 * 把粘贴的目录解析成多级树（count 模式）。缩进（前导空白，两空格为一层）
 * 决定层级；带行末数字的行是叶子（章），不带数字且有子行的是容器（部）。
 * 不带数字且无子行的行按「缺行数」处理（1 行 + 警告）。subtractHeader 为 true
 * 时每个叶子的行数减 1（扣掉 `# 章标题` 那一行）。
 */
export function parseTocTree(
  text: string,
  opts: { subtractHeader?: boolean } = {},
): TocNode[] {
  const subtract = opts.subtractHeader === true ? 1 : 0

  interface Raw {
    name: string
    count: number | null
    level: number
  }
  const raw: Raw[] = []
  for (const line of text.split(/\r?\n/)) {
    if (raw.length >= MAX_TOC_LINES) break
    if (line.trim() === '') continue
    const level = line.match(/^[ \t]*/)?.[0].length ?? 0
    const { name, startPage } = stripTrailingPage(line.trim())
    raw.push({ name, count: startPage, level })
  }

  // 缩进栈建树：比当前更浅的行成为父节点，更深/同深度的行弹栈。
  const roots: TocNode[] = []
  const stack: { node: TocNode; level: number }[] = []
  for (const row of raw) {
    while (stack.length > 0 && stack[stack.length - 1].level >= row.level) {
      stack.pop()
    }
    const node: TocNode = {
      name: row.name,
      pages: row.count == null ? null : Math.max(0, row.count - subtract),
      issue: null,
      children: [],
    }
    if (stack.length > 0) stack[stack.length - 1].node.children.push(node)
    else roots.push(node)
    stack.push({ node, level: row.level })
  }

  // 定稿：有子行 → 容器（忽略数字）；无子行且无数字 → 缺行数叶子。
  const finalize = (nodes: TocNode[]): void => {
    for (const node of nodes) {
      if (node.children.length > 0) {
        node.pages = null
        node.issue = null
        finalize(node.children)
      } else if (node.pages == null) {
        node.pages = 1
        node.issue = 'missing-count'
      }
    }
  }
  finalize(roots)

  return roots
}

/**
 * 生成两种落点共用的导入 payload。
 *
 * id 由调用方预生成并稳定复用，因此同一 payload 重放等于幂等 upsert
 * （失败重试不会重复建章）。
 */
export function buildImportPayload(
  bookName: string,
  nodes: ImportNodeInput[],
  bookId: string,
  unit = '页',
): BookImportPayload {
  return {
    bookId,
    bookName: bookName.trim(),
    unit: unit.trim() === '' ? '页' : unit.trim(),
    nodes: nodes.map((node) => ({
      id: node.key,
      parentId: node.parentKey,
      name: node.name.trim(),
      pages: node.pages,
    })),
  }
}

/**
 * A live (non-tombstoned) milestone under `goalId` whose name already equals
 * `bookName` (trimmed), excluding `excludeId`. Used to gate a second import of
 * the same book: a duplicate must surface a skip/overwrite/create choice, never
 * silently produce a second structure.
 */
export function findExistingMilestone(
  milestones: readonly {
    id: string
    goal_id: string
    name: string
    deleted_at: string | null
  }[],
  goalId: string,
  bookName: string,
  excludeId?: string | null,
): { id: string } | null {
  const name = bookName.trim()
  const hit = milestones.find(
    (m) =>
      m.goal_id === goalId &&
      m.name === name &&
      m.deleted_at == null &&
      m.id !== (excludeId ?? null),
  )
  return hit ? { id: hit.id } : null
}
