export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
export const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN)

export function quantileSorted(sorted: number[], q: number): number {
  if (!sorted.length) return NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export function quantile(xs: number[], q: number): number {
  return quantileSorted([...xs].sort((a, b) => a - b), q)
}

export function std(xs: number[]): number {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

export function skewness(xs: number[]): number {
  const n = xs.length
  if (n < 3) return NaN
  const m = mean(xs)
  const s = std(xs)
  if (!s) return 0
  return (n / ((n - 1) * (n - 2))) * xs.reduce((a, x) => a + ((x - m) / s) ** 3, 0)
}

export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length
  if (n < 3) return NaN
  const mx = mean(xs)
  const my = mean(ys)
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx
    const b = ys[i] - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : NaN
}

export function linearRegression(xs: number[], ys: number[]) {
  const n = xs.length
  const mx = mean(xs)
  const my = mean(ys)
  let sxy = 0, sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
  }
  const slope = sxx ? sxy / sxx : 0
  const intercept = my - slope * mx
  const r = pearson(xs, ys)
  return { slope, intercept, r2: r * r }
}

export function movingAverage(xs: (number | null)[], window: number): (number | null)[] {
  return xs.map((_, i) => {
    if (i < window - 1) return null
    const slice = xs.slice(i - window + 1, i + 1).filter((v): v is number => v != null)
    return slice.length ? mean(slice) : null
  })
}

/** "Nice" bin edges spanning [min, max] — round widths like 5, 10, 25. */
export function niceBins(min: number, max: number, target = 20): { start: number; width: number; count: number } {
  if (min === max) return { start: min - 0.5, width: 1, count: 1 }
  const raw = (max - min) / target
  const mag = 10 ** Math.floor(Math.log10(raw))
  const width = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((w) => w >= raw) ?? 10 * mag
  const start = Math.floor(min / width) * width
  const count = Math.max(1, Math.ceil((max - start) / width + 1e-9))
  return { start, width, count: max >= start + count * width ? count + 1 : count }
}

export function histogram(xs: number[], target = 20) {
  if (!xs.length) return []
  let min = Infinity, max = -Infinity
  for (const x of xs) { if (x < min) min = x; if (x > max) max = x }
  const { start, width, count } = niceBins(min, max, target)
  const bins = Array.from({ length: count }, (_, i) => ({ x0: start + i * width, x1: start + (i + 1) * width, count: 0 }))
  for (const x of xs) bins[Math.min(count - 1, Math.floor((x - start) / width))].count++
  return bins
}

export function fiveNumber(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  const q1 = quantileSorted(s, 0.25)
  const q3 = quantileSorted(s, 0.75)
  const iqr = q3 - q1
  const lo = q1 - 1.5 * iqr
  const hi = q3 + 1.5 * iqr
  const inside = s.filter((x) => x >= lo && x <= hi)
  return {
    min: s[0], q1, median: quantileSorted(s, 0.5), q3, max: s[s.length - 1],
    whiskerLo: inside[0] ?? q1, whiskerHi: inside[inside.length - 1] ?? q3,
    outliers: s.filter((x) => x < lo || x > hi),
  }
}
