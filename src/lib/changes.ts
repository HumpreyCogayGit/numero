// "What changed" after a data update: KPI moves, the biggest movers in the latest period, new category values
// and outliers among the new rows. Pure, so the store and the tests share it.

import type { ChangeReport, Dataset, Filter, Measure, Page, Row } from '../types'
import { aggregate, colMap, labelOf, measureColumn, measureLabel, nextBucket, runKpi, type AggCtx } from './aggregate'
import { bucketDate } from './dates'
import { fmtDate, fmtNumber } from './format'
import { quantileSorted } from './stats'


type Bucket = 'day' | 'week' | 'month'

const periodLabel = (t: number, b: Bucket) => (b === 'month' ? fmtDate(t, 'month') : b === 'week' ? `week of ${fmtDate(t)}` : fmtDate(t))

/** The first date column that comes from the file (computed ones are derived from it). */
const mainDate = (ds: Dataset) => ds.columns.find((c) => c.type === 'date' && c.formula == null) ?? ds.columns.find((c) => c.type === 'date')

function range(rows: Row[], key: string): [number, number] {
  let lo = Infinity, hi = -Infinity
  for (const r of rows) { const v = r[key]; if (typeof v === 'number') { if (v < lo) lo = v; if (v > hi) hi = v } }
  return [lo, hi]
}

export function whatChanged(before: Dataset, after: Dataset, pages: Page[], fileName: string, at = Date.now()): ChangeReport {
  const cols = colMap(after)
  const ctx: AggCtx = { cols, all: after.rows }
  const report: ChangeReport = { at, fileName, rowsBefore: before.rows.length, rowsAfter: after.rows.length, kpis: [], movers: [], newValues: [], outliers: [] }

  // ---- KPIs on every page, with that page's filters (relative filters roll forward with the data)
  const seen = new Set<string>()
  for (const [pi, page] of pages.entries()) {
    for (const w of page.widgets) {
      // the same measure on two pages (e.g. "Revenue" and the suggested "Sum of Revenue") is reported once
      const m0 = w.measures[0]
      const what = `${m0?.agg}:${m0?.column ?? m0?.calc ?? ''}:${w.kpiMode ?? ''}:${JSON.stringify(page.filters.map((f) => ({ ...f, id: '' })))}`
      if (w.type !== 'kpi' || seen.has(what) || w.measures.some((m) => m.column && !cols.has(m.column))) continue
      seen.add(what)
      const filters: Filter[] = page.filters
      const b = safe(() => runKpi(before, w, filters))
      const a = safe(() => runKpi(after, w, filters))
      if (!a || a.value == null) continue
      const mc = measureColumn(w.measures[0] ?? { id: 'c', agg: 'count' }, cols)
      const fmt = (v: number | null | undefined) => fmtNumber(v, mc, { format: w.format })
      const k: ChangeReport['kpis'][number] = {
        title: w.title, before: fmt(b?.value), after: fmt(a.value), upIsGood: w.upIsGood, key: what, other: pi > 0 || undefined,
        change: b?.value != null && b.value !== 0 ? (a.value - b.value) / Math.abs(b.value) : undefined,
      }
      if (w.target != null && b?.value != null) {
        k.target = fmt(w.target)
        if (b.value < w.target && a.value >= w.target) k.crossed = 'reached'
        else if (b.value >= w.target && a.value < w.target) k.crossed = 'fell below'
      }
      if (report.kpis.length < 12) report.kpis.push(k)
    }
  }

  // ---- biggest movers: latest period vs the one before, per category value
  const date = mainDate(after)
  const primary: Measure = pages.flatMap((p) => p.widgets).find((w) => w.type === 'kpi' && w.measures[0] && (!w.measures[0].column || cols.has(w.measures[0].column)))?.measures[0]
    ?? (() => { const n = after.columns.find((c) => c.type === 'number' && !c.isId && !c.formula); return n ? { id: 'm', column: n.key, agg: 'sum' as const } : { id: 'm', agg: 'count' as const } })()
  if (date) {
    const [lo, hi] = range(after.rows, date.key)
    const days = (hi - lo) / 864e5
    const bucket: Bucket = days >= 120 ? 'month' : days >= 21 ? 'week' : 'day'
    if (Number.isFinite(days) && days > 1) {
      const last = bucketDate(hi, bucket)
      const prev = bucketDate(last - 1, bucket)
      const end = nextBucket(last, bucket)
      const partial = bucket !== 'day' && date.grain !== 'month' && hi < end - 864e5
      report.period = { label: periodLabel(last, bucket), previous: periodLabel(prev, bucket), partial }
      const cur = after.rows.filter((r) => typeof r[date.key] === 'number' && (r[date.key] as number) >= last)
      const old = after.rows.filter((r) => typeof r[date.key] === 'number' && (r[date.key] as number) >= prev && (r[date.key] as number) < last)
      if (cur.length && old.length) {
        const mc = measureColumn(primary, cols)
        const mName = measureLabel(primary, cols)
        // computed columns are left out: they're mostly calendar parts (weekday, hour) that move with the calendar, not the business
        const dims = after.columns.filter((c) => (c.type === 'category' || c.type === 'boolean') && !c.isId && c.formula == null && c.distinct >= 2 && c.distinct <= 30)
        const all: ChangeReport['movers'] = []
        for (const d of dims) {
          const by = (rows: Row[]) => {
            const m = new Map<string, Row[]>()
            for (const r of rows) { const l = labelOf(r[d.key], d); let a = m.get(l); if (!a) m.set(l, (a = [])); a.push(r) }
            return m
          }
          const c = by(cur), p = by(old)
          for (const v of new Set([...c.keys(), ...p.keys()])) {
            const x = c.get(v) ? aggregate(c.get(v)!, primary, ctx) ?? 0 : 0
            const y = p.get(v) ? aggregate(p.get(v)!, primary, ctx) ?? 0 : 0
            if (x === y) continue
            // "Promo: No" reads better than a bare "No"
            all.push({ dimension: d.type === 'boolean' ? '' : d.name, value: d.type === 'boolean' ? `${d.name}: ${v}` : v, measure: mName, current: fmtNumber(x, mc), previous: fmtNumber(y, mc), change: x - y, pct: y ? (x - y) / Math.abs(y) : undefined })
          }
        }
        // a partial period would make everything look like it fell, so movers wait for a full one
        if (!partial) report.movers = all.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 6)
      }
    }
  }

  // ---- category values that weren't there before (a new store, product, region…)
  const bcols = colMap(before)
  for (const c of after.columns) {
    if (c.type !== 'category' || c.isId || c.distinct > 500) continue
    const old = bcols.get(c.key)
    if (!old) continue
    const had = new Set(before.rows.map((r) => labelOf(r[c.key], old)))
    const fresh = [...new Set(after.rows.map((r) => labelOf(r[c.key], c)))].filter((v) => !had.has(v))
    if (fresh.length && fresh.length <= Math.max(5, had.size)) report.newValues.push({ column: c.name, values: fresh.slice(0, 5), more: Math.max(0, fresh.length - 5) })
  }
  report.newValues = report.newValues.slice(0, 4)

  // ---- outliers among the new rows (dated after the previous data), judged against the old distribution
  const bdate = mainDate(before)
  if (date && bdate) {
    const oldMax = range(before.rows, bdate.key)[1]
    const added = after.rows.filter((r) => typeof r[date.key] === 'number' && (r[date.key] as number) > oldMax)
    if (added.length) {
      for (const c of after.columns) {
        if (c.type !== 'number' || c.isId || !bcols.has(c.key)) continue
        const xs = sample(before.rows, c.key)
        if (xs.length < 30) continue
        const q1 = quantileSorted(xs, 0.25), q3 = quantileSorted(xs, 0.75), iqr = q3 - q1
        if (!iqr) continue
        const lo = q1 - 3 * iqr, hi = q3 + 3 * iqr
        // values that were already common before aren't news: only flag beyond the old extremes' bulk
        const p99 = quantileSorted(xs, 0.995), p01 = quantileSorted(xs, 0.005)
        let count = 0, top: number | undefined
        for (const r of added) {
          const v = r[c.key]
          if (typeof v !== 'number') continue
          if ((v > hi && v > p99) || (v < lo && v < p01)) { count++; if (top === undefined || Math.abs(v - q3) > Math.abs(top - q3)) top = v }
        }
        if (count && top !== undefined) report.outliers.push({ column: c.name, count, highest: fmtNumber(top, c), usual: `${fmtNumber(Math.max(lo, xs[0]), c)} – ${fmtNumber(Math.min(hi, xs[xs.length - 1]), c)}` })
      }
      report.outliers = report.outliers.sort((a, b) => b.count - a.count).slice(0, 4)
    }
  }
  return report
}

/** Sorted numeric values of a column, sampled down to 50k for speed. */
function sample(rows: Row[], key: string): number[] {
  const step = Math.max(1, Math.floor(rows.length / 50000))
  const xs: number[] = []
  for (let i = 0; i < rows.length; i += step) { const v = rows[i][key]; if (typeof v === 'number') xs.push(v) }
  return xs.sort((a, b) => a - b)
}

function safe<T>(fn: () => T): T | undefined {
  try { return fn() } catch { return undefined }
}

/** True when there's nothing worth showing. */
export const isQuiet = (r: ChangeReport) => !r.kpis.length && !r.movers.length && !r.newValues.length && !r.outliers.length

