import type { MetadataRoute } from 'next'

// Special Route Handler. Next 16.2.6 requires the manifest route to explicitly
// opt into static rendering under output:'export' (the build fails asking for
// this exact directive). No request-time API is used, so force-static is safe
// and emits a static out/manifest.webmanifest.
export const dynamic = 'force-static'

// D-05: Orbit is the display name everywhere — manifest, layout title, icons.
// Subpath-capable: NEXT_PUBLIC_BASE_PATH prefixes start_url/scope/icons
// (empty = root deploy, e.g. local/private builds).
export default function manifest(): MetadataRoute.Manifest {
  const base = process.env.NEXT_PUBLIC_BASE_PATH || ''
  return {
    name: 'Orbit',
    short_name: 'Orbit',
    description: '本地优先的个人目标管理 — 目标 / 里程碑 / 任务 / 复盘',
    start_url: base + '/',
    scope: base + '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    lang: 'zh-CN',
    icons: [
      { src: base + '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: base + '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: base + '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
