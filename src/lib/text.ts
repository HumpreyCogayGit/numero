// Text widgets: headings and notes with live {placeholders} filled from the (filtered) data.
// A small markdown subset: "# " / "## " headings, "- " bullets, **bold**, *italic*, blank lines between paragraphs.

import type { Agg, Column, Dataset, Filter, Measure, Row, Widget } from '../types'
import { aggregate, colMap, filteredRows, measureColumn, rowsBehind, type AggCtx } from './aggregate'
import { bucketDate } from './dates'
import { fmtDate, fmtNumber } from './format'
import { defaultAgg } from './suggest'
import { topInsights } from './profile'

export interface Span { text: string; bold?: boolean; italic?: boolean; /** a filled placeholder */ value?: boolean; /** a placeholder that matched nothing */ missing?: boolean }
export type TextBlock =
  | { kind: 'h1' | 'h2' | 'p'; spans: Span[] }
  | { kind: 'ul'; items: Span[][] }

const AGG_WORDS: Record<string, Agg> = {
  sum: 'sum', total: 'sum', avg: 'avg', average: 'avg', mean: 'avg', median: 'median', min: 'min', max: 'max',
  'count distinct': 'distinct', distinct: 'distinct', count: 'count',
}
const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, ' ')

/** Placeholders the editor lists as examples, built from this dataset. */
export function placeholderExamples(ds: Dataset): string[] {
  const date = mainDate(ds)
  const num = ds.columns.find((c) => c.type === 'number' && !c.isId && c.formula == null)
  return [
    '{rows}',
    ...(date ? ['{latest month}', '{latest date}', '{first date}'] : []),
    ...ds.model.measures.slice(0, 2).map((m) => `{${m.name}}`),
    ...(num ? [`{${num.name}}`, `{avg ${num.name}}`, `{max ${num.name}}`] : []),
    '{updated}',
  ]
}

const mainDate = (ds: Pick<Dataset, 'columns'>) => ds.columns.find((c) => c.type === 'date' && c.formula == null) ?? ds.columns.find((c) => c.type === 'date')

/** Resolves one placeholder name to display text, or undefined when it matches nothing. */
export function resolvePlaceholder(name: string, ds: Dataset, rows: Row[], all: Row[] = rows): string | undefined {
  const n = norm(name)
  const cols = colMap(ds)
  // *_ALL functions in measures see the page-filtered rows, as in charts; `rows` also has the widget's own filters
  const ctx: AggCtx = { cols, all }
  if (n === 'rows' || n === 'row count') return rows.length.toLocaleString()
  if (n === 'updated') return ds.source.lastLoaded ? fmtDate(ds.source.lastLoaded) : fmtDate(ds.createdAt)
  const date = mainDate(ds)
  if (date && /^(latest|first) (date|day|month|year|quarter)$/.test(n)) {
    const [which, unit] = n.split(' ')
    let lo = Infinity, hi = -Infinity
    for (const r of rows) { const v = r[date.key]; if (typeof v === 'number') { if (v < lo) lo = v; if (v > hi) hi = v } }
    if (!Number.isFinite(lo)) return '—'
    const t = which === 'latest' ? hi : lo
    if (unit === 'month') return fmtDate(bucketDate(t, 'month'), 'month')
    if (unit === 'year') return String(new Date(t).getUTCFullYear())
    if (unit === 'quarter') { const d = new Date(t); return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}` }
    return fmtDate(t, date.grain === 'month' ? 'month' : 'day')
  }
  // a calculated measure, by name
  const def = ds.model.measures.find((m) => norm(m.name) === n)
  if (def) return value({ id: 'p', agg: 'calc', calc: def.key }, rows, ctx)
  // an exact column name wins ("Max Temp" is a column, not the max of "Temp"), aggregated the way charts default to
  const find = (s: string) => ds.columns.find((c) => norm(c.name) === norm(s) || norm(c.key) === norm(s))
  const c = find(name)
  if (c?.type === 'number') return value({ id: 'p', agg: defaultAgg(c), column: c.key }, rows, ctx)
  if (c) return value({ id: 'p', agg: 'distinct', column: c.key }, rows, ctx)
  // then "avg Price", "count distinct Store"…
  for (const [word, agg] of Object.entries(AGG_WORDS).sort((a, b) => b[0].length - a[0].length)) {
    if (n.startsWith(`${word} `)) {
      const col = find(n.slice(word.length + 1))
      // "count Revenue" counts the rows where Revenue is filled in
      if (col && agg === 'count') return rows.reduce((k, r) => k + (r[col.key] == null || r[col.key] === '' ? 0 : 1), 0).toLocaleString()
      if (col && (agg === 'distinct' || col.type === 'number' || col.type === 'boolean')) return value({ id: 'p', agg, column: col.key }, rows, ctx)
    }
  }
  return undefined
}

function value(m: Measure, rows: Row[], ctx: AggCtx): string {
  const v = aggregate(rows, m, ctx)
  const col: Column | undefined = measureColumn(m, ctx.cols)
  return fmtNumber(v, col, { compact: false })
}

/** Splits a line into spans: **bold** / *italic* first (they may wrap placeholders), then {placeholders} inside each part. */
function inline(line: string, fill: (name: string) => string | undefined): Span[] {
  const out: Span[] = []
  for (const part of emphasis(line)) {
    const re = /\{([^{}]+)\}/g
    let last = 0
    const style = { ...(part.bold && { bold: true }), ...(part.italic && { italic: true }) }
    for (let m = re.exec(part.text); m; m = re.exec(part.text)) {
      if (m.index > last) out.push({ text: part.text.slice(last, m.index), ...style })
      const v = fill(m[1])
      out.push(v == null ? { text: m[0], missing: true, ...style } : { text: v, value: true, ...style })
      last = m.index + m[0].length
    }
    if (last < part.text.length) out.push({ text: part.text.slice(last), ...style })
  }
  return out
}

function emphasis(s: string): Span[] {
  const out: Span[] = []
  const re = /\*\*(.+?)\*\*|\*(.+?)\*/g
  let last = 0
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) })
    out.push(m[1] != null ? { text: m[1], bold: true } : { text: m[2], italic: true })
    last = m.index + m[0].length
  }
  if (last < s.length) out.push({ text: s.slice(last) })
  return out
}

export function parseText(src: string, fill: (name: string) => string | undefined): TextBlock[] {
  const blocks: TextBlock[] = []
  let para: string[] = []
  const flush = () => { if (para.length) { blocks.push({ kind: 'p', spans: inline(para.join(' '), fill) }); para = [] } }
  for (const raw of src.split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) { flush(); continue }
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) { flush(); blocks.push({ kind: h[1].length === 1 ? 'h1' : 'h2', spans: inline(h[2], fill) }); continue }
    const li = /^\s*[-*•]\s+(.*)$/.exec(line)
    if (li) {
      flush()
      const prev = blocks[blocks.length - 1]
      const item = inline(li[1], fill)
      if (prev?.kind === 'ul') prev.items.push(item)
      else blocks.push({ kind: 'ul', items: [item] })
      continue
    }
    para.push(line.trim())
  }
  flush()
  return blocks
}

/** A line holding only this becomes a short list of the strongest findings from the Insights tab, under the same filters. */
export const INSIGHTS_TOKEN = '{insights}'
export const hasInsights = (w: Pick<Widget, 'text'>) => !!w.text?.split('\n').some((l) => l.trim() === INSIGHTS_TOKEN)

/** A text widget's blocks, with placeholders filled from the rows it sees (page + widget filters). */
export function renderText(ds: Dataset, w: Widget, filters: Filter[]): TextBlock[] {
  const rows = rowsBehind(ds, w, filters)
  const all = filteredRows(ds, filters)
  const cache = new Map<string, string | undefined>()
  const fill = (name: string) => {
    if (!cache.has(name)) cache.set(name, resolvePlaceholder(name, ds, rows, all))
    return cache.get(name)
  }
  if (!hasInsights(w)) return parseText(w.text ?? '', fill)
  // the text around the token is parsed as usual; the findings themselves are data, not markup
  const blocks: TextBlock[] = []
  let chunk: string[] = []
  const flush = () => { if (chunk.length) { blocks.push(...parseText(chunk.join('\n'), fill)); chunk = [] } }
  for (const line of (w.text ?? '').split('\n')) {
    if (line.trim() !== INSIGHTS_TOKEN) { chunk.push(line); continue }
    flush()
    const found = topInsights(ds, [...filters, ...(w.filters ?? [])])
    blocks.push(found.length
      ? { kind: 'ul', items: found.map((i) => [{ text: i.title, bold: true }, { text: ` — ${i.detail}` }]) }
      : { kind: 'p', spans: [{ text: 'No notable patterns in the rows shown.', italic: true }] })
  }
  flush()
  return blocks
}
