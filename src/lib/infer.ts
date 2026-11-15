import type { ColType, Column, DateGrain, ImportOptions, NumFormat, RawRow, RawValue, Row, Value } from '../types'

export type InferOptions = Pick<ImportOptions, 'decimal' | 'dateOrder' | 'softBlanks'> & {
  /** for dates the values can't settle (03/04/2024): day first? Defaults to the browser's locale */
  localeDayFirst?: boolean
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
}
const CURRENCY_RE = /[$€£¥₹₩₱]/
const TRUE_SET = new Set(['true', 'yes', 'y', 't'])
const FALSE_SET = new Set(['false', 'no', 'n', 'f'])

/** Always blank: nothing there, or a marker that can't be a real value. */
export const isBlank = (v: RawValue) =>
  v == null || (typeof v === 'string' && /^\s*$|^(n\/a|#n\/a|null|nan)$/i.test(v.trim()))

/**
 * Markers that are blank in a number or date column but may be real values in a category:
 * a region coded NA, a "Discount type: None" row, a dash used as a label.
 */
export const isSoftBlank = (v: RawValue) => typeof v === 'string' && /^(na|none|-|—|–)$/i.test(v.trim())

export type SoftBlanks = NonNullable<ImportOptions['softBlanks']>

// ---------- numbers ----------

const CURRENCY_CODE = '(?:USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD|CNY|INR|SEK|NOK|DKK|PLN|CZK|HUF|BRL|MXN|ZAR|SGD|HKD|KRW|TRY|ILS|AED|SAR)'
const CODE_LEAD_RE = new RegExp(`^${CURRENCY_CODE}\\s*(?=[-+(.\\d])`, 'i')
const CODE_TRAIL_RE = new RegExp(`(?<=[\\d.)])\\s*${CURRENCY_CODE}$`, 'i')
/** 1.2M, 3K, 4.5bn — attached to the digits; a lowercase m is left alone (5m is more often metres) */
const MAGNITUDE_RE = /(?<=\d)(k|K|M|MM|B|bn|Bn|BN|T)$/
const MAGNITUDE: Record<string, number> = { k: 1e3, m: 1e6, mm: 1e6, b: 1e9, bn: 1e9, t: 1e12 }
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * decimal = ',' reads European numbers: "1.234,5" → 1234.5.
 * `unit` is a suffix the whole column carries ("5 kg"): it is dropped before reading the number.
 */
export function parseNumber(v: RawValue, decimal: '.' | ',' = '.', unit?: string): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean' || v instanceof Date || v == null) return null
  let s = v.trim()
  if (!s) return null
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim() }
  if (unit) s = s.replace(new RegExp(`\\s*${escapeRe(unit)}$`, 'i'), '')
  // Unicode minus (U+2212), as written by word processors and some exports
  s = s.replace(/\u2212/g, '-')
  s = s.replace(CURRENCY_RE, '').replace(CODE_LEAD_RE, '').replace(CODE_TRAIL_RE, '').replace(/%$/, '').replace(/[\s\u00a0\u202f']/g, '')
  // accounting exports write the sign last: 100-
  if (/^[\d.,]+-$/.test(s)) s = `-${s.slice(0, -1)}`
  let scale = 1
  const mag = MAGNITUDE_RE.exec(s)
  if (mag) { scale = MAGNITUDE[mag[1].toLowerCase()]; s = s.slice(0, -mag[1].length) }
  if (decimal === ',') {
    if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '')
    s = s.replace(',', '.')
  } else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '')
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null
  const n = parseFloat(s) * scale
  return Number.isFinite(n) ? (neg ? -n : n) : null
}

/** A unit every value of the column ends with ("5 kg", "12.5 km/h", "21 °C"), so the column can still be a number. */
export function detectUnit(strs: string[], decimal: '.' | ',' = '.'): string | undefined {
  let unit: string | undefined
  let seen = 0
  for (const s of strs) {
    const m = /^[-+\u2212(]?[\d.,\s']*\d\)?\s*([a-zA-Z°µμ][a-zA-Z°µμ/²³]{0,7})$/.exec(s)
    if (!m) { if (parseNumber(s, decimal) == null) return undefined; continue }
    // a currency code or a magnitude (1.2M) is already understood without a unit
    if (parseNumber(s, decimal) != null) continue
    if (unit == null) unit = m[1]
    else if (unit.toLowerCase() !== m[1].toLowerCase()) return undefined
    seen++
  }
  return unit && seen >= Math.max(1, strs.length * 0.5) && strs.every((s) => parseNumber(s, decimal, unit) != null) ? unit : undefined
}

/**
 * Which decimal separator a file uses. A column that fails as dot-decimal but reads cleanly as comma-decimal
 * ("12,5", "1.234,50") is evidence for comma; a column that only reads as dot-decimal ("1,234.50") is evidence against.
 */
export function detectDecimal(headers: string[], rows: RawRow[], delimiter?: string): { decimal: '.' | ','; columns: string[]; preselect: boolean } {
  const sample = rows.length > 2000 ? strideSample(rows, 2000) : rows
  const comma: string[] = []
  let dotOnly = false
  for (const h of headers) {
    let n = 0, dot = 0, com = 0
    for (const r of sample) {
      const v = r[h]
      if (typeof v !== 'string' || isBlank(v) || isSoftBlank(v)) continue
      n++
      if (parseNumber(v, '.') != null) dot++
      if (parseNumber(v, ',') != null) com++
    }
    if (n < 1) continue
    if (dot / n < 0.95 && com / n >= 0.95) comma.push(h)
    else if (com / n < 0.95 && dot / n >= 0.95) dotOnly = true
  }
  const isComma = comma.length > 0 && !dotOnly
  return { decimal: isComma ? ',' : '.', columns: isComma ? comma : [], preselect: isComma && delimiter === ';' }
}

// ---------- dates ----------

const ISO_RE = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/
const SLASH_RE = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i
const MON_FIRST_RE = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i
/** 15 Jan 2024, 15-Jan-2024, and Excel's default d-mmm-yy: 15-Jan-24 */
const DAY_FIRST_RE = /^(\d{1,2})(?:st|nd|rd|th)?[\s/.-]+([a-z]{3,9})\.?,?[\s/.-]+(\d{4}|\d{2})$/i
const MON_YEAR_RE = /^([a-z]{3,9})\.?\s+(\d{4})$/i
/** Excel's mmm-yy: Jan-24, Jan-2024, Jan'24 (not "Jan 24", which may be a day) */
const MON_YY_RE = /^([a-z]{3,9})\.?[-/'’](\d{4}|\d{2})$/i
const COMPACT_RE = /^(\d{4})(\d{2})(\d{2})$/
const QUARTER_RE = /^(?:q([1-4])[\s/'’-]*(\d{4}|\d{2})|(\d{4})[\s/-]*q([1-4]))$/i
const WEEKDAY_RE = /^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\.?,?\s+/i
const TRAILING_TIME_RE = /^(.*\d)(?:,?\s+|T)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?\s*(GMT|UTC|Z|[+-]\d{2}:?\d{2})?$/i

const fullYear = (y: string) => (y.length === 4 ? +y : 2000 + +y - (+y > 50 ? 100 : 0))
const monthOf = (name: string) => {
  const mo = MONTHS[name.slice(0, 3).toLowerCase()]
  // "Janitor" is not January: the rest of the word has to belong to a month name
  return mo != null && MONTH_NAMES[mo].startsWith(name.toLowerCase().replace(/^sept$/, 'sep')) ? mo : undefined
}
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** Compact yyyymmdd (20240115). Only read where a date is expected: an 8-digit number is otherwise just a number. */
export function parseCompactDate(v: RawValue): number | null {
  const m = COMPACT_RE.exec(typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '')
  return m ? utc(+m[1], +m[2] - 1, +m[3]) : null
}

/** dayFirst resolves ambiguous 03/04/2020; decided per column by inspecting all values. */
export function parseDate(v: RawValue, dayFirst = false): number | null {
  if (v instanceof Date) return isNaN(+v) ? null : +v
  if (typeof v !== 'string') return null
  let s = v.trim()
  if (s.length < 6 || s.length > 40) return null
  let m = ISO_RE.exec(s)
  if (m) {
    const [, y, mo, d, h, mi, se, tz] = m
    if (tz) { const t = Date.parse(s.replace(' ', 'T')); return isNaN(t) ? null : t }
    return utc(+y, +mo - 1, d ? +d : 1, h ? +h : 0, mi ? +mi : 0, se ? +se : 0)
  }
  m = SLASH_RE.exec(s)
  if (m) {
    let [, a, b, c, h, mi, se, ap] = m
    let y: number, mo: number, d: number
    if (a.length === 4) { y = +a; mo = +b; d = +c }
    else {
      y = +c < 100 ? 2000 + +c - (+c > 50 ? 100 : 0) : +c
      if (dayFirst) { d = +a; mo = +b } else { mo = +a; d = +b }
    }
    let hh = h ? +h : 0
    if (ap) hh = (hh % 12) + (ap.toLowerCase() === 'pm' ? 12 : 0)
    return utc(y, mo - 1, d, hh, mi ? +mi : 0, se ? +se : 0)
  }
  // "Mon, 15 Jan 2024" and "Monday, January 15, 2024": the weekday adds nothing
  const wd = WEEKDAY_RE.exec(s)
  if (wd) s = s.slice(wd[0].length)
  const named = parseNamed(s)
  if (named != null) return named
  // a time after a written-out date: "15 Jan 2024 10:30:00 GMT"
  m = /[a-z]/i.test(s) ? TRAILING_TIME_RE.exec(s) : null
  if (m) {
    const day = parseNamed(m[1].trim())
    if (day == null) return null
    let hh = +m[2]
    if (m[5]) hh = (hh % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0)
    if (hh > 23 || +m[3] > 59 || +(m[4] ?? 0) > 59) return null
    let t = day + hh * 3_600_000 + +m[3] * 60_000 + +(m[4] ?? 0) * 1000
    const off = /^([+-])(\d{2}):?(\d{2})$/.exec(m[6] ?? '')
    if (off) t -= (off[1] === '-' ? -1 : 1) * (+off[2] * 60 + +off[3]) * 60_000
    return t
  }
  return null
}

/** Dates written with a month name or a quarter. */
function parseNamed(s: string): number | null {
  let m = MON_FIRST_RE.exec(s)
  if (m) { const mo = monthOf(m[1]); return mo == null ? null : utc(+m[3], mo, +m[2]) }
  m = DAY_FIRST_RE.exec(s)
  if (m) { const mo = monthOf(m[2]); return mo == null ? null : utc(fullYear(m[3]), mo, +m[1]) }
  m = MON_YEAR_RE.exec(s) ?? MON_YY_RE.exec(s)
  if (m) { const mo = monthOf(m[1]); return mo == null ? null : utc(fullYear(m[2]), mo, 1) }
  m = QUARTER_RE.exec(s)
  if (m) return utc(m[1] ? fullYear(m[2]) : +m[3], (+(m[1] ?? m[4]) - 1) * 3, 1)
  return null
}

function utc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number | null {
  if (mo < 0 || mo > 11 || d < 1 || d > 31 || y < 1000 || y > 9999 || h > 23 || mi > 59 || s > 59) return null
  const t = Date.UTC(y, mo, d, h, mi, s)
  return new Date(t).getUTCDate() === d ? t : null
}

/** Day-first if a value proves it (13/04), month-first if one proves that (04/13); otherwise the locale decides. */
function detectDayFirst(samples: string[], fallback: boolean): boolean {
  for (const s of samples) {
    const m = SLASH_RE.exec(s.trim())
    if (!m || m[1].length > 2) continue
    if (+m[1] > 12) return true
    if (+m[2] > 12) return false
  }
  return fallback
}

/** Whether the browser's locale writes the day before the month (en-GB, de, fr…: yes; en-US: no). */
export function localeDayFirst(locale = typeof navigator !== 'undefined' ? navigator.language : 'en-US'): boolean {
  try {
    const order = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' })
      .formatToParts(new Date(Date.UTC(2024, 10, 25))).map((p) => p.type).filter((t) => t === 'day' || t === 'month')
    return order[0] === 'day'
  } catch {
    return false
  }
}

export function detectGrain(times: number[]): DateGrain {
  let grain: DateGrain = 'year'
  for (const t of times) {
    const d = new Date(t)
    if (d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds()) return 'datetime'
    if (d.getUTCDate() !== 1) grain = 'day'
    else if (grain === 'year' && d.getUTCMonth() !== 0) grain = 'month'
  }
  return grain
}

// ---------- inference ----------

const YEAR_NAME_RE = /^(year|yr|fiscal[ _]?year|season)$/i
const DATE_WORDS = new Set(['date', 'day', 'dt', 'time', 'timestamp', 'period', 'created', 'updated', 'modified', 'posted', 'shipped', 'delivered', 'dob', 'birthday', 'at', 'on', 'when', 'ymd', 'yyyymmdd'])
/** always an identifier, however often it repeats */
const ID_WORDS = new Set(['id', 'ids', 'uuid', 'guid', 'key', 'sku', 'phone', 'tel', 'telephone', 'mobile', 'fax', 'ssn', 'isbn', 'ean', 'upc', 'barcode', 'iban', '#'])
/** labels written with digits: never a quantity, but often a useful grouping */
const CODE_WORDS = new Set(['zip', 'zipcode', 'postal', 'postcode', 'code', 'pin'])
const NUMBER_WORDS = new Set(['number', 'no', 'num', 'nr', 'nbr'])

/** Words of a column name: split on separators and camelCase, lowercased ("orderID" → order, id). */
export function nameWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9#%]+/)
    .filter(Boolean)
}

/** What a column's name says about digits in it: 'id' (order_id, phone, SKU, invoice number), 'code' (zip, postal code) or nothing. */
export function idKind(key: string): 'id' | 'code' | null {
  const w = nameWords(key)
  if (!w.length) return null
  if (w.some((x) => ID_WORDS.has(x))) return 'id'
  // "Order number", "Invoice No" — but not "Number of items" or a bare "Number"
  if (w.length > 1 && NUMBER_WORDS.has(w[w.length - 1])) return 'id'
  if (w.some((x) => CODE_WORDS.has(x))) return 'code'
  return null
}

const dateNamed = (key: string) => nameWords(key).some((x) => DATE_WORDS.has(x))

export interface Inferred extends Omit<Column, 'distinct' | 'missing'> {
  dayFirst?: boolean
  /** NA / None / - read as blank in this column (true for numbers and dates) */
  softBlank?: boolean
  /** the NA-like markers found, with how many of the inspected values each covers */
  softTokens?: { token: string; count: number }[]
  /** share of the inspected values that did not fit the detected type (0 when detection was unanimous) */
  misfit?: number
  /** a few of the values that did not fit, as written */
  misfits?: string[]
}

export function inferColumn(key: string, values: RawValue[], opts: InferOptions = {}): Inferred {
  const dec = opts.decimal ?? '.'
  const mode = opts.softBlanks ?? 'auto'
  const filled = values.filter((v) => !isBlank(v))
  const tokens = new Map<string, number>()
  for (const v of filled) if (isSoftBlank(v)) { const t = (v as string).trim(); tokens.set(t, (tokens.get(t) ?? 0) + 1) }
  const softTokens = [...tokens.entries()].map(([token, count]) => ({ token, count }))
  // the markers are set aside while the type is decided; whether they end up blank depends on that type
  const present = mode === 'never' ? filled : filled.filter((v) => !isSoftBlank(v))
  const sample = present.length > 5000 ? strideSample(present, 5000) : present
  const n = sample.length
  const base = { key, name: prettify(key) }
  const soft = (on: boolean) => (softTokens.length ? { softBlank: on && mode !== 'never', softTokens } : {})
  // a column of nothing but markers has no values to keep
  if (!n) return { ...base, type: 'text', detected: 'text', ...soft(true) }

  // native types (JSON / spreadsheet)
  if (sample.every((v) => typeof v === 'boolean')) return { ...base, type: 'boolean', detected: 'boolean', ...soft(true) }
  const dateObjs = sample.filter((v) => v instanceof Date).length
  if (dateObjs / n > 0.9) {
    return { ...base, type: 'date', detected: 'date', grain: detectGrain(sample.filter((v) => v instanceof Date).map((d) => +d)), ...soft(true), ...misfit(sample, (v) => v instanceof Date) }
  }

  const strs = sample.map((v) => (typeof v === 'string' ? v.trim() : String(v)))
  const lower = strs.map((s) => s.toLowerCase())
  if (lower.every((s) => TRUE_SET.has(s) || FALSE_SET.has(s))) return { ...base, type: 'boolean', detected: 'boolean', ...soft(true) }

  const named = idKind(key)
  // 02134, 007: the zero is part of the value, so it is a label and stays text
  const padded = sample.filter((v) => typeof v === 'string' && /^0\d+$/.test(v.trim())).length
  const keepText = padded > 0 && (padded / n >= 0.05 || !!named || new Set(strs.map((s) => s.length)).size === 1)

  // numbers
  let unit: string | undefined
  let nums = sample.map((v) => parseNumber(v, dec))
  let numOk = nums.filter((x) => x != null).length
  if (numOk / n < 0.95 && !keepText && (unit = detectUnit(strs, dec))) {
    nums = sample.map((v) => parseNumber(v, dec, unit))
    numOk = n
  }
  if (numOk / n >= 0.95 && !keepText) {
    const valid = nums.filter((x): x is number => x != null)
    const allInt = valid.every((x) => Number.isInteger(x))
    // 4-digit years stored as numbers become a yearly date axis
    if (allInt && YEAR_NAME_RE.test(key.trim()) && valid.every((x) => x >= 1800 && x <= 2200)) {
      return { ...base, type: 'date', detected: 'date', grain: 'year', ...soft(true) }
    }
    // 20240115 in a column called "date": compact dates, not eight-digit quantities
    if (allInt && numOk === n && dateNamed(key) && sample.every((v) => parseCompactDate(v) != null)) {
      return { ...base, type: 'date', detected: 'date', grain: detectGrain(sample.map((v) => parseCompactDate(v)!)), ...soft(true) }
    }
    const cur = strs.find((s) => CURRENCY_RE.test(s))
    const pct = strs.some((s) => s.endsWith('%')) || /(%|percent|pct)/i.test(key)
    const format: NumFormat = cur ? 'currency' : pct && strs.some((s) => s.endsWith('%')) ? 'percent' : allInt ? 'integer' : 'decimal'
    const distinct = new Set(valid).size
    // an identifier by name is never a measure, however often it repeats (order_id across line items, phone numbers)
    if (allInt && named && !unit && !cur && !pct) {
      return { ...base, type: 'category', detected: 'category', isId: named === 'id' || distinct > n * 0.9, ...soft(false) }
    }
    const discrete = allInt && distinct <= 12 && distinct < n / 3
    return { ...base, type: 'number', detected: 'number', format, currency: cur?.match(CURRENCY_RE)?.[0], discrete, ...(unit ? { unit } : {}), ...soft(true), ...misfit(strs, (_, i) => nums[i] != null) }
  }

  // dates
  const dayFirst = opts.dateOrder === 'dmy' ? true : opts.dateOrder === 'mdy' || opts.dateOrder === 'ymd' ? false : detectDayFirst(strs, opts.localeDayFirst ?? localeDayFirst())
  const dates = strs.map((s) => parseDate(s, dayFirst))
  const dateOk = dates.filter((x) => x != null).length
  if (dateOk / n >= 0.9) {
    return { ...base, type: 'date', detected: 'date', grain: detectGrain(dates.filter((x): x is number => x != null)), dayFirst, ...soft(true), ...misfit(strs, (_, i) => dates[i] != null) }
  }

  // text vs category: here NA, None and - may be real values, so they count
  const all = mode === 'always' ? strs : (filled.length > 5000 ? strideSample(filled, 5000) : filled).map((v) => (typeof v === 'string' ? v.trim() : String(v)))
  const distinct = new Set(all).size
  const avgLen = all.reduce((a, s) => a + s.length, 0) / all.length
  const isId = distinct > all.length * 0.95 && (named === 'id' || /(key|code)$/i.test(key.trim()) || /^[A-Z0-9-_]{6,}$/i.test(strs[0]))
  const category = !isId && avgLen < 40 && (distinct <= 50 || distinct / all.length < 0.5)
  if (category) return { ...base, type: 'category', detected: 'category', ...soft(mode === 'always') }
  return { ...base, type: 'text', detected: 'text', isId, ...soft(mode === 'always') }
}

/** The share (and a few examples) of values that didn't fit the detected type. */
function misfit<T>(vals: T[], ok: (v: T, i: number) => boolean): { misfit?: number; misfits?: string[] } {
  const bad: string[] = []
  let count = 0
  vals.forEach((v, i) => { if (!ok(v, i)) { count++; if (bad.length < 3 && !bad.includes(String(v))) bad.push(String(v)) } })
  return count ? { misfit: count / vals.length, misfits: bad } : {}
}

function strideSample<T>(arr: T[], k: number): T[] {
  const step = arr.length / k
  return Array.from({ length: k }, (_, i) => arr[Math.floor(i * step)])
}

export function prettify(key: string): string {
  const s = key.replace(/[_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ---------- coercion ----------

/** `softBlank`: NA / None / - are blank here (number, date and yes/no columns always treat them so). */
export function coerce(v: RawValue, col: Pick<Column, 'type' | 'grain' | 'unit'>, dayFirst = false, decimal: '.' | ',' = '.', softBlank = false): Value {
  if (isBlank(v)) return null
  switch (col.type) {
    case 'number': return parseNumber(v, decimal, col.unit)
    case 'date': {
      if (typeof v === 'number') return Number.isInteger(v) && v >= 1000 && v <= 9999 ? Date.UTC(v, 0, 1) : parseCompactDate(v)
      if (typeof v === 'string' && /^\d{4}$/.test(v.trim())) return Date.UTC(+v.trim(), 0, 1)
      return parseDate(v, dayFirst) ?? parseCompactDate(v)
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v
      const s = String(v).trim().toLowerCase()
      return TRUE_SET.has(s) || s === '1' ? true : FALSE_SET.has(s) || s === '0' ? false : null
    }
    default:
      if (softBlank && isSoftBlank(v)) return null
      if (v instanceof Date) return v.toISOString().slice(0, 10)
      return typeof v === 'string' ? v.trim() : String(v)
  }
}

/** What detection assumed about one column, for the import preview. */
export interface ColumnNote {
  key: string
  type: ColType
  /** share of inspected values that did not fit the detected type */
  misfit?: number
  misfits?: string[]
  /** NA-like markers in the column and whether they are read as blank */
  softTokens?: { token: string; count: number }[]
  softBlank?: boolean
  unit?: string
  isId?: boolean
}

export interface Typed { columns: Column[]; rows: Row[]; notes: ColumnNote[] }

/**
 * Markers that this file uses for "missing": NA / None / - found in a number or date column.
 * A file that writes NA under a measure means the same by NA under a category (R and pandas exports do).
 */
function fileBlankTokens(meta: Inferred[]): Set<string> {
  const out = new Set<string>()
  for (const m of meta) if (m.softBlank && (m.type === 'number' || m.type === 'date')) for (const t of m.softTokens ?? []) out.add(t.token.toLowerCase())
  return out
}

export function buildTable(headers: string[], raw: RawRow[], overrides: Record<string, ColType> = {}, prev?: Column[], opts: InferOptions = {}): Typed {
  const dec = opts.decimal ?? '.'
  const mode = opts.softBlanks ?? 'auto'
  const inferred = headers.map((h) => inferColumn(h, raw.map((r) => r[h]), opts))
  const fileBlanks = mode === 'auto' ? fileBlankTokens(inferred) : new Set<string>()
  const meta = inferred.map((inf) => {
    const h = inf.key
    const old = prev?.find((c) => c.key === h)
    const type = overrides[h] ?? inf.type
    let grain = inf.grain
    if (type === 'date' && !grain) {
      const ts = raw.slice(0, 2000).map((r) => coerce(r[h], { type: 'date' }, inf.dayFirst ?? opts.dateOrder === 'dmy')).filter((x): x is number => typeof x === 'number')
      grain = detectGrain(ts)
    }
    const typedBlank = type === 'number' || type === 'date' || type === 'boolean'
    const softBlank = mode === 'never' ? typedBlank : mode === 'always' || typedBlank || !!inf.softBlank
      || (!!inf.softTokens?.length && inf.softTokens.every((t) => fileBlanks.has(t.token.toLowerCase())))
    return { ...inf, name: old?.name ?? inf.name, type, grain, softBlank }
  })
  const rows: Row[] = raw.map((r) => {
    const o: Row = {}
    for (const m of meta) o[m.key] = coerce(r[m.key], m, m.dayFirst ?? opts.dateOrder === 'dmy', dec, m.softBlank)
    return o
  })
  const notes: ColumnNote[] = []
  const columns: Column[] = meta.map(({ dayFirst: _d, softBlank, softTokens, misfit: miss, misfits, ...m }) => {
    const seen = new Set<Value>()
    let missing = 0, lo = Infinity, hi = -Infinity
    const numeric = m.type === 'number'
    for (const r of rows) {
      const v = r[m.key]
      if (v == null) missing++
      else {
        if (seen.size < 100000) seen.add(v)
        if (numeric && typeof v === 'number') { if (v < lo) lo = v; if (v > hi) hi = v }
      }
    }
    const col: Column = { ...m, distinct: seen.size, missing }
    if (col.type === 'number' && !col.format) col.format = 'decimal'
    if (numeric && lo <= hi) col.range = [lo, hi]
    // an overridden type no longer matches what was measured for the detected one
    const own = col.type === m.detected
    if ((own && miss) || softTokens?.length || col.unit || col.isId) {
      notes.push({ key: col.key, type: col.type, ...(own && miss ? { misfit: miss, misfits } : {}), ...(softTokens?.length ? { softTokens, softBlank } : {}), ...(col.unit ? { unit: col.unit } : {}), ...(col.isId ? { isId: true } : {}) })
    }
    return col
  })
  return { columns, rows, notes }
}
