// Data-quality review of a file before it is imported: the same kinds of concern "Update data" raises for a new file
// (text in a number column, dates in the future, blanks, stray negatives), plus likely identifiers.
// Nothing here changes a value: the review only reports, and suggests a type change or a preparation step.
// Pure functions, so the worker and the tests share them.

import type { ColType, PrepStep, RawRow, RawValue } from '../types'
import { coerce, idKind, inferColumn, isBlank, isSoftBlank, parseDate, parseNumber, type ColumnNote, type InferOptions, type Inferred } from './infer'
import { fmtDate } from './format'

export type PrepFix = Omit<Extract<PrepStep, { op: 'filter' }>, 'id'> | Omit<Extract<PrepStep, { op: 'dropBlank' }>, 'id'>

export interface ImportCheck {
  column: string
  kind: 'type' | 'future' | 'blanks' | 'negative' | 'identifier'
  /** warning: likely to mislead a chart; info: worth knowing */
  severity: 'warning' | 'info'
  /** rows concerned, among the rows inspected */
  count: number
  /** the same as a share of the inspected rows */
  share: number
  message: string
  /** a few of the values, as written in the file */
  examples: string[]
  /** where the first few are: row numbers in the data (1 = the first row under the header) */
  rows: number[]
  /** what the user can do about it, besides importing anyway */
  fix?: { label: string; type: ColType } | { label: string; prep: PrepFix }
}

export interface ImportReview {
  checks: ImportCheck[]
  /** what detection assumed per column: values that did not fit, blank markers, units */
  notes: ColumnNote[]
  /** rows looked at; fewer than `total` for large files (an even sample) */
  inspected: number
  total: number
}

const DAY = 86_400_000
/** rows inspected at most: large files are sampled evenly, so nothing is copied and the check stays quick */
export const REVIEW_ROWS = 50_000

const plural = (k: number, one: string, many: string) => `${k.toLocaleString()} ${k === 1 ? one : many}`
const pct = (x: number) => (x < 0.01 ? 'under 1%' : `${Math.round(x * 100)}%`)

export function reviewImport(headers: string[], rows: RawRow[], opts: InferOptions & { now: number; overrides?: Record<string, ColType>; limit?: number }): ImportReview {
  const limit = opts.limit ?? REVIEW_ROWS
  const step = rows.length > limit ? rows.length / limit : 1
  const n = step === 1 ? rows.length : limit
  const at = (i: number) => (step === 1 ? i : Math.floor(i * step))
  const mode = opts.softBlanks ?? 'auto'
  const dayFirstOpt = opts.dateOrder === 'dmy'

  const inferred: Inferred[] = headers.map((h) => {
    const vals: RawValue[] = new Array(n)
    for (let i = 0; i < n; i++) vals[i] = rows[at(i)][h]
    return inferColumn(h, vals, opts)
  })
  // markers this file uses for "missing" under a number or date mean the same under a category (see buildTable)
  const fileBlanks = new Set<string>()
  if (mode === 'auto') for (const m of inferred) if (m.softBlank && (m.type === 'number' || m.type === 'date')) for (const t of m.softTokens ?? []) fileBlanks.add(t.token.toLowerCase())

  const checks: ImportCheck[] = []
  const notes: ColumnNote[] = []
  for (const inf of inferred) {
    const h = inf.key
    const type = opts.overrides?.[h] ?? inf.type
    const typed = type === 'number' || type === 'date' || type === 'boolean'
    const softBlank = mode === 'never' ? typed : mode === 'always' || typed || !!inf.softBlank
      || (!!inf.softTokens?.length && inf.softTokens.every((t) => fileBlanks.has(t.token.toLowerCase())))
    const col = { type, grain: inf.grain, unit: inf.unit }
    const dayFirst = inf.dayFirst ?? dayFirstOpt

    let blank = 0, present = 0, negatives = 0, numbers = 0
    const bad: string[] = [], badRows: number[] = [], negEx: string[] = [], negRows: number[] = [], futEx: number[] = [], futRows: number[] = [], blankRows: number[] = []
    let badCount = 0, future = 0, latest = -Infinity
    // for a column read as text: how much of it would have been a number or a date
    let asNumber = 0, asDate = 0
    const odd: string[] = [], oddRows: number[] = []
    const mixable = !typed && type === inf.type && !idKind(h)
    let lo = Infinity, hi = -Infinity
    const seen = new Set<unknown>()
    for (let i = 0; i < n; i++) {
      const r = at(i)
      const v = rows[r][h]
      if (isBlank(v) || (softBlank && isSoftBlank(v))) { blank++; if (blankRows.length < 5) blankRows.push(r + 1); continue }
      present++
      const x = coerce(v, col, dayFirst, opts.decimal, softBlank)
      if (x == null) {
        if (typed) { badCount++; if (bad.length < 3 && !bad.includes(String(v))) bad.push(String(v)); if (badRows.length < 5) badRows.push(r + 1) }
        continue
      }
      if (seen.size < 100_000) seen.add(x)
      if (mixable) {
        const isNum = parseNumber(v, opts.decimal) != null && !(typeof v === 'string' && /^0\d+$/.test(v.trim()))
        const isDate = !isNum && parseDate(v, dayFirst) != null
        if (isNum) asNumber++
        else if (isDate) asDate++
        else { if (odd.length < 3 && !odd.includes(String(v))) odd.push(String(v)); if (oddRows.length < 5) oddRows.push(r + 1) }
      }
      if (type === 'number' && typeof x === 'number') {
        numbers++
        if (x < lo) lo = x
        if (x > hi) hi = x
        if (x < 0) { negatives++; if (negEx.length < 3 && !negEx.includes(String(v))) negEx.push(String(v)); if (negRows.length < 5) negRows.push(r + 1) }
      } else if (type === 'date' && typeof x === 'number' && x > opts.now + DAY) {
        future++
        if (x > latest) latest = x
        if (futEx.length < 3) futEx.push(x)
        if (futRows.length < 5) futRows.push(r + 1)
      }
    }

    const own = type === inf.type
    // mostly numbers (or dates) with enough other text mixed in that the column fell back to text
    const mixed = mixable && present >= 5 ? (asNumber / present >= 0.6 ? 'number' as const : asDate / present >= 0.6 ? 'date' as const : null) : null
    if (mixed) {
      const k = mixed === 'number' ? asNumber : asDate
      checks.push({
        column: h, kind: 'type', severity: 'warning', count: present - k, share: (present - k) / n, examples: odd, rows: oddRows,
        message: `${h} is read as text: ${plural(present - k, 'value', 'values')} of ${present.toLocaleString()} ${present - k === 1 ? `isn’t a ${mixed}` : `aren’t ${mixed}s`}`,
        fix: { label: `Read as ${mixed} (those become blank)`, type: mixed },
      })
    }
    if ((own && inf.misfit) || inf.softTokens?.length || inf.unit || (own && inf.isId)) {
      notes.push({ key: h, type, ...(own && inf.misfit ? { misfit: inf.misfit, misfits: inf.misfits } : {}), ...(inf.softTokens?.length ? { softTokens: inf.softTokens, softBlank } : {}), ...(inf.unit ? { unit: inf.unit } : {}), ...(own && inf.isId ? { isId: true } : {}) })
    }
    if (!n) continue

    const word = type === 'number' ? 'numbers' : type === 'date' ? 'dates' : 'yes/no values'
    if (badCount) {
      const share = badCount / Math.max(1, present)
      checks.push({
        column: h, kind: 'type', severity: share >= 0.01 ? 'warning' : 'info', count: badCount, share: badCount / n, examples: bad, rows: badRows,
        message: `${plural(badCount, 'value', 'values')} in ${h} ${badCount === 1 ? `isn’t a ${word.replace(/s$/, '')}` : `aren’t ${word}`} — ${badCount === 1 ? 'it' : 'they'} will be blank`,
        fix: share >= 0.2 ? { label: 'Read as text', type: 'category' } : undefined,
      })
    }
    if (future) {
      checks.push({
        column: h, kind: 'future', severity: 'warning', count: future, share: future / n, examples: futEx.map((t) => fmtDate(t)), rows: futRows,
        message: `${plural(future, 'date', 'dates')} in ${h} ${future === 1 ? 'is' : 'are'} in the future (latest ${fmtDate(latest)}) — “latest period” figures will follow ${future === 1 ? 'it' : 'them'}`,
        fix: { label: 'Leave those rows out', prep: { op: 'filter', column: h, cmp: 'gt', value: new Date(opts.now).toISOString().slice(0, 10), keep: false } },
      })
    }
    if (blank && present && blank / n >= 0.05) {
      checks.push({
        column: h, kind: 'blanks', severity: blank / n >= 0.3 ? 'warning' : 'info', count: blank, share: blank / n, examples: [], rows: blankRows,
        message: `${h} is blank in ${plural(blank, 'row', 'rows')} (${pct(blank / n)})${type === 'number' ? ' — sums and averages skip them' : ''}`,
        fix: { label: 'Leave those rows out', prep: { op: 'dropBlank', column: h } },
      })
    } else if (!present) {
      checks.push({ column: h, kind: 'blanks', severity: 'info', count: blank, share: 1, examples: [], rows: [], message: `${h} is empty` })
    }
    // a handful of negatives where everything else is zero or above: returns and corrections, or typing slips
    if (type === 'number' && numbers >= 20 && negatives > 0 && negatives / numbers <= 0.02) {
      checks.push({
        column: h, kind: 'negative', severity: 'info', count: negatives, share: negatives / n, examples: negEx, rows: negRows,
        message: `${plural(negatives, 'negative value', 'negative values')} in ${h} — everything else is zero or above`,
      })
    }
    if (type === 'number' && numbers >= 20 && present === numbers && seen.size === numbers && Number.isInteger(lo) && (hi - lo + 1 === numbers || idKind(h))) {
      // every value different and counting up: a row number or ID that would otherwise be summed
      checks.push({
        column: h, kind: 'identifier', severity: 'info', count: numbers, share: numbers / n, examples: [], rows: [],
        message: `${h} looks like a row number or ID (every value is different) — as a number it would be added up`,
        fix: { label: 'Treat as a label', type: 'category' },
      })
    } else if (own && inf.isId) {
      checks.push({
        column: h, kind: 'identifier', severity: 'info', count: present, share: present / n, examples: [], rows: [],
        message: `${h} is read as an identifier: kept as a label and left out of totals and suggested charts`,
        fix: inf.type === 'category' && inf.detected === 'category' && present === numbersOnly(rows, h, at, n) ? { label: 'Use as a number', type: 'number' } : undefined,
      })
    } else if (type === 'category' && present >= 20 && seen.size / present > 0.9) {
      checks.push({
        column: h, kind: 'identifier', severity: 'info', count: seen.size, share: seen.size / n, examples: [], rows: [],
        message: `${h} is different in almost every row — it won’t group into a readable chart`,
        fix: { label: 'Read as text', type: 'text' },
      })
    }
  }
  const order = { warning: 0, info: 1 }
  checks.sort((a, b) => order[a.severity] - order[b.severity] || b.share - a.share)
  return { checks, notes, inspected: n, total: rows.length }
}

/** How many of the inspected values are plain digits (an ID that could also be a number). */
function numbersOnly(rows: RawRow[], h: string, at: (i: number) => number, n: number): number {
  let k = 0
  for (let i = 0; i < n; i++) { const v = rows[at(i)][h]; if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v.trim()))) k++ }
  return k
}

/** The review as stored with the dataset: what was shown at import and accepted, so reopening does not present it as new. */
export interface AcknowledgedReview {
  at: number
  checks: Pick<ImportCheck, 'column' | 'kind' | 'severity' | 'count' | 'message'>[]
}

export const acknowledge = (r: ImportReview, at: number): AcknowledgedReview => ({
  at,
  checks: r.checks.slice(0, 20).map(({ column, kind, severity, count, message }) => ({ column, kind, severity, count, message })),
})
