import Dexie, { type Table } from 'dexie'
import type { Goal, Milestone, Review, Task } from '@/lib/types'

// Single-user Orbit store. Data volume is tiny (one person's goals), so we
// index only what IndexedDB can key on reliably and filter the rest in memory.
// NOTE: boolean `completed` and nullable `milestone_id` are intentionally NOT
// indexed — IndexedDB cannot use boolean keys and skips null keys; filtering
// these in memory is correct and cheap at this scale.
//
// D-01: all four goal-domain tables are declared together in ONE version(1),
// so later phases never need a Dexie version migration to add entities.

export class OrbitDB extends Dexie {
  goals!: Table<Goal, string>
  milestones!: Table<Milestone, string>
  tasks!: Table<Task, string>
  reviews!: Table<Review, string>

  constructor() {
    super('orbit')
    this.version(1).stores({
      goals: 'id, updated_at, created_at',
      milestones: 'id, goal_id, updated_at, created_at',
      tasks: 'id, goal_id, updated_at, created_at',
      reviews: 'id, goal_id, updated_at, created_at',
    })
  }
}

// Constructing OrbitDB does NOT open IndexedDB — Dexie auto-opens lazily on the
// first table operation. So this module-scope instance is safe to import during
// Node build-time prerender. INVARIANT: never run a query at module scope or
// during render — only inside client effects/handlers (browser has IndexedDB;
// the prerender pass does not). Do not add an eager db.open() here.
export const db = new OrbitDB()
