// Client-side calendar bridge: locked five-name allow-list, localStorage
// persistence, and the createCalendarEvent POST (payload + bearer auth).
// Node env — fetch and localStorage are mocked per test; modules are re-imported
// after vi.resetModules() so API_URL/isSyncConfigured re-evaluate cleanly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSettlementTitle } from '@/lib/calendar'

class MemoryStorage implements Storage {
  private data = new Map<string, string>()

  get length(): number {
    return this.data.size
  }

  clear(): void {
    this.data.clear()
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value))
  }
}

const ORIGINAL_LOCALSTORAGE = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const ORIGINAL_FETCH = Object.getOwnPropertyDescriptor(globalThis, 'fetch')

function installStorage(): MemoryStorage {
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
  return storage
}

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init)),
  )
  Object.defineProperty(globalThis, 'fetch', {
    value: mock,
    configurable: true,
    writable: true,
  })
  return mock
}

function restore(desc: PropertyDescriptor | undefined, key: string) {
  if (desc) Object.defineProperty(globalThis, key, desc)
  else delete (globalThis as { [k: string]: unknown })[key]
}

const SESSION = {
  email: 'me@example.com',
  deviceId: 'device-1',
  deviceName: 'Mac',
  accessToken: 'access-1',
  accessExpiresAt: 2_000_000_000_000,
  refreshToken: 'refresh-1',
  refreshExpiresAt: 2_000_000_000_000,
}

beforeEach(() => {
  vi.resetModules()
  installStorage()
})

afterEach(() => {
  restore(ORIGINAL_LOCALSTORAGE, 'localStorage')
  restore(ORIGINAL_FETCH, 'fetch')
  delete process.env.NEXT_PUBLIC_API_URL
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('POMODORO_CALENDARS + isCalendarName', () => {
  it('locks exactly the five names, each with a color', async () => {
    const { POMODORO_CALENDARS, isCalendarName } = await import('../lib/calendar')
    expect(POMODORO_CALENDARS.map((c) => c.name)).toEqual([
      '学习',
      '工作',
      '家政',
      '健身',
      '个人',
    ])
    for (const calendar of POMODORO_CALENDARS) {
      expect(calendar.color).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
    expect(
      Object.fromEntries(POMODORO_CALENDARS.map((c) => [c.name, c.color])),
    ).toEqual({
      学习: '#EAB308',
      工作: '#0A84FF',
      家政: '#BF5AF2',
      健身: '#30D158',
      个人: '#D8A47F',
    })
    expect(isCalendarName('学习')).toBe(true)
    expect(isCalendarName('购物')).toBe(false)
    expect(isCalendarName('')).toBe(false)
    expect(isCalendarName(null)).toBe(false)
    expect(isCalendarName(1)).toBe(false)
  })
})

describe('persistence', () => {
  it('round-trips a valid choice and clears on null', async () => {
    const { loadPomodoroCalendar, savePomodoroCalendar } = await import('../lib/calendar')
    expect(loadPomodoroCalendar()).toBeNull()
    savePomodoroCalendar('工作')
    expect(loadPomodoroCalendar()).toBe('工作')
    savePomodoroCalendar(null)
    expect(loadPomodoroCalendar()).toBeNull()
  })

  it('discards a stored value outside the allow-list', async () => {
    const { loadPomodoroCalendar } = await import('../lib/calendar')
    localStorage.setItem('orbit_pomodoro_calendar', '购物')
    expect(loadPomodoroCalendar()).toBeNull()
  })
})

describe('buildCalendarEventPayload', () => {
  it('computes endIso = startedAt + durationSec, title fallback, and keeps all notes', async () => {
    const { buildCalendarEventPayload } = await import('../lib/calendar')
    const base = {
      sessionId: 'abc',
      calendar: '学习' as const,
      startedAt: '2026-11-05T08:30:00.000Z',
      durationSec: 1500,
      notes: ['a', 'b'],
    }

    const unlinked = buildCalendarEventPayload({ ...base, linkName: null })
    expect(unlinked.startIso).toBe('2026-11-05T08:30:00.000Z')
    expect(unlinked.endIso).toBe('2026-11-05T08:55:00.000Z') // +1500s
    expect(unlinked.title).toBe('🍅 专注')
    expect(unlinked.notes).toEqual(['a', 'b'])

    const linked = buildCalendarEventPayload({ ...base, linkName: '读一章' })
    expect(linked.title).toBe('🍅 读一章')
  })
})

describe('createCalendarEvent', () => {
  it('is a no-op (false) when the build has no API origin', async () => {
    delete process.env.NEXT_PUBLIC_API_URL
    const fetchMock = installFetch(async () => new Response(null, { status: 201 }))
    const { createCalendarEvent } = await import('../lib/calendar')
    const result = await createCalendarEvent({
      sessionId: 'abc',
      calendar: '学习',
      title: '🍅 专注',
      startIso: '2026-11-05T08:30:00.000Z',
      endIso: '2026-11-05T08:55:00.000Z',
      notes: [],
    })
    expect(result).toBe('unavailable')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs the payload with a bearer token when configured', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://orbit.test'
    vi.resetModules()
    const { writeSession } = await import('../lib/auth-storage')
    writeSession(SESSION)
    const fetchMock = installFetch(async () => new Response(null, { status: 201 }))
    const { createCalendarEvent } = await import('../lib/calendar')

    const payload = {
      sessionId: 'abc',
      calendar: '学习' as const,
      title: '🍅 专注',
      startIso: '2026-11-05T08:30:00.000Z',
      endIso: '2026-11-05T08:55:00.000Z',
      notes: ['a', 'b'],
    }

    const result = await createCalendarEvent(payload)
    expect(result).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://orbit.test/v1/calendar-events')
    expect(init.method).toBe('POST')
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer access-1')
    expect(JSON.parse(init.body as string)).toEqual(payload)
  })

  it("returns 'failed' when the Worker rejects the write", async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://orbit.test'
    vi.resetModules()
    const { writeSession } = await import('../lib/auth-storage')
    writeSession(SESSION)
    installFetch(async () => new Response(null, { status: 502 }))
    const { createCalendarEvent } = await import('../lib/calendar')
    const result = await createCalendarEvent({
      sessionId: 'abc',
      calendar: '学习' as const,
      title: '🍅 专注',
      startIso: '2026-11-05T08:30:00.000Z',
      endIso: '2026-11-05T08:55:00.000Z',
      notes: [],
    })
    expect(result).toBe('failed')
  })

  it("returns 'failed' when the network throws", async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://orbit.test'
    vi.resetModules()
    const { writeSession } = await import('../lib/auth-storage')
    writeSession(SESSION)
    installFetch(async () => {
      throw new Error('network down')
    })
    const { createCalendarEvent } = await import('../lib/calendar')
    const result = await createCalendarEvent({
      sessionId: 'abc',
      calendar: '学习' as const,
      title: '🍅 专注',
      startIso: '2026-11-05T08:30:00.000Z',
      endIso: '2026-11-05T08:55:00.000Z',
      notes: [],
    })
    expect(result).toBe('failed')
  })
})

describe('buildSettlementTitle (T20)', () => {
  it('joins a shared milestone/部 prefix once, then the leaf names with 、', () => {
    expect(
      buildSettlementTitle([
        ['白痴', '第二部', '八'],
        ['白痴', '第二部', '九'],
      ]),
    ).toBe('🍅 白痴-第二部-八、九')
  })

  it('shortens the prefix when the chains diverge', () => {
    expect(
      buildSettlementTitle([
        ['白痴', '第二部', '八'],
        ['白痴', '第三部', '一'],
      ]),
    ).toBe('🍅 白痴-八、一')
  })

  it('falls back to plain 专注 with no chains', () => {
    expect(buildSettlementTitle([])).toBe('🍅 专注')
  })

  it('caps the title at 200 characters', () => {
    const chains = Array.from({ length: 40 }, (_, i) => ['很长的书名前缀', `${i}`.padStart(3, '0')])
    expect(buildSettlementTitle(chains).length).toBeLessThanOrEqual(200)
  })
})
