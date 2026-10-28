import type { Entity } from '@/lib/repository'

/**
 * Single source of truth for the shape of every synchronized entity.
 *
 * Two consumers:
 *  - `importData()` uses it to validate every incoming row BEFORE any write, so
 *    a malformed export can never overwrite good rows with partial ones.
 *  - `SqliteLocalRepository` uses `ENTITY_COLUMNS` as a strict allowlist before
 *    interpolating column names into SQL (values are always parameterized).
 *
 * Keep this aligned with lib/types.ts — a drift here is a data-loss bug, not a
 * cosmetic one.
 */

type ColumnKind = 'string' | 'nullableString' | 'timestamp' | 'boolean' | 'nullableTimestamp' | 'number'

const SHAPES: Record<Entity, Readonly<Record<string, ColumnKind>>> = {
  goals: {
    id: 'string',
    name: 'string',
    description: 'string',
    created_at: 'timestamp',
    sort_order: 'number',
    updated_at: 'timestamp',
    deleted_at: 'nullableTimestamp',
  },
  milestones: {
    id: 'string',
    goal_id: 'string',
    name: 'string',
    completed: 'boolean',
    completed_at: 'nullableTimestamp',
    created_at: 'timestamp',
    sort_order: 'number',
    updated_at: 'timestamp',
    deleted_at: 'nullableTimestamp',
  },
  tasks: {
    id: 'string',
    goal_id: 'string',
    milestone_id: 'nullableString',
    name: 'string',
    completed: 'boolean',
    completed_at: 'nullableTimestamp',
    created_at: 'timestamp',
    sort_order: 'number',
    updated_at: 'timestamp',
    deleted_at: 'nullableTimestamp',
  },
  reviews: {
    id: 'string',
    goal_id: 'string',
    content: 'string',
    created_at: 'timestamp',
    updated_at: 'timestamp',
    deleted_at: 'nullableTimestamp',
  },
}

/** Column allowlist per entity — the only keys allowed to reach SQL. */
export const ENTITY_COLUMNS: Record<Entity, readonly string[]> = {
  goals: Object.keys(SHAPES.goals),
  milestones: Object.keys(SHAPES.milestones),
  tasks: Object.keys(SHAPES.tasks),
  reviews: Object.keys(SHAPES.reviews),
}

// Identity / foreign-key columns that must not be empty strings.
const NON_EMPTY: Record<Entity, readonly string[]> = {
  goals: ['id'],
  milestones: ['id', 'goal_id'],
  tasks: ['id', 'goal_id'],
  reviews: ['id', 'goal_id'],
}

// Columns that may be absent on legacy rows (a present value is still
// validated). `sort_order` arrived in Phase 2; pre-Phase-2 goals legitimately
// lack it and the UI's effectiveOrder() already falls back to created_at.
const OPTIONAL: Record<Entity, readonly string[]> = {
  goals: ['sort_order'],
  milestones: ['sort_order'],
  tasks: ['sort_order'],
  reviews: [],
}

function fail(message: string): never {
  throw new Error(`导入失败：${message}`)
}

/**
 * Validate one import row against its entity shape. Throws on the first
 * problem; returns nothing (the row is only ever read, never transformed).
 *
 * Rejected: non-objects, missing keys, unknown keys, wrong primitive types,
 * non-ISO timestamps, and empty identity columns. Timestamps are re-parsed so
 * the lexicographic `sinceUpdatedAt` comparison in list() stays meaningful.
 */
export function validateImportRow(entity: Entity, row: unknown, index: number): void {
  const where = `data.${entity}[${index}]`
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    fail(`${where} 不是对象`)
  }
  const r = row as Record<string, unknown>
  const shape = SHAPES[entity]

  // OWN-property allowlist: `in` would also accept prototype-named keys
  // (__proto__/constructor/toString) because they exist on Object.prototype.
  for (const key of Object.keys(r)) {
    if (!Object.hasOwn(shape, key)) fail(`${where} 含未知字段 "${key}"`)
  }

  for (const key of Object.keys(shape)) {
    if (!Object.hasOwn(r, key)) {
      if (OPTIONAL[entity].includes(key)) continue
      fail(`${where} 缺少字段 "${key}"`)
    }
    const value = r[key]
    switch (shape[key]) {
      case 'string':
        if (typeof value !== 'string') fail(`${where}.${key} 必须是字符串`)
        break
      case 'nullableString':
        if (value !== null && typeof value !== 'string') {
          fail(`${where}.${key} 必须是 null 或字符串`)
        }
        break
      case 'timestamp':
        if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
          fail(`${where}.${key} 必须是有效的 ISO 时间戳`)
        }
        break
      case 'boolean':
        if (typeof value !== 'boolean') fail(`${where}.${key} 必须是布尔值`)
        break
      case 'nullableTimestamp':
        if (value !== null && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) {
          fail(`${where}.${key} 必须是 null 或有效的 ISO 时间戳`)
        }
        break
      case 'number':
        // Rejects strings, NaN, and Infinity — sort_order must be a finite
        // number so ordering comparisons stay meaningful.
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          fail(`${where}.${key} 必须是数字`)
        }
        break
    }
  }

  for (const key of NON_EMPTY[entity]) {
    if (r[key] === '') fail(`${where}.${key} 不能为空`)
  }
}

/** Validate every row of one entity. Throws on the first bad row. */
export function validateImportRows(entity: Entity, rows: readonly unknown[]): void {
  rows.forEach((row, index) => validateImportRow(entity, row, index))
}
