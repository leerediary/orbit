import { describe, it, expect } from 'vitest'
import { balancedColumns } from '@/lib/balanced-columns'

describe('balancedColumns', () => {
  it('handles empty and single', () => {
    expect(balancedColumns([])).toEqual([])
    expect(balancedColumns([5])).toEqual([[0]])
  })

  it('keeps two cards side by side', () => {
    expect(balancedColumns([3, 3])).toEqual([[0], [1]])
  })

  it('keeps three equal cards in three columns', () => {
    expect(balancedColumns([4, 4, 4])).toEqual([[0], [1], [2]])
  })

  it('isolates one tall card into its own column', () => {
    // 习惯打卡 tall, the other two short -> [[0],[1,2]]
    expect(balancedColumns([9, 1, 1])).toEqual([[0], [1, 2]])
  })

  it('stacks two cards next to a tall middle card', () => {
    expect(balancedColumns([3, 9, 3])).toEqual([[0], [1, 2]])
  })

  it('splits when the tall card is last', () => {
    expect(balancedColumns([1, 1, 9])).toEqual([[0, 1], [2]])
  })

  it('preserves reading order (contiguous columns)', () => {
    expect(balancedColumns([5, 4, 3]).flat()).toEqual([0, 1, 2])
  })
})

describe('balancedColumns hysteresis (T15: stop 2↔3 flapping)', () => {
  it('stays with the current count when the improvement is within the margin', () => {
    // 3-col cost 12 vs current 2-col cost 14: only ~14% better, below 15% margin.
    expect(balancedColumns([4, 4, 3], 3, 2, { current: 2, hysteresis: 0.15 })).toEqual([
      [0],
      [1, 2],
    ])
  })

  it('switches when the improvement exceeds the margin', () => {
    // 3-col cost 18 vs 2-col cost 24: 25% better — switch.
    expect(balancedColumns([4, 4, 4], 3, 2, { current: 2, hysteresis: 0.15 })).toEqual([
      [0],
      [1],
      [2],
    ])
  })

  it('keeps the cheaper current layout even when the alternative is near-tied', () => {
    // current 3-col cost 12; 2-col best cost 14 — switching would be worse anyway.
    expect(balancedColumns([4, 4, 3], 3, 2, { current: 3, hysteresis: 0.15 })).toEqual([
      [0],
      [1],
      [2],
    ])
  })

  it('falls back to the plain best when the current count is out of range', () => {
    expect(balancedColumns([4, 4, 4], 3, 2, { current: 5, hysteresis: 0.15 })).toEqual([
      [0],
      [1],
      [2],
    ])
  })

  it('behaves as before when no options are given', () => {
    expect(balancedColumns([4, 4, 3])).toEqual([[0], [1], [2]])
  })
})
