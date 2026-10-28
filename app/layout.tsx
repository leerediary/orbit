import type { Metadata, Viewport } from 'next'
import './globals.css'
import RegisterSW from '@/components/RegisterSW'

// D-05: Orbit is the display name everywhere.
export const metadata: Metadata = {
  title: 'Orbit',
  applicationName: 'Orbit',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Orbit' },
}

export const viewport: Viewport = {
  themeColor: '#ffffff',
  viewportFit: 'cover',
}

// Phase 1 shell is intentionally bare: no navigation bar, no sync/auth
// banners, no bootstrap component. Those belong to later phases (D-06 —
// pure local-first).
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full">
      <body className="min-h-full flex flex-col">
        <RegisterSW />
        <main className="flex-1 md:max-w-[75%] mx-auto w-full px-6 pt-0 pb-16">
          {children}
        </main>
      </body>
    </html>
  )
}
