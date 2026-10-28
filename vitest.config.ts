import { defineConfig, configDefaults } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Pin the test time zone to UTC for determinism. dayKey() derives the local day
// from a timestamp, so without a fixed TZ these tests would pass/fail depending
// on the machine's zone (e.g. a 16:00Z session lands on the next day in UTC+8).
// Set before workers spawn so the forks pool inherits it. Under UTC,
// dayKey(iso, 0) == the UTC date prefix, so the expectations are deterministic.
process.env.TZ = 'UTC'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [{ find: '@', replacement: root.replace(/\/$/, '') }],
  },
  test: {
    environment: 'node',
    setupFiles: ['fake-indexeddb/auto'],
    // Leftover isolation worktrees under .claude/worktrees hold stale copies of
    // every test file; without this they get globbed and fail on old signatures.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
})
