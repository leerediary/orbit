import { describe, expect, it } from 'vitest'
import { deriveDeviceName } from '../lib/device-name'

/**
 * D-D locks the five device labels and their priority order. Electron's
 * renderer UA contains both `Electron/` and `Macintosh`, so ordering matters:
 * it must win over the plain Macintosh check.
 */

const ELECTRON_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Orbit/1.0 Chrome/130.0.0.0 Electron/45.2.1 Safari/537.36'
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const IPAD =
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

describe('deriveDeviceName', () => {
  it('maps the Electron renderer on macOS to Mac（桌面）', () => {
    expect(deriveDeviceName(ELECTRON_MAC)).toBe('Mac（桌面）')
  })

  it('maps iPhone', () => {
    expect(deriveDeviceName(IPHONE)).toBe('iPhone')
  })

  it('maps iPad', () => {
    expect(deriveDeviceName(IPAD)).toBe('iPad')
  })

  it('maps plain Macintosh to Mac', () => {
    expect(deriveDeviceName(MAC_SAFARI)).toBe('Mac')
  })

  it('maps anything else, including an empty string, to 浏览器', () => {
    expect(deriveDeviceName(WINDOWS_CHROME)).toBe('浏览器')
    expect(deriveDeviceName('')).toBe('浏览器')
  })

  it('falls back to 浏览器 for Electron on a non-Mac host', () => {
    expect(
      deriveDeviceName(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Electron/45.2.1 Safari/537.36',
      ),
    ).toBe('浏览器')
  })
})
