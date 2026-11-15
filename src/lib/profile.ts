import type { Column, Dataset, Filter } from '../types'
import { applyFilters, bucketDate, colMap, correlationMatrix, labelOf, resolveBucket } from './aggregate'
import { fmtDate, fmtNumber, fmtPct } from './format'
import { fiveNumber, histogram, mean, skewness, std, sum } from './stats'
import { anomalies, seasonalProfile } from './forecast'
import { defaultAgg, rankMeasures } from './suggest'

export interface ColumnProfile {
  col: Column
  count: number
  missing: number
  distinct: number
  numeric?: {
    min: number; max: number; mean: number; median: number; std: number; sum: number
    q1: number; q3: number; skew: number; outliers: number; zeros: number; negatives: number
    hist: { x0: number; x1: number; count: number }[]
  }
  date?: { min: number; max: number; spanDays: number; series: { label: string; count: number }[] }
  top?: { value: string; count: number }[]
  text?: { avgLen: number; maxLen: number }
}

export function profileColumn(ds: Dataset, col: Column, filters: Filter[] = []): ColumnProfile {
  const rows = applyFilters(ds.rows, filters, colMap(ds))
  const vals = rows.map((r) => r[col.key])
  const present = vals.filter((v) => v != null && v !== '')
  const p: ColumnProfile = { col, count: rows.length, missing: rows.length - present.length, distinct: new Set(present).size }
  if (col.type === 'number') {
    const xs = present.filter((v): v is number => typeof v === 'number')
    if (xs.length) {
      const f = fiveNumber(xs)
      p.numeric = {
        min: f.min, max: f.max, mean: mean(xs), median: f.median, std: std(xs), sum: sum(xs),
        q1: f.q1, q3: f.q3, skew: skewness(xs), outliers: f.outliers.length,
        zeros: xs.filter((x) => x === 0).length, negatives: xs.filter((x) => x < 0).length,
        hist: histogram(xs, 24),
      }
    }
  }
  if (col.type === 'date') {
    const ts = present.filter((v): v is number => typeof v === 'number')
    if (ts.length) {
      let min = Infinity, max = -Infinity
      for (const t of ts) { if (t < min) min = t; if (t > max) max = t }
      const b = resolveBucket(col, rows)
      const counts = new Map<number, number>()
      for (const t of ts) { const k = bucketDate(t, b); counts.set(k, (counts.get(k) ?? 0) + 1) }
      p.date = {
        min, max, spanDays: (max - min) / 864e5,
        series: [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([k, c]) => ({ label: fmtDate(k, b), count: c })),
      }
    }
  }
  if (col.type === 'category' || col.type === 'text' || col.type === 'boolean' || col.discrete) {
    const counts = new Map<string, number>()
    for (const v of present) { const l = labelOf(v, col); counts.set(l, (counts.get(l) ?? 0) + 1) }
    p.top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, count]) => ({ value, count }))
  }
  if (col.type === 'text' || col.type === 'category') {
    const lens = present.map((v) => String(v).length)
    p.text = { avgLen: lens.length ? sum(lens) / lens.length : 0, maxLen: Math.max(0, ...lens) }
  }
  return p
}

// ---------- automatic insights ----------

export interface Insight {
  kind: 'correlation' | 'dominant' | 'outliers' | 'trend' | 'missing' | 'skew' | 'extreme' | 'seasonal' | 'anomaly'
  title: string
  detail: string
  strength: number
  columns: string[]
  /** what the finding rests on: rows used, blanks left out, the period, the method */
  basis?: string
  /** descriptive: a summary of the rows as they are; model: a fitted pattern (trend line, seasonal profile), not a prediction or a cause */
  nature?: 'descriptive' | 'model'
}

/** Above this many rows the per-column findings (outliers, skew, dominant values) look at an even sample. */
export const INSIGHT_SAMPLE = 200_000

/** The rows themselves up to INSIGHT_SAMPLE, an evenly spaced sample of that size beyond it. */
export function evenSample<T>(rows: T[], k = INSIGHT_SAMPLE): T[] {
  if (rows.length <= k) return rows
  const stride = rows.length / k
  return Array.from({ length: k }, (_, i) => rows[Math.floor(i * stride)])
}

export const measureCols = (ds: Dataset) => ds.columns.filter((c) => c.type === 'number' && !c.isId)
export const dimensionCols = (ds: Dataset) =>
  ds.columns.filter((c) => (c.type === 'category' || c.type === 'boolean') && !c.isId && c.distinct >= 2 && c.distinct <= 60)

export function findInsights(ds: Pick<Dataset, 'columns' | 'rows'> & Partial<Pick<Dataset, 'model' | 'source'>>, filters: Filter[] = []): Insight[] {
  return insightsOf(ds as Dataset, filters)
}

function insightsOf(ds: Dataset, filters: Filter[]): Insight[] {
  const out: Insight[] = []
  const cols = colMap(ds)
  const allRows = applyFilters(ds.rows, filters, cols)
  // sorting every column of a million rows would block the page: distribution findings use an even sample
  const sampled = allRows.length > INSIGHT_SAMPLE
  const rows = evenSample(allRows)
  const nums = measureCols(ds).filter((c) => !c.discrete).slice(0, 14)
  const scope = `${sampled ? `an even sample of ${INSIGHT_SAMPLE.toLocaleString()} of ${allRows.length.toLocaleString()}` : allRows.length.toLocaleString()} rows${filters.length ? ` matching ${filters.length} filter${filters.length > 1 ? 's' : ''}` : ''}${ds.source?.truncated ? ' (the import stopped at a row limit)' : ''}`
  const used = (n: number, total = rows.length) => `${n.toLocaleString()} of ${scope}${total - n > 0 ? `; ${(total - n).toLocaleString()} blank left out` : ''}`

  // correlations
  if (nums.length >= 2) {
    const cm = correlationMatrix(sampled ? { ...ds, rows } : ds, nums.map((c) => c.key), sampled ? [] : filters)
    const pairs: { a: number; b: number; r: number }[] = []
    for (let i = 0; i < nums.length; i++) for (let j = i + 1; j < nums.length; j++) {
      const r = cm.matrix[i][j]
      if (Number.isFinite(r)) pairs.push({ a: i, b: j, r })
    }
    pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r))
    // a pair that is all but identical (the same quantity twice, a total and its part) says nothing: the dashboard's scatter skips those too
    for (const p of pairs.filter((x) => Math.abs(x.r) < 0.999).slice(0, 3)) {
      if (Math.abs(p.r) < 0.5) break
      const strong = Math.abs(p.r) > 0.8 ? 'Strong' : 'Moderate'
      out.push({
        kind: 'correlation', columns: [nums[p.a].key, nums[p.b].key], strength: Math.abs(p.r),
        title: `${strong} ${p.r > 0 ? 'positive' : 'negative'} correlation`,
        detail: `${nums[p.a].name} and ${nums[p.b].name} move ${p.r > 0 ? 'together' : 'in opposite directions'} (r = ${p.r.toFixed(2)}).`,
        nature: 'descriptive', basis: `Pearson correlation over ${scope}, rows with either value blank left out. A correlation does not show that one causes the other.`,
      })
    }
  }

  // dominant categories
  for (const c of dimensionCols(ds).slice(0, 6)) {
    const counts = new Map<string, number>()
    for (const r of rows) { const l = labelOf(r[c.key], c); counts.set(l, (counts.get(l) ?? 0) + 1) }
    const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? []
    if (top && n / rows.length > 0.4 && counts.size > 2) {
      out.push({
        kind: 'dominant', columns: [c.key], strength: n / rows.length,
        title: `"${top}" dominates ${c.name}`,
        detail: `${fmtPct(n / rows.length)} of rows are "${top}" across ${counts.size} distinct values.`,
        nature: 'descriptive', basis: `Row counts over ${scope}; blanks count as a value of their own.`,
      })
    }
  }

  // outliers & skew
  for (const c of nums.slice(0, 8)) {
    const xs = rows.map((r) => r[c.key]).filter((v): v is number => typeof v === 'number')
    if (xs.length < 10) continue
    const f = fiveNumber(xs)
    const share = f.outliers.length / xs.length
    if (share > 0.01) {
      out.push({
        kind: 'outliers', columns: [c.key], strength: Math.min(1, share * 5),
        title: `${f.outliers.length.toLocaleString()} outliers in ${c.name}`,
        detail: `Values outside ${fmtNumber(f.whiskerLo, c)}–${fmtNumber(f.whiskerHi, c)} (1.5× IQR); most extreme is ${fmtNumber(Math.abs(f.max - f.median) > Math.abs(f.min - f.median) ? f.max : f.min, c)}.`,
        nature: 'descriptive', basis: `${used(xs.length)}. Threshold: 1.5× the interquartile range beyond the quartiles — unusual, not necessarily wrong.`,
      })
    }
    const sk = skewness(xs)
    if (Math.abs(sk) > 1.5) {
      out.push({
        kind: 'skew', columns: [c.key], strength: Math.min(1, Math.abs(sk) / 4),
        title: `${c.name} is ${sk > 0 ? 'right' : 'left'}-skewed`,
        detail: `Mean ${fmtNumber(mean(xs), c)} vs median ${fmtNumber(f.median, c)} — a few ${sk > 0 ? 'large' : 'small'} values pull the average. Prefer the median.`,
        nature: 'descriptive', basis: `${used(xs.length)}. Skewness ${sk.toFixed(1)} (beyond ±1.5 is reported).`,
      })
    }
  }

  // time trend on the primary measure: the same measure, added up or averaged the same way, as the suggested dashboard
  const dateCol = ds.columns.find((c) => c.type === 'date' && c.distinct >= 4)
  const primary: Column | undefined = rankMeasures(ds)[0] ?? nums[0]
  const agg = primary ? defaultAgg(primary) : 'avg'
  const additive = agg === 'sum'
  const Label = primary ? `${additive ? 'Total' : 'Average'} ${primary.name}` : ''
  const label = primary ? `${additive ? 'total' : 'average'} ${primary.name}` : ''
  const fold = (xs: number[]) => (additive ? sum(xs) : mean(xs))
  /** values of the primary measure per period (all matching rows: one pass, no sorting) */
  const series = (bucket: Parameters<typeof bucketDate>[1]) => {
    const g = new Map<number, number[]>()
    let n = 0
    if (dateCol && primary) for (const r of allRows) {
      const t = r[dateCol.key], v = r[primary.key]
      if (typeof t === 'number' && typeof v === 'number') {
        n++
        const k = bucketDate(t, bucket)
        let arr = g.get(k)
        if (!arr) g.set(k, (arr = []))
        arr.push(v)
      }
    }
    return { g, n, keys: [...g.keys()].sort((a, b) => a - b) }
  }
  const allScope = `${allRows.length.toLocaleString()} rows${filters.length ? ` matching ${filters.length} filter${filters.length > 1 ? 's' : ''}` : ''}${ds.source?.truncated ? ' (the import stopped at a row limit)' : ''}`
  const usedAll = (n: number) => `${n.toLocaleString()} of ${allScope}${allRows.length - n > 0 ? `; ${(allRows.length - n).toLocaleString()} without a date or value left out` : ''}`
  if (dateCol && primary) {
    const b = resolveBucket(dateCol, allRows)
    const { g, n, keys } = series(b)
    if (keys.length >= 4) {
      const ys = keys.map((k) => fold(g.get(k)!))
      const xs = keys.map((_, i) => i)
      const mx = mean(xs), my = mean(ys)
      let sxy = 0, sxx = 0
      xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2 })
      const slope = sxy / sxx
      const change = my ? (slope * (keys.length - 1)) / Math.abs(my) : 0
      const span = `${fmtDate(keys[0], b)} – ${fmtDate(keys[keys.length - 1], b)}`
      if (Math.abs(change) > 0.1) {
        out.push({
          kind: 'trend', columns: [dateCol.key, primary.key], strength: Math.min(1, Math.abs(change)),
          title: `${Label} trends ${change > 0 ? 'upward' : 'downward'}`,
          detail: `${Label} per ${b} ${change > 0 ? 'rose' : 'fell'} about ${fmtPct(Math.abs(change), 0)} over ${span} (linear fit).`,
          nature: 'model', basis: `${usedAll(n)}, as ${label} per ${b} over ${keys.length} periods (${span}). A straight line fitted to the past: it describes the direction so far and is not a forecast.`,
        })
      }
      // a peak is worth a line only when it stands clear of the other periods
      const maxI = ys.indexOf(Math.max(...ys))
      const rest = ys.filter((_, i) => i !== maxI)
      const sd = std(rest)
      if (keys.length >= 6 && sd > 0 && (ys[maxI] - mean(rest)) / sd >= 2) {
        out.push({
          kind: 'extreme', columns: [dateCol.key, primary.key], strength: 0.3,
          title: `Peak ${label}: ${fmtDate(keys[maxI], b)}`,
          detail: `The highest ${label} (${fmtNumber(ys[maxI], primary)}) occurred in ${fmtDate(keys[maxI], b)} — well above the other periods (typically ${fmtNumber(mean(rest), primary)}).`,
          nature: 'descriptive', basis: `${usedAll(n)}, as ${label} per ${b}. Reported when the highest period is at least two standard deviations above the rest.`,
        })
      }
    }
  }

  // seasonality & anomalies on a monthly series of the primary measure
  if (dateCol && primary) {
    const { g, n, keys } = series('month')
    if (keys.length >= 24) {
      // align to January so profile positions are calendar months
      const full: (number | null)[] = []
      const startT = Date.UTC(new Date(keys[0]).getUTCFullYear(), 0, 1)
      for (let t = startT; t <= keys[keys.length - 1]; t = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1)) full.push(g.has(t) ? fold(g.get(t)!) : null)
      const sp = seasonalProfile(full, 12)
      if (sp && sp.strength > 0.5) {
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        const hi = sp.profile.indexOf(Math.max(...sp.profile)), lo = sp.profile.indexOf(Math.min(...sp.profile))
        out.push({
          kind: 'seasonal', columns: [dateCol.key, primary.key], strength: sp.strength,
          title: `${Label} follows a yearly cycle`,
          detail: `It tends to peak in ${months[hi]} and bottom out in ${months[lo]} (the seasonal pattern explains ${fmtPct(sp.strength, 0)} of month-to-month variation).`,
          nature: 'model', basis: `${usedAll(n)}, as ${label} per month over ${keys.length} months. The typical month-of-year profile of the past; months with no rows are left out.`,
        })
      }
      const monthly = keys.map((k) => fold(g.get(k)!))
      const an = anomalies(monthly, 12)
      if (an.length) {
        out.push({
          kind: 'anomaly', columns: [dateCol.key, primary.key], strength: Math.min(1, an.length / 6),
          title: `${an.length} unusual month${an.length > 1 ? 's' : ''} in ${label}`,
          detail: `${an.slice(0, 3).map((i) => fmtDate(keys[i], 'month')).join(', ')}${an.length > 3 ? '…' : ''} sit far outside the expected seasonal pattern.`,
          nature: 'model', basis: `${usedAll(n)}, as ${label} per month. Each month is compared with what its trend and season would suggest; "unusual" marks a large gap, not an error or its cause.`,
        })
      }
    }
  }

  // missing data
  const gappy = ds.columns.filter((c) => c.missing / Math.max(1, ds.rows.length) > 0.1).sort((a, b) => b.missing - a.missing)
  if (gappy.length) {
    out.push({
      kind: 'missing', columns: gappy.map((c) => c.key), strength: gappy[0].missing / ds.rows.length,
      title: `${gappy.length} column${gappy.length > 1 ? 's have' : ' has'} notable gaps`,
      detail: gappy.slice(0, 4).map((c) => `${c.name} (${fmtPct(c.missing / ds.rows.length, 0)} missing)`).join(', ') + '.',
      nature: 'descriptive', basis: `Blank cells over all ${ds.rows.length.toLocaleString()} rows of the dataset (filters do not apply). Sums and averages skip blank cells.`,
    })
  }
  return out
}

/** The strongest few findings, for the summary on the suggested dashboard. */
export const topInsights = (ds: Dataset, filters: Filter[] = [], k = 3): Insight[] =>
  findInsights(ds, filters).filter((i) => i.kind !== 'missing').sort((a, b) => b.strength - a.strength).slice(0, k)
