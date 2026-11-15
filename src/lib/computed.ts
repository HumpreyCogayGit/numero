import type { ColType, Column, ComputedDef, DateGrain, NumFormat, Row, Value } from '../types'
import { evaluate, FormulaError, FUNCTIONS, str, tokenize, type FValue } from './formula'
import { detectGrain } from './infer'

export interface Typed {
  type: ColType
  values: Value[]
  format?: NumFormat
  grain?: DateGrain
  discrete?: boolean
}

/** Decides a column type from formula results and converts them to stored cell values. */
export function typeResults(raw: FValue[], format: ComputedDef['format'] = 'auto'): Typed {
  let nums = 0, dates = 0, bools = 0, strs = 0
  for (const v of raw) {
    if (v == null || v === '') continue
    if (v instanceof Date) dates++
    else if (typeof v === 'number') nums++
    else if (typeof v === 'boolean') bools++
    else strs++
  }
  const present = nums + dates + bools + strs
  if (!present) return { type: 'number', values: raw.map(() => null), format: format === 'auto' ? 'decimal' : format }

  if (dates === present) {
    const values = raw.map((v) => (v instanceof Date && !isNaN(+v) ? +v : null))
    return { type: 'date', values, grain: detectGrain(values.filter((x): x is number => x != null).slice(0, 5000)) }
  }
  if (bools === present) return { type: 'boolean', values: raw.map((v) => (typeof v === 'boolean' ? v : null)) }
  if (nums === present || (nums && nums + bools === present)) {
    // 12 significant digits removes float noise (0.1 + 0.2) so equal results group together
    const values = raw.map((v) => (typeof v === 'number' && Number.isFinite(v) ? +v.toPrecision(12) : typeof v === 'boolean' ? (v ? 1 : 0) : null))
    const valid = values.filter((x): x is number => x != null)
    const allInt = valid.every((x) => Number.isInteger(x))
    const distinct = new Set(valid).size
    return {
      type: 'number', values,
      format: format && format !== 'auto' ? format : allInt ? 'integer' : 'decimal',
      discrete: allInt && distinct <= 12 && distinct < valid.length / 3,
    }
  }
  // text (mixed results become text too)
  const values = raw.map((v) => (v == null || v === '' ? null : str(v)))
  const present2 = values.filter((v): v is string => v != null)
  const distinct = new Set(present2).size
  const avgLen = present2.reduce((a, s) => a + s.length, 0) / Math.max(1, present2.length)
  const category = avgLen < 40 && (distinct <= 50 || distinct / present2.length < 0.5)
  return { type: category ? 'category' : 'text', values }
}

export function uniqueKey(name: string, taken: Set<string>): string {
  const base = 'calc_' + (name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'column')
  let k = base, i = 2
  while (taken.has(k)) k = `${base}_${i++}`
  return k
}

/** Evaluates computed columns in order; each formula can use the base columns and earlier computed ones. */
export function applyComputed(baseCols: Column[], baseRows: Row[], defs: ComputedDef[]): { columns: Column[]; rows: Row[] } {
  const columns = [...baseCols]
  const rows = defs.length ? baseRows.map((r) => ({ ...r })) : baseRows
  for (const def of defs) {
    let typed: Typed
    let formulaError: string | undefined
    try {
      const res = evaluate(def.formula, columns, rows)
      typed = typeResults(res.values, def.format)
      if (res.rowErrors) formulaError = `${res.rowErrors.toLocaleString()} rows failed: ${res.firstRowError}`
    } catch (e) {
      formulaError = e instanceof FormulaError || e instanceof Error ? e.message : String(e)
      typed = { type: 'number', values: rows.map(() => null), format: 'decimal' }
    }
    let missing = 0
    const seen = new Set<Value>()
    typed.values.forEach((v, i) => {
      rows[i][def.key] = v
      if (v == null) missing++
      else if (seen.size < 100000) seen.add(v)
    })
    columns.push({
      key: def.key, name: def.name, type: typed.type, detected: typed.type,
      format: typed.format, grain: typed.grain, discrete: typed.discrete,
      distinct: seen.size, missing, formula: def.formula, formulaError,
    })
  }
  return { columns, rows }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Rewrites references to a renamed column — both [Old Name] and bare OldName — at the token level,
 * so text inside quotes and function names are never touched.
 */
export function renameRefs(defs: ComputedDef[], oldName: string, newName: string, key?: string): ComputedDef[] {
  const lo = oldName.trim().toLowerCase()
  const keyLo = key?.toLowerCase()
  const bare = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(newName)
  return defs.map((d) => {
    let toks
    try { toks = tokenize(d.formula) } catch { return d }
    let out = ''
    let pos = 0
    for (const t of toks) {
      if (t.t === 'eof') break
      const hit = (t.t === 'col' && t.v.trim().toLowerCase() === lo)
        || (t.t === 'id' && !FUNCTIONS[t.v.toUpperCase()] && (t.v.toLowerCase() === lo) && t.v.toLowerCase() !== keyLo)
      if (hit) {
        out += d.formula.slice(pos, t.s) + (t.t === 'id' && bare ? newName : `[${newName}]`)
        pos = t.e
      }
    }
    out += d.formula.slice(pos)
    return out === d.formula ? d : { ...d, formula: out }
  })
}

/** Computed columns whose formula mentions the given column by [name] or key. */
export function dependents(defs: ComputedDef[], col: Pick<Column, 'key' | 'name'>): ComputedDef[] {
  const re = new RegExp(`\\[\\s*(${escapeRe(col.name)}|${escapeRe(col.key)})\\s*\\]|\\b${escapeRe(col.key)}\\b`, 'i')
  return defs.filter((d) => d.key !== col.key && re.test(d.formula))
}
