/**
 * Order-preserving balanced columns (mini masonry).
 *
 * Given card heights in display order, split the cards into 2..maxCols
 * CONTIGUOUS columns (reading order is preserved left-to-right, top-to-bottom)
 * so the layout is as close to a rectangle as possible. The cost of a layout is
 * `columns × tallest-column-height`, i.e. the rendered bounding-box area;
 * minimizing it minimizes whitespace (total height is fixed). On a tie, more
 * columns win so a side-by-side layout is preferred when heights are even.
 */

export interface BalancedColumnsOptions {
  /**
   * T15: the column count currently rendered. Together with `hysteresis`, the
   * layout only switches when the best new layout beats the current layout's
   * cost by at least that fraction. Card heights depend on column width
   * (narrower column → more text wrapping → taller card), so a bare cost
   * comparison feeds back: switching columns changes the measurements, which
   * can flip the winner back — the visible 2↔3 column flapping on window open.
   */
  current?: number
  hysteresis?: number
}

function compositions(total: number, parts: number): number[][] {
  const out: number[][] = []
  const current: number[] = []
  const build = (partsLeft: number, remaining: number) => {
    if (partsLeft === 1) {
      out.push([...current, remaining])
      return
    }
    for (let v = 1; v <= remaining - (partsLeft - 1); v++) {
      current.push(v)
      build(partsLeft - 1, remaining - v)
      current.pop()
    }
  }
  build(parts, total)
  return out
}

/** Best contiguous k-column split for exactly k; null when k is out of range. */
function bestForK(
  heights: number[],
  k: number,
): { cols: number[][]; cost: number } | null {
  const n = heights.length
  if (k < 1 || k > n) return null
  let best: number[][] | null = null
  let bestCost = Infinity
  for (const comp of compositions(n, k)) {
    const cols: number[][] = []
    let idx = 0
    for (const len of comp) {
      const col: number[] = []
      for (let j = 0; j < len; j++) col.push(idx + j)
      cols.push(col)
      idx += len
    }
    const tallest = Math.max(
      ...cols.map((col) => col.reduce((sum, i) => sum + heights[i], 0)),
    )
    const cost = k * tallest
    if (cost < bestCost || (cost === bestCost && cols.length > (best?.length ?? 0))) {
      bestCost = cost
      best = cols
    }
  }
  return best ? { cols: best, cost: bestCost } : null
}

export function balancedColumns(
  heights: number[],
  maxCols = 3,
  minCols = 2,
  opts?: BalancedColumnsOptions,
): number[][] {
  const n = heights.length
  if (n === 0) return []
  if (n === 1) return [[0]]

  let best: { cols: number[][]; cost: number } | null = null
  for (let k = minCols; k <= Math.min(n, maxCols); k++) {
    const candidate = bestForK(heights, k)
    if (!candidate) continue
    if (
      !best ||
      candidate.cost < best.cost ||
      (candidate.cost === best.cost && candidate.cols.length > best.cols.length)
    ) {
      best = candidate
    }
  }
  if (!best) return []

  // Hysteresis: stay with the current column count unless the best layout is
  // better by the requested margin.
  if (opts?.current != null && opts.hysteresis && opts.hysteresis > 0) {
    const current = bestForK(heights, opts.current)
    if (current && best.cost >= current.cost * (1 - opts.hysteresis)) {
      return current.cols
    }
  }

  return best.cols
}
