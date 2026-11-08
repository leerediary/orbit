'use client'

import type { CSSProperties } from 'react'
import type { Category } from '@/lib/types'

interface CategoryCardProps {
  category: Category
  onRestore?: (category: Category) => void
}

const FOCUS_RING_INSET =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:-2px]'

const RESTORE_BUTTON_STYLE: CSSProperties = {
  flex: '0 0 auto',
  height: '44px',
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

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

/**
 * Name → date, in that exact order. Shared shape with the archived GoalCard so
 * the type scale can never drift; the description block is gone because
 * Category has no description.
 */
function CardBody({ category }: { category: Category }) {
  return (
    <span
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        minWidth: 0,
        textAlign: 'left',
      }}
    >
      <span
        style={{
          fontSize: '17px',
          fontWeight: 600,
          lineHeight: 1.47,
          color: 'var(--foreground)',
          overflowWrap: 'anywhere',
        }}
      >
        {category.name}
      </span>
      <span
        style={{
          fontSize: '13px',
          fontWeight: 400,
          lineHeight: 1.4,
          color: 'var(--muted)',
        }}
      >
        {formatDate(category.created_at)}
      </span>
    </span>
  )
}

/**
 * An archived category row (07-UI-SPEC "Home — archived categories"). The main
 * region is static and the only action is 恢复 — categories have no detail view.
 */
export default function CategoryCard({ category, onRestore }: CategoryCardProps) {
  return (
    <li
      data-category-card
      data-category-id={category.id}
      className="flex"
      style={{
        position: 'relative',
        gap: '8px',
        alignItems: 'flex-start',
        padding: '16px',
        minWidth: 0,
        background: 'var(--card)',
        borderRadius: '12px',
        boxShadow: 'var(--card-shadow)',
      }}
    >
      <div data-category-main data-category-id={category.id} style={{ flex: '1 1 auto', minWidth: 0 }}>
        <CardBody category={category} />
      </div>
      <button
        type="button"
        onClick={() => onRestore?.(category)}
        className={`${FOCUS_RING_INSET} accent-button`}
        style={RESTORE_BUTTON_STYLE}
      >
        恢复
      </button>
    </li>
  )
}
