// lib/sqlite-bridge.ts — TypeScript contract for the Swift-injected window.orbitBridge
//
// INVARIANT: this module is tree-shaken from web builds — it is only imported by
// lib/sqlite-repository.ts, which in turn is only instantiated by
// lib/repository-provider.ts when `window.orbitBridge` is present at runtime
// (i.e. inside a future native WKWebView shell). `getBridge()` MUST NEVER be
// called during Next.js prerender: the Node prerender pass has no `window`, and
// the constructor of SqliteLocalRepository deliberately does NOT touch the
// bridge — every bridge access happens inside a method that is reached only from
// a client effect/handler, after the native shell has injected
// `window.orbitBridge` via an `atDocumentStart` WKUserScript.
//
// Runtime presence of `window.orbitBridge` is the SINGLE source of truth for the
// native-vs-web branch (D-03 — see repository-provider.ts). No build-time
// env-detection branch is used; the native shell injection is the only signal.

export interface OrbitBridge {
  execute(sql: string, params: unknown[]): Promise<void>
  query<T>(sql: string, params: unknown[]): Promise<T[]>
}

declare global {
  interface Window {
    orbitBridge?: OrbitBridge
  }
}

export function getBridge(): OrbitBridge {
  if (typeof window === 'undefined' || !window.orbitBridge) {
    throw new Error('[SqliteRepository] orbitBridge not available — not running in native shell')
  }
  return window.orbitBridge
}
