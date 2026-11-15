// Turns a plain-English question into a widget, entirely on-device (no AI service, no network).
//   "average price by symbol since 2005"   → bar of avg Price by Symbol, Date ≥ 2005
//   "monthly revenue by region as area"    → area of sum Revenue by month, split by Region
//   "top 5 genres by worldwide gross"      → bar, top 5
//   "how many movies per rating"           → bar of row count by MPAA Rating

import type { Agg, ChartType, Column, Dataset, DateBucket, Filter, Measure, Widget } from '../types'
import { colMap, labelOf, measureLabel } from './aggregate'
import { fmtDate, fmtNumber } from './format'
import { parseNumber } from './infer'
import { defaultAgg, entityColumn, stageColumn, uid } from './suggest'
import { detectGeo, detectLatLon } from './geo'

export interface AskOk { ok: true; widget: Widget; reading: string[] }
export interface AskFail { ok: false; message: string }
export type AskResult = AskOk | AskFail

const AGG_WORDS: [RegExp, Agg][] = [
  [/\b(average|avg|mean|typical)\b/, 'avg'],
  [/\b(median)\b/, 'median'],
  [/\b(total|sum|overall)\b/, 'sum'],
  [/\b(maximum|max|highest|largest|biggest|peak)\b/, 'max'],
  [/\b(minimum|min|lowest|smallest)\b/, 'min'],
  [/\b(distinct|unique|different)\b/, 'distinct'],
  [/\b(count|number of|how many|#)\b/, 'count'],
]
const CHART_WORDS: [RegExp, ChartType][] = [
  [/\b(cohorts?|retention|coming back|returning|churn)\b/, 'cohort'],
  [/\b(funnel)\b/, 'funnel'],
  [/\b(pareto|80 ?\/ ?20|long tail|the few)\b/, 'pareto'],
  [/\b(waterfall|bridge|contribution|contributions|what drove)\b/, 'waterfall'],
  [/\b(pie|donut|doughnut|share|proportion|breakdown|composition)\b/, 'donut'],
  [/\b(scatter|vs\.?|versus|against|relationship|correlat\w*)\b/, 'scatter'],
  [/\b(histogram|distribution|spread of)\b/, 'histogram'],
  [/\b(box ?plot|boxplot|spread)\b/, 'box'],
  [/\b(heat ?map|matrix)\b/, 'heatmap'],
  [/\b(treemap|tree map)\b/, 'treemap'],
  [/\b(map|geograph\w*|choropleth)\b/, 'map'],
  [/\b(table|list|summary)\b/, 'table'],
  [/\b(area)\b/, 'area'],
  [/\b(line|trend|over time|timeline|evolution)\b/, 'line'],
  [/\b(bar|bars|column chart|columns|rank\w*|compare)\b/, 'bar'],
]
const BUCKET_WORDS: [RegExp, DateBucket][] = [
  [/\b(hourly|by hour|per hour)\b/, 'hour'],
  [/\b(daily|by day|per day|each day)\b/, 'day'],
  [/\b(weekly|by week|per week|each week)\b/, 'week'],
  [/\b(monthly|by month|per month|each month)\b/, 'month'],
  [/\b(quarterly|by quarter|per quarter)\b/, 'quarter'],
  [/\b(yearly|annual\w*|by year|per year|each year)\b/, 'year'],
  [/\b(day of (the )?week|weekday)\b/, 'dow'],
  [/\b(month of (the )?year|seasonal\w*)\b/, 'moy'],
]
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const STOP = new Set(['the', 'a', 'an', 'of', 'by', 'per', 'for', 'in', 'on', 'and', 'or', 'to', 'is', 'are', 'what', 'show', 'me', 'chart', 'as', 'with', 'all', 'each', 'how', 'many', 'much', 'over', 'time', 'top', 'bottom', 'where', 'from', 'since', 'before', 'after', 'between', 'yes', 'no', 'not', 'other', 'blank'])

interface Mention { col: Column; start: number; end: number }

const norm = (s: string) => s.toLowerCase().replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim()
const variants = (s: string) => {
  const n = norm(s)
  const out = new Set([n])
  if (n.endsWith('s')) out.add(n.slice(0, -1))
  else out.add(n + 's')
  if (n.endsWith('y')) out.add(n.slice(0, -1) + 'ies')
  // "temp max" → also "max temp"
  const words = n.split(' ')
  if (words.length === 2) out.add(`${words[1]} ${words[0]}`)
  return [...out].filter((v) => v.length > 1)
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function findColumns(q: string, cols: Column[]): Mention[] {
  const cands = cols.flatMap((c) => [...new Set([...variants(c.name), ...variants(c.key)])].map((v) => ({ col: c, v })))
  cands.sort((a, b) => b.v.length - a.v.length)
  const taken: [number, number][] = []
  const out: Mention[] = []
  for (const { col, v } of cands) {
    const re = new RegExp(`(^|[^a-z0-9])(${esc(v)})(?=$|[^a-z0-9])`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(q))) {
      const start = m.index + m[1].length, end = start + v.length
      if (taken.some(([a, b]) => start < b && end > a)) continue
      taken.push([start, end])
      out.push({ col, start, end })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

function aggNear(q: string, pos: number): Agg | undefined {
  const before = q.slice(Math.max(0, pos - 28), pos)
  let best: { agg: Agg; at: number } | undefined
  for (const [re, agg] of AGG_WORDS) {
    const m = [...before.matchAll(new RegExp(re.source, 'g'))].pop()
    if (m && (!best || m.index! > best.at)) best = { agg, at: m.index! }
  }
  return best?.agg
}

export function ask(question: string, ds: Dataset): AskResult {
  const q = ` ${norm(question).replace(/[?!]/g, '')} `
  if (!q.trim()) return { ok: false, message: 'Ask a question about your data, e.g. “total revenue by region”.' }
  const cols = colMap(ds)
  const all = ds.columns
  const reading: string[] = []
  const mentions = findColumns(q, all)
  const dateCol = all.find((c) => c.type === 'date')
  const filters: Filter[] = []

  // --- category values mentioned in the question become filters ("for MSFT", "excluding rain")
  const used = new Set<number>()
  for (const m of mentions) for (let i = m.start; i < m.end; i++) used.add(i)
  for (const c of all) {
    if ((c.type !== 'category' && c.type !== 'boolean') || c.distinct > 500) continue
    const values = [...new Set(ds.rows.slice(0, 50_000).map((r) => labelOf(r[c.key], c)))]
    const hits: string[] = []
    let exclude = false
    for (const v of values) {
      const lv = norm(v)
      if (lv.length < 2 || STOP.has(lv) || all.some((x) => norm(x.name) === lv)) continue
      const re = new RegExp(`(^|[^a-z0-9])(${esc(lv)})(?=$|[^a-z0-9])`)
      const m = re.exec(q)
      if (!m) continue
      const at = m.index + m[1].length
      if ([...Array(lv.length).keys()].some((i) => used.has(at + i))) continue
      hits.push(v)
      if (/\b(excluding|except|without|not|other than)\s+(the\s+)?$/.test(q.slice(Math.max(0, at - 22), at))) exclude = true
    }
    if (hits.length) {
      filters.push({ id: uid('f'), column: c.key, values: hits, exclude })
      reading.push(`${c.name} ${exclude ? 'is not' : 'is'} ${hits.join(', ')}`)
    }
  }

  // --- time window
  if (dateCol) {
    let maxT = -Infinity
    for (const r of ds.rows) { const v = r[dateCol.key]; if (typeof v === 'number' && v > maxT) maxT = v }
    const y = (s: string) => Date.UTC(+s, 0, 1)
    let m: RegExpMatchArray | null
    const add = (f: Omit<Filter, 'id' | 'column'>, text: string) => { filters.push({ id: uid('f'), column: dateCol.key, ...f }); reading.push(`${dateCol.name} ${text}`) }
    if ((m = q.match(/\bbetween (\d{4}) and (\d{4})\b/))) add({ min: y(m[1]), max: Date.UTC(+m[2] + 1, 0, 1) - 1 }, `${m[1]}–${m[2]}`)
    else if ((m = q.match(/\b(?:since|after|from) (\d{4})\b/))) add({ min: y(m[1]) }, `from ${m[1]}`)
    else if ((m = q.match(/\b(?:before|until|up to) (\d{4})\b/))) add({ max: y(m[1]) - 1 }, `before ${m[1]}`)
    else if ((m = q.match(new RegExp(`\\bin (${MONTHS.join('|')}) (\\d{4})\\b`)))) {
      const mo = MONTHS.indexOf(m[1])
      add({ min: Date.UTC(+m[2], mo, 1), max: Date.UTC(+m[2], mo + 1, 1) - 1 }, `in ${fmtDate(Date.UTC(+m[2], mo, 1), 'month')}`)
    } else if ((m = q.match(/\b(?:in|during) (\d{4})\b/))) add({ min: y(m[1]), max: Date.UTC(+m[1] + 1, 0, 1) - 1 }, `in ${m[1]}`)
    else if ((m = q.match(/\b(?:last|past|previous) (\d+)? ?(day|week|month|quarter|year)s?\b/)) && Number.isFinite(maxT)) {
      const n = m[1] ? +m[1] : 1
      // relative, so the chart keeps showing the latest period after new data is loaded
      add({ relative: { last: n, unit: m[2] as 'month' } }, `in the last ${n} ${m[2]}${n > 1 ? 's' : ''}`)
    }
  }

  // --- numeric comparisons: "price over 100", "rating at least 7"
  for (const mn of mentions) {
    if (mn.col.type !== 'number') continue
    const after = q.slice(mn.end, mn.end + 40)
    const m = after.match(/^\s*(?:is\s+)?(>=|<=|>|<|=|over|above|more than|greater than|at least|under|below|less than|at most|equals?|exactly)\s+(-?[\d.,]+[kmb]?)/)
    if (!m) continue
    const scale = /k$/.test(m[2]) ? 1e3 : /m$/.test(m[2]) ? 1e6 : /b$/.test(m[2]) ? 1e9 : 1
    const n = (parseNumber(m[2].replace(/[kmb]$/, '')) ?? NaN) * scale
    if (!Number.isFinite(n)) continue
    const op = m[1]
    const f: Filter = { id: uid('f'), column: mn.col.key }
    if (/^(>|over|above|more than|greater than)$/.test(op)) f.min = n + 1e-9
    else if (/^(>=|at least)$/.test(op)) f.min = n
    else if (/^(<|under|below|less than)$/.test(op)) f.max = n - 1e-9
    else if (/^(<=|at most)$/.test(op)) f.max = n
    else { f.min = n; f.max = n }
    filters.push(f)
    ;(mn as Mention & { filterOnly?: boolean }).filterOnly = true
    reading.push(`${mn.col.name} ${op} ${fmtNumber(n, mn.col)}`)
  }

  // --- chart type and bucket words
  let type: ChartType | undefined
  for (const [re, t] of CHART_WORDS) if (re.test(q)) { type = t; break }
  let bucket: DateBucket | undefined
  for (const [re, b] of BUCKET_WORDS) if (re.test(q)) { bucket = b; break }
  const overTime = /\b(over time|trend|timeline|evolution)\b/.test(q) || !!bucket

  // --- split mentions into measures vs dimensions
  const live = mentions.filter((m) => !(m as Mention & { filterOnly?: boolean }).filterOnly)
  const byIdx = q.search(/\b(by|per|for each|across|grouped by|broken down by|split by)\b/)
  const isDim = (m: Mention) => m.col.type === 'category' || m.col.type === 'boolean' || m.col.type === 'date' || m.col.type === 'text' || (m.col.type === 'number' && !!m.col.discrete)
  const dimMentions = live.filter((m) => (byIdx >= 0 && m.start > byIdx && isDim(m)) || (isDim(m) && m.col.type !== 'number' && byIdx < 0 && !aggNear(q, m.start)))
  const numMentions = live.filter((m) => m.col.type === 'number' && !dimMentions.includes(m))

  // --- measures
  const measures: Measure[] = []
  const countish = /\b(how many|number of|count)\b/.test(q)
  for (const m of numMentions) {
    if (type === 'scatter' || type === 'histogram' || type === 'box') break
    const agg = aggNear(q, m.start) ?? defaultAgg(m.col)
    measures.push({ id: uid('m'), column: m.col.key, agg: agg === 'count' ? 'sum' : agg })
  }
  // "how many genres" (a dimension after the count words, with no "by") = distinct count
  if (!measures.length && countish) {
    const after = q.slice(q.search(/\b(how many|number of|count)\b/))
    const target = live.find((m) => isDim(m) && q.indexOf(after) <= m.start && (byIdx < 0 || m.start < byIdx))
    if (target && /\b(distinct|unique|different)\b/.test(q)) measures.push({ id: uid('m'), column: target.col.key, agg: 'distinct' })
    else measures.push({ id: uid('m'), agg: 'count' })
    if (target && byIdx < 0 && !dimMentions.includes(target)) dimMentions.push(target)
  }
  const agg0 = AGG_WORDS.find(([re]) => re.test(q))?.[1]
  if (!measures.length && agg0 === 'distinct') {
    const target = live.find(isDim)
    if (target) measures.push({ id: uid('m'), column: target.col.key, agg: 'distinct' })
  }

  // --- dimensions
  let dimension = dimMentions.find((m) => m.col.type !== 'date' || !overTime)?.col
  let series: Column | undefined
  if (overTime && dateCol) {
    series = dimension
    dimension = dimMentions.find((m) => m.col.type === 'date')?.col ?? dateCol
  } else if (dimMentions.length > 1) {
    series = dimMentions.find((m) => m.col !== dimension)?.col
  }
  if (series?.key === dimension?.key) series = undefined

  // --- top / bottom N
  let limit: number | undefined
  let sort: Widget['sort']
  const top = q.match(/\b(top|best|highest|largest|biggest) (\d+)\b/) ?? q.match(/\b(\d+) (highest|largest|biggest|best|top)\b/)
  const bottom = q.match(/\b(bottom|worst|lowest|smallest) (\d+)\b/) ?? q.match(/\b(\d+) (lowest|smallest|worst)\b/)
  if (top) { limit = +(top[2].match(/\d/) ? top[2] : top[1]); sort = 'value-desc' }
  if (bottom) { limit = +(bottom[2].match(/\d/) ? bottom[2] : bottom[1]); sort = 'value-asc' }

  // --- special chart types
  if (type === 'scatter') {
    const nums = live.filter((m) => m.col.type === 'number').map((m) => m.col)
    if (nums.length < 2) return { ok: false, message: 'A scatter plot needs two numeric columns, e.g. “horsepower vs weight”.' }
    const color = dimMentions.find((m) => m.col.type === 'category')?.col
    // "Y vs X": the first column named is the vertical axis
    reading.unshift(`${nums[0].name} against ${nums[1].name}`)
    if (color) reading.push(`colored by ${color.name}`)
    return done({ type, x: nums[1].key, y: nums[0].key, color: color?.key, trend: true, measures: [] }, `${nums[0].name} vs ${nums[1].name}`)
  }
  if (type === 'histogram' || (type === 'box' && !dimension)) {
    const col = live.find((m) => m.col.type === 'number')?.col
    if (!col) return { ok: false, message: 'Name a numeric column, e.g. “distribution of price”.' }
    reading.unshift(`Distribution of ${col.name}`)
    return done({ type: 'histogram', x: col.key, bins: 24, measures: [] }, `Distribution of ${col.name}`)
  }
  if (type === 'box' && dimension) {
    const col = live.find((m) => m.col.type === 'number')?.col
    if (!col) return { ok: false, message: 'Name a numeric column, e.g. “spread of price by symbol”.' }
    reading.unshift(`Spread of ${col.name}`, `by ${dimension.name}`)
    return done({ type: 'box', y: col.key, dimension: dimension.key, measures: [] }, `${col.name} spread by ${dimension.name}`)
  }
  if (type === 'map') {
    const geoDim = dimension && detectGeo(dimension, ds.rows) ? dimension : all.find((c) => detectGeo(c, ds.rows))
    if (geoDim) {
      const geo = detectGeo(geoDim, ds.rows)!
      if (!measures.length) measures.push({ id: uid('m'), agg: 'count' })
      reading.unshift(measureLabel(measures[0], cols), `by ${geoDim.name} on a ${geo === 'usa' ? 'US' : 'world'} map`)
      return done({ type: 'map', geo, dimension: geoDim.key, measures: measures.slice(0, 1) }, `${measureLabel(measures[0], cols)} by ${geoDim.name}`)
    }
    const ll = detectLatLon(all, ds.rows)
    if (ll) {
      reading.unshift('Locations on a map')
      return done({ type: 'points', geo: 'world', x: ll.lon, y: ll.lat, measures: [] }, 'Locations')
    }
    return { ok: false, message: 'No country, state, or latitude/longitude columns were found for a map.' }
  }

  // cohorts follow an ID over time; funnels default to the stage column; waterfalls over time default to the date
  if (type === 'cohort') {
    const entity = live.find((m) => m.col.type !== 'date' && m.col.type !== 'number' && (m.col.isId || m.col.distinct > 20))?.col ?? entityColumn(ds)
    if (!entity || !dateCol) return { ok: false, message: 'A cohort table needs a date and an ID that repeats, e.g. “retention of customer id by month”.' }
    const b = bucket === 'day' || bucket === 'week' || bucket === 'quarter' || bucket === 'year' ? bucket : 'month'
    reading.unshift(`${entity.name} coming back`, `by first ${b}`)
    return done({ type: 'cohort', size: 'full', dimension: dateCol.key, bucket: b, entity: entity.key, measures: [] }, `${entity.name} coming back, by first ${b}`)
  }
  if (type === 'funnel' && !dimension) dimension = stageColumn(ds)
  if (type === 'waterfall' && !dimension && dateCol) dimension = dateCol

  if (!measures.length && !dimension) {
    const examples = all.slice(0, 3).map((c) => c.name.toLowerCase()).join(', ')
    return { ok: false, message: `I couldn’t match that to any columns. Try naming one — for example ${examples}.` }
  }
  if (!measures.length) measures.push({ id: uid('m'), agg: 'count' })

  if (!type) {
    if (!dimension) type = 'kpi'
    else if (dimension.type === 'date') type = 'line'
    else if (series) type = 'bar'
    else type = (dimension.distinct > 8 || (limit ?? 0) > 8) ? 'hbar' : 'bar'
  }
  if (type === 'bar' && dimension && dimension.type !== 'date' && dimension.distinct > 10 && !series) type = 'hbar'
  if ((type === 'line' || type === 'area') && (!dimension || dimension.type !== 'date') && dateCol) {
    series = series ?? dimension
    dimension = dateCol
  }
  if (type === 'heatmap' && !series) {
    series = all.find((c) => c.type === 'category' && c.key !== dimension?.key && c.distinct <= 30)
  }
  if (type === 'kpi' && dateCol && !dimension) dimension = undefined

  const mLabel = measures.map((m) => measureLabel(m, cols)).join(', ')
  reading.unshift(mLabel)
  if (dimension) reading.splice(1, 0, `by ${dimension.type === 'date' && bucket ? bucket.replace('dow', 'day of week').replace('moy', 'month of year') : dimension.name}`)
  if (series) reading.splice(2, 0, `split by ${series.name}`)
  if (limit) reading.push(`${sort === 'value-asc' ? 'bottom' : 'top'} ${limit}`)

  const title = [mLabel, dimension ? `by ${dimension.type === 'date' && bucket ? (bucket === 'dow' ? 'day of week' : bucket === 'moy' ? 'month of year' : bucket) : dimension.name}` : '', series ? `and ${series.name}` : ''].filter(Boolean).join(' ')
  return done({
    type,
    dimension: type === 'kpi' ? dateCol?.key : dimension?.key,
    bucket: dimension?.type === 'date' ? bucket ?? 'auto' : undefined,
    series: type === 'kpi' || type === 'donut' || type === 'treemap' || type === 'funnel' || type === 'pareto' || type === 'waterfall' ? undefined : series?.key,
    measures: type === 'line' || type === 'area' || type === 'bar' || type === 'hbar' || type === 'table' ? (series ? measures.slice(0, 1) : measures) : measures.slice(0, 1),
    limit,
    // funnel stages numbered "1 Visit, 2 Cart…" keep their order
    sort: sort ?? (type === 'funnel' && dimension && ds.rows.slice(0, 200).every((r) => /^\s*\d/.test(labelOf(r[dimension!.key], dimension!))) ? 'label-asc' : undefined),
    stacked: type === 'area' && !!series,
  }, title)

  function done(partial: Partial<Widget>, title: string): AskOk {
    const widget: Widget = {
      id: uid(), title: title.charAt(0).toUpperCase() + title.slice(1), size: partial.type === 'kpi' ? 'xs' : partial.type === 'map' || partial.type === 'points' ? 'lg' : 'md',
      measures: [], type: 'bar', ...partial, filters: filters.length ? filters : undefined,
      subtitle: `Asked: “${question.trim()}”`,
    }
    return { ok: true, widget, reading }
  }
}

/** Example questions tailored to the dataset's columns. */
export function askExamples(ds: Dataset): string[] {
  const num = ds.columns.find((c) => c.type === 'number' && !c.discrete && !c.isId)
  const cat = ds.columns.find((c) => c.type === 'category' && !c.isId && c.distinct >= 2 && c.distinct <= 40)
  const date = ds.columns.find((c) => c.type === 'date' && c.distinct >= 4)
  const out: string[] = []
  const n = (c: Column) => c.name.toLowerCase()
  if (num && cat) out.push(`${defaultAgg(num) === 'avg' ? 'average' : 'total'} ${n(num)} by ${n(cat)}`)
  if (num && date) out.push(`monthly ${n(num)} trend`)
  if (cat) out.push(`how many rows per ${n(cat)}`)
  if (num && cat) out.push(`top 5 ${n(cat)} by ${n(num)}`)
  const nums = ds.columns.filter((c) => c.type === 'number' && !c.discrete && !c.isId)
  const stage = stageColumn(ds)
  if (stage) out.unshift(`funnel by ${n(stage)}`)
  const entity = date && entityColumn(ds)
  if (entity) out.splice(1, 0, `retention of ${n(entity)}`)
  if (nums.length >= 2) out.push(`${n(nums[1])} vs ${n(nums[0])}`)
  if (num) out.push(`distribution of ${n(num)}`)
  return out.slice(0, 5)
}
