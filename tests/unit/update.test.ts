import { describe, expect, it } from 'vitest'
import { checkIncoming, compareHeaders, guessKey, mergeRows } from '../../src/lib/update'
import { resolveRelative, runKpi, filteredRows } from '../../src/lib/aggregate'
import { buildDataset } from '../../src/lib/model'
import { PRESETS } from '../../src/lib/presets'
import { emptyModel } from '../../src/lib/model'
import type { Dataset, DatasetModel, RawRow } from '../../src/types'
import { parseSample } from './helpers'

const iso = (t: number) => new Date(t).toISOString().slice(0, 10)

describe('matching columns of a fresh file', () => {
  it('matches exactly, then ignoring case / spacing / underscores, and reports the rest', () => {
    const c = compareHeaders(['Order ID', 'Order Date', 'Store', 'Discount'], ['order_id', 'Order Date', 'Store', 'Coupon', 'Region'])
    expect(c.matched).toEqual([{ old: 'Order ID', incoming: 'order_id' }, { old: 'Order Date', incoming: 'Order Date' }, { old: 'Store', incoming: 'Store' }])
    expect(c.missing).toEqual(['Discount'])
    expect(c.added).toEqual(['Coupon', 'Region'])
  })
  it('guesses an ID column to de-duplicate on', () => {
    const rows = [{ 'Order ID': 'A1', n: '1' }, { 'Order ID': 'A2', n: '1' }]
    expect(guessKey(['Order ID', 'n'], rows)).toBe('Order ID')
    expect(guessKey(['n'], rows)).toBeUndefined()
    // a few duplicate rows (removed later by prep) don't disqualify an ID column
    const dupes = Array.from({ length: 100 }, (_, i) => ({ 'Order ID': `A${i < 98 ? i : 0}` }))
    expect(guessKey(['Order ID'], dupes)).toBe('Order ID')
  })
})

describe('merging', () => {
  const oldH = ['id', 'day', 'amount']
  const oldR: RawRow[] = [{ id: '1', day: '2025-06-01', amount: '10' }, { id: '2', day: '2025-06-02', amount: '20' }]
  const newH = ['ID', 'day', 'amount', 'channel']
  const newR: RawRow[] = [{ ID: '2', day: '2025-06-02', amount: '20', channel: 'web' }, { ID: '3', day: '2025-07-01', amount: '30', channel: 'app' }]
  const mapping = { id: 'ID', day: 'day', amount: 'amount' }

  it('appends under the existing header names, adds new columns, matches rows already loaded by key', () => {
    const r = mergeRows(oldH, oldR, newH, newR, { mode: 'append', mapping, dedupe: { enabled: true, keys: ['id'] } })
    expect(r.headers).toEqual(['id', 'day', 'amount', 'channel'])
    expect(r.rows.map((x) => x.id)).toEqual(['1', '2', '3'])
    expect(r.rows[0].channel).toBeNull()
    expect(r.rows[2]).toEqual({ id: '3', day: '2025-07-01', amount: '30', channel: 'app' })
    // row 2 is already loaded; it gains the new column's value
    expect(r.rows[1].channel).toBe('web')
    expect([r.added, r.updated, r.skipped]).toEqual([1, 1, 0])
  })
  it('overwrites a loaded row whose key comes back with new values, and skips unchanged ones', () => {
    const r = mergeRows(oldH, oldR, oldH, [{ id: '1', day: '2025-06-01', amount: '10' }, { id: '2', day: '2025-06-02', amount: '25' }], { mode: 'append', mapping: { id: 'id', day: 'day', amount: 'amount' }, dedupe: { enabled: true, keys: ['id'] } })
    expect(r.rows).toEqual([oldR[0], { id: '2', day: '2025-06-02', amount: '25' }])
    expect([r.added, r.updated, r.skipped]).toEqual([0, 1, 1])
  })
  it('an update keeps loaded values for columns the new file lacks; the last repeat of a key wins', () => {
    const r = mergeRows(oldH, oldR, ['id', 'amount'], [{ id: '2', amount: '21' }, { id: '2', amount: '22' }, { id: '4', amount: '1' }, { id: '4', amount: '2' }], { mode: 'append', mapping: { id: 'id', amount: 'amount' }, dedupe: { enabled: true, keys: ['id'] } })
    expect(r.rows[1]).toEqual({ id: '2', day: '2025-06-02', amount: '22' })
    expect(r.rows[2]).toEqual({ id: '4', day: null, amount: '2' })
    expect([r.added, r.updated, r.skipped]).toEqual([1, 1, 0])
  })
  it('without de-duplication keeps every incoming row', () => {
    const r = mergeRows(oldH, oldR, newH, newR, { mode: 'append', mapping, dedupe: { enabled: false, keys: [] } })
    expect(r.rows).toHaveLength(4)
  })
  it('whole-row de-duplication when no key is chosen', () => {
    const r = mergeRows(oldH, oldR, oldH, [...oldR, { id: '9', day: '2025-07-09', amount: '1' }], { mode: 'append', mapping: { id: 'id', day: 'day', amount: 'amount' }, dedupe: { enabled: true, keys: [] } })
    expect([r.added, r.updated, r.skipped]).toEqual([1, 0, 2])
  })
  it('sync: a full export also removes loaded rows it no longer lists (N5)', () => {
    const rows: RawRow[] = [{ id: '1', v: 'a' }, { id: '2', v: 'b' }, { id: '3', v: 'c' }]
    const r = mergeRows(['id', 'v'], rows, ['id', 'v'], [{ id: '1', v: 'a' }, { id: '3', v: 'C' }, { id: '4', v: 'd' }], { mode: 'append', mapping: { id: 'id', v: 'v' }, dedupe: { enabled: true, keys: ['id'] }, sync: true })
    expect(r.rows).toEqual([{ id: '1', v: 'a' }, { id: '3', v: 'C' }, { id: '4', v: 'd' }])
    expect([r.added, r.updated, r.skipped, r.removed]).toEqual([1, 1, 1, 1])
    // without a key there's nothing to sync on
    const n = mergeRows(['id', 'v'], rows, ['id', 'v'], [{ id: '1', v: 'a' }], { mode: 'append', mapping: { id: 'id', v: 'v' }, dedupe: { enabled: true, keys: [] }, sync: true })
    expect(n.removed).toBe(0)
  })
  it('whole-row matching ignores columns the new file lacks (R6)', () => {
    const r = mergeRows(['a', 'b'], [{ a: '1', b: 'x' }], ['a'], [{ a: '1' }, { a: '2' }], { mode: 'append', mapping: { a: 'a' }, dedupe: { enabled: true, keys: [] } })
    expect([r.added, r.skipped]).toEqual([1, 1])
  })
  it('replace keeps only the new rows; unmapped columns become blank', () => {
    const r = mergeRows(oldH, oldR, newH, newR, { mode: 'replace', mapping: { id: 'ID', day: 'day' } })
    expect(r.rows).toHaveLength(2)
    expect(r.rows[0].amount).toBeNull()
    expect(r.removed).toBe(2)
  })
})

describe('relative date filters roll forward', () => {
  const dec31 = Date.UTC(2015, 11, 31)
  it('calendar periods include the latest one', () => {
    const r = (last: number, unit: 'month' | 'quarter' | 'year' | 'day' | 'week', calendar = true) => { const x = resolveRelative({ last, unit, calendar }, dec31); return [iso(x.min), iso(x.max)] }
    expect(r(1, 'month')).toEqual(['2015-12-01', '2015-12-31'])
    expect(r(3, 'month')).toEqual(['2015-10-01', '2015-12-31'])
    expect(r(1, 'quarter')).toEqual(['2015-10-01', '2015-12-31'])
    expect(r(1, 'year')).toEqual(['2015-01-01', '2015-12-31'])
    expect(r(30, 'day', false)).toEqual(['2015-12-02', '2015-12-31'])
  })

  it('a new month of coffee orders moves "latest month" and the KPIs forward', async () => {
    const base = await parseSample('coffee-chain-sales.csv')
    const july = await parseSample('updates/coffee-chain-sales-2025-07.csv')
    const model: DatasetModel = { ...emptyModel(), ...PRESETS['coffee-chain-sales.csv'].model!({ idOf: () => undefined }) }
    const build = (headers: string[], rows: RawRow[]): Dataset => {
      const b = buildDataset({ headers, rows }, model)
      return { id: 'c', name: 'c', fileName: 'c', format: 'csv', createdAt: 0, rowCount: b.rows.length, columnCount: b.columns.length, source: { kind: 'sample' }, model, columns: b.columns, rows: b.rows }
    }
    const before = build(base.sheets[0].headers, base.sheets[0].rows)
    const check = compareHeaders(base.sheets[0].headers, july.sheets[0].headers)
    expect(check.missing).toEqual([])
    const merged = mergeRows(base.sheets[0].headers, base.sheets[0].rows, july.sheets[0].headers, july.sheets[0].rows, {
      mode: 'append', mapping: Object.fromEntries(check.matched.map((m) => [m.old, m.incoming])), dedupe: { enabled: true, keys: ['Order ID'] },
    })
    expect(merged.added).toBe(july.sheets[0].rows.length - (july.sheets[0].rows.length - new Set(july.sheets[0].rows.map((r) => r['Order ID'])).size))
    const after = build(merged.headers, merged.rows)

    const latestMonth = [{ id: 'f', column: 'Order Date', relative: { last: 1, unit: 'month' as const, calendar: true } }]
    const monthOf = (ds: Dataset) => iso(Math.min(...filteredRows(ds, latestMonth).map((r) => r['Order Date'] as number))).slice(0, 7)
    expect(monthOf(before)).toBe('2025-06')
    expect(monthOf(after)).toBe('2025-07')

    const kpi = { id: 'k', type: 'kpi' as const, title: '', size: 'xs' as const, dimension: 'Order Date', bucket: 'month' as const, measures: [{ id: 'm', column: 'calc_revenue', agg: 'sum' as const }] }
    expect(runKpi(before, kpi).deltaLabel).toBe('Jun 2025 vs May 2025')
    expect(runKpi(after, kpi).deltaLabel).toBe('Jul 2025 vs Jun 2025')
    // filtered to the latest month, the value is July only and the change still compares with June
    const julyOnly = runKpi(after, kpi, latestMonth)
    expect(julyOnly.deltaLabel).toBe('Jul 2025 vs Jun 2025')
    expect(julyOnly.rows).toBe(filteredRows(after, latestMonth).length)
    expect(julyOnly.spark!.length).toBeGreaterThan(12)
    // the prep steps cleaned the new month too: no test orders, no stray store spellings
    expect(after.rows.some((r) => r.Product === 'TEST ITEM')).toBe(false)
    expect(new Set(after.rows.map((r) => r.Store)).size).toBe(9)
  })
})

describe('checks on an incoming file', () => {
  const now = Date.UTC(2026, 9, 26)
  const headers = ['day', 'qty', 'store']
  const old: RawRow[] = Array.from({ length: 60 }, (_, i) => ({ day: `2025-06-${String((i % 30) + 1).padStart(2, '0')}`, qty: String(i + 1), store: i % 2 ? 'A' : 'B' }))
  const same = { day: 'day', qty: 'qty', store: 'store' }
  const check = (rows: RawRow[]) => checkIncoming(headers, old, rows, same, { now })

  it('a clean file passes', () => {
    expect(check(Array.from({ length: 20 }, (_, i) => ({ day: `2025-07-${String(i + 1).padStart(2, '0')}`, qty: String(i), store: 'A' })))).toEqual([])
  })
  it('flags text in a number column, new blanks, negatives and future dates', () => {
    const rows: RawRow[] = [
      ...Array.from({ length: 10 }, () => ({ day: '2025-07-01', qty: 'TBD', store: 'A' })),
      ...Array.from({ length: 5 }, () => ({ day: '2025-07-02', qty: '3', store: '' })),
      { day: '2025-07-03', qty: '-4', store: 'B' },
      { day: '2031-03-03', qty: '1', store: 'B' },
      ...Array.from({ length: 20 }, () => ({ day: '2025-07-04', qty: '2', store: 'A' })),
    ]
    const c = check(rows)
    expect(c.map((x) => [x.column, x.kind, x.count])).toEqual([['day', 'future', 1], ['qty', 'type', 10], ['qty', 'negative', 1], ['store', 'blanks', 5]])
    expect(c.find((x) => x.kind === 'type')!.examples).toEqual(['TBD'])
    expect(c.find((x) => x.kind === 'future')!.message).toMatch(/latest Mar 3, 2031/)
  })
  it('the coffee sample’s July file raises nothing it didn’t already have', async () => {
    const base = await parseSample('coffee-chain-sales.csv')
    const july = await parseSample('updates/coffee-chain-sales-2025-07.csv')
    const h = base.sheets[0].headers
    expect(checkIncoming(h, base.sheets[0].rows, july.sheets[0].rows, Object.fromEntries(h.map((x) => [x, x])), { now })).toEqual([])
  })
})
