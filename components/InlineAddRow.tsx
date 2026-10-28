'use client'

import { useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'

interface InlineAddRowProps {
  placeholder: string
  ariaLabel: string
  onCreate: (name: string) => Promise<void>
  disabled?: boolean
  /** Renders as `data-add-row={dataAddRow}` on the input so focus-return logic
   *  can resolve a specific add row by selector. Values: "milestones",
   *  "direct", "milestone:<id>". */
  dataAddRow?: string
  /** Failure copy shown below the row when onCreate rejects. */
  errorMessage?: string
}

const INPUT_FOCUS_RING = 'focus:[outline:2px_solid_var(--accent)] focus:[outline-offset:2px]'

const ERROR_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--foreground)',
}

/**
 * The Phase 3 quick-add row (03-UI-SPEC §7): a muted plus glyph + a borderless
 * 17px input. Enter creates (ignoring IME composition), Escape clears/blurs.
 * The owning parent performs the repository write and rejects on failure; this
 * component owns its own local error state and preserves the typed text.
 */
export default function InlineAddRow({
  placeholder,
  ariaLabel,
  onCreate,
  disabled = false,
  dataAddRow,
  errorMessage,
}: InlineAddRowProps) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  async function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      setValue('')
      setError(null)
      inputRef.current?.blur()
      return
    }

    if (event.key !== 'Enter') return
    // Never create a row while an IME composition session is active.
    if (event.nativeEvent.isComposing) return

    event.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return

    try {
      await onCreate(trimmed)
      setValue('')
      setError(null)
      // Keep focus so rapid entry never needs a re-tap.
      inputRef.current?.focus()
    } catch {
      // Preserve the typed text on failure.
      setError(errorMessage ?? '添加失败，请重试。')
    }
  }

  return (
    <div className="flex flex-col" style={{ gap: '4px' }}>
      <div className="flex items-center" style={{ gap: '8px', minHeight: '44px' }}>
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          aria-hidden="true"
          focusable="false"
          style={{ flex: '0 0 auto', color: 'var(--muted)' }}
        >
          <line
            x1="9"
            y1="3"
            x2="9"
            y2="15"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="3"
            y1="9"
            x2="15"
            y2="9"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            if (error) setError(null)
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={ariaLabel}
          maxLength={100}
          data-add-row={dataAddRow}
          className={`${INPUT_FOCUS_RING} placeholder:text-[var(--muted)]`}
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            fontSize: '17px',
            fontWeight: 400,
            lineHeight: 1.47,
            fontFamily: 'inherit',
            color: 'var(--foreground)',
            background: 'transparent',
            border: 'none',
            borderRadius: 0,
            padding: 0,
          }}
        />
      </div>
      {error ? <p style={ERROR_STYLE}>{error}</p> : null}
    </div>
  )
}
