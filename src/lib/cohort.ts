// Cohort tables: entities (customers, users…) grouped by the period they were first seen, and how many of each
// cohort are active in each later period.

import type { Dataset, Filter, Row, Widget } from '../types'
import { colMap, nextBucket, rowsBehind } from './aggregate'
import { bucketDate } from './dates'
import { fmtDate } from './format'

export type CohortBucket = 'day' | 'week' | 'month' | 'quarter' | 'year'

export interface CohortRow {
  label: string
  /** entities first seen in this period */
  size: number
  /** active entities per period offset (0 = the first period); null where the data doesn't reach yet */
  active: (number | null)[]
  /** start of the cohort's first period */
  start: number
  /** the entities in the cohort (for "Show rows") */
  members: string[]
}
export interface CohortResult {
  cohorts: CohortRow[]
  periods: number
  bucket: CohortBucket
  /** a word for one period: "Month", "Week"… */
  unit: string
}

const MAX = 24

/** Whole periods from a to b (both bucket starts). */
function offset(a: number, b: number, bucket: CohortBucket): number {
  const x = new Date(a), y = new Date(b)
  const months = (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + y.getUTCMonth() - x.getUTCMonth()
  switch (bucket) {
    case 'day': return Math.round((b - a) / 864e5)
    case 'week': return Math.round((b - a) / (7 * 864e5))
    case 'month': return months
    case 'quarter': return Math.floor(months / 3)
    case 'year': return y.getUTCFullYear() - x.getUTCFullYear()
  }
}

const label = (t: number, b: CohortBucket) =>
  b === 'month' ? fmtDate(t, 'month') : b === 'year' ? String(new Date(t).getUTCFullYear())
    : b === 'quarter' ? `Q${Math.floor(new Date(t).getUTCMonth() / 3) + 1} ${new Date(t).getUTCFullYear()}`
      : b === 'week' ? `Wk of ${fmtDate(t)}` : fmtDate(t)

export function cohortBucket(w: Widget): CohortBucket {
  const b = w.bucket
  return b === 'day' || b === 'week' || b === 'quarter' || b === 'year' ? b : 'month'
}

export function runCohort(ds: Dataset, w: Widget, filters: Filter[] = []): CohortResult | null {
  const cols = colMap(ds)
  const date = w.dimension ? cols.get(w.dimension) : undefined
  const entity = w.entity ? cols.get(w.entity) : undefined
  const bucket = cohortBucket(w)
  const unit = { day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' }[bucket]
  if (!date || date.type !== 'date' || !entity) return null
  const rows: Row[] = rowsBehind(ds, w, filters)
  // each entity's first period, and the periods it was active in
  const first = new Map<string, number>()
  const seen = new Map<string, Set<number>>()
  let last = -Infinity
  for (const r of rows) {
    const t = r[date.key], e = r[entity.key]
    if (typeof t !== 'number' || e == null || e === '') continue
    const k = String(e)
    const b = bucketDate(t, bucket)
    if (b > last) last = b
    const f = first.get(k)
    if (f == null || b < f) first.set(k, b)
    let s = seen.get(k)
    if (!s) seen.set(k, (s = new Set()))
    s.add(b)
  }
  if (!first.size) return { cohorts: [], periods: 0, bucket, unit }
  const byCohort = new Map<number, { size: number; active: Map<number, number>; members: string[] }>()
  for (const [k, f] of first) {
    let c = byCohort.get(f)
    if (!c) byCohort.set(f, (c = { size: 0, active: new Map(), members: [] }))
    c.size++
    c.members.push(k)
    for (const b of seen.get(k)!) {
      const o = offset(f, b, bucket)
      c.active.set(o, (c.active.get(o) ?? 0) + 1)
    }
  }
  const starts = [...byCohort.keys()].sort((a, b) => a - b).slice(-MAX)
  const periods = Math.min(MAX, offset(starts[0], last, bucket) + 1)
  const cohorts = starts.map((s) => {
    const c = byCohort.get(s)!
    const reach = offset(s, last, bucket)
    return { label: label(s, bucket), size: c.size, start: s, members: c.members, active: Array.from({ length: periods }, (_, o) => (o > reach ? null : c.active.get(o) ?? 0)) }
  })
  return { cohorts, periods, bucket, unit }
}

/** Average retention per period across cohorts that reach it, weighted by cohort size. */
export function averageRetention(r: CohortResult): (number | null)[] {
  return Array.from({ length: r.periods }, (_, o) => {
    let n = 0, d = 0
    for (const c of r.cohorts) { const v = c.active[o]; if (v != null) { n += v; d += c.size } }
    return d ? n / d : null
  })
}

/** Filters for the rows behind one cell: the cohort's entities, within that period. */
export function cohortCellFilters(w: Widget, row: CohortRow, offset: number): Omit<Filter, 'id'>[] {
  const bucket = cohortBucket(w)
  let from = row.start
  for (let i = 0; i < offset; i++) from = nextBucket(from, bucket)
  return [
    { column: w.entity!, values: row.members },
    { column: w.dimension!, min: from, max: nextBucket(from, bucket) - 1 },
  ]
}
