import type { Entity } from '@/lib/repository'
import { getLocalRepository } from '@/lib/repository-provider'
import { EXPORT_ENTITIES, EXPORT_FORMAT, EXPORT_VERSION } from '@/lib/data-export'
import { validateImportRows } from '@/lib/entity-schema'

/**
 * Import a data-portability JSON string into the local repository.
 *
 * Repository-agnostic by design: uses `getLocalRepository()` to reach
 * `replaceAll` (the local-only whole-store primitive). Import is a 整库替换
 * (true restore, D-01): all four tables are cleared and then loaded with the
 * backup's rows verbatim — preserving id, updated_at, deleted_at, and all
 * other fields. Rows created after the backup are discarded; tombstones are
 * kept intact and timestamps are never re-stamped.
 *
 * This function is pure — zero DOM access. A future native SQLite path reuses
 * it unchanged by calling `importData(json)` from Swift via `evaluateJavaScript`.
 *
 * Validation runs BEFORE any write, and the clear + load happens in ONE atomic
 * transaction — so any per-row failure (bad shape) rolls back ALL clears and
 * writes. The store is genuinely untouched on failure.
 */
export async function importData(json: string): Promise<void> {
  // 1. Parse
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('导入失败：文件内容不是有效的 JSON')
  }

  // 2. Validate — all checks before any bulkLoad
  if (parsed == null || typeof parsed !== 'object') {
    throw new Error('导入失败：文件格式不正确（期望一个 JSON 对象）')
  }
  const obj = parsed as Record<string, unknown>

  if (obj.format !== EXPORT_FORMAT) {
    throw new Error(`导入失败：文件格式不匹配（期望 "${EXPORT_FORMAT}"，实际是 "${String(obj.format)}"）`)
  }

  if (typeof obj.version !== 'number') {
    throw new Error('导入失败：缺少版本号')
  }
  // Future compatibility: accept any numeric version we know how to handle.
  // For now we only handle version 1.
  if (obj.version !== EXPORT_VERSION) {
    throw new Error(`导入失败：不支持的版本 ${obj.version}（当前支持版本 ${EXPORT_VERSION}）`)
  }

  const data = obj.data
  if (data == null || typeof data !== 'object') {
    throw new Error('导入失败：缺少 data 字段或格式不正确')
  }

  for (const entity of EXPORT_ENTITIES) {
    const rows = (data as Record<string, unknown>)[entity]
    if (!Array.isArray(rows)) {
      throw new Error(`导入失败：data.${entity} 不是数组`)
    }
    // Per-row shape validation. Dexie's bulkPut accepts any object with an
    // `id` and performs a FULL-record replace, so an id-only row would destroy
    // an existing complete row. Reject malformed rows here, before any write.
    validateImportRows(entity, rows)
  }

  // 3. Replace the whole store in ONE atomic transaction (EXPORT_ENTITIES
  //    order). replaceAll clears all four tables unconditionally, then loads
  //    the backup verbatim (D-01). Atomicity is load-bearing: a per-row failure
  //    (bad shape) rolls back ALL clears and writes, so the store is never left
  //    half-wiped.
  const entries = EXPORT_ENTITIES.map(
    (entity) => [entity as Entity, (data as Record<string, unknown[]>)[entity]] as const,
  )
  await getLocalRepository().replaceAll(entries)
}
