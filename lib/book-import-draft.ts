/**
 * Session-scoped draft store for the book TOC import sheet (feedback 2026-11-01).
 *
 * BookImportSheet is unmounted on backdrop-click / Escape close, so its
 * multi-field draft lives here in memory (keyed by entry mode) instead of inside
 * the component. A successful import clears it so reopening starts fresh.
 */
export interface BookImportDraftNode {
  key: string
  name: string
  /** Editable count/start-page string; empty for a container (部). */
  startPage: string
  children: BookImportDraftNode[]
}

export interface BookImportDraft {
  step: 'paste' | 'review'
  bookName: string
  totalPagesText: string
  unit: string
  parseMode: 'start-page' | 'count'
  tocText: string
  rows: BookImportDraftNode[]
}

export const bookImportDrafts: Record<'goal' | 'milestone', BookImportDraft | null> = {
  goal: null,
  milestone: null,
}
