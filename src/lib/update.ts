// Loading a fresh file into an existing dataset: column matching and append / replace merging.
// Pure functions, so the worker and the tests share them.

import type { ColType, RawRow, RawValue } from '../types'
import { coerce, inferColumn, isBlank, isSoftBlank, type InferOptions } from './infer'
import { fmtDate } from './format'

export type UpdateMode = 'append' | 'replace'

export interface HeaderCheck {
  /** existing columns found in the new file (same name, or same name ignoring case/spacing) */
  matched: { old: string; incoming: string }[]
  /** existing columns the new file lacks */
  missing: string[]
  /** columns only in the new file */
  added: string[]
}

const norm = (h: string) => h.toLowerCase().replace(/[\s_\-.]+/g, ' ').trim()

/** Matches incoming headers to the dataset's: exact first, then ignoring case, spaces and underscores. */
export function compareHeaders(existing: string[], incoming: string[]): HeaderCheck {
  const left = new Set(incoming)
  const matched: HeaderCheck['matched'] = []
  const missing: string[] = []
  for (const h of existing) {
    if (left.has(h)) { matched.push({ old: h, incoming: h }); left.delete(h); continue }
    const alt = [...left].find((x) => norm(x) === norm(h))
    if (alt) { matched.push({ old: h, incoming: alt }); left.delete(alt) } else missing.push(h)
  }
  return { matched, missing, added: [...left] }
}

export interface MergeOptions {
  mode: UpdateMode
  /** existing header → incoming header (from compareHeaders plus user choices); unmapped existing columns become blank */
  mapping: Record<string, string | undefined>
  /**
   * append only: match incoming rows to rows already loaded. With key columns, a match with changed values
   * overwrites the loaded row and an unchanged match is skipped; without keys, identical rows are skipped.
   */
  dedupe?: { enabled: boolean; keys: string[] }
  /** with key columns: the new file is a full export, so loaded rows whose key isn't in it are removed */
  sync?: boolean
}

export interface MergeResult {
  headers: string[]
  rows: RawRow[]
  added: number
  /** loaded rows overwritten with new values (same key) */
  updated: number
  skipped: number
  removed: number
}

const cell = (v: RawValue) => (v == null ? '' : v instanceof Date ? v.toISOString() : String(v).trim())

/**
 * Builds the new source rows under the dataset's existing header names, so prep steps, overrides,
 * computed columns and dashboards keep working. New columns are appended to the header list.
 */
export function mergeRows(existingHeaders: string[], existingRows: RawRow[], incomingHeaders: string[], incomingRows: RawRow[], o: MergeOptions): MergeResult {
  const mappedIncoming = new Set(Object.values(o.mapping).filter(Boolean) as string[])
  const extra = incomingHeaders.filter((h) => !mappedIncoming.has(h) && !existingHeaders.includes(h))
  const headers = [...existingHeaders, ...extra]
  const translate = (r: RawRow): RawRow => {
    const out: RawRow = {}
    for (const h of existingHeaders) {
      const src = o.mapping[h]
      out[h] = src ? r[src] ?? null : null
    }
    for (const h of extra) out[h] = r[h] ?? null
    return out
  }
  const fresh = incomingRows.map(translate)
  if (o.mode === 'replace') {
    return { headers, rows: fresh, added: fresh.length, updated: 0, skipped: 0, removed: existingRows.length }
  }
  const rows = extra.length ? existingRows.map((r) => { const c = { ...r }; for (const h of extra) c[h] = null; return c }) : [...existingRows]
  if (!o.dedupe?.enabled) return { headers, rows: [...rows, ...fresh], added: fresh.length, updated: 0, skipped: 0, removed: 0 }
  const keyed = o.dedupe.keys.length > 0
  // without a key, rows are compared on the columns the new file provides (a missing column would make every row look new)
  const keys = keyed ? o.dedupe.keys : existingHeaders.filter((h) => o.mapping[h])
  // an update only carries the columns the new file has; the others keep their loaded values
  const fields = [...existingHeaders.filter((h) => o.mapping[h]), ...extra]
  const sig = (r: RawRow) => keys.map((k) => cell(r[k])).join('\u0001')
  const at = new Map<string, number>()
  rows.forEach((r, i) => { const s = sig(r); if (!at.has(s)) at.set(s, i) })
  const loaded = rows.length
  const touched = new Set<number>()
  let added = 0, skipped = 0
  for (const r of fresh) {
    const s = sig(r)
    const i = at.get(s)
    if (i === undefined) { at.set(s, rows.length); rows.push(r); added++; continue }
    if (!keyed || fields.every((h) => cell(rows[i][h]) === cell(r[h]))) { skipped++; continue }
    // the same key again: the newest values win
    const next = { ...rows[i] }
    for (const h of fields) next[h] = r[h]
    rows[i] = next
    if (i < loaded) touched.add(i)
  }
  if (keyed && o.sync) {
    // a full export: what it no longer lists is gone
    const listed = new Set(fresh.map(sig))
    const kept = rows.filter((r, i) => i >= loaded || listed.has(sig(r)))
    return { headers, rows: kept, added, updated: touched.size, skipped, removed: rows.length - kept.length }
  }
  return { headers, rows, added, updated: touched.size, skipped, removed: 0 }
}

/** A sensible default key for de-duplication: an ID-like column present in both files. */
export function guessKey(headers: string[], rows: RawRow[]): string | undefined {
  const idLike = headers.filter((h) => /(^id$|[ _-]id$|^id[ _-]|number$|^no\.?$|key$|code$)/i.test(h.trim()) || /order|invoice|transaction|ticket/i.test(h) && /id|no|number/i.test(h))
  for (const h of idLike) {
    // nearly unique is enough: raw exports often carry a few duplicate rows that prep steps remove later
    const vals = rows.slice(0, 20000).map((r) => cell(r[h])).filter(Boolean)
    if (vals.length && new Set(vals).size >= vals.length * 0.95) return h
  }
  return undefined
}

export interface DataCheck {
  column: string
  kind: 'type' | 'blanks' | 'negative' | 'future'
  count: number
  message: string
  /** a few offending values, as written in the file */
  examples: string[]
}

const DAY = 86_400_000

/**
 * Compares the incoming file with the data already loaded, column by column, and reports values that look wrong:
 * text in a number or date column, blanks in a column that was always filled, negatives in a column that never
 * had any, and dates in the future. Checks run on the raw file, before prep steps.
 */
export function checkIncoming(existingHeaders: string[], existingRows: RawRow[], incomingRows: RawRow[], mapping: Record<string, string | undefined>,
  opts: InferOptions & { now: number; overrides?: Record<string, ColType> }): DataCheck[] {
  const out: DataCheck[] = []
  const sample = existingRows.length > 20000 ? existingRows.filter((_, i) => i % Math.ceil(existingRows.length / 20000) === 0) : existingRows
  const dayFirst = opts.dateOrder === 'dmy'
  for (const h of existingHeaders) {
    const src = mapping[h]
    if (!src || !incomingRows.length) continue
    const values = sample.map((r) => r[h])
    const inferred = inferColumn(h, values, opts)
    const type = opts.overrides?.[h] ?? inferred.type
    const col = { type, grain: inferred.grain, unit: inferred.unit }
    const read = (v: RawValue) => coerce(v, col, inferred.dayFirst ?? dayFirst, opts.decimal)
    // NA / None / - are blanks under a number or date, and values under a category
    const softBlank = opts.softBlanks === 'always' || (opts.softBlanks !== 'never' && (type === 'number' || type === 'date' || type === 'boolean' || !!inferred.softBlank))
    const empty = (v: RawValue) => isBlank(v) || (softBlank && isSoftBlank(v))
    // what the loaded data looks like
    let oldBlank = 0, oldBad = 0, oldMin = Infinity, oldMax = -Infinity
    for (const v of values) {
      if (empty(v)) { oldBlank++; continue }
      const x = read(v)
      if (x == null) oldBad++
      else if (typeof x === 'number') { if (x < oldMin) oldMin = x; if (x > oldMax) oldMax = x }
    }
    const oldPresent = values.length - oldBlank
    // the new file, in full
    const blanks: number[] = [], bad: string[] = [], negative: string[] = [], future: number[] = []
    let present = 0
    const futureFrom = Math.max(oldMax, opts.now) + DAY
    for (let i = 0; i < incomingRows.length; i++) {
      const v = incomingRows[i][src]
      if (empty(v)) { blanks.push(i); continue }
      present++
      const x = read(v)
      if (x == null) { if (type === 'number' || type === 'date' || type === 'boolean') bad.push(String(v)) }
      else if (type === 'number' && typeof x === 'number' && x < 0) negative.push(String(v))
      else if (type === 'date' && typeof x === 'number' && x > futureFrom) future.push(x)
    }
    const few = (xs: string[]) => [...new Set(xs)].slice(0, 3)
    const n = (k: number, one: string, many: string) => `${k.toLocaleString()} ${k === 1 ? one : many}`
    const typeWord = type === 'number' ? 'numbers' : type === 'date' ? 'dates' : 'yes/no values'
    if (bad.length >= Math.max(3, present * 0.02) && bad.length / Math.max(1, present) > (oldBad / Math.max(1, oldPresent)) * 3 + 0.01) {
      out.push({ column: h, kind: 'type', count: bad.length, examples: few(bad), message: `${n(bad.length, 'value', 'values')} in ${h} ${bad.length === 1 ? 'isn’t a' : 'aren’t'} ${bad.length === 1 ? typeWord.replace(/s$/, '') : typeWord}` })
    }
    if (oldBlank / Math.max(1, values.length) < 0.005 && blanks.length >= Math.max(3, incomingRows.length * 0.02)) {
      out.push({ column: h, kind: 'blanks', count: blanks.length, examples: [], message: `${n(blanks.length, 'row has', 'rows have')} no ${h} — it was always filled before` })
    }
    if (type === 'number' && oldPresent >= 20 && oldMin >= 0 && negative.length) {
      out.push({ column: h, kind: 'negative', count: negative.length, examples: few(negative), message: `${n(negative.length, 'negative value', 'negative values')} in ${h} — it was never negative before` })
    }
    if (type === 'date' && future.length) {
      out.push({ column: h, kind: 'future', count: future.length, examples: few(future.map((t) => fmtDate(t))), message: `${n(future.length, 'date', 'dates')} in ${h} ${future.length === 1 ? 'is' : 'are'} in the future (latest ${fmtDate(Math.max(...future))})` })
    }
  }
  return out
}
