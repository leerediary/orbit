// Pomodoro → iCloud calendar bridge (client side).
//
// The calendar choice is a local, per-device preference (localStorage, not the
// sync DB) and is remembered across sessions. Writing is best-effort: the
// Worker POST is fire-and-forget from the settlement path, so a failure must
// never surface in the UI. Only meaningful when this build was given an API
// origin (isSyncConfigured) — the public mirror ships none.
import { isSyncConfigured } from './api-url'
import { authedFetch } from './auth-client'

/** The five iCloud calendar display names + a dot color for the picker. */
export const POMODORO_CALENDARS = [
  { name: '学习', color: '#EAB308' },
  { name: '工作', color: '#0A84FF' },
  { name: '家政', color: '#BF5AF2' },
  { name: '健身', color: '#30D158' },
  { name: '个人', color: '#D8A47F' },
] as const

export type PomodoroCalendarName = (typeof POMODORO_CALENDARS)[number]['name']

const CALENDAR_STORAGE_KEY = 'orbit_pomodoro_calendar'

/** Storage seam, mirroring lib/auth-storage.ts so Node/prerender stay safe. */
function getStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
  } catch {
    return null
  }
}

export function isCalendarName(value: unknown): value is PomodoroCalendarName {
  return (
    typeof value === 'string' &&
    POMODORO_CALENDARS.some((calendar) => calendar.name === value)
  )
}

/** The remembered calendar choice, or null when unset/corrupt. */
export function loadPomodoroCalendar(): PomodoroCalendarName | null {
  const raw = getStorage()?.getItem(CALENDAR_STORAGE_KEY)
  return isCalendarName(raw) ? raw : null
}

/** Persist (or clear, with null) the remembered calendar choice. */
export function savePomodoroCalendar(name: PomodoroCalendarName | null): void {
  const storage = getStorage()
  if (!storage) return
  if (name === null) storage.removeItem(CALENDAR_STORAGE_KEY)
  else storage.setItem(CALENDAR_STORAGE_KEY, name)
}

export interface CalendarEventPayload {
  sessionId: string
  calendar: PomodoroCalendarName
  title: string
  startIso: string
  endIso: string
  notes: string[]
}

export interface CalendarEventPayloadInput {
  sessionId: string
  calendar: PomodoroCalendarName
  startedAt: string
  durationSec: number
  linkName: string | null
  /** T20: prebuilt title (multi-task settlement, e.g. 白痴-第二部-第八、九章).
   *  Falls back to `🍅 {linkName ?? '专注'}` when omitted. */
  title?: string
  notes: string[]
}

/**
 * Build the calendar-event payload for a settled session. Pure so the
 * settlement hook's title / endIso / notes semantics are unit-testable:
 * endIso = startedAt + durationSec; title = the prebuilt title or
 * `🍅 ${linkName ?? '专注'}`; notes = every note line (settlement lines plus
 * user notes), not just the habit-shared ones.
 */
export function buildCalendarEventPayload(
  input: CalendarEventPayloadInput,
): CalendarEventPayload {
  return {
    sessionId: input.sessionId,
    calendar: input.calendar,
    title: input.title ?? `🍅 ${input.linkName ?? '专注'}`,
    startIso: input.startedAt,
    endIso: new Date(new Date(input.startedAt).getTime() + input.durationSec * 1000).toISOString(),
    notes: input.notes,
  }
}

/**
 * T20: title for a multi-task settlement — the shared milestone/部 prefix once,
 * then the leaf task names joined with 、, e.g. 🍅 白痴-第二部-第八、九章.
 * `chains` = one array per acted task ([milestone?, ...ancestors, taskName]);
 * an empty list yields the plain 🍅 专注. Capped at 200 chars.
 */
export function buildSettlementTitle(chains: string[][]): string {
  if (chains.length === 0) return '🍅 专注'
  const minLen = Math.min(...chains.map((chain) => chain.length))
  const prefix: string[] = []
  for (let i = 0; i < minLen - 1; i++) {
    const value = chains[0][i]
    if (chains.every((chain) => chain[i] === value)) prefix.push(value)
    else break
  }
  const leaves = chains.map((chain) => chain[chain.length - 1])
  const title = `🍅 ${[...prefix, leaves.join('、')].join('-')}`
  return title.length > 200 ? `${title.slice(0, 199)}…` : title
}

export type CalendarWriteResult = 'ok' | 'failed' | 'unavailable'

/**
 * Write a settled pomodoro to the user's iCloud calendar through the Worker.
 * Never throws: 'ok' when the server accepted the write, 'failed' when the
 * write was rejected or the network failed, 'unavailable' when this build has
 * no API origin (public mirror).
 */
export async function createCalendarEvent(
  payload: CalendarEventPayload,
): Promise<CalendarWriteResult> {
  if (!isSyncConfigured) return 'unavailable'
  try {
    const res = await authedFetch('/v1/calendar-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return res.ok ? 'ok' : 'failed'
  } catch {
    return 'failed'
  }
}
