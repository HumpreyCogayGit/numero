// Data-preparation steps applied to raw rows before type inference.
// Steps are data (stored in the dataset model) so they replay on every rebuild and on refreshed sources.

import type { FilterCmp, PrepStep, RawRow, RawValue } from '../types'
import { parseDate, parseNumber } from './infer'
import { quantile } from './stats'
import { uniqueHeaders } from './parse'

export interface Table { headers: string[]; rows: RawRow[] }
export interface StepReport { id: string; summary: string; error?: string }
export type SourceResolver = (datasetId: string) => (Table & { name: string }) | undefined

const blank = (v: RawValue) => v == null || (typeof v === 'string' && v.trim() === '')
const asText = (v: RawValue) => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v))
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`

export const OP_LABEL: Record<PrepStep['op'], string> = {
  dedupe: 'Remove duplicate rows',
  dropBlank: 'Remove blank rows',
  fill: 'Fill blanks',
  trim: 'Trim spaces',
  case: 'Change case',
  replace: 'Find & replace',
  split: 'Split column',
  remove: 'Remove columns',
  reorder: 'Reorder columns',
  filter: 'Filter rows',
  unpivot: 'Unpivot (wide → long)',
  join: 'Join another dataset',
  append: 'Append another dataset',
}

/** Applies enabled steps in order. A failing step is skipped and reported, never fatal. */
export function applyPrep(input: Table, steps: PrepStep[], resolve?: SourceResolver, decimal: '.' | ',' = '.'): Table & { reports: StepReport[] } {
  let t: Table = input
  const reports: StepReport[] = []
  for (const step of steps) {
    if (step.disabled) { reports.push({ id: step.id, summary: 'Disabled' }); continue }
    try {
      const r = applyStep(t, step, resolve, decimal)
      t = r.table
      reports.push({ id: step.id, summary: r.summary })
    } catch (e) {
      reports.push({ id: step.id, summary: 'Skipped', error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { ...t, reports }
}

function need(t: Table, ...cols: (string | undefined)[]) {
  for (const c of cols) if (c != null && !t.headers.includes(c)) throw new Error(`Column “${c}” no longer exists`)
}

export function matches(v: RawValue, cmp: FilterCmp, target: string | undefined, decimal: '.' | ',' = '.'): boolean {
  if (cmp === 'blank') return blank(v)
  if (cmp === 'notBlank') return !blank(v)
  if (blank(v)) return cmp === 'neq' || cmp === 'notContains'
  const t = target ?? ''
  const a = asText(v).trim().toLowerCase(), b = t.trim().toLowerCase()
  if (cmp === 'contains') return a.includes(b)
  if (cmp === 'notContains') return !a.includes(b)
  // numbers, then dates, then text
  let x: number | null = parseNumber(v, decimal), y: number | null = parseNumber(t, decimal)
  if (x == null || y == null) {
    x = v instanceof Date ? +v : parseDate(asText(v).trim())
    y = parseDate(t.trim())
  }
  const c = x != null && y != null ? x - y : a < b ? -1 : a > b ? 1 : 0
  switch (cmp) {
    case 'eq': return c === 0
    case 'neq': return c !== 0
    case 'gt': return c > 0
    case 'lt': return c < 0
    case 'gte': return c >= 0
    case 'lte': return c <= 0
  }
  return false
}

function applyStep(t: Table, s: PrepStep, resolve: SourceResolver | undefined, decimal: '.' | ','): { table: Table; summary: string } {
  switch (s.op) {
    case 'dedupe': {
      const cols = s.columns?.length ? s.columns : t.headers
      need(t, ...cols)
      const seen = new Set<string>()
      const rows = t.rows.filter((r) => {
        const k = JSON.stringify(cols.map((c) => asText(r[c])))
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      return { table: { ...t, rows }, summary: `Removed ${plural(t.rows.length - rows.length, 'duplicate')}` }
    }
    case 'dropBlank': {
      need(t, s.column)
      const rows = s.column ? t.rows.filter((r) => !blank(r[s.column!])) : t.rows.filter((r) => t.headers.some((h) => !blank(r[h])))
      return { table: { ...t, rows }, summary: `Removed ${plural(t.rows.length - rows.length, 'row')}` }
    }
    case 'fill': {
      need(t, s.column)
      const c = s.column
      let n = 0
      let fillValue: RawValue = null
      if (s.method === 'zero') fillValue = 0
      if (s.method === 'value') fillValue = s.value ?? ''
      if (s.method === 'mean' || s.method === 'median') {
        const xs = t.rows.map((r) => parseNumber(r[c], decimal)).filter((x): x is number => x != null)
        if (!xs.length) throw new Error(`“${c}” has no numbers to average`)
        fillValue = s.method === 'mean' ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toPrecision(12) : quantile(xs, 0.5)
      }
      let rows: RawRow[]
      if (s.method === 'previous' || s.method === 'next') {
        rows = t.rows.map((r) => ({ ...r }))
        const order = s.method === 'previous' ? rows : [...rows].reverse()
        let last: RawValue = null
        for (const r of order) {
          if (blank(r[c])) { if (last != null) { r[c] = last; n++ } } else last = r[c]
        }
      } else {
        rows = t.rows.map((r) => (blank(r[c]) ? (n++, { ...r, [c]: fillValue }) : r))
      }
      return { table: { ...t, rows }, summary: `Filled ${plural(n, 'cell')}` }
    }
    case 'trim': {
      const cols = s.columns?.length ? s.columns : t.headers
      need(t, ...cols)
      let n = 0
      const rows = t.rows.map((r) => {
        let o = r
        for (const c of cols) {
          const v = r[c]
          if (typeof v === 'string') {
            const nv = v.trim().replace(/\s+/g, ' ')
            if (nv !== v) { if (o === r) o = { ...r }; o[c] = nv; n++ }
          }
        }
        return o
      })
      return { table: { ...t, rows }, summary: `Cleaned ${plural(n, 'cell')}` }
    }
    case 'case': {
      need(t, s.column)
      const f = s.mode === 'upper' ? (x: string) => x.toUpperCase() : s.mode === 'lower' ? (x: string) => x.toLowerCase()
        : (x: string) => x.toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (_, a, b) => a + b.toUpperCase())
      let n = 0
      const rows = t.rows.map((r) => {
        const v = r[s.column]
        if (typeof v !== 'string') return r
        const nv = f(v)
        if (nv === v) return r
        n++
        return { ...r, [s.column]: nv }
      })
      return { table: { ...t, rows }, summary: `Changed ${plural(n, 'cell')}` }
    }
    case 'replace': {
      need(t, s.column)
      if (!s.find) throw new Error('Nothing to find')
      const cols = s.column ? [s.column] : t.headers
      const esc = s.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(s.wholeCell ? `^${esc}$` : esc, s.matchCase ? 'g' : 'gi')
      let n = 0
      const rows = t.rows.map((r) => {
        let o = r
        for (const c of cols) {
          const v = r[c]
          if (v == null) continue
          const str = asText(v)
          re.lastIndex = 0
          if (!re.test(str)) continue
          re.lastIndex = 0
          if (o === r) o = { ...r }
          o[c] = str.replace(re, s.replace)
          n++
        }
        return o
      })
      return { table: { ...t, rows }, summary: `Replaced in ${plural(n, 'cell')}` }
    }
    case 'split': {
      need(t, s.column)
      if (!s.separator) throw new Error('Choose a separator')
      const parts = Math.max(2, Math.min(20, s.parts || 2))
      const names = uniqueHeaders([...t.headers, ...Array.from({ length: parts }, (_, i) => `${s.column} ${i + 1}`)]).slice(t.headers.length)
      const idx = t.headers.indexOf(s.column)
      const headers = [...t.headers.slice(0, idx + 1), ...names, ...t.headers.slice(idx + 1)].filter((h) => s.keepOriginal !== false || h !== s.column)
      const rows = t.rows.map((r) => {
        const pieces = asText(r[s.column]).split(s.separator)
        // the last part keeps any remainder so nothing is lost
        const vals = names.map((_, i) => (i === parts - 1 ? pieces.slice(i).join(s.separator) : pieces[i]) ?? null)
        const o: RawRow = { ...r }
        names.forEach((nm, i) => (o[nm] = vals[i] === '' ? null : vals[i]))
        if (s.keepOriginal === false) delete o[s.column]
        return o
      })
      return { table: { headers, rows }, summary: `Added ${names.join(', ')}` }
    }
    case 'remove': {
      const drop = new Set(s.columns)
      const headers = t.headers.filter((h) => !drop.has(h))
      return { table: { headers, rows: t.rows }, summary: `Removed ${plural(t.headers.length - headers.length, 'column')}` }
    }
    case 'reorder': {
      const first = s.columns.filter((c) => t.headers.includes(c))
      const headers = [...first, ...t.headers.filter((h) => !first.includes(h))]
      return { table: { headers, rows: t.rows }, summary: 'Reordered' }
    }
    case 'filter': {
      need(t, s.column)
      const rows = t.rows.filter((r) => matches(r[s.column], s.cmp, s.value, decimal) === s.keep)
      return { table: { ...t, rows }, summary: `Kept ${plural(rows.length, 'row')}, removed ${(t.rows.length - rows.length).toLocaleString()}` }
    }
    case 'unpivot': {
      need(t, ...s.columns)
      if (!s.columns.length) throw new Error('Choose columns to unpivot')
      const ids = t.headers.filter((h) => !s.columns.includes(h))
      const [nameCol, valueCol] = uniqueHeaders([...ids, s.nameColumn || 'Attribute', s.valueColumn || 'Value']).slice(ids.length)
      const rows: RawRow[] = []
      for (const r of t.rows) {
        for (const c of s.columns) {
          const o: RawRow = {}
          for (const id of ids) o[id] = r[id]
          o[nameCol] = c
          o[valueCol] = r[c]
          rows.push(o)
        }
      }
      return { table: { headers: [...ids, nameCol, valueCol], rows }, summary: `${plural(t.rows.length, 'row')} → ${rows.length.toLocaleString()}` }
    }
    case 'join': {
      const other = resolve?.(s.datasetId)
      if (!other) throw new Error('The other dataset is not available')
      need(t, s.leftKey)
      if (!other.headers.includes(s.rightKey)) throw new Error(`“${s.rightKey}” is not in ${other.name}`)
      const index = new Map<string, RawRow>()
      for (const r of other.rows) {
        const k = asText(r[s.rightKey]).trim().toLowerCase()
        if (!index.has(k)) index.set(k, r)
      }
      const take = (s.columns?.length ? s.columns : other.headers).filter((h) => h !== s.rightKey && other.headers.includes(h))
      const prefix = s.prefix ?? `${other.name} · `
      const outNames = uniqueHeaders([...t.headers, ...take.map((h) => (t.headers.includes(h) ? prefix + h : h))]).slice(t.headers.length)
      let matched = 0
      const rows: RawRow[] = []
      for (const r of t.rows) {
        const m = index.get(asText(r[s.leftKey]).trim().toLowerCase())
        if (m) matched++
        else if (s.how === 'inner') continue
        const o: RawRow = { ...r }
        take.forEach((h, i) => (o[outNames[i]] = m ? m[h] : null))
        rows.push(o)
      }
      return { table: { headers: [...t.headers, ...outNames], rows }, summary: `Matched ${plural(matched, 'row')} of ${t.rows.length.toLocaleString()}` }
    }
    case 'append': {
      const other = resolve?.(s.datasetId)
      if (!other) throw new Error('The other dataset is not available')
      const headers = [...t.headers, ...other.headers.filter((h) => !t.headers.includes(h))]
      return { table: { headers, rows: [...t.rows, ...other.rows] }, summary: `Added ${plural(other.rows.length, 'row')} from ${other.name}` }
    }
  }
}

export function describeStep(s: PrepStep): string {
  switch (s.op) {
    case 'dedupe': return s.columns?.length ? `by ${s.columns.join(', ')}` : 'identical rows'
    case 'dropBlank': return s.column ? `where ${s.column} is blank` : 'where every cell is blank'
    case 'fill': return `${s.column} with ${s.method === 'value' ? `“${s.value ?? ''}”` : s.method}`
    case 'trim': return s.columns?.length ? s.columns.join(', ') : 'all text columns'
    case 'case': return `${s.column} → ${s.mode}`
    case 'replace': return `“${s.find}” → “${s.replace}”${s.column ? ` in ${s.column}` : ''}`
    case 'split': return `${s.column} on “${s.separator}” into ${s.parts}`
    case 'remove': return s.columns.join(', ')
    case 'reorder': return s.columns.slice(0, 4).join(', ') + (s.columns.length > 4 ? '…' : '')
    case 'filter': return `${s.keep ? 'keep' : 'remove'} rows where ${s.column} ${CMP_LABEL[s.cmp]}${s.cmp === 'blank' || s.cmp === 'notBlank' ? '' : ` “${s.value ?? ''}”`}`
    case 'unpivot': return `${s.columns.length} columns → ${s.nameColumn} / ${s.valueColumn}`
    case 'join': return `${s.how} join on ${s.leftKey} = ${s.rightKey}`
    case 'append': return 'rows from another dataset'
  }
}

export const CMP_LABEL: Record<FilterCmp, string> = {
  eq: 'equals', neq: 'does not equal', contains: 'contains', notContains: 'does not contain',
  gt: 'is greater than', lt: 'is less than', gte: 'is at least', lte: 'is at most', blank: 'is blank', notBlank: 'is not blank',
}
