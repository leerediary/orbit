/**
 * Pure user-agent to device-name mapping (D-D). Checked in order: the Electron
 * renderer on macOS matches both `Electron/` and `Macintosh`, so it must win
 * over the plain Mac check.
 */
export function deriveDeviceName(userAgent: string): string {
  if (/Electron\//.test(userAgent) && /Macintosh/.test(userAgent)) return 'Mac（桌面）'
  if (/iPhone/.test(userAgent)) return 'iPhone'
  if (/iPad/.test(userAgent)) return 'iPad'
  if (/Macintosh/.test(userAgent)) return 'Mac'
  return '浏览器'
}
