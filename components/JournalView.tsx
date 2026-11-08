'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, CompositionEvent, CSSProperties } from 'react'
import { getRepository } from '@/lib/repository-provider'
import { formatSavedTime, shiftDayKey } from '@/lib/journal'
import { getTodayStr } from '@/lib/today'
import { shouldDeferSyncReload, useSyncRefresh } from '@/lib/sync-state'
import type { JournalEntry } from '@/lib/types'
import JournalDateNav from '@/components/JournalDateNav'

const LOAD_ERROR = '日记加载失败。请重新加载；如果仍然失败，刷新页面后再试。'

const HERO_TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '48px',
  fontWeight: 600,
  lineHeight: 1.05,
  letterSpacing: '-0.02em',
  color: 'var(--foreground)',
}

// Section heading when the journal is embedded at the bottom of 今日 (not a
// standalone tab): a 20px title instead of the 48px hero.
const EMBEDDED_HEADING_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '20px',
  fontWeight: 600,
  lineHeight: 1.2,
  letterSpacing: '-0.01em',
  color: 'var(--foreground)',
}

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

const FOCUS_RING_OUTSET =
  'focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]'

const CARD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '16px',
  background: 'var(--card)',
  borderRadius: '12px',
  boxShadow: 'var(--card-shadow)',
  minWidth: 0,
  minHeight: '320px',
}

const STATUS_ROW_STYLE: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'center',
  gap: '8px',
  minHeight: '20px',
}

const STATUS_TEXT_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
  fontVariantNumeric: 'tabular-nums',
}

const STATUS_ERROR_STYLE: CSSProperties = {
  ...STATUS_TEXT_STYLE,
  color: 'var(--foreground)',
}

const RETRY_BUTTON_STYLE: CSSProperties = {
  minHeight: '44px',
  padding: '0 4px',
  background: 'none',
  border: 'none',
  color: 'var(--accent)',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  fontFamily: 'inherit',
  cursor: 'pointer',
}

// Phase 19 / D-02 — read-only conflict-copy disclosure. A native <details>
// keeps this a viewer: no buttons, no selection, no new accent, no shadow.
const CONFLICT_SUMMARY_STYLE: CSSProperties = {
  cursor: 'pointer',
  fontSize: '13px',
  fontWeight: 400,
  lineHeight: 1.4,
  color: 'var(--muted)',
}

const CONFLICT_BODY_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.47,
  color: 'var(--foreground)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}

const DEBOUNCE_MS = 600

const TEXTAREA_STYLE: CSSProperties = {
  width: '100%',
  minWidth: 0,
  minHeight: '320px',
  margin: 0,
  padding: 0,
  background: 'transparent',
  border: 'none',
  resize: 'none',
  overflow: 'hidden',
  fontSize: '17px',
  fontWeight: 400,
  lineHeight: 1.6,
  fontFamily: 'inherit',
  color: 'var(--foreground)',
  overflowWrap: 'anywhere',
}

const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

function clampDay(day: string, today: string): string {
  // Lexicographic comparison is valid for YYYY-MM-DD. Future days clamp to today.
  return day > today ? today : day
}

/**
 * 日记 view (Phase 10, JOURNAL-01..03; 10-UI-SPEC).
 *
 * A single writing surface per logical local day. All rows load once on mount
 * into a `Map<day_key, JournalEntry>`; day switches are map lookups (one row/day,
 * ≈365/year). `contentByDayRef` is the authoritative per-day content cache: it is
 * seeded from every live row on load and updated on every successful save, so a
 * return visit in the same session shows the just-saved text instead of the
 * mount-time snapshot.
 *
 * All repository and `getTodayStr()` access stays inside effects/handlers — the
 * Node prerender pass has no IndexedDB and no localStorage under
 * `output: 'export'`.
 */
export default function JournalView({ embedded = false }: { embedded?: boolean }) {
  const [entries, setEntries] = useState<Map<string, JournalEntry> | null>(null)
  const [day, setDay] = useState<string | null>(null)
  const [today, setToday] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [dayLoading, setDayLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [savedAt, setSavedAt] = useState('')

  const alive = useRef(false)
  // Authoritative per-day content cache, seeded from every loaded live row and
  // updated on every successful save. Survives in-session day switches.
  const contentByDayRef = useRef<Map<string, string>>(new Map())
  const lastSavedRef = useRef<Map<string, string>>(new Map())
  const idByDayRef = useRef<Map<string, string>>(new Map())
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // Captured at keystroke time so the debounce timer never reads React state
  // (a stale closure would write the old text to the new day — Pitfall 1).
  const pendingRef = useRef<{ day: string; content: string } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Serializes writes so an older save can never land after a newer one.
  const chainRef = useRef<Promise<void>>(Promise.resolve())
  const composingRef = useRef(false)
  const failedRef = useRef<{ day: string; content: string } | null>(null)

  async function load(opts: { preserveDay?: boolean } = {}) {
    try {
      const repo = getRepository()
      const rows = await repo.list<JournalEntry>('journalEntries')
      if (!alive.current) return

      const map = new Map<string, JournalEntry>()
      for (const row of rows) {
        // The repository already excludes tombstones; filter defensively to
        // mirror the other views.
        if (row.deleted_at != null) continue
        map.set(row.day_key, row)
        contentByDayRef.current.set(row.day_key, row.content)
        lastSavedRef.current.set(row.day_key, row.content)
        idByDayRef.current.set(row.day_key, row.id)
      }

      const todayKey = getTodayStr()
      // A remote reload must never jump the selected day back to today (W2):
      // preserve the currently open day, clamped to today.
      const initialDay =
        opts.preserveDay && day !== null ? clampDay(day, todayKey) : todayKey
      const row = map.get(initialDay)

      setEntries(map)
      setToday(todayKey)
      setDay(initialDay)
      // Reseed from the fetched rows so an allowed remote reload shows the
      // latest server content for the preserved day.
      setContent(contentByDayRef.current.get(initialDay) ?? '')
      setStatus(row ? 'saved' : 'idle')
      setSavedAt(row ? formatSavedTime(row.updated_at) : '')
      setLoadError(false)
      setLoading(false)
    } catch {
      if (!alive.current) return
      setLoadError(true)
      setLoading(false)
    }
  }

  useEffect(() => {
    alive.current = true
    void load()
    // Day rollover while the view stays open: recompute "today" on focus /
    // visibility (Phase 9 pattern). The SELECTED day stays put so a user
    // mid-sentence at midnight is not moved.
    const refreshToday = () => setToday(getTodayStr())
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

  // D-05 / B2 + W2: reload when remote rows land, but NEVER while a draft is
  // pending/failed or a save is in flight, and preserve the selected day.
  useSyncRefresh(() => {
    if (
      shouldDeferSyncReload({
        pending: pendingRef.current !== null,
        failed: failedRef.current !== null,
        status,
      })
    ) {
      return
    }
    void load({ preserveDay: true })
  })

  // Seed the id map for every loaded row so lifecycle flushes resolve an id
  // from refs alone (the mount-time `entries` snapshot may be stale/null in the
  // first-render closure used by the lifecycle listeners).
  useEffect(() => {
    if (!entries) return
    for (const [key, row] of entries) {
      if (!idByDayRef.current.has(key)) idByDayRef.current.set(key, row.id)
    }
  }, [entries])

  // Lifecycle flush. The callbacks read only refs (pendingRef / idByDayRef /
  // lastSavedRef / contentByDayRef), so the captured-null first-render closure
  // cannot write to `journal-null` or the wrong day (Pitfall 1/9/10).
  useEffect(() => {
    const flushOnHide = () => {
      if (document.hidden) void flushSave()
    }
    const flushOnPageHide = () => {
      void flushSave()
    }
    document.addEventListener('visibilitychange', flushOnHide)
    window.addEventListener('pagehide', flushOnPageHide)
    return () => {
      document.removeEventListener('visibilitychange', flushOnHide)
      window.removeEventListener('pagehide', flushOnPageHide)
      void flushSave()
    }
    // Refs-only; flushSave's stable setters make the first-render closure safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Resolve the visible content for the selected day. Depends on [day] ONLY —
  // a background save on another day must never clobber live typing. The cache
  // is read BEFORE the mount-time snapshot so an in-session save wins.
  useEffect(() => {
    if (day === null) return
    setDayLoading(true)

    const row = entries?.get(day)
    const cache = contentByDayRef.current
    let resolved = cache.get(day)
    if (resolved === undefined) {
      resolved = row?.content ?? ''
      cache.set(day, resolved)
    }
    if (row) {
      if (!lastSavedRef.current.has(day)) lastSavedRef.current.set(day, row.content)
      if (!idByDayRef.current.has(day)) idByDayRef.current.set(day, row.id)
    }

    setContent(resolved)
    setStatus(row ? 'saved' : 'idle')
    setSavedAt(row ? formatSavedTime(row.updated_at) : '')
    setDayLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day])

  // Auto-grow: the page scrolls; the textarea never shows an inner scrollbar.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [content, dayLoading])

  // Schedule a debounced write. The payload is captured at keystroke time; the
  // timer never reads React state.
  function schedule(targetDay: string, nextContent: string) {
    pendingRef.current = { day: targetDay, content: nextContent }
    setStatus('saving')
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void flushSave()
    }, DEBOUNCE_MS)
  }

  // Flush the pending draft immediately. Derives the id and day ONLY from
  // `pending`, never from render `day`/`content`, and serializes writes so an
  // older write can never land after a newer one.
  async function flushSave(): Promise<void> {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null

    // Unchanged content: keep the last saved status, skip the write.
    if (lastSavedRef.current.get(pending.day) === pending.content) {
      setStatus('saved')
      return
    }

    chainRef.current = chainRef.current
      .then(async () => {
        // Never let upsert generate a fresh UUID for a new journal row (it
        // returns void, so a new id per save would hit the &day_key unique
        // index). Reuse the loaded row id, else a deterministic day id.
        const id =
          idByDayRef.current.get(pending.day) ??
          entries?.get(pending.day)?.id ??
          `journal-${pending.day}`
        await getRepository().upsert<JournalEntry>('journalEntries', {
          id,
          day_key: pending.day,
          content: pending.content,
        })
        const savedIso = new Date().toISOString()
        idByDayRef.current.set(pending.day, id)
        lastSavedRef.current.set(pending.day, pending.content)
        contentByDayRef.current.set(pending.day, pending.content)
        // Merge the saved row into `entries` so a return visit in this session
        // resolves the fresh text, not the mount-time snapshot.
        setEntries((previous) => {
          const next = new Map(previous ?? new Map<string, JournalEntry>())
          const existing = next.get(pending.day)
          // Phase 19 / landmine 5: spread `...existing` first so fields the
          // save payload does not carry — notably `conflict_copies` — survive
          // an in-session save until the next reload.
          next.set(pending.day, {
            ...(existing ?? {}),
            id,
            day_key: pending.day,
            content: pending.content,
            updated_at: savedIso,
            deleted_at: existing?.deleted_at ?? null,
          })
          return next
        })
        failedRef.current = null
        setSavedAt(formatSavedTime(savedIso))
        // If a newer keystroke is already queued, keep 保存中… (that newer
        // payload will set the final status); otherwise show the saved time.
        if (pendingRef.current === null) setStatus('saved')
      })
      .catch(() => {
        // Keep the draft (the textarea still holds it); surface the retry.
        failedRef.current = pending
        setStatus('error')
      })

    await chainRef.current
  }

  function retrySave() {
    if (!failedRef.current) return
    pendingRef.current = failedRef.current
    setStatus('saving')
    void flushSave()
  }

  async function goToDay(nextRaw: string) {
    if (day === null || today === null) return
    const next = clampDay(nextRaw, today)
    if (next === day) return
    // Clear the visible text BEFORE switching so the previous day's text can
    // never render under the new day's label; show 正在加载… meanwhile.
    setDayLoading(true)
    setContent('')
    await flushSave()
    setDay(next)
  }

  function goPrev() {
    if (day === null) return
    void goToDay(shiftDayKey(day, -1))
  }

  function goNext() {
    if (day === null || today === null) return
    const next = shiftDayKey(day, 1)
    if (next > today) return
    void goToDay(next)
  }

  function changeDay(next: string) {
    void goToDay(next)
  }

  function retryLoad() {
    setLoadError(false)
    setLoading(true)
    setEntries(null)
    void load()
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value
    setContent(value)
    // Never persist a partial IME composition; compositionend schedules.
    if (composingRef.current) return
    if (day !== null) schedule(day, value)
  }

  function handleCompositionStart() {
    composingRef.current = true
  }

  function handleCompositionEnd(
    event: CompositionEvent<HTMLTextAreaElement>,
  ) {
    composingRef.current = false
    if (day !== null) schedule(day, event.currentTarget.value)
  }

  function handleBlur() {
    void flushSave()
  }

  const placeholder =
    day !== null && today !== null && day === today
      ? '写下今天发生的事情…'
      : '写下这一天的记录…'

  // Phase 19 / D-02: bodies superseded by a journal merge, shown read-only.
  const conflictCopies = day !== null ? (entries?.get(day)?.conflict_copies ?? []) : []

  return (
    <div className="flex flex-col" style={{ gap: '24px' }}>
      <header
        className="flex flex-col"
        style={{ gap: '16px', marginBottom: '24px' }}
      >
        <h1 style={embedded ? EMBEDDED_HEADING_STYLE : HERO_TITLE_STYLE}>日记</h1>
        {day !== null && today !== null ? (
          <JournalDateNav
            day={day}
            today={today}
            onPrev={goPrev}
            onNext={goNext}
            onDayChange={changeDay}
          />
        ) : null}
      </header>

      {loadError ? (
        <div className="flex flex-col" style={{ gap: '8px' }}>
          <p style={ERROR_STYLE}>{LOAD_ERROR}</p>
          <button
            type="button"
            onClick={retryLoad}
            className={`self-start ${FOCUS_RING_OUTSET} accent-button`}
            style={ACCENT_TEXT_BUTTON_STYLE}
          >
            重新加载日记
          </button>
        </div>
      ) : (
        <div className="flex flex-col" style={CARD_STYLE}>
          <div aria-live="polite" style={STATUS_ROW_STYLE}>
            {status === 'saving' ? (
              <span style={STATUS_TEXT_STYLE}>保存中…</span>
            ) : status === 'saved' ? (
              <span style={STATUS_TEXT_STYLE}>
                {savedAt ? `已保存 ${savedAt}` : '已保存'}
              </span>
            ) : status === 'error' ? (
              <>
                <span style={STATUS_ERROR_STYLE}>保存失败，请重试。</span>
                <button
                  type="button"
                  onClick={retrySave}
                  className={`${FOCUS_RING_OUTSET} accent-button`}
                  style={RETRY_BUTTON_STYLE}
                >
                  重试保存
                </button>
              </>
            ) : null}
          </div>
          {loading ? (
            <p style={LOADING_STYLE}>正在加载日记…</p>
          ) : dayLoading || day === null || today === null ? (
            <p style={LOADING_STYLE}>正在加载…</p>
          ) : (
            <>
              <label htmlFor="journal-content" style={VISUALLY_HIDDEN}>
                日记内容
              </label>
              <textarea
                id="journal-content"
                ref={textareaRef}
                value={content}
                onChange={handleChange}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                onBlur={handleBlur}
                placeholder={placeholder}
                className={`${FOCUS_RING_OUTSET} placeholder:text-[var(--muted)]`}
                style={TEXTAREA_STYLE}
              />
              {conflictCopies.length > 0 ? (
                <details>
                  <summary style={CONFLICT_SUMMARY_STYLE}>
                    冲突副本 ({conflictCopies.length})
                  </summary>
                  <div
                    className="flex flex-col"
                    style={{ gap: '8px', marginTop: '8px' }}
                  >
                    {conflictCopies.map((copy, index) => (
                      <div
                        key={`${copy.at}-${index}`}
                        className="flex flex-col"
                        style={{ gap: '4px' }}
                      >
                        <p style={STATUS_TEXT_STYLE}>{formatSavedTime(copy.at)}</p>
                        <p style={CONFLICT_BODY_STYLE}>{copy.content}</p>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  )
}
