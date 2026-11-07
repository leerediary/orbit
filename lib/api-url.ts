/**
 * Build-time API origin for the cloud sync backend.
 *
 * Next.js inlines every `process.env.NEXT_PUBLIC_*` reference at `next build`
 * (see node_modules/next/dist/docs/01-app/02-guides/environment-variables.md),
 * so the value is frozen into the bundle. Unset === public mirror build: the
 * cloud-sync section must not render, and no API origin ships in that bundle
 * (Phase 16 D-03/D-04).
 */
export const API_URL: string = process.env.NEXT_PUBLIC_API_URL ?? ''

/** True only when this build was given an API origin to talk to. */
export const isSyncConfigured: boolean = API_URL.length > 0
