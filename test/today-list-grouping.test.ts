import { describe, expect, it } from 'vitest'
import { groupLeavesByParent } from '@/lib/today-list'
import type { PickableLeaf } from '@/lib/today-list'

function leaf(id: string, name: string, parentId: string | null, breadcrumb: string | null): PickableLeaf {
  return {
    task: { id, name, parent_id: parentId } as PickableLeaf['task'],
    goal: { id: 'g1' } as PickableLeaf['goal'],
    milestone: null,
    breadcrumb,
  }
}

describe('groupLeavesByParent', () => {
  it('splits direct leaves from parent groups, preserving first-appearance order', () => {
    const leaves = [
      leaf('t1', '第一章', 'p1', '白痴 - 第一部'),
      leaf('t2', '直属任务', null, null),
      leaf('t3', '第二章', 'p1', '白痴 - 第一部'),
      leaf('t4', '第三章', 'p2', '白痴 - 第二部'),
    ]
    const { direct, groups } = groupLeavesByParent(leaves)
    expect(direct.map((l) => l.task.id)).toEqual(['t2'])
    expect(groups).toHaveLength(2)
    expect(groups[0].parentId).toBe('p1')
    expect(groups[0].parentName).toBe('第一部')
    expect(groups[0].leaves.map((l) => l.task.id)).toEqual(['t1', 't3'])
    expect(groups[1].parentId).toBe('p2')
    expect(groups[1].parentName).toBe('第二部')
    expect(groups[1].leaves.map((l) => l.task.id)).toEqual(['t4'])
  })

  it('falls back to a generic group name when breadcrumb is missing', () => {
    const { groups } = groupLeavesByParent([leaf('t1', '第一章', 'p1', null)])
    expect(groups[0].parentName).toBe('子任务组')
  })

  it('returns all leaves as direct when no parent exists', () => {
    const leaves = [leaf('t1', 'A', null, null), leaf('t2', 'B', null, null)]
    const { direct, groups } = groupLeavesByParent(leaves)
    expect(direct).toHaveLength(2)
    expect(groups).toHaveLength(0)
  })
})
