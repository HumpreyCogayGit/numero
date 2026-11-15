import type { Column, ColumnFormat, DateBucket, DateGrain, Value } from '../types'
import { formatDate } from './formula'

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function compact(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  const fmt = (v: number, s: string) => `${trim(v.toFixed(digits))}${s}`
  if (a >= 1e12) return fmt(n / 1e12, 'T')
  if (a >= 1e9) return fmt(n / 1e9, 'B')
  if (a >= 1e6) return fmt(n / 1e6, 'M')
  if (a >= 1e4) return fmt(n / 1e3, 'K')
  if (a >= 1000) return Math.round(n).toLocaleString('en-US')
  if (a >= 100) return trim(n.toFixed(Math.min(digits, 1)))
  if (a >= 1) return trim(n.toFixed(2))
  if (a === 0) return '0'
  return trim(n.toPrecision(3))
}

const trim = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s)

/** Formats a number using the column's type format, its display settings, and an optional per-widget override. */
export function fmtNumber(n: number | null | undefined, col?: Column, opts: { compact?: boolean; format?: ColumnFormat } = {}): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const f: ColumnFormat = { ...col?.display, ...opts.format }
  const kind = f.num ?? col?.format
  const v = kind === 'ratio' ? n * 100 : n
  const useCompact = f.compact ?? opts.compact ?? true
  let body: string
  if (f.decimals != null) {
    const d = Math.max(0, Math.min(10, f.decimals))
    body = useCompact && Math.abs(v) >= 1e4 ? compactFixed(v, d) : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
  } else {
    body = useCompact ? compact(v) : Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }
  let out = body
  if (kind === 'currency') {
    const sym = f.currency ?? col?.currency ?? '$'
    out = v < 0 ? `-${sym}${body.replace('-', '')}` : `${sym}${body}`
  } else if (kind === 'percent' || kind === 'ratio') out = `${body}%`
  return `${f.prefix ?? ''}${out}${f.suffix ?? ''}`
}

/** Axis tick label: the column's format (%, currency, prefix/suffix) in short form, without fixed decimals. */
export const fmtAxis = (v: number, col?: Column, format?: ColumnFormat) => fmtNumber(v, col, { format: { ...format, decimals: undefined, compact: true } })

function compactFixed(n: number, d: number): string {
  const a = Math.abs(n)
  const [div, s] = a >= 1e12 ? [1e12, 'T'] : a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : [1e3, 'K']
  return `${(n / div).toFixed(d)}${s}`
}

export function fmtDate(t: number, grain: DateGrain | DateBucket = 'day'): string {
  const d = new Date(t)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  switch (grain) {
    case 'year': return String(y)
    case 'quarter': return `Q${Math.floor(m / 3) + 1} ${y}`
    case 'month': return `${MON[m]} ${y}`
    case 'dow': return DOW[t] ?? String(t)
    case 'moy': return MON[t] ?? String(t)
    case 'hour':
    case 'datetime':
      return `${MON[m]} ${d.getUTCDate()}, ${y} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    case 'week': return `Wk of ${MON[m]} ${d.getUTCDate()}, ${y}`
    default: return `${MON[m]} ${d.getUTCDate()}, ${y}`
  }
}

export function fmtValue(v: Value, col?: Column, compactNums = false): string {
  if (v == null) return ''
  if (!col) return String(v)
  if (col.type === 'number' && typeof v === 'number') return fmtNumber(v, col, { compact: compactNums })
  if (col.type === 'date' && typeof v === 'number') {
    if (col.display?.datePattern) return formatDate(new Date(v), col.display.datePattern)
    return fmtDate(v, col.grain === 'datetime' ? 'datetime' : col.grain ?? 'day')
  }
  if (col.type === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

export function fmtPct(x: number, digits = 1): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : '—'
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 ** 2).toFixed(1)} MB`
}
