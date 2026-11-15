import type { DateBucket } from '../types'
import { mean, std } from './stats'

export interface Forecast {
  method: 'holt-winters' | 'holt' | 'linear'
  /** one-step-ahead fitted values for the history (null where the model has no estimate yet) */
  fitted: (number | null)[]
  forecast: number[]
  lower: number[]
  upper: number[]
  residualStd: number
}

export function seasonLength(bucket?: Exclude<DateBucket, 'auto'>): number {
  switch (bucket) {
    case 'month': return 12
    case 'quarter': return 4
    case 'week': return 52
    case 'day': return 7
    case 'hour': return 24
    default: return 0
  }
}

/** Fills interior gaps by linear interpolation so smoothing has a continuous series. */
function interpolate(xs: (number | null)[]): number[] {
  const out = xs.slice() as (number | null)[]
  const first = out.findIndex((v) => v != null)
  if (first < 0) return []
  for (let i = 0; i < first; i++) out[i] = out[first]
  let last = first
  for (let i = first + 1; i < out.length; i++) {
    if (out[i] == null) continue
    for (let j = last + 1; j < i; j++) out[j] = out[last]! + ((out[i]! - out[last]!) * (j - last)) / (i - last)
    last = i
  }
  for (let i = last + 1; i < out.length; i++) out[i] = out[last]
  return out as number[]
}

interface Fit { sse: number; fitted: (number | null)[]; level: number; trend: number; seasonal: number[] }

function holtWinters(y: number[], m: number, a: number, b: number, g: number): Fit {
  const seasons = Math.floor(y.length / m)
  const seasonAvg = Array.from({ length: seasons }, (_, s) => mean(y.slice(s * m, s * m + m)))
  let level = seasonAvg[0]
  let trend = seasons > 1 ? (seasonAvg[1] - seasonAvg[0]) / m : 0
  const seasonal = Array.from({ length: m }, (_, i) => mean(seasonAvg.map((avg, s) => y[s * m + i] - avg)))
  const fitted: (number | null)[] = new Array(y.length).fill(null)
  let sse = 0
  for (let t = 0; t < y.length; t++) {
    const s = seasonal[t % m]
    if (t >= m) {
      const f = level + trend + s
      fitted[t] = f
      sse += (y[t] - f) ** 2
    }
    const prevLevel = level
    level = a * (y[t] - s) + (1 - a) * (level + trend)
    trend = b * (level - prevLevel) + (1 - b) * trend
    seasonal[t % m] = g * (y[t] - level) + (1 - g) * s
  }
  return { sse, fitted, level, trend, seasonal }
}

function holt(y: number[], a: number, b: number): Fit {
  let level = y[0]
  let trend = y.length > 1 ? y[1] - y[0] : 0
  const fitted: (number | null)[] = new Array(y.length).fill(null)
  let sse = 0
  for (let t = 1; t < y.length; t++) {
    const f = level + trend
    fitted[t] = f
    sse += (y[t] - f) ** 2
    const prev = level
    level = a * y[t] + (1 - a) * (level + trend)
    trend = b * (level - prev) + (1 - b) * trend
  }
  return { sse, fitted, level, trend, seasonal: [] }
}

const GRID = [0.1, 0.2, 0.35, 0.5, 0.7, 0.9]

/**
 * Forecasts `horizon` periods ahead. Seasonal Holt-Winters (additive) when there are at least two full seasons,
 * Holt's linear trend otherwise, plain regression for very short series. Bands are ±1.96σ of one-step residuals, widening with √h.
 */
export function forecast(values: (number | null)[], horizon: number, season = 0): Forecast | null {
  const y = interpolate(values)
  if (y.length < 4 || horizon < 1) return null
  let best: Fit | null = null
  let method: Forecast['method'] = 'linear'
  if (season > 1 && y.length >= season * 2) {
    for (const a of GRID) for (const b of [0.05, 0.1, 0.2]) for (const g of [0.1, 0.3, 0.5]) {
      const f = holtWinters(y, season, a, b, g)
      if (!best || f.sse < best.sse) best = f
    }
    method = 'holt-winters'
  } else if (y.length >= 6) {
    for (const a of GRID) for (const b of [0.05, 0.1, 0.2, 0.4]) {
      const f = holt(y, a, b)
      if (!best || f.sse < best.sse) best = f
    }
    method = 'holt'
  }
  if (!best) {
    // least-squares line
    const xs = y.map((_, i) => i)
    const mx = mean(xs), my = mean(y)
    let sxy = 0, sxx = 0
    xs.forEach((x, i) => { sxy += (x - mx) * (y[i] - my); sxx += (x - mx) ** 2 })
    const slope = sxx ? sxy / sxx : 0
    const fitted = xs.map((x) => my + slope * (x - mx))
    best = { sse: y.reduce((a, v, i) => a + (v - fitted[i]) ** 2, 0), fitted, level: fitted[fitted.length - 1], trend: slope, seasonal: [] }
  }
  // a series that has never gone negative (counts, sales, rainfall) shouldn't be forecast below zero
  const nonNegative = y.every((v) => v >= 0)
  const residuals = y.map((v, i) => (best!.fitted[i] == null ? null : v - best!.fitted[i]!)).filter((r): r is number => r != null)
  const sigma = residuals.length > 2 ? std(residuals) : 0
  const fc: number[] = [], lo: number[] = [], hi: number[] = []
  for (let h = 1; h <= horizon; h++) {
    const s = method === 'holt-winters' ? best.seasonal[(y.length + h - 1) % season] : 0
    const v = best.level + h * best.trend + s
    const w = 1.96 * sigma * Math.sqrt(h)
    const c = (x: number) => (nonNegative ? Math.max(0, x) : x)
    fc.push(c(v)); lo.push(c(v - w)); hi.push(c(v + w))
  }
  return { method, fitted: best.fitted, forecast: fc, lower: lo, upper: hi, residualStd: sigma }
}

/** Indices whose value sits more than k residual standard deviations from the model's fit. */
export function anomalies(values: (number | null)[], season = 0, k = 3): number[] {
  const f = forecast(values, 1, season)
  if (!f || !f.residualStd) return []
  return values.flatMap((v, i) => (v != null && f.fitted[i] != null && Math.abs(v - f.fitted[i]!) > k * f.residualStd ? [i] : []))
}

/** Seasonal profile: average deviation from each season's mean, per position (e.g. per month of year). */
export function seasonalProfile(values: (number | null)[], season: number): { strength: number; profile: number[] } | null {
  const y = interpolate(values)
  if (season < 2 || y.length < season * 2) return null
  const seasons = Math.floor(y.length / season)
  const dev: number[][] = Array.from({ length: season }, () => [])
  for (let s = 0; s < seasons; s++) {
    const block = y.slice(s * season, s * season + season)
    const avg = mean(block)
    block.forEach((v, i) => dev[i].push(v - avg))
  }
  const profile = dev.map((d) => mean(d))
  // share of within-season variance explained by the profile
  const all = dev.flat()
  const total = all.reduce((a, v) => a + v * v, 0)
  const resid = dev.reduce((a, d, i) => a + d.reduce((b, v) => b + (v - profile[i]) ** 2, 0), 0)
  return { strength: total ? Math.max(0, 1 - resid / total) : 0, profile }
}
