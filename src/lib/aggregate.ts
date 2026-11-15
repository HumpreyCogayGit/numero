import type { Agg, Column, Dataset, DateBucket, Filter, Measure, MeasureDef, Row, Value, Widget } from '../types'
import { fmtDate, fmtNumber } from './format'
import { evalMeasure, getMeasure } from './measure'
import { fiveNumber, histogram, mean, niceBins, pearson, quantileSorted, std } from './stats'
import { bucketDate } from './dates'

export { bucketDate }

export const AGG_LABEL: Record<Agg, string> = {
  count: 'Count', sum: 'Sum', avg: 'Average', median: 'Median', min: 'Min', max: 'Max',
  distinct: 'Distinct count', std: 'Std. deviation', p90: '90th percentile', p10: '10th percentile', calc: 'Calculated',
}
export const BUCKET_LABEL: Record<DateBucket, string> = {
  auto: 'Auto', hour: 'Hour', day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year',
  dow: 'Day of week', moy: 'Month of year',
}
export const OTHER = 'Other'
export const BLANK = '(blank)'

type DatasetLike = Pick<Dataset, 'columns' | 'rows'> & { model?: { measures: MeasureDef[] } }

/** Column lookup that also carries the dataset's calculated measures. */
export type ColMap = Map<string, Column> & { measures?: MeasureDef[] }
const colMapCache = new WeakMap<Column[], ColMap>()

export function colMap(ds: DatasetLike): ColMap {
  let m = colMapCache.get(ds.columns)
  if (!m || m.measures !== ds.model?.measures) {
    m = new Map(ds.columns.map((c) => [c.key, c])) as ColMap
    m.measures = ds.model?.measures
    colMapCache.set(ds.columns, m)
  }
  return m
}

export const measureDef = (m: Measure, cols: ColMap) => (m.agg === 'calc' ? cols.measures?.find((d) => d.key === m.calc) : undefined)

export function measureLabel(m: Measure, cols: ColMap): string {
  if (m.agg === 'calc') return measureDef(m, cols)?.name ?? 'Missing measure'
  if (m.agg === 'count' || !m.column) return 'Count of rows'
  const c = cols.get(m.column)
  return `${AGG_LABEL[m.agg]} of ${c?.name ?? m.column}`
}

/** Column used to format a measure's values (count/distinct are plain integers). */
export function measureColumn(m: Measure, cols: ColMap): Column | undefined {
  if (m.agg === 'calc') {
    const d = measureDef(m, cols)
    if (!d) return undefined
    const format = d.format && d.format !== 'auto' ? d.format : 'decimal'
    return { key: `__${d.key}`, name: d.name, type: 'number', detected: 'number', format, distinct: 0, missing: 0 }
  }
  if (m.agg === 'count' || m.agg === 'distinct' || !m.column) return undefined
  return cols.get(m.column)
}

/** Columns a widget depends on — used to flag widgets whose columns were deleted or renamed away. */
export function widgetColumns(w: Widget): string[] {
  return [w.dimension, w.series, w.x, w.y, w.color, w.sizeBy, w.facet, w.drillTo, w.entity, ...w.measures.map((m) => m.column), ...(w.filters ?? []).map((f) => f.column), ...(w.tooltipFields ?? [])]
    .filter((k): k is string => !!k)
}

export function missingColumns(w: Widget, cols: ColMap): string[] {
  const missing = widgetColumns(w).filter((k) => !cols.has(k))
  for (const m of w.measures) if (m.agg === 'calc' && !measureDef(m, cols)) missing.push(m.calc ?? 'measure')
  return [...new Set(missing)]
}

// ---------- filters ----------

export function applyFilters(rows: Row[], filters: Filter[] | undefined, cols: Map<string, Column>): Row[] {
  const active = (resolveFilters(filters, rows) ?? []).filter((f) => cols.has(f.column) && isActive(f) && !(f.relative && f.min == null))
  if (!active.length) return rows
  const tests = active.map((f) => {
    const col = cols.get(f.column)!
    const set = f.values ? new Set(f.values) : null
    const text = f.text?.toLowerCase()
    return (r: Row) => {
      const v = r[f.column]
      let ok = true
      if (set) ok = set.has(labelOf(v, col))
      if (ok && f.min != null) ok = typeof v === 'number' && v >= f.min
      if (ok && f.max != null) ok = typeof v === 'number' && v <= f.max
      if (ok && text) ok = v != null && String(v).toLowerCase().includes(text)
      return f.exclude ? !ok : ok
    }
  })
  return rows.filter((r) => tests.every((t) => t(r)))
}

/** Same filters, ignoring ids and order — used to tell which saved view is showing. */
export function sameFilters(a: Filter[], b: Filter[]): boolean {
  const sig = (fs: Filter[]) => fs.filter(isActive).map(({ id: _id, fromWidget: _w, ...f }) => stable(f)).sort().join('|')
  return sig(a) === sig(b)
}

/** JSON with object keys sorted at every level (a key list passed to JSON.stringify would drop nested keys). */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}

export const isActive = (f: Filter) => !!(f.values?.length || f.min != null || f.max != null || f.text || f.relative)

/**
 * Turns a relative date filter into a fixed range ending at `latest` (the dataset's last date):
 * calendar → whole periods, the latest one included (latest month, last 3 months, year to date);
 * rolling → the last N units up to the latest date (last 30 days).
 */
export function resolveRelative(rel: NonNullable<Filter['relative']>, latest: number): { min: number; max: number } {
  const n = Math.max(1, Math.round(rel.last))
  const d = new Date(latest)
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate()
  if (rel.calendar) {
    const start = bucketDate(latest, rel.unit)
    const s = new Date(start)
    const back = {
      day: Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() - (n - 1)),
      week: Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() - 7 * (n - 1)),
      month: Date.UTC(s.getUTCFullYear(), s.getUTCMonth() - (n - 1), 1),
      quarter: Date.UTC(s.getUTCFullYear(), s.getUTCMonth() - 3 * (n - 1), 1),
      year: Date.UTC(s.getUTCFullYear() - (n - 1), 0, 1),
    }[rel.unit]
    return { min: back, max: nextBucket(latest, rel.unit) - 1 }
  }
  const min = {
    day: Date.UTC(y, m, day - n + 1),
    week: Date.UTC(y, m, day - 7 * n + 1),
    month: Date.UTC(y, m - n, day + 1),
    quarter: Date.UTC(y, m - 3 * n, day + 1),
    year: Date.UTC(y - n, m, day + 1),
  }[rel.unit]
  return { min, max: Date.UTC(y, m, day + 1) - 1 }
}

/** Fixes relative date filters against each column's latest date in `rows` (pass the whole dataset). */
export function resolveFilters(filters: Filter[] | undefined, rows: Row[]): Filter[] | undefined {
  if (!filters?.some((f) => f.relative)) return filters
  return filters.map((f) => {
    if (!f.relative) return f
    const latest = dateRange(rows, f.column)[1]
    return Number.isFinite(latest) ? { ...f, ...resolveRelative(f.relative, latest) } : f
  })
}

// dashboard filters are shared by every widget, so filter once per filter set
const filterCache = new WeakMap<Row[], Map<string, Row[]>>()

export function filteredRows(ds: DatasetLike, filters: Filter[] | undefined): Row[] {
  const cols = colMap(ds)
  const active = (resolveFilters(filters, ds.rows) ?? []).filter((f) => cols.has(f.column) && isActive(f))
  if (!active.length) return ds.rows
  const key = JSON.stringify(active.map(({ id: _id, fromWidget: _w, ...f }) => f))
  let m = filterCache.get(ds.rows)
  if (!m) filterCache.set(ds.rows, (m = new Map()))
  let hit = m.get(key)
  if (!hit) {
    hit = applyFilters(ds.rows, active, cols)
    if (m.size > 16) m.clear()
    m.set(key, hit)
  }
  return hit
}

/** Applies the drill-down stack: the deepest level's dimension, plus every level's filter. */
export function effective(w: Widget): Widget {
  if (!w.drill?.length) return w
  const last = w.drill[w.drill.length - 1]
  return { ...w, dimension: last.dimension, bucket: last.bucket, filters: [...(w.filters ?? []), ...w.drill.map((d) => d.filter)] }
}

function widgetRows(ds: DatasetLike, w: Widget, global: Filter[]) {
  const cols = colMap(ds)
  const all = filteredRows(ds, global)
  return { cols, all, rows: applyFilters(all, resolveFilters(w.filters, ds.rows), cols) }
}

/** The rows a widget is built from: page filters, its own filters and its drill-down path, optionally narrowed by one more filter (a clicked mark). */
export function rowsBehind(ds: DatasetLike, widget: Widget, global: Filter[] = [], extra: Omit<Filter, 'id'>[] = []): Row[] {
  const w = effective(widget)
  const { cols, rows } = widgetRows(ds, w, global)
  return extra.length ? applyFilters(rows, resolveFilters(extra.map((f, i) => ({ ...f, id: `extra_${i}` })), ds.rows), cols) : rows
}

/** String identity for categorical matching (filters, legends). */
export function labelOf(v: Value, col: Column): string {
  if (v == null || v === '') return BLANK
  if (col.type === 'boolean') return v ? 'Yes' : 'No'
  if (col.type === 'date' && typeof v === 'number') return fmtDate(v, col.grain === 'datetime' ? 'datetime' : col.grain ?? 'day')
  return String(v)
}

// ---------- aggregation ----------

export interface AggCtx { cols: ColMap; all: Row[] }

export function aggregate(rows: Row[], m: Measure, ctx?: AggCtx): number | null {
  if (m.agg === 'calc') {
    const def = ctx ? measureDef(m, ctx.cols) : undefined
    if (!def || !ctx) return null
    const compiled = getMeasure(def.formula, [...ctx.cols.values()])
    return compiled instanceof Error ? null : evalMeasure(compiled, rows, ctx.all)
  }
  if (m.agg === 'count' || !m.column) return rows.length
  const key = m.column
  if (m.agg === 'distinct') {
    const s = new Set<Value>()
    for (const r of rows) if (r[key] != null) s.add(r[key])
    return s.size
  }
  // sum / avg / min / max in one pass without building an array (hot path on large data)
  if (m.agg === 'sum' || m.agg === 'avg' || m.agg === 'min' || m.agg === 'max') {
    let n = 0, s = 0, lo = Infinity, hi = -Infinity
    for (let i = 0; i < rows.length; i++) {
      let v = rows[i][key]
      if (typeof v === 'boolean') v = v ? 1 : 0
      else if (typeof v !== 'number') continue
      n++; s += v
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (!n) return m.agg === 'sum' ? 0 : null
    return m.agg === 'sum' ? s : m.agg === 'avg' ? s / n : m.agg === 'min' ? lo : hi
  }
  const xs: number[] = []
  for (const r of rows) {
    const v = r[key]
    if (typeof v === 'number') xs.push(v)
    else if (typeof v === 'boolean') xs.push(v ? 1 : 0)
  }
  if (!xs.length) return null
  switch (m.agg) {
    case 'std': { const s = std(xs); return Number.isFinite(s) ? s : null }
    default: {
      const sorted = xs.sort((a, b) => a - b)
      return quantileSorted(sorted, m.agg === 'median' ? 0.5 : m.agg === 'p90' ? 0.9 : 0.1)
    }
  }
}

export const isAdditive = (m: Measure) => m.agg === 'count' || m.agg === 'sum' || m.agg === 'distinct'

// ---------- dates ----------

// date range per (rows, column): every auto-bucketed widget would otherwise rescan all rows
const rangeCache = new WeakMap<Row[], Map<string, [number, number]>>()

function dateRange(rows: Row[], key: string): [number, number] {
  let m = rangeCache.get(rows)
  if (!m) rangeCache.set(rows, (m = new Map()))
  let hit = m.get(key)
  if (!hit) {
    let min = Infinity, max = -Infinity
    for (let i = 0; i < rows.length; i++) {
      const v = rows[i][key]
      if (typeof v === 'number') { if (v < min) min = v; if (v > max) max = v }
    }
    m.set(key, (hit = [min, max]))
  }
  return hit
}

export function resolveBucket(col: Column, rows: Row[], bucket: DateBucket = 'auto'): Exclude<DateBucket, 'auto'> {
  if (bucket !== 'auto') return bucket
  if (col.grain === 'year') return 'year'
  const [min, max] = dateRange(rows, col.key)
  const days = (max - min) / 864e5
  if (!Number.isFinite(days)) return 'month'
  if (days <= 3 && col.grain === 'datetime') return 'hour'
  if (days <= 120 && col.grain !== 'month') return 'day'
  if (days <= 730 && col.grain !== 'month') return 'week'
  if (days <= 3650 * 1.2) return 'month'
  if (days <= 3650 * 3) return 'quarter'
  return 'year'
}

/** Start of the bucket after `t`'s bucket. */
export function nextBucket(t: number, b: Exclude<DateBucket, 'auto' | 'dow' | 'moy'>): number {
  const d = new Date(bucketDate(t, b))
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate()
  switch (b) {
    case 'hour': return +d + 36e5
    case 'day': return Date.UTC(y, m, day + 1)
    case 'week': return Date.UTC(y, m, day + 7)
    case 'month': return Date.UTC(y, m + 1, 1)
    case 'quarter': return Date.UTC(y, m + 3, 1)
    case 'year': return Date.UTC(y + 1, 0, 1)
  }
}

const yearEarlier = (t: number) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()) }

// ---------- grouping ----------

export interface GroupKeyFn {
  key: (r: Row) => string | number
  label: (k: string | number) => string
  /** natural order for keys */
  compare: (a: string | number, b: string | number) => number
  isTime: boolean
  bucket?: Exclude<DateBucket, 'auto'>
  /** filter that selects one key (cross-filtering and drill-down) */
  filterFor: (k: string | number) => Omit<Filter, 'id'>
}

export function groupKeyFn(col: Column, rows: Row[], bucket?: DateBucket, bins = 10): GroupKeyFn {
  const numCmp = (a: string | number, b: string | number) =>
    typeof a === 'number' && typeof b === 'number' ? a - b : typeof a === 'number' ? -1 : typeof b === 'number' ? 1 : String(a).localeCompare(String(b))
  const blankFilter = (): Omit<Filter, 'id'> => ({ column: col.key, values: [BLANK] })
  if (col.type === 'date') {
    const b = resolveBucket(col, rows, bucket)
    const isTime = b !== 'dow' && b !== 'moy'
    // many rows share a timestamp: compute each bucket once (bucketDate allocates a Date)
    const memo = new Map<number, number>()
    const k = col.key
    return {
      key: (r) => {
        const t = r[k]
        if (typeof t !== 'number') return BLANK
        let v = memo.get(t)
        if (v === undefined) { v = bucketDate(t, b); if (memo.size < 500_000) memo.set(t, v) }
        return v
      },
      label: (k) => (typeof k === 'number' ? fmtDate(k, b) : String(k)),
      compare: numCmp, isTime, bucket: b,
      filterFor: (k) => (typeof k === 'number' && isTime ? { column: col.key, min: k, max: nextBucket(k, b as never) - 1 } : blankFilter()),
    }
  }
  if (col.type === 'number' && !col.discrete) {
    let min = Infinity, max = -Infinity, n = 0
    for (const r of rows) { const v = r[col.key]; if (typeof v === 'number') { n++; if (v < min) min = v; if (v > max) max = v } }
    const nb = n ? niceBins(min, max, bins) : { start: 0, width: 1, count: 1 }
    return {
      key: (r) => (typeof r[col.key] === 'number' ? nb.start + Math.floor(((r[col.key] as number) - nb.start) / nb.width) * nb.width : BLANK),
      label: (k) => (typeof k === 'number' ? `${fmtNumber(k, col)}–${fmtNumber(k + nb.width, col)}` : String(k)),
      compare: numCmp, isTime: false,
      filterFor: (k) => (typeof k === 'number' ? { column: col.key, min: k, max: k + nb.width - 1e-9 } : blankFilter()),
    }
  }
  if (col.type === 'number') {
    return {
      key: (r) => (typeof r[col.key] === 'number' ? (r[col.key] as number) : BLANK),
      label: (k) => (typeof k === 'number' ? fmtNumber(k, col, { compact: false }) : String(k)),
      compare: numCmp, isTime: false,
      filterFor: (k) => (typeof k === 'number' ? { column: col.key, min: k, max: k } : blankFilter()),
    }
  }
  return {
    key: (r) => labelOf(r[col.key], col),
    label: (k) => String(k),
    compare: (a, b) => (a === BLANK ? 1 : b === BLANK ? -1 : String(a).localeCompare(String(b), undefined, { numeric: true })),
    isTime: false,
    filterFor: (k) => ({ column: col.key, values: [String(k)] }),
  }
}

function groupRows(rows: Row[], fn: GroupKeyFn): Map<string | number, Row[]> {
  const g = new Map<string | number, Row[]>()
  const key = fn.key
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const k = key(r)
    let arr = g.get(k)
    if (!arr) g.set(k, (arr = []))
    arr.push(r)
  }
  return g
}

export interface Series {
  name: string
  values: (number | null)[]
  measure: Measure
  /** comparison series (previous year / period): drawn muted */
  ghost?: boolean
  /** split-by key per series, for cross-filtering on series clicks */
  key?: string | number
}
export interface GroupResult {
  categories: string[]
  categoryKeys: (string | number)[]
  series: Series[]
  isTime: boolean
  bucket?: Exclude<DateBucket, 'auto'>
  dimension?: Column
  splitBy?: Column
  total: number
  /** builds a filter for a clicked category / series */
  filterFor?: GroupKeyFn['filterFor']
  seriesFilterFor?: GroupKeyFn['filterFor']
}

const MAX_SERIES = 8

export function runGrouped(ds: DatasetLike, widget: Widget, globalFilters: Filter[] = []): GroupResult {
  const w = effective(widget)
  const { cols, all, rows } = widgetRows(ds, w, globalFilters)
  const ctx: AggCtx = { cols, all }
  const measures = w.measures.length ? w.measures : [{ id: 'count', agg: 'count' as Agg }]
  const dimCol = w.dimension ? cols.get(w.dimension) : undefined
  const fn = dimCol ? groupKeyFn(dimCol, rows, w.bucket) : null
  const groups = fn ? groupRows(rows, fn) : new Map<string | number, Row[]>([['All', rows]])
  let keys = [...groups.keys()]

  const splitCol = w.series ? cols.get(w.series) : undefined
  const primary = measures[0]

  // rank categories by the primary measure for sorting / top N
  const score = new Map(keys.map((k) => [k, aggregate(groups.get(k)!, primary, ctx) ?? -Infinity]))
  const sort = w.sort ?? (fn?.isTime || dimCol?.type === 'number' || fn?.bucket ? 'natural' : 'value-desc')
  const cmp = fn?.compare ?? (() => 0)
  if (sort === 'natural' || sort === 'label-asc') keys.sort(cmp)
  else if (sort === 'label-desc') keys.sort((a, b) => cmp(b, a))
  else if (sort === 'value-asc') keys.sort((a, b) => score.get(a)! - score.get(b)!)
  else keys.sort((a, b) => score.get(b)! - score.get(a)!)

  // top N folds the tail into "Other" (never for time axes, where the tail is real history)
  if (w.limit && keys.length > w.limit && !fn?.isTime) {
    const byScore = [...keys].sort((a, b) => score.get(b)! - score.get(a)!)
    const keep = new Set(byScore.slice(0, w.limit))
    const rest = keys.filter((k) => !keep.has(k)).flatMap((k) => groups.get(k)!)
    keys = keys.filter((k) => keep.has(k))
    if (rest.length) { groups.set(OTHER, rest); keys.push(OTHER) }
  }

  let series: Series[]
  let sfn: GroupKeyFn | undefined
  if (splitCol) {
    sfn = groupKeyFn(splitCol, rows, 'auto', 6)
    const skey = sfn.key
    // one pass: category → series key → rows, plus rows per series for ranking
    const cells = new Map<string | number, Map<string | number, Row[]>>()
    const sGroups = new Map<string | number, Row[]>()
    for (const k of keys) {
      const m = new Map<string | number, Row[]>()
      const rs = groups.get(k)!
      for (let i = 0; i < rs.length; i++) {
        const r = rs[i]
        const sk = skey(r)
        let arr = m.get(sk)
        if (!arr) m.set(sk, (arr = []))
        arr.push(r)
        let all = sGroups.get(sk)
        if (!all) sGroups.set(sk, (all = []))
        all.push(r)
      }
      cells.set(k, m)
    }
    let sKeys = [...sGroups.keys()].sort((a, b) => (aggregate(sGroups.get(b)!, primary, ctx) ?? 0) - (aggregate(sGroups.get(a)!, primary, ctx) ?? 0))
    const overflow = sKeys.length > MAX_SERIES
    const kept = new Set(overflow ? sKeys.slice(0, MAX_SERIES - 1) : sKeys)
    // grids (heatmaps) read best in natural order; stacked series read best largest-first
    sKeys = sfn.isTime || splitCol.type === 'number' || w.type === 'heatmap' ? [...kept].sort(sfn.compare) : [...kept]
    // fold series past the cap into "Other" per cell
    if (overflow) {
      for (const m of cells.values()) {
        const other: Row[] = []
        for (const [sk, rs] of m) if (!kept.has(sk)) { for (const r of rs) other.push(r); m.delete(sk) }
        if (other.length) m.set(OTHER, other)
      }
    }
    const additive = isAdditive(primary)
    const seriesKeys: (string | number)[] = overflow ? [...sKeys, OTHER] : sKeys
    series = seriesKeys.map((sk) => ({
      name: sk === OTHER ? OTHER : sfn!.label(sk),
      key: sk,
      measure: primary,
      values: keys.map((k) => {
        const sub = cells.get(k)!.get(sk)
        // additive measures are 0 for an empty cell, which keeps stacks and lines continuous
        return sub?.length ? aggregate(sub, primary, ctx) : additive ? 0 : null
      }),
    }))
  } else {
    series = measures.map((m, i) => ({
      name: measureLabel(m, cols), measure: m,
      // the ranking pass already aggregated the primary measure per group
      values: keys.map((k) => (i === 0 && k !== OTHER ? (score.get(k) === -Infinity ? null : score.get(k)!) : aggregate(groups.get(k)!, m, ctx))),
    }))
  }

  if (w.cumulative) {
    for (const s of series) {
      let acc = 0
      s.values = s.values.map((v) => (v == null ? acc : (acc += v)))
    }
  }

  // comparison: same period a year earlier, or the previous period
  if (w.compare && w.compare !== 'none' && fn?.isTime && !splitCol && series.length === 1) {
    const s = series[0]
    const values = w.compare === 'yoy'
      ? keys.map((k) => {
          if (typeof k !== 'number') return null
          const prev = groups.get(bucketDate(yearEarlier(k), fn.bucket!))
          return prev?.length ? aggregate(prev, s.measure, ctx) : null
        })
      : s.values.map((_, i) => (i > 0 ? s.values[i - 1] : null))
    series.push({ name: w.compare === 'yoy' ? 'Previous year' : 'Previous period', values, measure: s.measure, ghost: true })
  }

  if (w.normalized && series.length > 1) {
    keys.forEach((_, i) => {
      const t = series.reduce((a, s) => a + (s.ghost ? 0 : s.values[i] ?? 0), 0)
      for (const s of series) if (!s.ghost) s.values[i] = t ? ((s.values[i] ?? 0) / t) * 100 : null
    })
  }

  return {
    categories: keys.map((k) => (k === OTHER ? OTHER : fn ? fn.label(k) : String(k))),
    categoryKeys: keys,
    series, isTime: !!fn?.isTime, bucket: fn?.bucket,
    dimension: dimCol, splitBy: splitCol, total: rows.length,
    filterFor: fn?.filterFor, seriesFilterFor: sfn?.filterFor,
  }
}

/**
 * Extra tooltip lines per category of a grouped chart: numbers aggregated with `aggOf` (the chart default for the
 * column), dates as the latest one, categories as their most common value.
 */
export function groupExtras(ds: DatasetLike, widget: Widget, globalFilters: Filter[], fields: string[], aggOf: (c: Column) => Agg): Map<string | number, [string, string][]> {
  const w = effective(widget)
  const { cols, all, rows } = widgetRows(ds, w, globalFilters)
  const dimCol = w.dimension ? cols.get(w.dimension) : undefined
  const out = new Map<string | number, [string, string][]>()
  const used = fields.map((f) => cols.get(f)).filter((c): c is Column => !!c)
  if (!dimCol || !used.length) return out
  const groups = groupRows(rows, groupKeyFn(dimCol, rows, w.bucket))
  const ctx: AggCtx = { cols, all }
  for (const [k, rs] of groups) {
    out.set(k, used.map((c): [string, string] => {
      if (c.type === 'number' || c.type === 'boolean') {
        const agg = c.type === 'boolean' ? 'avg' : aggOf(c)
        return [`${AGG_LABEL[agg]} of ${c.name}`, fmtNumber(aggregate(rs, { id: 'x', column: c.key, agg }, ctx), c.type === 'boolean' ? { ...c, format: 'ratio' } : c)]
      }
      if (c.type === 'date') {
        let hi = -Infinity
        for (const r of rs) { const v = r[c.key]; if (typeof v === 'number' && v > hi) hi = v }
        return [`Latest ${c.name}`, Number.isFinite(hi) ? labelOf(hi, c) : '—']
      }
      const counts = new Map<string, number>()
      for (const r of rs) { const l = labelOf(r[c.key], c); counts.set(l, (counts.get(l) ?? 0) + 1) }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
      return [c.name, sorted.length ? `${sorted[0][0]}${sorted.length > 1 ? ` (+${sorted.length - 1} more)` : ''}` : '—']
    }))
  }
  return out
}

// ---------- KPI ----------

export interface KpiResult {
  value: number | null
  spark?: { label: string; value: number | null }[]
  delta?: number
  deltaLabel?: string
  rows: number
  /** label of a trailing partial period left out of the comparison */
  partial?: string
  /** the value's period when kpiMode is 'latest' */
  period?: string
  /** the rows of that period, for "Show rows" */
  periodFilter?: Omit<Filter, 'id'>
  target?: number
}

export function runKpi(ds: DatasetLike, widget: Widget, globalFilters: Filter[] = []): KpiResult {
  const w = effective(widget)
  const { cols, all, rows } = widgetRows(ds, w, globalFilters)
  const ctx: AggCtx = { cols, all }
  const m = w.measures[0] ?? { id: 'c', agg: 'count' }
  const dateCol = w.dimension && cols.get(w.dimension)?.type === 'date' ? cols.get(w.dimension) : undefined
  if (!dateCol) return { value: aggregate(rows, m, ctx), rows: rows.length, target: w.target }

  // the comparison and sparkline look past date filters on the KPI's own date column:
  // with the page set to "latest month", the value is that month and the change is vs the month before
  const notDate = (f: Filter) => f.column !== dateCol.key
  const dateFiltered = (globalFilters.some((f) => !notDate(f) && isActive(f)) || (w.filters ?? []).some((f) => !notDate(f) && isActive(f)))
  const context = dateFiltered ? applyFilters(filteredRows(ds, globalFilters.filter(notDate)), resolveFilters(w.filters?.filter(notDate), ds.rows), cols) : rows
  const fn = groupKeyFn(dateCol, context, w.bucket ?? 'auto')
  const g = groupRows(context, fn)
  let keys = [...g.keys()].filter((k): k is number => typeof k === 'number').sort((a, b) => a - b)
  if (dateFiltered) {
    // the latest period is the latest one inside the filter
    let maxIn = -Infinity
    for (const r of rows) { const v = r[dateCol.key]; if (typeof v === 'number' && v > maxIn) maxIn = v }
    const lastIn = Number.isFinite(maxIn) ? fn.key({ [dateCol.key]: maxIn }) : undefined
    if (typeof lastIn === 'number') keys = keys.filter((k) => k <= lastIn)
  }

  // a period that hasn't finished yet (data stops mid-month) would make any comparison misleading
  // (yearly data dated Jan 1 is complete by definition, so completeness is judged at the column's own grain)
  let partial: string | undefined
  const finer = { datetime: 0, day: 1, month: 2, year: 3 }[dateCol.grain ?? 'day']
  const coarse = { hour: 0, day: 1, week: 1.5, month: 2, quarter: 2.5, year: 3, dow: -1, moy: -1 }[fn.bucket ?? 'day']
  if (fn.isTime && fn.bucket && coarse > finer && fn.bucket !== 'hour' && keys.length > 2) {
    // judged on the whole dataset: a filter (e.g. rainy days only) mustn't make the last month look unfinished
    const maxT = dateRange(ds.rows, dateCol.key)[1]
    const last = keys[keys.length - 1]
    const end = nextBucket(last, fn.bucket as never)
    const e = new Date(end)
    // the last expected data point of a complete period, one grain unit before its end
    const lastExpected = dateCol.grain === 'month' ? Date.UTC(e.getUTCFullYear(), e.getUTCMonth() - 1, 1) : end - 864e5
    if (maxT < lastExpected) {
      partial = fn.label(last)
      keys = keys.slice(0, -1)
    }
  }

  const spark = keys.slice(-24).map((k) => ({ label: fn.label(k), value: aggregate(g.get(k)!, m, ctx) }))
  const lastKey = keys[keys.length - 1]
  const latest = lastKey != null ? aggregate(g.get(lastKey)!, m, ctx) : null
  const value = w.kpiMode === 'latest' && !dateFiltered ? latest : aggregate(rows, m, ctx)

  let delta: number | undefined
  let deltaLabel: string | undefined
  const compare = w.compare ?? 'previous'
  if (compare !== 'none' && lastKey != null) {
    const prevKey = compare === 'yoy' ? bucketDate(yearEarlier(lastKey), fn.bucket!) : keys[keys.length - 2]
    const prev = prevKey != null && g.get(prevKey)?.length ? aggregate(g.get(prevKey)!, m, ctx) : null
    if (prev != null && latest != null && prev !== 0) {
      delta = (latest - prev) / Math.abs(prev)
      deltaLabel = `${fn.label(lastKey)} vs ${fn.label(prevKey!)}`
    }
  }
  const latestShown = w.kpiMode === 'latest' && !dateFiltered && lastKey != null && fn.bucket && fn.bucket !== 'dow' && fn.bucket !== 'moy'
  const periodFilter = latestShown ? { column: dateCol.key, min: lastKey, max: nextBucket(lastKey, fn.bucket as never) - 1 } : undefined
  return { value, spark, delta, deltaLabel, rows: rows.length, partial, period: w.kpiMode === 'latest' && lastKey != null ? fn.label(lastKey) : undefined, periodFilter, target: w.target }
}

// ---------- scatter ----------

export interface ScatterResult {
  groups: { name: string; points: [number, number][]; extra: Value[][] }[]
  regression?: { slope: number; intercept: number; r2: number; r: number }
  xCol?: Column
  yCol?: Column
  extraCols: Column[]
  sampled: boolean
}

export function runScatter(ds: DatasetLike, widget: Widget, globalFilters: Filter[] = []): ScatterResult {
  const w = effective(widget)
  const { cols, rows } = widgetRows(ds, w, globalFilters)
  const xCol = w.x ? cols.get(w.x) : undefined
  const yCol = w.y ? cols.get(w.y) : undefined
  const extraCols = (w.tooltipFields ?? []).map((k) => cols.get(k)).filter((c): c is Column => !!c)
  if (!xCol || !yCol) return { groups: [], sampled: false, extraCols }
  const colorCol = w.color ? cols.get(w.color) : undefined
  let pts = rows.filter((r) => typeof r[xCol.key] === 'number' && typeof r[yCol.key] === 'number')
  const sampled = pts.length > 4000
  if (sampled) { const step = pts.length / 4000; pts = Array.from({ length: 4000 }, (_, i) => pts[Math.floor(i * step)]) }
  const xs = pts.map((r) => r[xCol.key] as number)
  const ys = pts.map((r) => r[yCol.key] as number)
  const extraOf = (r: Row) => extraCols.map((c) => r[c.key])
  let groups: ScatterResult['groups']
  if (colorCol) {
    // scatter compares every pair of colors, so it's capped at 3 categories + Other
    const counts = new Map<string, number>()
    for (const r of pts) { const l = labelOf(r[colorCol.key], colorCol); counts.set(l, (counts.get(l) ?? 0) + 1) }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
    const keep = top.length > 4 ? top.slice(0, 3) : top
    const map = new Map<string, { points: [number, number][]; extra: Value[][] }>(keep.map((k) => [k, { points: [], extra: [] }]))
    if (top.length > keep.length) map.set(OTHER, { points: [], extra: [] })
    pts.forEach((r, i) => {
      const g = map.get(labelOf(r[colorCol.key], colorCol)) ?? map.get(OTHER)!
      g.points.push([xs[i], ys[i]])
      g.extra.push(extraOf(r))
    })
    groups = [...map.entries()].map(([name, g]) => ({ name, ...g }))
  } else {
    groups = [{ name: yCol.name, points: xs.map((x, i) => [x, ys[i]]), extra: pts.map(extraOf) }]
  }
  let regression: ScatterResult['regression']
  if (xs.length > 2) {
    const r = pearson(xs, ys)
    const mx = mean(xs), my = mean(ys)
    let sxy = 0, sxx = 0
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2 }
    const slope = sxx ? sxy / sxx : 0
    regression = { slope, intercept: my - slope * mx, r2: r * r, r }
  }
  return { groups, regression, xCol, yCol, extraCols, sampled }
}

// ---------- histogram / box / correlation ----------

export function runHistogram(ds: DatasetLike, widget: Widget, globalFilters: Filter[] = []) {
  const w = effective(widget)
  const { cols, rows } = widgetRows(ds, w, globalFilters)
  const key = w.x ?? w.measures[0]?.column
  const col = key ? cols.get(key) : undefined
  if (!col) return { bins: [], col }
  const xs: number[] = []
  for (const r of rows) { const v = r[col.key]; if (typeof v === 'number') xs.push(v) }
  return { bins: histogram(xs, w.bins ?? 20), col, n: xs.length, mean: mean(xs) }
}

export function runBox(ds: DatasetLike, widget: Widget, globalFilters: Filter[] = []) {
  const w = effective(widget)
  const { cols, rows } = widgetRows(ds, w, globalFilters)
  const col = w.y ? cols.get(w.y) : w.measures[0]?.column ? cols.get(w.measures[0].column!) : undefined
  if (!col) return { items: [], col }
  const dimCol = w.dimension ? cols.get(w.dimension) : undefined
  const fn = dimCol ? groupKeyFn(dimCol, rows, w.bucket) : null
  const groups = fn ? groupRows(rows, fn) : new Map<string | number, Row[]>([[col.name, rows]])
  let keys = [...groups.keys()]
  if (fn) keys.sort(fn.compare)
  if (!fn?.isTime && keys.length > 12) keys = keys.sort((a, b) => groups.get(b)!.length - groups.get(a)!.length).slice(0, 12)
  const items = keys.map((k) => {
    const xs = groups.get(k)!.map((r) => r[col.key]).filter((v): v is number => typeof v === 'number')
    return { name: fn ? fn.label(k) : String(k), key: k, n: xs.length, ...(xs.length ? fiveNumber(xs) : null) }
  }).filter((d) => d.n > 0)
  return { items, col, dimCol, filterFor: fn?.filterFor }
}

export function correlationMatrix(ds: DatasetLike, keys: string[], globalFilters: Filter[] = []) {
  const cols = colMap(ds)
  const rows = filteredRows(ds, globalFilters)
  const matrix: number[][] = keys.map(() => keys.map(() => NaN))
  for (let i = 0; i < keys.length; i++) {
    for (let j = i; j < keys.length; j++) {
      const xs: number[] = [], ys: number[] = []
      for (const r of rows) {
        const a = r[keys[i]], b = r[keys[j]]
        if (typeof a === 'number' && typeof b === 'number') { xs.push(a); ys.push(b) }
      }
      const r = i === j ? 1 : pearson(xs, ys)
      matrix[i][j] = matrix[j][i] = r
    }
  }
  return { keys, names: keys.map((k) => cols.get(k)?.name ?? k), matrix }
}

// ---------- pivot ----------

export interface PivotResult {
  rowHeaders: string[][]
  colHeaders: string[]
  cells: (number | null)[][]
  rowTotals: (number | null)[]
  colTotals: (number | null)[]
  grand: number | null
  /** groups left out by the row / column caps */
  hiddenRows: number
  hiddenCols: number
}

export const PIVOT_MAX_ROWS = 500
export const PIVOT_MAX_COLS = 60

export function runPivot(ds: DatasetLike, rowDims: string[], colDim: string | undefined, m: Measure, filters: Filter[], buckets: Record<string, DateBucket> = {}): PivotResult {
  const cols = colMap(ds)
  const rows = filteredRows(ds, filters)
  const ctx: AggCtx = { cols, all: rows }
  const rFns = rowDims.map((d) => groupKeyFn(cols.get(d)!, rows, buckets[d]))
  const cFn = colDim ? groupKeyFn(cols.get(colDim)!, rows, buckets[colDim]) : null
  const rowGroups = new Map<string, { parts: (string | number)[]; rows: Row[]; byCol: Map<string | number, Row[]> }>()
  const colGroups = new Map<string | number, Row[]>()
  for (const r of rows) {
    const parts = rFns.map((f) => f.key(r))
    const k = JSON.stringify(parts)
    let g = rowGroups.get(k)
    if (!g) rowGroups.set(k, (g = { parts, rows: [], byCol: new Map() }))
    g.rows.push(r)
    if (cFn) {
      const ck = cFn.key(r)
      let a = g.byCol.get(ck)
      if (!a) g.byCol.set(ck, (a = []))
      a.push(r)
      let c = colGroups.get(ck)
      if (!c) colGroups.set(ck, (c = []))
      c.push(r)
    }
  }
  const sortedRows = [...rowGroups.values()].sort((a, b) => {
    for (let i = 0; i < rFns.length; i++) { const c = rFns[i].compare(a.parts[i], b.parts[i]); if (c) return c }
    return 0
  })
  const rowList = sortedRows.slice(0, PIVOT_MAX_ROWS)
  const allColKeys = cFn ? [...colGroups.keys()].sort(cFn.compare) : []
  const colKeys = allColKeys.slice(0, PIVOT_MAX_COLS)
  return {
    rowHeaders: rowList.map((g) => g.parts.map((p, i) => rFns[i].label(p))),
    colHeaders: cFn ? colKeys.map((k) => cFn.label(k)) : [],
    cells: rowList.map((g) => colKeys.map((ck) => { const sub = g.byCol.get(ck); return sub?.length ? aggregate(sub, m, ctx) : null })),
    rowTotals: rowList.map((g) => aggregate(g.rows, m, ctx)),
    colTotals: colKeys.map((ck) => aggregate(colGroups.get(ck)!, m, ctx)),
    grand: aggregate(rows, m, ctx),
    hiddenRows: sortedRows.length - rowList.length,
    hiddenCols: allColKeys.length - colKeys.length,
  }
}
