import type { Agg, Column, Dataset, Measure, Widget } from '../types'
import { correlationMatrix, measureLabel, colMap } from './aggregate'
import { dimensionCols, measureCols } from './profile'
import { detectGeo, detectLatLon } from './geo'
import { labelOf } from './aggregate'
import { nameWords } from './infer'

let seq = 0
export const uid = (p = 'w') => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`

// Names are matched on whole words (after splitting on separators and camelCase), so "discount" is not a count,
// "operating" is not a "per" and "usage" is not an age.
const words = (...w: string[]) => new Set(w)
const ADDITIVE_WORDS = words(
  'sales', 'sale', 'revenue', 'amount', 'amt', 'total', 'subtotal', 'sum', 'count', 'cnt', 'qty', 'quantity', 'units', 'gross', 'net', 'profit', 'cost', 'costs', 'spend', 'spent',
  'pop', 'population', 'volume', 'orders', 'votes', 'budget', 'income', 'precip', 'precipitation', 'rain', 'rainfall', 'snow', 'snowfall', 'unemployed', 'sold', 'clicks', 'views', 'visits',
  'deaths', 'cases', 'weight', 'tax', 'taxes', 'vat', 'fee', 'fees', 'shipping', 'freight', 'tip', 'tips', 'hours', 'hrs', 'minutes', 'mins', 'seconds', 'duration', 'distance', 'miles', 'km',
  'salary', 'salaries', 'payroll', 'wages', 'expense', 'expenses', 'payment', 'payments', 'refund', 'refunds', 'downloads', 'impressions', 'sessions', 'signups', 'purchases', 'earnings', 'donations',
)
/** the name says outright that the values are already averaged or relative */
const RELATIVE_WORDS = words('rate', 'ratio', 'avg', 'average', 'mean', 'median', 'pct', 'percent', 'percentage', '%', 'per', 'share', 'index', 'margin')
const AVG_WORDS = words(
  'price', 'rating', 'score', 'temp', 'temperature', 'age', 'speed', 'mpg', 'expect', 'expectancy', 'fertility', 'length', 'depth', 'width', 'height', 'acceleration', 'horsepower', 'displacement',
  'wind', 'mm', 'cm', 'min', 'max', 'minimum', 'maximum', 'latitude', 'longitude', 'lat', 'lon', 'lng', 'grade', 'rank', 'level', 'density', 'pressure', 'humidity', 'bmi',
)
const SNAPSHOT_WORDS = words('pop', 'population', 'balance', 'inventory', 'stock', 'level', 'headcount', 'employees', 'members', 'subscribers', 'outstanding', 'capacity')
/** columns that name the steps of a process: a funnel */
export const STAGE_RE = /\b(stage|step|status|funnel|phase|pipeline)\b/i
/** columns that identify who comes back: a cohort table */
export const ENTITY_RE = /\b(customer|user|client|account|member|visitor|patient|subscriber|player|student)s?\b.*\b(id|no|number|key|code)?$/i

const has = (set: Set<string>, w: string[]) => w.some((x) => set.has(x))

/** What the column's name says about adding it up: 'sum', 'avg', or nothing. */
export function nameAgg(key: string): 'sum' | 'avg' | undefined {
  const w = nameWords(key)
  if (has(RELATIVE_WORDS, w)) return 'avg'
  // "Discount amount", "Total price": the additive word decides
  if (w.includes('total') || w.includes('sum') || w.includes('amount')) return 'sum'
  // a unit written last: body_mass_g
  if (has(AVG_WORDS, w) || (w.length > 1 && w[w.length - 1] === 'g')) return 'avg'
  if (has(ADDITIVE_WORDS, w)) return 'sum'
  return undefined
}

const isSnapshot = (key: string) => has(SNAPSHOT_WORDS, nameWords(key))

/**
 * Sum or average, when nothing else is known. The name decides first; then the format; then the values:
 * fractions and 0–100 scores are averaged; whole non-negative numbers with many different values that reach down
 * toward zero are counts to add up. Whole numbers in a narrow band (129,726–143,093) are levels, and stay averaged.
 */
export function defaultAgg(c: Column): Agg {
  const named = nameAgg(c.key)
  if (named) return named
  if (c.format === 'percent' || c.format === 'ratio') return 'avg'
  if (c.format === 'currency') return 'sum'
  if (c.range) {
    const [lo, hi] = c.range
    if (lo >= 0 && hi <= 1) return 'avg'
    if (lo >= 0 && hi <= 100) return 'avg'
    if (lo >= 0 && c.format === 'integer' && c.distinct > 20 && lo <= hi * 0.1) return 'sum'
  }
  return 'avg'
}

const m = (c: Column | undefined, agg?: Agg): Measure =>
  c ? { id: uid('m'), column: c.key, agg: agg ?? defaultAgg(c) } : { id: uid('m'), agg: 'count' }

/** Measures ranked: additive columns first, then fewest missing values. */
export function rankMeasures(ds: Dataset): Column[] {
  // coordinates are locations, not quantities to add up or average
  const ll = detectLatLon(ds.columns, ds.rows)
  return measureCols(ds)
    .filter((c) => !c.discrete && c.key !== ll?.lat && c.key !== ll?.lon)
    .sort((a, b) => Number(nameAgg(b.key) === 'sum') - Number(nameAgg(a.key) === 'sum') || a.missing - b.missing)
}

/** Dimensions ranked toward 3–12 distinct values; discrete numbers (cylinders, cluster) count too. */
function rankDims(ds: Dataset): Column[] {
  const dims = [
    ...dimensionCols(ds),
    ...ds.columns.filter((c) => c.type === 'number' && c.discrete && c.distinct >= 2),
    ...ds.columns.filter((c) => c.type === 'date' && c.distinct >= 2 && c.distinct < 4),
  ]
  const score = (c: Column) => (c.distinct >= 3 && c.distinct <= 20 ? 0 : c.distinct === 2 ? 1 : 2) + c.missing / Math.max(1, ds.rows.length) + (c.type === 'number' ? 1.5 : 0)
  return dims.sort((a, b) => score(a) - score(b))
}

export interface Suggestions { widgets: Widget[]; extra: Widget[] }

/** A category that names process steps (3–10 of them), for a funnel. */
export function stageColumn(ds: Dataset): Column | undefined {
  return ds.columns.find((c) => c.type === 'category' && STAGE_RE.test(c.name) && c.distinct >= 3 && c.distinct <= 10)
}

/** An ID that repeats across rows (a customer seen several times), for a cohort table. */
export function entityColumn(ds: Dataset): Column | undefined {
  const repeats = (c: Column) => c.distinct >= 20 && c.distinct < ds.rows.length * 0.8
  return ds.columns.find((c) => c.type !== 'date' && c.type !== 'boolean' && ENTITY_RE.test(c.name) && repeats(c))
    ?? ds.columns.find((c) => c.isId && c.type !== 'date' && repeats(c))
}

/** Funnel stages read in their own order when they're numbered ("1 Visit", "2 Cart"…), otherwise largest first. */
function stageSort(ds: Dataset, c: Column): Widget['sort'] {
  const sample = ds.rows.slice(0, 200).map((r) => labelOf(r[c.key], c))
  return sample.every((v) => /^\s*\d/.test(v)) ? 'label-asc' : 'value-desc'
}

export function suggest(ds: Dataset): Suggestions {
  const cols = colMap(ds)
  const measures = rankMeasures(ds)
  const dims = rankDims(ds)
  // a date column with only a handful of values (e.g. 3 survey years) reads better as a category
  const time = ds.columns.find((c) => c.type === 'date' && c.distinct >= 4)
  const [m1, m2] = measures
  const [d1, d2] = dims
  const smallDim = dims.find((d) => d.distinct <= 6)
  const w: Widget[] = []
  const extra: Widget[] = []
  const lbl = (x: Measure) => measureLabel(x, cols)
  // charts not split by time can't add up a level (population, balance) across periods: average it instead
  const mc = (c: Column | undefined) => (c && time && isSnapshot(c.key) && defaultAgg(c) === 'sum' ? m(c, 'avg') : m(c))

  // KPI row
  w.push({ id: uid(), type: 'kpi', size: 'xs', title: 'Total records', measures: [m(undefined)], dimension: time?.key, reason: 'Row count' })
  for (const c of measures.slice(0, 3)) {
    const mm = m(c)
    // levels like population or price can't be added up across periods: show the latest period instead
    const snapshot = !!time && mm.agg === 'sum' && isSnapshot(c.key)
    w.push({
      id: uid(), type: 'kpi', size: 'xs', title: snapshot ? `${lbl(mm)} (latest)` : lbl(mm), measures: [mm], dimension: time?.key,
      kpiMode: snapshot ? 'latest' : undefined, reason: 'Headline metric',
    })
  }

  // trend over time
  if (time && m1) {
    const split = smallDim && smallDim.distinct <= 6 ? smallDim : undefined
    const mm = m(m1)
    const stack = split && mm.agg === 'sum'
    w.push({
      id: uid(), type: stack ? 'area' : 'line', size: 'lg', title: `${lbl(mm)} over time`,
      subtitle: split ? `by ${split.name}` : undefined,
      dimension: time.key, bucket: 'auto', measures: [mm], series: split?.key, stacked: !!stack,
      trend: !split, reason: 'Date column + numeric measure',
    })
  } else if (time) {
    w.push({ id: uid(), type: 'line', size: 'lg', title: 'Records over time', dimension: time.key, bucket: 'auto', measures: [m(undefined)], trend: true, reason: 'Date column' })
  }

  // part-to-whole
  if (smallDim) {
    w.push({ id: uid(), type: 'donut', size: time ? 'sm' : 'md', title: `Share by ${smallDim.name}`, dimension: smallDim.key, measures: [m(undefined)], reason: 'Low-cardinality category' })
  }

  // a process with named steps reads best as a funnel
  const stage = stageColumn(ds)
  if (stage) w.push({ id: uid(), type: 'funnel', size: 'md', title: `Funnel by ${stage.name}`, dimension: stage.key, measures: [m(undefined)], sort: stageSort(ds, stage), reason: 'Stage-like column' })

  // ranking
  if (d1) {
    const mm = m1 ? mc(m1) : m(undefined)
    const big = d1.distinct > 6
    w.push({ id: uid(), type: big ? 'hbar' : 'bar', size: 'md', title: `${lbl(mm)} by ${d1.name}`, dimension: d1.key, measures: [mm], limit: 12, reason: 'Compare categories' })
  }
  if (time && m2) {
    const mm = m(m2)
    w.push({ id: uid(), type: 'line', size: 'md', title: `${lbl(mm)} over time`, dimension: time.key, bucket: 'auto', measures: [mm], trend: true, reason: 'Second measure trend' })
  } else if (d2) {
    const mm = m1 ? mc(m1) : m(undefined)
    w.push({ id: uid(), type: d2.distinct > 6 ? 'hbar' : 'bar', size: 'md', title: `${lbl(mm)} by ${d2.name}`, dimension: d2.key, measures: [mm], limit: 12, reason: 'Compare categories' })
  }

  // distribution
  if (m1) {
    w.push({ id: uid(), type: 'histogram', size: 'md', title: `Distribution of ${m1.name}`, x: m1.key, measures: [], bins: 24, reason: 'Numeric distribution' })
  }

  // relationship
  let pair: [Column, Column] | undefined
  if (measures.length >= 2) {
    const cand = measures.slice(0, 10)
    const cm = correlationMatrix(ds, cand.map((c) => c.key))
    let best = 0
    for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
      const r = Math.abs(cm.matrix[i][j])
      if (Number.isFinite(r) && r > best && r < 0.999) { best = r; pair = [cand[i], cand[j]] }
    }
    if (pair) {
      const colorDim = dims.find((d) => d.distinct <= 4 && d.type !== 'number')
      w.push({
        id: uid(), type: 'scatter', size: 'md', title: `${pair[1].name} vs ${pair[0].name}`,
        subtitle: colorDim ? `colored by ${colorDim.name}` : undefined,
        x: pair[0].key, y: pair[1].key, color: colorDim?.key, measures: [], trend: true, reason: `Strongest correlation (|r| = ${best.toFixed(2)})`,
      })
    }
  }

  // spread by group
  if (m1 && d1 && d1.distinct <= 12) {
    w.push({ id: uid(), type: 'box', size: 'md', title: `${m1.name} spread by ${d1.name}`, dimension: d1.key, y: m1.key, measures: [], reason: 'Distribution per group' })
  }

  // cross-tab
  // two categories only make a readable grid when both are small
  if (d1 && ((time) || (d2 && d1.distinct <= 30 && d2.distinct <= 30))) {
    const xDim = time ?? d2!
    const yDim = d1
    const mm = m1 && time ? m(m1) : m(undefined)
    w.push({ id: uid(), type: 'heatmap', size: time ? 'full' : 'md', title: `${lbl(mm)} by ${xDim.name} and ${yDim.name}`, dimension: xDim.key, bucket: time ? 'auto' : undefined, series: yDim.key, measures: [mm], reason: 'Two dimensions' })
  }

  // geography
  const geoCol = ds.columns.find((c) => (c.type === 'category' || c.type === 'text') && detectGeo(c, ds.rows))
  const ll = detectLatLon(ds.columns, ds.rows)
  if (ll) {
    const usa = geoCol && detectGeo(geoCol, ds.rows) === 'usa'
    w.push({ id: uid(), type: 'points', size: 'lg', title: 'Locations', x: ll.lon, y: ll.lat, geo: usa ? 'usa' : 'world', measures: [], reason: 'Latitude / longitude columns' })
  }
  if (geoCol) {
    const mm = m1 ? mc(m1) : m(undefined)
    w.push({ id: uid(), type: 'map', size: ll ? 'md' : 'lg', title: `${lbl(mm)} by ${geoCol.name}`, dimension: geoCol.key, geo: detectGeo(geoCol, ds.rows)!, measures: [mm], reason: 'Country or state column' })
  }

  // correlation matrix
  if (measures.length >= 3) {
    w.push({ id: uid(), type: 'correlation', size: measures.length > 5 ? 'full' : 'md', title: 'Correlation matrix', measures: measures.slice(0, 8).map((c) => m(c)), reason: '3+ numeric columns' })
  }

  // the same IDs over time: how many come back
  // (a cohort is one more full pass on every filter: not suggested for very large data, still available by hand)
  const entity = time && ds.rows.length <= 250_000 && entityColumn(ds)
  if (entity && time) w.push({ id: uid(), type: 'cohort', size: 'full', title: 'Coming back, by first month', subtitle: `cohort: each month’s new ${entity.name} values, active again later`, dimension: time.key, bucket: 'month', entity: entity.key, measures: [], reason: 'An ID that repeats over time' })

  // summary table
  if (d1) {
    const ms: Measure[] = [m(undefined), ...measures.slice(0, 3).map((c) => mc(c))]
    w.push({ id: uid(), type: 'table', size: 'full', title: `Summary by ${d1.name}`, dimension: d1.key, measures: ms, sort: 'value-desc', limit: 25, reason: 'Grouped summary' })
  }

  // what stands out, in words: the strongest findings of the Insights tab, live under the page's filters
  // (recomputed on every filter: like the cohort table, not suggested for very large data — the Insights tab has them)
  if ((measures.length || dims.length) && ds.rows.length <= 250_000) {
    w.push({ id: uid(), type: 'text', size: 'full', title: '', measures: [], text: '## What stands out\n{insights}', reason: 'Top findings from the Insights tab' })
  }

  // ---- extra suggestions (offered in the "Add chart" gallery) ----
  // the newer forms lead the gallery when the data fits them
  extra.push({ id: uid(), type: 'text', size: 'full', title: '', measures: [], text: `## ${ds.name}${time ? ' through {latest month}' : ''}\n{rows} rows${m1 ? ` · ${defaultAgg(m1) === 'sum' ? 'total' : 'average'} ${m1.name} **{${m1.name}}**` : ''}`, reason: 'Heading with live values' })
  const tail = dims.find((d) => d.type === 'category' && d.distinct >= 8 && d.distinct <= 200)
  if (tail && m1 && defaultAgg(m1) === 'sum') extra.push({ id: uid(), type: 'pareto', size: 'md', title: `${lbl(m(m1))} by ${tail.name} · Pareto`, dimension: tail.key, measures: [m(m1)], limit: 30, reason: 'Which few make most of it' })
  if (time && m1 && defaultAgg(m1) === 'sum') {
    // a waterfall needs few bars: coarser periods for longer histories
    let lo = Infinity, hi = -Infinity
    for (const r of ds.rows) { const v = r[time.key]; if (typeof v === 'number') { if (v < lo) lo = v; if (v > hi) hi = v } }
    const years = (hi - lo) / (365 * 864e5)
    const bucket = years <= 2 ? 'month' : years <= 8 ? 'quarter' : 'year'
    extra.push({ id: uid(), type: 'waterfall', size: 'md', title: `Change in ${lbl(m(m1))} by ${bucket}`, dimension: time.key, bucket, measures: [m(m1)], reason: 'Period-to-period change' })
  }
  if (smallDim && m1 && defaultAgg(m1) === 'sum') extra.push({ id: uid(), type: 'waterfall', size: 'md', title: `${lbl(m(m1))} by ${smallDim.name} · waterfall`, dimension: smallDim.key, measures: [m(m1)], reason: 'How the parts add up' })
  for (const d of dims.slice(0, 5)) {
    if (d.distinct > 12) extra.push({ id: uid(), type: 'treemap', size: 'md', title: `Records by ${d.name}`, dimension: d.key, measures: [m(undefined)], limit: 30, reason: 'Many categories' })
    for (const c of measures.slice(0, 2)) {
      const mm = m(c)
      extra.push({ id: uid(), type: d.distinct > 6 ? 'hbar' : 'bar', size: 'md', title: `${lbl(mm)} by ${d.name}`, dimension: d.key, measures: [mm], limit: 12, reason: 'Compare categories' })
    }
  }
  for (const c of measures.slice(1, 6)) {
    extra.push({ id: uid(), type: 'histogram', size: 'md', title: `Distribution of ${c.name}`, x: c.key, measures: [], bins: 24, reason: 'Numeric distribution' })
  }
  if (time) {
    extra.push({ id: uid(), type: 'bar', size: 'md', title: 'Records by day of week', dimension: time.key, bucket: 'dow', measures: [m(undefined)], sort: 'natural', reason: 'Weekly pattern' })
    extra.push({ id: uid(), type: 'bar', size: 'md', title: `${m1 ? lbl(m(m1)) : 'Records'} by month of year`, dimension: time.key, bucket: 'moy', measures: [m(m1)], sort: 'natural', reason: 'Seasonality' })
    if (m1) extra.push({ id: uid(), type: 'area', size: 'md', title: `Cumulative ${lbl(m(m1, 'sum'))}`, dimension: time.key, bucket: 'auto', measures: [m(m1, 'sum')], cumulative: true, reason: 'Running total' })
  }
  if (d1 && d2) {
    const mm = m(m1)
    extra.push({ id: uid(), type: 'bar', size: 'md', title: `${lbl(mm)} by ${d1.name} and ${d2.name}`, dimension: d1.key, series: d2.key, stacked: true, measures: [mm], limit: 10, reason: 'Stacked comparison' })
  }

  const seen = new Set(w.map(signature))
  return { widgets: pack(w), extra: extra.filter((x) => !seen.has(signature(x)) && (seen.add(signature(x)), true)) }
}

export const signature = (w: Widget) =>
  [w.type, w.dimension, w.bucket, w.series, w.x, w.y, w.cumulative, w.measures.map((x) => `${x.agg}:${x.column ?? ''}`).join('|'), w.type === 'text' ? w.text : ''].join('/')

const SPAN_OF = { xs: 3, sm: 4, md: 6, lg: 8, full: 12 } as const

/** Keeps suggestion order but pulls a later widget forward when it fills the gap left in a 12-column row. */
function pack(ws: Widget[]): Widget[] {
  const rest = [...ws]
  const out: Widget[] = []
  let free = 12
  while (rest.length) {
    let i = rest.findIndex((w) => SPAN_OF[w.size] <= free)
    if (i < 0) {
      // nothing fits the gap: widen the previous widget to close the row, if a half can become two thirds
      const last = out[out.length - 1]
      if (last && free === 6 && last.size === 'md') last.size = 'full'
      else if (last && free === 4 && last.size === 'lg') last.size = 'full'
      free = 12
      i = 0
    }
    const [w] = rest.splice(i, 1)
    out.push(w)
    free -= SPAN_OF[w.size]
    if (free <= 0) free = 12
  }
  const last = out[out.length - 1]
  if (last && free !== 12 && free === 12 - SPAN_OF[last.size] && last.type !== 'kpi') last.size = 'full'
  return out
}
