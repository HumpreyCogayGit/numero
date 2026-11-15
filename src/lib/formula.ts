// Formula language for computed columns.
// Parsed into an AST and interpreted — never passed to eval / new Function.
//
//   [Revenue] - [Cost]                      column refs in brackets (bare names work without spaces)
//   IF([Margin] > 0.2, "High", "Low")       functions, case-insensitive
//   [Sales] / SUM([Sales]) * 100            single-argument SUM/AVG/MIN/MAX/... aggregate the whole column
//   RUNNING_SUM([Sales], [Date], [Region])  window functions take optional order-by / partition-by columns

import type { Column, Row } from '../types'
import { bucketDate } from './dates'
import { parseDate, parseNumber } from './infer'
import { quantileSorted } from './stats'

export type FValue = number | string | boolean | Date | null

export class FormulaError extends Error {
  constructor(message: string, public start: number, public end: number) {
    super(message)
  }
}

// ---------- tokenizer ----------

type TokType = 'num' | 'str' | 'col' | 'id' | 'op' | 'lp' | 'rp' | 'comma' | 'eof'
export interface Token { t: TokType; v: string; s: number; e: number }

const OPS = ['<=', '>=', '<>', '!=', '==', '&&', '||', '+', '-', '*', '/', '%', '^', '&', '=', '<', '>', '!']

export function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    const s = i
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!
      i += m[0].length
      out.push({ t: 'num', v: m[0], s, e: i })
      continue
    }
    if (c === '"' || c === "'") {
      let v = ''
      i++
      for (;;) {
        if (i >= src.length) throw new FormulaError('Text is missing its closing quote', s, src.length)
        if (src[i] === c) {
          if (src[i + 1] === c) { v += c; i += 2; continue }
          i++
          break
        }
        v += src[i++]
      }
      out.push({ t: 'str', v, s, e: i })
      continue
    }
    if (c === '[') {
      const end = src.indexOf(']', i + 1)
      if (end < 0) throw new FormulaError('Column reference is missing its closing ]', s, src.length)
      out.push({ t: 'col', v: src.slice(i + 1, end), s, e: end + 1 })
      i = end + 1
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i))!
      i += m[0].length
      out.push({ t: 'id', v: m[0], s, e: i })
      continue
    }
    if (c === '(') { out.push({ t: 'lp', v: c, s, e: ++i }); continue }
    if (c === ')') { out.push({ t: 'rp', v: c, s, e: ++i }); continue }
    if (c === ',' || c === ';') { out.push({ t: 'comma', v: ',', s, e: ++i }); continue }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (op) { i += op.length; out.push({ t: 'op', v: op, s, e: i }); continue }
    throw new FormulaError(`Unexpected character “${c}”`, s, s + 1)
  }
  out.push({ t: 'eof', v: '', s: src.length, e: src.length })
  return out
}

// ---------- parser ----------

export type Node =
  | { k: 'lit'; v: FValue; s: number; e: number }
  | { k: 'col'; col: Column; s: number; e: number }
  | { k: 'un'; op: string; a: Node; s: number; e: number }
  | { k: 'bin'; op: string; a: Node; b: Node; s: number; e: number }
  | { k: 'call'; name: string; def: FnDef; args: Node[]; s: number; e: number; win: boolean }

export function resolveColumn(ref: string, cols: Column[]): Column | undefined {
  const r = ref.trim()
  const lo = r.toLowerCase()
  return cols.find((c) => c.name === r) ?? cols.find((c) => c.key === r)
    ?? cols.find((c) => c.name.toLowerCase() === lo) ?? cols.find((c) => c.key.toLowerCase() === lo)
}

export function parse(src: string, cols: Column[]): Node {
  const toks = tokenize(src)
  let p = 0
  const peek = () => toks[p]
  const next = () => toks[p++]
  const isKw = (t: Token, kw: string) => t.t === 'id' && t.v.toUpperCase() === kw
  const isOp = (t: Token, ...ops: string[]) => t.t === 'op' && ops.includes(t.v)
  const bin = (op: string, a: Node, b: Node): Node => ({ k: 'bin', op, a, b, s: a.s, e: b.e })

  if (toks.length === 1) throw new FormulaError('Enter a formula', 0, 0)

  function or(): Node {
    let a = and()
    while (isKw(peek(), 'OR') || isOp(peek(), '||')) { next(); a = bin('OR', a, and()) }
    return a
  }
  function and(): Node {
    let a = not()
    while (isKw(peek(), 'AND') || isOp(peek(), '&&')) { next(); a = bin('AND', a, not()) }
    return a
  }
  function not(): Node {
    if (isKw(peek(), 'NOT') || isOp(peek(), '!')) {
      const t = next()
      const a = not()
      return { k: 'un', op: 'NOT', a, s: t.s, e: a.e }
    }
    return cmp()
  }
  function cmp(): Node {
    let a = concat()
    while (isOp(peek(), '=', '==', '!=', '<>', '<', '>', '<=', '>=')) {
      const op = next().v
      a = bin(op === '==' ? '=' : op === '<>' ? '!=' : op, a, concat())
    }
    return a
  }
  function concat(): Node {
    let a = add()
    while (isOp(peek(), '&')) { next(); a = bin('&', a, add()) }
    return a
  }
  function add(): Node {
    let a = mul()
    while (isOp(peek(), '+', '-')) { const op = next().v; a = bin(op, a, mul()) }
    return a
  }
  function mul(): Node {
    let a = unary()
    while (isOp(peek(), '*', '/', '%')) { const op = next().v; a = bin(op, a, unary()) }
    return a
  }
  function unary(): Node {
    if (isOp(peek(), '-', '+')) {
      const t = next()
      const a = unary()
      return t.v === '-' ? { k: 'un', op: 'NEG', a, s: t.s, e: a.e } : a
    }
    return pow()
  }
  function pow(): Node {
    const a = primary()
    if (isOp(peek(), '^')) { next(); return bin('^', a, unary()) }
    return a
  }
  function primary(): Node {
    const t = next()
    switch (t.t) {
      case 'num': return { k: 'lit', v: parseFloat(t.v), s: t.s, e: t.e }
      case 'str': return { k: 'lit', v: t.v, s: t.s, e: t.e }
      case 'col': {
        const col = resolveColumn(t.v, cols)
        if (!col) throw new FormulaError(`Unknown column [${t.v}]`, t.s, t.e)
        return { k: 'col', col, s: t.s, e: t.e }
      }
      case 'lp': {
        const a = or()
        const r = next()
        if (r.t !== 'rp') throw new FormulaError('Expected a closing )', r.s, Math.max(r.e, r.s + 1))
        return a
      }
      case 'id': {
        const up = t.v.toUpperCase()
        if (peek().t === 'lp') {
          const def = FUNCTIONS[up]
          if (!def) throw new FormulaError(`Unknown function ${t.v}()`, t.s, t.e)
          next()
          const args: Node[] = []
          if (peek().t !== 'rp') {
            for (;;) {
              args.push(or())
              if (peek().t === 'comma') { next(); continue }
              break
            }
          }
          const r = next()
          if (r.t !== 'rp') {
            const startsValue = r.t === 'str' || r.t === 'num' || r.t === 'col' || r.t === 'id' || r.t === 'lp'
            throw new FormulaError(
              startsValue ? `Missing a comma before ${r.t === 'str' ? src.slice(r.s, r.e) : `“${src.slice(r.s, r.e)}”`} in ${up}()` : r.t === 'eof' ? `${up}() is missing its closing )` : `Expected , or ) in ${up}()`,
              r.s, Math.max(r.e, r.s + 1))
          }
          if (args.length < def.min || args.length > def.max) {
            const want = def.min === def.max ? `${def.min}` : def.max === Infinity ? `at least ${def.min}` : `${def.min}–${def.max}`
            throw new FormulaError(`${up}() takes ${want} argument${def.max === 1 ? '' : 's'} — ${def.sig}`, t.s, r.e)
          }
          const win = !!def.win && (def.winWhen ? def.winWhen(args.length) : true)
          return { k: 'call', name: up, def, args, s: t.s, e: r.e, win }
        }
        if (up === 'TRUE') return { k: 'lit', v: true, s: t.s, e: t.e }
        if (up === 'FALSE') return { k: 'lit', v: false, s: t.s, e: t.e }
        if (up === 'NULL') return { k: 'lit', v: null, s: t.s, e: t.e }
        const col = resolveColumn(t.v, cols)
        if (col) return { k: 'col', col, s: t.s, e: t.e }
        if (FUNCTIONS[up]) throw new FormulaError(`${up} is a function — add parentheses: ${up}(…)`, t.s, t.e)
        throw new FormulaError(`Unknown name “${t.v}” — wrap column names in [brackets]`, t.s, t.e)
      }
      case 'eof': throw new FormulaError('Formula ends unexpectedly', t.s, t.s)
      default: throw new FormulaError(`Unexpected “${t.v}”`, t.s, t.e)
    }
  }

  const ast = or()
  const rest = peek()
  if (rest.t !== 'eof') {
    const msg = rest.t === 'rp' ? 'Extra closing ) — check your parentheses' : rest.t === 'comma' ? 'Unexpected comma outside a function' : `Unexpected “${src.slice(rest.s, rest.e)}” — missing an operator?`
    throw new FormulaError(msg, rest.s, rest.e)
  }
  return ast
}

/** Columns a formula references (used for previews and dependency checks). */
export function referencedColumns(node: Node, out = new Set<string>()): Set<string> {
  if (node.k === 'col') out.add(node.col.key)
  else if (node.k === 'un') referencedColumns(node.a, out)
  else if (node.k === 'bin') { referencedColumns(node.a, out); referencedColumns(node.b, out) }
  else if (node.k === 'call') node.args.forEach((a) => referencedColumns(a, out))
  return out
}

// ---------- coercion helpers ----------

const isDate = (v: FValue): v is Date => v instanceof Date
export function num(v: FValue): number | null {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (isDate(v)) return +v
  return parseNumber(v)
}
export function str(v: FValue): string {
  if (v == null) return ''
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toPrecision(12))
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (isDate(v)) {
    const iso = v.toISOString()
    return v.getUTCHours() || v.getUTCMinutes() || v.getUTCSeconds() ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10)
  }
  return v
}
export function toDate(v: FValue): Date | null {
  if (v == null) return null
  if (isDate(v)) return isNaN(+v) ? null : v
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1000 && v <= 9999 ? new Date(Date.UTC(v, 0, 1)) : new Date(v)
  if (typeof v === 'string') {
    const s = v.trim()
    if (/^\d{4}$/.test(s)) return new Date(Date.UTC(+s, 0, 1))
    const t = parseDate(s) ?? Date.parse(s)
    return t == null || isNaN(t) ? null : new Date(t)
  }
  return null
}
export const truthy = (v: FValue) => !(v == null || v === false || v === 0 || v === '' || (typeof v === 'number' && isNaN(v)))
const fin = (n: number | null) => (n == null || !Number.isFinite(n) ? null : n)

function compare(a: FValue, b: FValue): number | null {
  if (a == null || b == null) return null
  if (isDate(a) || isDate(b)) {
    const x = toDate(a), y = toDate(b)
    return x && y ? +x - +y : null
  }
  if (typeof a === 'number' || typeof b === 'number' || typeof a === 'boolean' || typeof b === 'boolean') {
    const x = num(a), y = num(b)
    if (x != null && y != null) return x - y
  }
  const x = str(a), y = str(b)
  return x < y ? -1 : x > y ? 1 : 0
}

function equals(a: FValue, b: FValue): boolean {
  if (a == null || b == null) return a == null && b == null
  return compare(a, b) === 0
}

// ---------- dates ----------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
type Unit = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second'

function unitOf(v: FValue, fallback: Unit = 'day'): Unit {
  if (v == null) return fallback
  const u = str(v).toLowerCase().replace(/s$/, '')
  const map: Record<string, Unit> = { y: 'year', yr: 'year', year: 'year', q: 'quarter', quarter: 'quarter', m: 'month', mo: 'month', month: 'month', w: 'week', wk: 'week', week: 'week', d: 'day', day: 'day', h: 'hour', hr: 'hour', hour: 'hour', min: 'minute', minute: 'minute', mi: 'minute', s: 'second', sec: 'second', second: 'second' }
  if (!map[u]) throw new Error(`Unknown date unit “${str(v)}” — use day, week, month, quarter, year, hour or minute`)
  return map[u]
}

function dateAdd(d: Date, n: number, unit: Unit): Date {
  const ms = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5 } as Record<string, number>
  if (ms[unit]) return new Date(+d + n * ms[unit])
  const months = unit === 'year' ? n * 12 : unit === 'quarter' ? n * 3 : n
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + Math.trunc(months), day = d.getUTCDate()
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return new Date(Date.UTC(y, m, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()))
}

function dateDiff(a: Date, b: Date, unit: Unit): number {
  const ms = +b - +a
  switch (unit) {
    case 'second': return Math.trunc(ms / 1e3)
    case 'minute': return Math.trunc(ms / 6e4)
    case 'hour': return Math.trunc(ms / 36e5)
    case 'day': return Math.trunc(ms / 864e5)
    case 'week': return Math.trunc(ms / 6048e5)
    default: {
      let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth())
      const partial = (b.getUTCDate() * 864e5 + (+b % 864e5)) - (a.getUTCDate() * 864e5 + (+a % 864e5))
      if (months > 0 && partial < 0) months--
      if (months < 0 && partial > 0) months++
      return unit === 'month' ? months : unit === 'quarter' ? Math.trunc(months / 3) : Math.trunc(months / 12)
    }
  }
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = (t.getUTCDay() + 6) % 7
  t.setUTCDate(t.getUTCDate() - day + 3)
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4))
  return 1 + Math.round(((+t - +firstThu) / 864e5 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7)
}

export function formatDate(d: Date, pattern: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return pattern.replace(/'[^']*'|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|mm|ss|Q/g, (tok) => {
    if (tok.startsWith("'")) return tok.slice(1, -1)
    switch (tok) {
      case 'YYYY': return String(d.getUTCFullYear())
      case 'YY': return pad(d.getUTCFullYear() % 100)
      case 'MMMM': return MONTHS[d.getUTCMonth()]
      case 'MMM': return MONTHS[d.getUTCMonth()].slice(0, 3)
      case 'MM': return pad(d.getUTCMonth() + 1)
      case 'M': return String(d.getUTCMonth() + 1)
      case 'DD': return pad(d.getUTCDate())
      case 'D': return String(d.getUTCDate())
      case 'dddd': return DAYS[(d.getUTCDay() + 6) % 7]
      case 'ddd': return DAYS[(d.getUTCDay() + 6) % 7].slice(0, 3)
      case 'HH': return pad(d.getUTCHours())
      case 'mm': return pad(d.getUTCMinutes())
      case 'ss': return pad(d.getUTCSeconds())
      case 'Q': return String(Math.floor(d.getUTCMonth() / 3) + 1)
      default: return tok
    }
  })
}

// ---------- window helpers ----------

/** Row indices grouped by partition key, each group sorted by the order-by values (nulls last, stable). */
function sequences(n: number, order?: FValue[], part?: FValue[]): number[][] {
  const groups = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    const k = part ? str(part[i]) : ''
    let g = groups.get(k)
    if (!g) groups.set(k, (g = []))
    g.push(i)
  }
  const out = [...groups.values()]
  if (order) {
    for (const g of out) g.sort((a, b) => {
      const x = order[a], y = order[b]
      if (x == null) return y == null ? a - b : 1
      if (y == null) return -1
      return (compare(x, y) ?? 0) || a - b
    })
  }
  return out
}

function numbers(xs: FValue[]): number[] {
  const out: number[] = []
  for (const x of xs) { const v = num(x); if (v != null) out.push(v) }
  return out
}

export type ColAgg = (xs: FValue[]) => FValue
export const colAggs: Record<string, ColAgg> = {
  SUM: (xs) => numbers(xs).reduce((a, b) => a + b, 0),
  AVG: (xs) => { const v = numbers(xs); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null },
  MEDIAN: (xs) => { const v = numbers(xs).sort((a, b) => a - b); return v.length ? quantileSorted(v, 0.5) : null },
  MIN: (xs) => { let m: FValue = null; for (const x of xs) if (x != null && (m == null || (compare(x, m) ?? 0) < 0)) m = x; return m },
  MAX: (xs) => { let m: FValue = null; for (const x of xs) if (x != null && (m == null || (compare(x, m) ?? 0) > 0)) m = x; return m },
  COUNT: (xs) => xs.filter((x) => x != null && x !== '').length,
  COUNTD: (xs) => new Set(xs.filter((x) => x != null && x !== '').map(str)).size,
  STDEV: (xs) => {
    const v = numbers(xs)
    if (v.length < 2) return null
    const m = v.reduce((a, b) => a + b, 0) / v.length
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1))
  },
}

/** Applies a column aggregate across the whole column (or per partition) and broadcasts it back to each row. */
function broadcast(agg: ColAgg, xs: FValue[], part?: FValue[]): FValue[] {
  const out = new Array<FValue>(xs.length)
  for (const g of sequences(xs.length, undefined, part)) {
    const v = agg(g.map((i) => xs[i]))
    for (const i of g) out[i] = v
  }
  return out
}

function rankWithin(xs: FValue[], idx: number[], desc: boolean, out: FValue[]) {
  const valid = idx.filter((i) => num(xs[i]) != null).sort((a, b) => (num(xs[desc ? b : a])! - num(xs[desc ? a : b])!))
  let rank = 0
  valid.forEach((i, j) => {
    if (j === 0 || num(xs[i]) !== num(xs[valid[j - 1]])) rank = j + 1
    out[i] = rank
  })
}

// ---------- function registry ----------

export type Category = 'Logic' | 'Math' | 'Text' | 'Date' | 'Aggregate' | 'Window' | 'Binning'

export interface FnDef {
  cat: Category
  sig: string
  desc: string
  ex: string
  min: number
  max: number
  fn?: (...a: FValue[]) => FValue
  /** gets unevaluated args — for IF/IFS/SWITCH/COALESCE short-circuiting */
  lazy?: (args: Node[], ev: (n: Node) => FValue) => FValue
  /** evaluated once over the whole column; receives each argument as a full column */
  win?: (cols: FValue[][], n: number) => FValue[]
  /** for dual-mode functions: true when this arity means "aggregate the column" */
  winWhen?: (argc: number) => boolean
}

const N = (v: FValue) => num(v)
const math1 = (f: (x: number) => number) => (x: FValue) => { const v = N(x); return v == null ? null : fin(f(v)) }
const dateFn = (f: (d: Date) => FValue) => (x: FValue) => { const d = toDate(x); return d ? f(d) : null }
const textFn = (f: (s: string, ...rest: FValue[]) => FValue) => (s: FValue, ...rest: FValue[]) => (s == null ? null : f(str(s), ...rest))

const D = (cat: Category, sig: string, desc: string, ex: string, min: number, max: number, rest: Partial<FnDef>): FnDef => ({ cat, sig, desc, ex, min, max, ...rest })

/** Aggregates that also work row-wise when given several arguments — MAX([a], [b]). */
function dualAgg(name: keyof typeof colAggs, desc: string, ex: string, rowWise?: (xs: FValue[]) => FValue): FnDef {
  return D('Aggregate', `${name}(column)`, desc, ex, 1, rowWise ? Infinity : 1, {
    win: ([xs]) => broadcast(colAggs[name], xs),
    winWhen: (argc) => argc === 1,
    fn: rowWise ? (...xs: FValue[]) => rowWise(xs) : undefined,
  })
}

const groupAgg = (name: keyof typeof colAggs, desc: string, ex: string): FnDef =>
  D('Aggregate', `GROUP_${name}(column, group_by)`, desc, ex, 2, 2, { win: ([xs, part]) => broadcast(colAggs[name], xs, part) })

export const FUNCTIONS: Record<string, FnDef> = {
  // ---- logic
  IF: D('Logic', 'IF(condition, then, [else])', 'Returns one value when the condition is true, another when it is false.', 'IF([Profit] > 0, "Profit", "Loss")', 2, 3, {
    lazy: ([c, a, b], ev) => (truthy(ev(c)) ? ev(a) : b ? ev(b) : null),
  }),
  IFS: D('Logic', 'IFS(cond1, value1, cond2, value2, …, [else])', 'Checks conditions in order and returns the value of the first one that is true.', 'IFS([Score] >= 90, "A", [Score] >= 80, "B", "C")', 2, Infinity, {
    lazy: (args, ev) => {
      for (let i = 0; i + 1 < args.length; i += 2) if (truthy(ev(args[i]))) return ev(args[i + 1])
      return args.length % 2 ? ev(args[args.length - 1]) : null
    },
  }),
  SWITCH: D('Logic', 'SWITCH(value, match1, result1, …, [default])', 'Compares a value against a list of matches and returns the paired result.', 'SWITCH([Region], "N", "North", "S", "South", "Other")', 3, Infinity, {
    lazy: ([x, ...rest], ev) => {
      const v = ev(x)
      for (let i = 0; i + 1 < rest.length; i += 2) if (equals(v, ev(rest[i]))) return ev(rest[i + 1])
      return rest.length % 2 ? ev(rest[rest.length - 1]) : null
    },
  }),
  COALESCE: D('Logic', 'COALESCE(value1, value2, …)', 'Returns the first value that is not blank.', 'COALESCE([Nickname], [Name], "Unknown")', 1, Infinity, {
    lazy: (args, ev) => { for (const a of args) { const v = ev(a); if (v != null && v !== '') return v } return null },
  }),
  ISBLANK: D('Logic', 'ISBLANK(value)', 'True when the value is empty or missing.', 'ISBLANK([Director])', 1, 1, { fn: (x) => x == null || x === '' }),
  ISNUMBER: D('Logic', 'ISNUMBER(value)', 'True when the value is (or can be read as) a number.', 'ISNUMBER([Code])', 1, 1, { fn: (x) => num(x) != null && !isDate(x) }),
  NULLIF: D('Logic', 'NULLIF(value, other)', 'Returns blank when both values are equal — useful to avoid dividing by zero.', '[Sales] / NULLIF([Units], 0)', 2, 2, { fn: (a, b) => (equals(a, b) ? null : a) }),
  AND: D('Logic', 'AND(cond1, cond2, …)', 'True when every condition is true.', 'AND([Age] >= 18, [Age] < 65)', 1, Infinity, { fn: (...xs) => xs.every(truthy) }),
  OR: D('Logic', 'OR(cond1, cond2, …)', 'True when any condition is true.', 'OR([Status] = "Late", [Status] = "Lost")', 1, Infinity, { fn: (...xs) => xs.some(truthy) }),
  NOT: D('Logic', 'NOT(condition)', 'Reverses a true/false value.', 'NOT(ISBLANK([Email]))', 1, 1, { fn: (x) => (x == null ? null : !truthy(x)) }),
  IN: D('Logic', 'IN(value, option1, option2, …)', 'True when the value equals any of the options.', 'IN([Origin], "Europe", "Japan")', 2, Infinity, { fn: (x, ...opts) => opts.some((o) => equals(x, o)) }),
  BETWEEN: D('Logic', 'BETWEEN(value, low, high)', 'True when low ≤ value ≤ high (numbers, dates or text).', 'BETWEEN([Year], 2000, 2009)', 3, 3, {
    fn: (x, lo, hi) => { const a = compare(x, lo), b = compare(x, hi); return a == null || b == null ? null : a >= 0 && b <= 0 },
  }),

  // ---- math
  ABS: D('Math', 'ABS(number)', 'Absolute value.', 'ABS([Change])', 1, 1, { fn: math1(Math.abs) }),
  ROUND: D('Math', 'ROUND(number, [digits])', 'Rounds to the given number of decimal places (negative digits round to tens, hundreds…).', 'ROUND([Price] * 1.08, 2)', 1, 2, {
    fn: (x, d) => { const v = N(x); if (v == null) return null; const p = 10 ** (N(d) ?? 0); return Math.round(v * p) / p },
  }),
  CEILING: D('Math', 'CEILING(number, [step])', 'Rounds up to the nearest multiple of step (default 1).', 'CEILING([Minutes], 15)', 1, 2, { fn: (x, s) => { const v = N(x), st = N(s) ?? 1; return v == null || !st ? null : Math.ceil(v / st) * st } }),
  FLOOR: D('Math', 'FLOOR(number, [step])', 'Rounds down to the nearest multiple of step (default 1).', 'FLOOR([Age], 10)', 1, 2, { fn: (x, s) => { const v = N(x), st = N(s) ?? 1; return v == null || !st ? null : Math.floor(v / st) * st } }),
  TRUNC: D('Math', 'TRUNC(number)', 'Drops the decimal part.', 'TRUNC([Hours])', 1, 1, { fn: math1(Math.trunc) }),
  SQRT: D('Math', 'SQRT(number)', 'Square root.', 'SQRT([Area])', 1, 1, { fn: math1(Math.sqrt) }),
  POWER: D('Math', 'POWER(number, exponent)', 'Raises a number to a power (same as ^).', 'POWER(1 + [Rate], 10)', 2, 2, { fn: (a, b) => { const x = N(a), y = N(b); return x == null || y == null ? null : fin(x ** y) } }),
  EXP: D('Math', 'EXP(number)', 'e raised to the number.', 'EXP([LogValue])', 1, 1, { fn: math1(Math.exp) }),
  LN: D('Math', 'LN(number)', 'Natural logarithm.', 'LN([Population])', 1, 1, { fn: math1((x) => (x > 0 ? Math.log(x) : NaN)) }),
  LOG: D('Math', 'LOG(number, [base])', 'Logarithm, base 10 unless another base is given.', 'LOG([Revenue])', 1, 2, {
    fn: (x, b) => { const v = N(x), base = N(b) ?? 10; return v == null || v <= 0 ? null : fin(Math.log(v) / Math.log(base)) },
  }),
  MOD: D('Math', 'MOD(number, divisor)', 'Remainder after division.', 'MOD([Id], 2)', 2, 2, { fn: (a, b) => { const x = N(a), y = N(b); return x == null || !y ? null : ((x % y) + y) % y } }),
  SIGN: D('Math', 'SIGN(number)', '−1, 0 or 1 depending on the sign.', 'SIGN([Profit])', 1, 1, { fn: math1(Math.sign) }),
  CLAMP: D('Math', 'CLAMP(number, low, high)', 'Limits a number to a range.', 'CLAMP([Score], 0, 100)', 3, 3, { fn: (x, lo, hi) => { const v = N(x); return v == null ? null : Math.min(N(hi) ?? Infinity, Math.max(N(lo) ?? -Infinity, v)) } }),
  DIVIDE: D('Math', 'DIVIDE(numerator, denominator, [if_zero])', 'Safe division — returns if_zero (default blank) instead of an error when dividing by zero.', 'DIVIDE([Profit], [Revenue], 0)', 2, 3, {
    fn: (a, b, alt) => { const x = N(a), y = N(b); return x == null || y == null ? null : y === 0 ? alt ?? null : x / y },
  }),
  PI: D('Math', 'PI()', 'The constant π.', 'PI() * [Radius] ^ 2', 0, 0, { fn: () => Math.PI }),

  // ---- text
  CONCAT: D('Text', 'CONCAT(text1, text2, …)', 'Joins values into one text (same as &).', 'CONCAT([First], " ", [Last])', 1, Infinity, { fn: (...xs) => xs.map(str).join('') }),
  UPPER: D('Text', 'UPPER(text)', 'Converts to upper case.', 'UPPER([Code])', 1, 1, { fn: textFn((s) => s.toUpperCase()) }),
  LOWER: D('Text', 'LOWER(text)', 'Converts to lower case.', 'LOWER([Email])', 1, 1, { fn: textFn((s) => s.toLowerCase()) }),
  PROPER: D('Text', 'PROPER(text)', 'Capitalizes the first letter of each word.', 'PROPER([Name])', 1, 1, { fn: textFn((s) => s.toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (_, a, b) => a + b.toUpperCase())) }),
  TRIM: D('Text', 'TRIM(text)', 'Removes leading, trailing and repeated spaces.', 'TRIM([City])', 1, 1, { fn: textFn((s) => s.trim().replace(/\s+/g, ' ')) }),
  LEN: D('Text', 'LEN(text)', 'Number of characters.', 'LEN([Title])', 1, 1, { fn: (s) => (s == null ? null : str(s).length) }),
  LEFT: D('Text', 'LEFT(text, count)', 'First characters of the text.', 'LEFT([Zip], 3)', 2, 2, { fn: textFn((s, n) => s.slice(0, Math.max(0, N(n) ?? 0))) }),
  RIGHT: D('Text', 'RIGHT(text, count)', 'Last characters of the text.', 'RIGHT([Phone], 4)', 2, 2, { fn: textFn((s, n) => { const k = Math.max(0, N(n) ?? 0); return k ? s.slice(-k) : '' }) }),
  MID: D('Text', 'MID(text, start, [count])', 'Characters from a 1-based start position.', 'MID([Sku], 4, 2)', 2, 3, {
    fn: textFn((s, st, n) => { const i = Math.max(1, N(st) ?? 1) - 1; return n == null ? s.slice(i) : s.slice(i, i + Math.max(0, N(n) ?? 0)) }),
  }),
  REPLACE: D('Text', 'REPLACE(text, find, replacement)', 'Replaces every occurrence of find.', 'REPLACE([Phone], "-", "")', 3, 3, { fn: textFn((s, f, r) => (str(f) ? s.split(str(f)).join(str(r)) : s)) }),
  CONTAINS: D('Text', 'CONTAINS(text, search)', 'True when the text contains search (case-insensitive).', 'CONTAINS([Title], "love")', 2, 2, { fn: (s, f) => (s == null ? null : str(s).toLowerCase().includes(str(f).toLowerCase())) }),
  STARTSWITH: D('Text', 'STARTSWITH(text, prefix)', 'True when the text starts with prefix (case-insensitive).', 'STARTSWITH([Sku], "AB")', 2, 2, { fn: (s, f) => (s == null ? null : str(s).toLowerCase().startsWith(str(f).toLowerCase())) }),
  ENDSWITH: D('Text', 'ENDSWITH(text, suffix)', 'True when the text ends with suffix (case-insensitive).', 'ENDSWITH([Email], ".edu")', 2, 2, { fn: (s, f) => (s == null ? null : str(s).toLowerCase().endsWith(str(f).toLowerCase())) }),
  FIND: D('Text', 'FIND(text, search)', '1-based position of search in text, or 0 when not found.', 'FIND([Email], "@")', 2, 2, { fn: (s, f) => (s == null ? null : str(s).indexOf(str(f)) + 1) }),
  SPLIT: D('Text', 'SPLIT(text, separator, index)', 'The index-th piece after splitting (1-based; negative counts from the end).', 'SPLIT([Email], "@", 2)', 3, 3, {
    fn: textFn((s, sep, i) => { const parts = s.split(str(sep)); const k = N(i) ?? 1; const v = k < 0 ? parts[parts.length + k] : parts[k - 1]; return v ?? null }),
  }),
  LPAD: D('Text', 'LPAD(text, length, [pad])', 'Pads on the left to a fixed length.', 'LPAD([Id], 6, "0")', 2, 3, { fn: (s, n, p) => (s == null ? null : str(s).padStart(N(n) ?? 0, p == null ? ' ' : str(p) || ' ')) }),
  REGEXMATCH: D('Text', 'REGEXMATCH(text, pattern)', 'True when the text matches a regular expression.', 'REGEXMATCH([Code], "^[A-Z]{3}\\d+$")', 2, 2, { fn: (s, p) => (s == null ? null : new RegExp(str(p), 'i').test(str(s))) }),
  REGEXEXTRACT: D('Text', 'REGEXEXTRACT(text, pattern, [group])', 'The part of the text matched by a regular expression (or one of its groups).', 'REGEXEXTRACT([Title], "\\((\\d{4})\\)", 1)', 2, 3, {
    fn: (s, p, g) => { if (s == null) return null; const m = new RegExp(str(p), 'i').exec(str(s)); return m ? m[N(g) ?? 0] ?? null : null },
  }),
  TEXT: D('Text', 'TEXT(value)', 'Converts any value to text.', 'TEXT([Year])', 1, 1, { fn: (x) => (x == null ? null : str(x)) }),
  NUMBER: D('Text', 'NUMBER(text)', 'Reads a number from text ("$1,200", "45%" → 1200, 45).', 'NUMBER([Price Text])', 1, 1, { fn: (x) => num(x) }),
  FORMAT: D('Text', 'FORMAT(number, [decimals])', 'Formats a number as text with thousands separators.', 'FORMAT([Revenue], 0) & " USD"', 1, 2, {
    fn: (x, d) => { const v = N(x); if (v == null) return null; const k = N(d) ?? 2; return v.toLocaleString('en-US', { minimumFractionDigits: k, maximumFractionDigits: k }) },
  }),

  // ---- dates
  YEAR: D('Date', 'YEAR(date)', 'The year as a number.', 'YEAR([Order Date])', 1, 1, { fn: dateFn((d) => d.getUTCFullYear()) }),
  QUARTER: D('Date', 'QUARTER(date)', 'Quarter of the year (1–4).', 'QUARTER([Order Date])', 1, 1, { fn: dateFn((d) => Math.floor(d.getUTCMonth() / 3) + 1) }),
  MONTH: D('Date', 'MONTH(date)', 'Month of the year (1–12).', 'MONTH([Order Date])', 1, 1, { fn: dateFn((d) => d.getUTCMonth() + 1) }),
  WEEK: D('Date', 'WEEK(date)', 'ISO week number (1–53).', 'WEEK([Order Date])', 1, 1, { fn: dateFn(isoWeek) }),
  DAY: D('Date', 'DAY(date)', 'Day of the month (1–31).', 'DAY([Order Date])', 1, 1, { fn: dateFn((d) => d.getUTCDate()) }),
  WEEKDAY: D('Date', 'WEEKDAY(date)', 'Day of the week, 1 = Monday … 7 = Sunday.', 'WEEKDAY([Date]) >= 6', 1, 1, { fn: dateFn((d) => ((d.getUTCDay() + 6) % 7) + 1) }),
  HOUR: D('Date', 'HOUR(datetime)', 'Hour of the day (0–23).', 'HOUR([Timestamp])', 1, 1, { fn: dateFn((d) => d.getUTCHours()) }),
  MINUTE: D('Date', 'MINUTE(datetime)', 'Minute of the hour (0–59).', 'MINUTE([Timestamp])', 1, 1, { fn: dateFn((d) => d.getUTCMinutes()) }),
  MONTHNAME: D('Date', 'MONTHNAME(date, [short])', 'Month name — "January", or "Jan" when short is TRUE.', 'MONTHNAME([Date], TRUE)', 1, 2, { fn: (x, s) => { const d = toDate(x); return d ? (truthy(s) ? MONTHS[d.getUTCMonth()].slice(0, 3) : MONTHS[d.getUTCMonth()]) : null } }),
  DAYNAME: D('Date', 'DAYNAME(date, [short])', 'Weekday name — "Monday", or "Mon" when short is TRUE.', 'DAYNAME([Date])', 1, 2, { fn: (x, s) => { const d = toDate(x); if (!d) return null; const n = DAYS[(d.getUTCDay() + 6) % 7]; return truthy(s) ? n.slice(0, 3) : n } }),
  DATE: D('Date', 'DATE(year, month, day)', 'Builds a date from its parts.', 'DATE([Year], [Month], 1)', 3, 3, {
    fn: (y, m, d) => { const a = N(y), b = N(m), c = N(d); return a == null || b == null || c == null ? null : new Date(Date.UTC(a, b - 1, c)) },
  }),
  TODATE: D('Date', 'TODATE(text)', 'Reads a date from text ("2024-03-01", "Mar 1 2024", "03/01/2024").', 'TODATE([Date Text])', 1, 1, { fn: (x) => toDate(x) }),
  TODAY: D('Date', 'TODAY()', "Today's date.", 'DATEDIFF([Signup], TODAY(), "day")', 0, 0, { fn: () => { const n = new Date(); return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())) } }),
  NOW: D('Date', 'NOW()', 'The current date and time.', 'DATEDIFF([Created], NOW(), "hour")', 0, 0, { fn: () => new Date() }),
  DATEDIFF: D('Date', 'DATEDIFF(start, end, [unit])', 'Whole units from start to end. Units: day (default), week, month, quarter, year, hour, minute.', 'DATEDIFF([Order Date], [Ship Date], "day")', 2, 3, {
    fn: (a, b, u) => { const x = toDate(a), y = toDate(b); return x && y ? dateDiff(x, y, unitOf(u)) : null },
  }),
  DATEADD: D('Date', 'DATEADD(date, amount, [unit])', 'Adds days (default) or another unit to a date.', 'DATEADD([Order Date], 30, "day")', 2, 3, {
    fn: (d, n, u) => { const x = toDate(d), k = N(n); return x && k != null ? dateAdd(x, k, unitOf(u)) : null },
  }),
  DATETRUNC: D('Date', 'DATETRUNC(date, unit)', 'Rounds a date down to the start of its year, quarter, month, week, day or hour.', 'DATETRUNC([Order Date], "month")', 2, 2, {
    fn: (d, u) => {
      const x = toDate(d)
      if (!x) return null
      const unit = unitOf(u)
      if (unit === 'minute' || unit === 'second') return new Date(Math.floor(+x / 6e4) * 6e4)
      return new Date(bucketDate(+x, unit))
    },
  }),
  EOMONTH: D('Date', 'EOMONTH(date, [months])', 'Last day of the month, optionally shifted by a number of months.', 'EOMONTH([Invoice Date])', 1, 2, {
    fn: (d, m) => { const x = toDate(d); return x ? new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1 + (N(m) ?? 0), 0)) : null },
  }),
  DATEFORMAT: D('Date', 'DATEFORMAT(date, pattern)', 'Formats a date as text. Tokens: YYYY YY Q MMMM MMM MM M DD D dddd ddd HH mm ss; put literal text in single quotes.', 'DATEFORMAT([Date], "\'Q\'Q YYYY")', 2, 2, { fn: (d, p) => { const x = toDate(d); return x ? formatDate(x, str(p)) : null } }),

  // ---- aggregates (whole column when given one column)
  SUM: dualAgg('SUM', 'Total of the whole column — e.g. for share of total. With several arguments, adds them per row.', '[Sales] / SUM([Sales]) * 100', (xs) => numbers(xs).reduce((a, b) => a + b, 0)),
  AVG: dualAgg('AVG', 'Average of the whole column. With several arguments, averages them per row.', '[Score] - AVG([Score])', (xs) => { const v = numbers(xs); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }),
  MIN: dualAgg('MIN', 'Smallest value in the column. With several arguments, the smallest per row.', 'MIN([Q1], [Q2], [Q3])', (xs) => colAggs.MIN(xs)),
  MAX: dualAgg('MAX', 'Largest value in the column. With several arguments, the largest per row.', '[Price] / MAX([Price])', (xs) => colAggs.MAX(xs)),
  MEDIAN: dualAgg('MEDIAN', 'Median of the whole column.', 'IF([Income] > MEDIAN([Income]), "Above", "Below")'),
  COUNT: dualAgg('COUNT', 'Number of non-blank values in the column.', 'COUNT([Email])'),
  COUNTD: dualAgg('COUNTD', 'Number of distinct values in the column.', 'COUNTD([Customer])'),
  STDEV: dualAgg('STDEV', 'Sample standard deviation of the column.', '([Value] - AVG([Value])) / STDEV([Value])'),
  SUM_ALL: D('Aggregate', 'SUM_ALL(column)', 'Total over every row in view, ignoring the chart’s grouping — for share of total in calculated measures.', 'SUM([Sales]) / SUM_ALL([Sales])', 1, 1, { win: ([xs]) => broadcast(colAggs.SUM, xs) }),
  AVG_ALL: D('Aggregate', 'AVG_ALL(column)', 'Average over every row in view, ignoring the chart’s grouping.', 'AVG([Price]) - AVG_ALL([Price])', 1, 1, { win: ([xs]) => broadcast(colAggs.AVG, xs) }),
  COUNT_ALL: D('Aggregate', 'COUNT_ALL(column)', 'Non-blank values over every row in view, ignoring the chart’s grouping.', 'COUNT([Id]) / COUNT_ALL([Id])', 1, 1, { win: ([xs]) => broadcast(colAggs.COUNT, xs) }),
  COUNTROWS: D('Aggregate', 'COUNTROWS()', 'Number of rows — in a calculated measure, the rows in each chart cell.', 'SUM([Revenue]) / COUNTROWS()', 0, 0, { win: (_c, n) => new Array(n).fill(n) }),
  PERCENTILE: D('Aggregate', 'PERCENTILE(column, p)', 'Value at percentile p of the column (p as 0–1 or 0–100).', '[Price] > PERCENTILE([Price], 0.9)', 2, 2, {
    win: ([xs, ps], n) => {
      const sorted = numbers(xs).sort((a, b) => a - b)
      const p = num(ps[0]) ?? 0.5
      const v = sorted.length ? quantileSorted(sorted, p > 1 ? p / 100 : p) : null
      return new Array(n).fill(v)
    },
  }),
  GROUP_SUM: groupAgg('SUM', 'Total within each group, repeated on every row of the group.', '[Sales] / GROUP_SUM([Sales], [Region]) * 100'),
  GROUP_AVG: groupAgg('AVG', 'Average within each group.', '[Price] - GROUP_AVG([Price], [Category])'),
  GROUP_MIN: groupAgg('MIN', 'Smallest value within each group.', 'GROUP_MIN([Date], [Customer])'),
  GROUP_MAX: groupAgg('MAX', 'Largest value within each group.', '[Score] = GROUP_MAX([Score], [Team])'),
  GROUP_MEDIAN: groupAgg('MEDIAN', 'Median within each group.', 'GROUP_MEDIAN([Salary], [Department])'),
  GROUP_COUNT: D('Aggregate', 'GROUP_COUNT(group_by)', 'Number of rows in each group.', 'GROUP_COUNT([Customer])', 1, 1, { win: ([part]) => broadcast((xs) => xs.length, part, part) }),

  // ---- window (row order matters)
  ROWNUM: D('Window', 'ROWNUM()', 'Row position in the file, starting at 1.', 'ROWNUM()', 0, 0, { win: (_c, n) => Array.from({ length: n }, (_, i) => i + 1) }),
  RANK: D('Window', 'RANK(column, ["asc"|"desc"], [group_by])', 'Rank of each value (1 = largest unless "asc"). Ties share a rank.', 'RANK([Revenue])', 1, 3, {
    win: ([xs, ord, part], n) => {
      const out = new Array<FValue>(n).fill(null)
      const desc = str(ord?.[0] ?? 'desc').toLowerCase() !== 'asc'
      for (const g of sequences(n, undefined, part)) rankWithin(xs, g, desc, out)
      return out
    },
  }),
  PERCENT_RANK: D('Window', 'PERCENT_RANK(column)', 'Percentile rank 0–100: the share of values at or below this one.', 'PERCENT_RANK([Score])', 1, 1, {
    win: ([xs], n) => {
      const sorted = numbers(xs).sort((a, b) => a - b)
      return Array.from({ length: n }, (_, i) => {
        const v = num(xs[i])
        if (v == null || !sorted.length) return null
        let lo = 0, hi = sorted.length
        while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= v) lo = m + 1; else hi = m }
        return (lo / sorted.length) * 100
      })
    },
  }),
  NTILE: D('Window', 'NTILE(column, buckets)', 'Splits values into equal-count buckets numbered 1…buckets (e.g. quartiles with 4).', 'NTILE([Income], 4)', 2, 2, {
    win: ([xs, ks], n) => {
      const k = Math.max(1, Math.round(num(ks[0]) ?? 4))
      const idx = Array.from({ length: n }, (_, i) => i).filter((i) => num(xs[i]) != null).sort((a, b) => num(xs[a])! - num(xs[b])!)
      const out = new Array<FValue>(n).fill(null)
      idx.forEach((i, j) => (out[i] = Math.floor((j * k) / idx.length) + 1))
      return out
    },
  }),
  ZSCORE: D('Window', 'ZSCORE(column, [group_by])', 'Standard score: how many standard deviations a value is from the mean.', 'ABS(ZSCORE([Amount])) > 3', 1, 2, {
    win: ([xs, part], n) => {
      const out = new Array<FValue>(n).fill(null)
      for (const g of sequences(n, undefined, part)) {
        const v = g.map((i) => xs[i])
        const m = colAggs.AVG(v) as number | null, s = colAggs.STDEV(v) as number | null
        for (const i of g) { const x = num(xs[i]); out[i] = x == null || m == null || !s ? null : (x - m) / s }
      }
      return out
    },
  }),
  NORMALIZE: D('Window', 'NORMALIZE(column)', 'Rescales the column to 0–1 (min–max scaling).', 'NORMALIZE([Horsepower])', 1, 1, {
    win: ([xs], n) => {
      const v = numbers(xs)
      const lo = Math.min(...v), hi = Math.max(...v)
      return Array.from({ length: n }, (_, i) => { const x = num(xs[i]); return x == null || hi === lo ? null : (x - lo) / (hi - lo) })
    },
  }),
  RUNNING_SUM: D('Window', 'RUNNING_SUM(column, [order_by], [group_by])', 'Cumulative total, in file order unless order_by is given; restarts for each group.', 'RUNNING_SUM([Sales], [Date])', 1, 3, {
    win: ([xs, ord, part], n) => {
      const out = new Array<FValue>(n).fill(null)
      for (const g of sequences(n, ord, part)) { let acc = 0; for (const i of g) { acc += num(xs[i]) ?? 0; out[i] = acc } }
      return out
    },
  }),
  RUNNING_AVG: D('Window', 'RUNNING_AVG(column, [order_by], [group_by])', 'Average of all values so far.', 'RUNNING_AVG([Rating], [Date])', 1, 3, {
    win: ([xs, ord, part], n) => {
      const out = new Array<FValue>(n).fill(null)
      for (const g of sequences(n, ord, part)) {
        let acc = 0, k = 0
        for (const i of g) { const v = num(xs[i]); if (v != null) { acc += v; k++ } out[i] = k ? acc / k : null }
      }
      return out
    },
  }),
  MOVING_AVG: D('Window', 'MOVING_AVG(column, window, [order_by], [group_by])', 'Average of the last `window` rows (including this one).', 'MOVING_AVG([Temp], 7, [Date])', 2, 4, {
    win: ([xs, ws, ord, part], n) => {
      const w = Math.max(1, Math.round(num(ws[0]) ?? 3))
      const out = new Array<FValue>(n).fill(null)
      for (const g of sequences(n, ord, part)) {
        g.forEach((i, j) => {
          if (j < w - 1) return
          const v = numbers(g.slice(j - w + 1, j + 1).map((k) => xs[k]))
          out[i] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
        })
      }
      return out
    },
  }),
  LAG: D('Window', 'LAG(column, [offset], [order_by], [group_by])', 'Value from `offset` rows earlier (default 1).', '[Price] - LAG([Price], 1, [Date], [Symbol])', 1, 4, {
    win: ([xs, os, ord, part], n) => shift(xs, -(Math.round(num(os?.[0] ?? 1) ?? 1)), n, ord, part),
  }),
  LEAD: D('Window', 'LEAD(column, [offset], [order_by], [group_by])', 'Value from `offset` rows later (default 1).', 'LEAD([Date], 1, [Date], [Customer])', 1, 4, {
    win: ([xs, os, ord, part], n) => shift(xs, Math.round(num(os?.[0] ?? 1) ?? 1), n, ord, part),
  }),
  PCT_CHANGE: D('Window', 'PCT_CHANGE(column, [order_by], [group_by])', 'Percent change from the previous row (×100).', 'PCT_CHANGE([Price], [Date], [Symbol])', 1, 3, {
    win: ([xs, ord, part], n) => {
      const prev = shift(xs, -1, n, ord, part)
      return Array.from({ length: n }, (_, i) => { const a = num(prev[i]), b = num(xs[i]); return a == null || b == null || a === 0 ? null : ((b - a) / Math.abs(a)) * 100 })
    },
  }),

  // ---- binning
  BIN: D('Binning', 'BIN(number, size, [start])', 'Lower edge of the fixed-width bin the number falls into.', 'BIN([Age], 10)', 2, 3, {
    fn: (x, s, st) => { const v = N(x), w = N(s), o = N(st) ?? 0; return v == null || !w ? null : o + Math.floor((v - o) / w) * w },
  }),
  BUCKET: D('Binning', 'BUCKET(number, edge1, edge2, …)', 'Labels a number by the ranges between edges: "< 18", "18–35", "35+"…', 'BUCKET([Age], 18, 35, 60)', 2, Infinity, {
    fn: (x, ...edges) => {
      const v = N(x)
      if (v == null) return null
      const e = numbers(edges).sort((a, b) => a - b)
      const f = (k: number) => (Number.isInteger(k) ? String(k) : String(+k.toPrecision(6)))
      if (v < e[0]) return `< ${f(e[0])}`
      for (let i = 1; i < e.length; i++) if (v < e[i]) return `${f(e[i - 1])}–${f(e[i])}`
      return `${f(e[e.length - 1])}+`
    },
  }),
}

function shift(xs: FValue[], offset: number, n: number, ord?: FValue[], part?: FValue[]): FValue[] {
  const out = new Array<FValue>(n).fill(null)
  for (const g of sequences(n, ord, part)) g.forEach((i, j) => { const k = j + offset; out[i] = k >= 0 && k < g.length ? xs[g[k]] : null })
  return out
}

// ---------- evaluation ----------

export function readCell(v: Row[string], col: Column): FValue {
  if (v == null) return null
  if (col.type === 'date' && typeof v === 'number') return new Date(v)
  return v
}

export interface EvalResult {
  values: FValue[]
  ast: Node
  rowErrors: number
  firstRowError?: string
}

/** Parses and evaluates a formula over every row. Throws FormulaError for syntax/reference problems. */
/** Non-short-circuit operators, shared by row formulas and calculated measures. */
export function binaryOp(op: string, a: FValue, b: FValue): FValue {
  switch (op) {
    case '&': return str(a) + str(b)
    case '=': return equals(a, b)
    case '!=': return !equals(a, b)
    case '<': case '>': case '<=': case '>=': {
      const c = compare(a, b)
      if (c == null) return null
      return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0
    }
  }
  if (a == null || b == null) return null
  if (op === '+') {
    if (isDate(a) && !isDate(b)) { const k = num(b); return k == null ? null : dateAdd(a, k, 'day') }
    if (isDate(b) && !isDate(a)) { const k = num(a); return k == null ? null : dateAdd(b, k, 'day') }
    if ((typeof a === 'string' && num(a) == null) || (typeof b === 'string' && num(b) == null)) return str(a) + str(b)
  }
  if (op === '-') {
    if (isDate(a) && isDate(b)) return (+a - +b) / 864e5
    if (isDate(a)) { const k = num(b); return k == null ? null : dateAdd(a, -k, 'day') }
  }
  const x = num(a), y = num(b)
  if (x == null || y == null) return null
  switch (op) {
    case '+': return x + y
    case '-': return x - y
    case '*': return x * y
    case '/': return y === 0 ? null : x / y
    case '%': return y === 0 ? null : x % y
    case '^': return fin(x ** y)
  }
  return null
}

export function unaryOp(op: string, a: FValue): FValue {
  if (op === 'NOT') return a == null ? null : !truthy(a)
  const x = num(a)
  return x == null ? null : -x
}

/** Parses and evaluates a formula over every row. Throws FormulaError for syntax/reference problems. */
export function evaluate(src: string, cols: Column[], rows: Row[]): EvalResult {
  return evaluateAst(parse(src, cols), rows)
}

/** Evaluates a parsed row-level formula over the given rows. */
export function evaluateAst(ast: Node, rows: Row[]): EvalResult {
  const cache = new Map<Node, FValue[]>()
  const n = rows.length
  let rowErrors = 0
  let firstRowError: string | undefined

  const ev = (node: Node, i: number): FValue => {
    switch (node.k) {
      case 'lit': return node.v
      case 'col': return readCell(rows[i][node.col.key], node.col)
      case 'un': return unaryOp(node.op, ev(node.a, i))
      case 'bin': {
        if (node.op === 'AND') return truthy(ev(node.a, i)) ? truthy(ev(node.b, i)) : false
        if (node.op === 'OR') return truthy(ev(node.a, i)) ? true : truthy(ev(node.b, i))
        return binaryOp(node.op, ev(node.a, i), ev(node.b, i))
      }
      case 'call': {
        const def = node.def
        if (node.win) {
          let col = cache.get(node)
          if (!col) {
            const argCols = node.args.map((a) => Array.from({ length: n }, (_, j) => safe(() => ev(a, j))))
            col = def.win!(argCols, n)
            cache.set(node, col)
          }
          return col[i]
        }
        if (def.lazy) return def.lazy(node.args, (a) => ev(a, i))
        return def.fn!(...node.args.map((a) => ev(a, i)))
      }
    }
  }

  const safe = (f: () => FValue): FValue => {
    try {
      return f()
    } catch (e) {
      rowErrors++
      firstRowError ??= e instanceof Error ? e.message : String(e)
      return null
    }
  }

  const values = new Array<FValue>(n)
  for (let i = 0; i < n; i++) values[i] = safe(() => ev(ast, i))
  return { values, ast, rowErrors, firstRowError }
}

// ---------- editor support ----------

export type HlKind = 'fn' | 'col' | 'str' | 'num' | 'op' | 'kw' | 'paren' | 'bad' | 'plain'

/** Lossless token segmentation for syntax highlighting; never throws. */
export function highlight(src: string, cols: Column[]): { text: string; kind: HlKind }[] {
  const out: { text: string; kind: HlKind }[] = []
  let toks: Token[]
  let tail = src.length
  try {
    toks = tokenize(src)
  } catch (e) {
    const err = e as FormulaError
    tail = err.start
    try { toks = tokenize(src.slice(0, err.start)) } catch { toks = [] }
  }
  let pos = 0
  for (const t of toks) {
    if (t.t === 'eof') break
    if (t.s > pos) out.push({ text: src.slice(pos, t.s), kind: 'plain' })
    let kind: HlKind = 'plain'
    if (t.t === 'num') kind = 'num'
    else if (t.t === 'str') kind = 'str'
    else if (t.t === 'col') kind = resolveColumn(t.v, cols) ? 'col' : 'bad'
    else if (t.t === 'op') kind = 'op'
    else if (t.t === 'lp' || t.t === 'rp' || t.t === 'comma') kind = 'paren'
    else if (t.t === 'id') {
      const up = t.v.toUpperCase()
      kind = ['AND', 'OR', 'NOT', 'TRUE', 'FALSE', 'NULL'].includes(up) ? 'kw' : FUNCTIONS[up] ? 'fn' : resolveColumn(t.v, cols) ? 'col' : 'bad'
    }
    out.push({ text: src.slice(t.s, t.e), kind })
    pos = t.e
  }
  if (pos < src.length) out.push({ text: src.slice(pos), kind: tail < src.length ? 'bad' : 'plain' })
  return out
}
