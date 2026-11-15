import { describe, expect, it } from 'vitest'
import { buildTable, detectDecimal, detectUnit, idKind, inferColumn, isBlank, nameWords, parseCompactDate, parseDate, parseNumber } from '../../src/lib/infer'
import { parseText } from '../../src/lib/parse'
import type { RawRow } from '../../src/types'

const rowsOf = (cols: Record<string, unknown[]>): { headers: string[]; rows: RawRow[] } => {
  const headers = Object.keys(cols)
  const n = Math.max(...headers.map((h) => cols[h].length))
  return { headers, rows: Array.from({ length: n }, (_, i) => Object.fromEntries(headers.map((h) => [h, cols[h][i] as never]))) }
}
const table = (cols: Record<string, unknown[]>, opts = {}) => { const t = rowsOf(cols); return buildTable(t.headers, t.rows, {}, undefined, opts) }
const col = (t: ReturnType<typeof table>, key: string) => t.columns.find((c) => c.key === key)!
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d)
const repeat = <T,>(xs: T[], times: number) => Array.from({ length: times }, () => xs).flat()

describe('R1 blank markers are conservative', () => {
  it('NA, None and - stay values in a category column', () => {
    const t = table({ region: repeat(['NA', 'EU', 'APAC', 'NA', 'EU'], 4), discount: repeat(['None', 'Coupon', 'None', 'Member', '-'], 4) })
    expect(col(t, 'region')).toMatchObject({ type: 'category', missing: 0, distinct: 3 })
    expect(t.rows[0].region).toBe('NA')
    expect(col(t, 'discount')).toMatchObject({ type: 'category', missing: 0, distinct: 4 })
    expect(t.rows.map((r) => r.discount)).toContain('-')
  })
  it('the same markers are blank in a number or date column, and the preview is told which', () => {
    const t = table({ amount: ['12', 'NA', '15', '-', '9', 'None'], when: ['2024-01-01', '-', '2024-01-03', '2024-01-04', 'NA', '2024-01-06'] })
    expect(col(t, 'amount')).toMatchObject({ type: 'number', missing: 3 })
    expect(col(t, 'when')).toMatchObject({ type: 'date', missing: 2 })
    const note = t.notes.find((n) => n.key === 'amount')!
    expect(note.softBlank).toBe(true)
    expect(note.softTokens!.map((x) => x.token).sort()).toEqual(['-', 'NA', 'None'])
  })
  it('a marker the file uses under a number means missing under a category too (R / pandas exports)', () => {
    const t = table({ mass: ['3750', 'NA', '3800', '3250'], sex: ['male', 'NA', 'female', 'male'], region: ['EU', 'None', 'EU', 'US'] })
    expect(col(t, 'sex').missing).toBe(1)
    // "None" never appears under a number in this file, so it is a value
    expect(col(t, 'region').missing).toBe(0)
  })
  it('the user can force either reading', () => {
    const cols = { region: repeat(['NA', 'EU', 'APAC'], 5), amount: repeat(['1', '2', 'NA'], 5) }
    expect(col(table({ region: cols.region }, { softBlanks: 'always' }), 'region').missing).toBe(5)
    const never = table(cols, { softBlanks: 'never' })
    expect(col(never, 'region').missing).toBe(0)
    // kept as written: a third of the column is now text, so it is no longer a number
    expect(col(never, 'amount').type).toBe('category')
  })
  it('empty cells, N/A, null and NaN are always blank; a column of nothing but dashes is empty', () => {
    for (const v of ['', '  ', 'N/A', 'n/a', 'null', 'NaN', null, undefined]) expect(isBlank(v), String(v)).toBe(true)
    for (const v of ['NA', 'None', '-', '0', 'no']) expect(isBlank(v), v).toBe(false)
    expect(col(table({ x: ['-', '-', '-'], y: ['a', 'b', 'c'] }), 'x').missing).toBe(3)
  })
  it('detection never changes the stored source values', () => {
    const { headers, rows } = rowsOf({ region: ['NA', 'EU'], zip: ['02134', '10001'], amount: ['1.2M', '100-'] })
    const before = JSON.stringify(rows)
    buildTable(headers, rows)
    expect(JSON.stringify(rows)).toBe(before)
  })
})

describe('R1 identifiers and codes are not measures', () => {
  it('ZIP and postal codes keep their leading zero', () => {
    const t = table({ zip: ['02134', '10001', '02139', '94105', '60601', '02134'] })
    expect(col(t, 'zip').type).not.toBe('number')
    expect(t.rows[0].zip).toBe('02134')
    // fixed-width codes without an identifying name too
    expect(col(table({ branch: ['007', '012', '103', '044'] }), 'branch').type).not.toBe('number')
    // …and a postal code stays a label even where none starts with zero
    expect(col(table({ 'Postal Code': ['94105', '60601', '10001', '94105'] }), 'Postal Code')).toMatchObject({ type: 'category' })
  })
  it('an order_id that repeats across line items is an ID, not a KPI', () => {
    const ids = Array.from({ length: 60 }, (_, i) => String(1000 + Math.floor(i / 3)))
    const t = table({ order_id: ids, qty: ids.map((_, i) => String((i % 5) + 1)) })
    expect(col(t, 'order_id')).toMatchObject({ type: 'category', isId: true })
    expect(col(t, 'qty').type).toBe('number')
  })
  it('phone numbers, SKUs and "Invoice No" are labels; "Number of items" is still a number', () => {
    const digits = ['5551234567', '5559876543', '5551234567', '5550001111']
    expect(col(table({ phone: digits }), 'phone')).toMatchObject({ type: 'category', isId: true })
    expect(col(table({ 'Invoice No': ['1001', '1002', '1002', '1003'] }), 'Invoice No').type).toBe('category')
    expect(col(table({ productSKU: ['4411', '4412', '4411', '4413'] }), 'productSKU').type).toBe('category')
    expect(col(table({ 'Number of items': ['3', '14', '7', '22'] }), 'Number of items').type).toBe('number')
    expect(col(table({ paid: ['3', '14', '7', '22'] }), 'paid').type).toBe('number')
  })
  it('reads names by whole words', () => {
    expect(nameWords('orderID')).toEqual(['order', 'id'])
    expect(nameWords('Order_Line.Number')).toEqual(['order', 'line', 'number'])
    expect(idKind('order_id')).toBe('id')
    expect(idKind('zip')).toBe('code')
    expect(idKind('Number')).toBeNull()
    // "id" inside a word is not an identifier: paid, width, video
    for (const k of ['paid', 'width', 'video_views', 'Humidity']) expect(idKind(k), k).toBeNull()
  })
})

describe('R1 decimal comma', () => {
  it('12,5 in a semicolon file is read as a number: comma is detected and preselected', async () => {
    const p = await parseText('city;price;qty\nBerlin;12,5;3\nParis;7,25;1\nRome;1.234,50;2\n', 'eu.csv')
    const s = p.sheets[0]
    const d = detectDecimal(s.headers, s.rows, p.detected.delimiter)
    expect(d).toEqual({ decimal: ',', columns: ['price'], preselect: true })
    const t = buildTable(s.headers, s.rows, {}, undefined, { decimal: d.decimal })
    expect(col(t, 'price').type).toBe('number')
    expect(t.rows.map((r) => r.price)).toEqual([12.5, 7.25, 1234.5])
  })
  it('is proposed, not preselected, when the delimiter is a comma', () => {
    const { headers, rows } = rowsOf({ price: ['12,5', '7,25', '3,1'] })
    expect(detectDecimal(headers, rows, ',')).toMatchObject({ decimal: ',', preselect: false })
  })
  it('stays with dot for thousands separators and for files that mix in real dot decimals', () => {
    const a = rowsOf({ amount: ['1,234', '12,500', '999'] })
    expect(detectDecimal(a.headers, a.rows, ';').decimal).toBe('.')
    const b = rowsOf({ eu: ['12,5', '7,25'], us: ['1,234.50', '2,000.75'] })
    expect(detectDecimal(b.headers, b.rows, ';').decimal).toBe('.')
  })
})

describe('R1 dates', () => {
  it.each([
    ['15-Jan-24', day(2024, 1, 15)],
    ['15-Jan-2024', day(2024, 1, 15)],
    ['5-Sep-98', day(1998, 9, 5)],
    ['Jan-24', day(2024, 1, 1)],
    ['Jan-2024', day(2024, 1, 1)],
    ['Q1 2024', day(2024, 1, 1)],
    ['Q3 2024', day(2024, 7, 1)],
    ['2024-Q4', day(2024, 10, 1)],
    ['Mon, 15 Jan 2024', day(2024, 1, 15)],
    ['Monday, January 15, 2024', day(2024, 1, 15)],
    ['Mon, 15 Jan 2024 10:30:00 GMT', Date.UTC(2024, 0, 15, 10, 30)],
    ['Mon, 15 Jan 2024 10:30:00 +0200', Date.UTC(2024, 0, 15, 8, 30)],
    // already supported: must keep working
    ['2024-01-15', day(2024, 1, 15)],
    ['Jan 15, 2024', day(2024, 1, 15)],
    ['15 January 2024', day(2024, 1, 15)],
    ['March 2024', day(2024, 3, 1)],
  ])('%s', (text, expected) => {
    expect(parseDate(text)).toBe(expected)
  })
  it('rejects look-alikes', () => {
    for (const s of ['15-Foo-24', '32-Jan-24', 'Q5 2024', 'Jan 24', 'Janitor 2024', 'Mon, hello', '20240115']) expect(parseDate(s), s).toBeNull()
  })
  it('reads compact yyyymmdd only where a date is expected', () => {
    expect(parseCompactDate('20240115')).toBe(day(2024, 1, 15))
    expect(parseCompactDate(20240115)).toBe(day(2024, 1, 15))
    expect(parseCompactDate('20241340')).toBeNull()
    const vals = ['20240115', '20240116', '20240117', '20240201']
    const named = table({ order_date: vals })
    expect(col(named, 'order_date')).toMatchObject({ type: 'date', grain: 'day' })
    expect(named.rows[0].order_date).toBe(day(2024, 1, 15))
    // the same digits under another name are a number
    expect(col(table({ reading: vals }), 'reading').type).toBe('number')
  })
  it('each new format makes its column a date column', () => {
    const cases: Record<string, string[]> = {
      excel: ['15-Jan-24', '16-Jan-24', '17-Feb-24', '1-Mar-24'],
      monthly: ['Jan-24', 'Feb-24', 'Mar-24', 'Apr-24'],
      quarter: ['Q1 2024', 'Q2 2024', 'Q3 2024', 'Q4 2024'],
      weekday: ['Mon, 15 Jan 2024', 'Tue, 16 Jan 2024', 'Wed, 17 Jan 2024', 'Thu, 18 Jan 2024'],
    }
    const t = table(cases)
    for (const k of Object.keys(cases)) expect(col(t, k).type, k).toBe('date')
    expect(col(t, 'excel').grain).toBe('day')
    expect(col(t, 'monthly').grain).toBe('month')
  })
})

describe('R1 numbers', () => {
  it.each([
    ['−5', -5],
    ['−1,234.5', -1234.5],
    ['100-', -100],
    ['1,234.50-', -1234.5],
    ['1,234.50 USD', 1234.5],
    ['EUR 99', 99],
    ['12 eur', 12],
    ['1.2M', 1_200_000],
    ['3K', 3000],
    ['4.5bn', 4_500_000_000],
    ['(1,200)', -1200],
    ['$1,200.50', 1200.5],
    ['45%', 45],
    ['1e3', 1000],
  ])('%s → %d', (text, expected) => {
    expect(parseNumber(text)).toBeCloseTo(expected, 6)
  })
  it('a unit is read only when the whole column carries the same one', () => {
    expect(parseNumber('5 kg')).toBeNull()
    expect(parseNumber('5 kg', '.', 'kg')).toBe(5)
    expect(detectUnit(['5 kg', '12.5 kg', '7kg'])).toBe('kg')
    expect(detectUnit(['5 kg', '12 lb'])).toBeUndefined()
    const t = table({ weight: ['5 kg', '12.5 kg', '7 kg', '0.4 kg'], mixed: ['5 kg', '12 lb', '7 kg', '3 oz'] })
    expect(col(t, 'weight')).toMatchObject({ type: 'number', unit: 'kg', range: [0.4, 12.5] })
    expect(t.rows.map((r) => r.weight)).toEqual([5, 12.5, 7, 0.4])
    expect(col(t, 'mixed').type).not.toBe('number')
  })
  it('one of these styles no longer turns the column into text', () => {
    const t = table({ minus: ['−5', '12', '−3', '8'], trailing: ['100-', '250', '75-', '10'], code: ['1,234.50 USD', '99.00 USD', '15.25 USD', '8.00 USD'], mag: ['1.2M', '900K', '3.4M', '2M'] })
    for (const k of ['minus', 'trailing', 'code', 'mag']) expect(col(t, k).type, k).toBe('number')
    expect(t.rows[0]).toMatchObject({ minus: -5, trailing: -100, code: 1234.5, mag: 1_200_000 })
  })
  it('does not mistake words or labels for numbers', () => {
    for (const s of ['3B-12', 'Apt 4', 'USD', '-', 'M', '12 Main St', '5m']) expect(parseNumber(s), s).toBeNull()
  })
})

describe('R1 the preview learns what did not fit', () => {
  it('reports the share and examples of values that did not match the detected type', () => {
    const vals = [...Array.from({ length: 38 }, (_, i) => String(i * 3)), 'n.a.', 'tbd']
    const inf = inferColumn('amount', vals)
    expect(inf.type).toBe('number')
    expect(inf.misfit).toBeCloseTo(0.05, 5)
    expect(inf.misfits).toEqual(['n.a.', 'tbd'])
    expect(table({ amount: vals }).notes.find((n) => n.key === 'amount')).toMatchObject({ misfit: 0.05, misfits: ['n.a.', 'tbd'] })
  })
  it('says nothing about a unanimous column', () => {
    expect(inferColumn('amount', ['1', '2', '3']).misfit).toBeUndefined()
    expect(table({ amount: ['1', '2', '3'], city: ['a', 'b', 'a'] }).notes).toEqual([])
  })
})
