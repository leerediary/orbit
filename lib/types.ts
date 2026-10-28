// Sync-ready metadata shared by every Orbit entity (D-02).
// updated_at is stamped client-side on every write; deleted_at is the
// soft-delete tombstone — null means the row is live.
export interface SyncMeta {
  id: string // client-generated UUID (crypto.randomUUID) at insert time
  updated_at: string // ISO 8601
  deleted_at: string | null // ISO 8601 tombstone; null = live
}

export interface Goal extends SyncMeta {
  name: string
  description: string
  created_at: string
  // Manual display order (D-02/D-08). Required for all Phase-2 writes; legacy
  // rows may lack it at runtime and sort by created_at via effectiveOrder().
  sort_order: number
}

export interface Milestone extends SyncMeta {
  goal_id: string
  name: string
  completed: boolean
  completed_at: string | null
  created_at: string
  // Manual display order (D-05). Required for all Phase-3 writes; legacy rows
  // may lack it at runtime and sort by created_at via effectiveOrder().
  sort_order: number
}

export interface Task extends SyncMeta {
  goal_id: string
  milestone_id: string | null
  name: string
  completed: boolean
  completed_at: string | null
  created_at: string
  // Manual display order (D-05). Required for all Phase-3 writes; legacy rows
  // may lack it at runtime and sort by created_at via effectiveOrder().
  sort_order: number
}

export interface Review extends SyncMeta {
  goal_id: string
  content: string
  created_at: string
}
