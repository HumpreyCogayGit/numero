import { describe, expect, it } from 'vitest'
import { acknowledge, reviewImport } from '../../src/lib/quality'
import { checkIncoming } from '../../src/lib/update'
import { applyPrep } from '../../src/lib/prep'
import type { PrepStep, RawRow } from '../../src/types'
import { FIXTURES, parseSample } from './helpers'

const NOW = Date.UTC(2024, 5, 1)
const make = (n: number, f: (i: number) => RawRow) => Array.from({ length: n }, (_, i) => f(i))
const review = (rows: RawRow[], extra = {}) => reviewImport(Object.keys(rows[0]), rows, { now: NOW, ...extra })
const kinds = (r: ReturnType<typeof review>) => r.checks.map((c) => `${c.column}:${c.kind}:${c.severity}`)

describe('first import: data-quality checks before the dashboard is built', () => {
  it('a clean file raises nothing', () => {
    const r = review(make(60, (i) => ({ day: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`, region: ['N', 'S', 'E'][i % 3], sales: String(100 + i * 3) })))
    expect(r.checks).toEqual([])
    expect(r.notes).toEqual([])
    expect(r).toMatchObject({ inspected: 60, total: 60 })
  })
  it('dates in the future are a warning, with the rows and a step that leaves them out (K1)', () => {
    const rows = make(40, (i) => ({ released: i === 7 || i === 30 ? `2046-03-${10 + i % 9}` : `2023-0${(i % 9) + 1}-15`, n: String(i) }))
    const r = review(rows)
    const c = r.checks.find((x) => x.kind === 'future')!
    expect(c).toMatchObject({ column: 'released', severity: 'warning', count: 2, rows: [8, 31] })
    expect(c.message).toMatch(/2 dates in released are in the future \(latest Mar 1\d, 2046\)/)
    // the suggested step really removes exactly those rows — and only when the user adds it
    const step = { id: 's', ...(c.fix as { prep: object }).prep } as PrepStep
    const kept = applyPrep({ headers: ['released', 'n'], rows }, [step])
    expect(kept.rows).toHaveLength(38)
    expect(rows).toHaveLength(40)
  })
  it('text in a number column: severity follows the share, examples are quoted as written', () => {
    // a tenth of the column is text: it is no longer a number at all, which is the thing to say
    const many = review(make(50, (i) => ({ amount: i % 10 === 0 ? 'pending' : String(i) })))
    expect(many.checks[0]).toMatchObject({ column: 'amount', kind: 'type', severity: 'warning', count: 5, examples: ['pending'], rows: [1, 11, 21, 31, 41] })
    expect(many.checks[0].message).toBe('amount is read as text: 5 values of 50 aren’t numbers')
    expect(many.checks[0].fix).toEqual({ label: 'Read as number (those become blank)', type: 'number' })
    // forced to a number, the same values are reported as the ones that will be blank
    const forced = review(make(50, (i) => ({ amount: i % 10 === 0 ? 'pending' : String(i) })), { overrides: { amount: 'number' } })
    expect(forced.checks[0]).toMatchObject({ kind: 'type', severity: 'warning', count: 5 })
    const one = review(make(400, (i) => ({ amount: i === 20 ? 'tbd' : String(i * 2) })))
    expect(one.checks.find((c) => c.kind === 'type')).toMatchObject({ severity: 'info', count: 1 })
    expect(one.checks.find((c) => c.kind === 'type')!.message).toBe('1 value in amount isn’t a number — it will be blank')
  })
  it('missing values: quiet below 5%, info above, warning above 30%', () => {
    const at = (share: number) => review(make(100, (i) => ({ city: ['Oslo', 'Rome'][i % 2], score: i < share * 100 ? '' : String(50 + i) }))).checks.filter((c) => c.kind === 'blanks')
    expect(at(0.02)).toEqual([])
    expect(at(0.1)[0]).toMatchObject({ severity: 'info', count: 10 })
    expect(at(0.4)[0]).toMatchObject({ severity: 'warning', count: 40 })
    expect(at(0.1)[0].message).toBe('score is blank in 10 rows (10%) — sums and averages skip them')
  })
  it('NA is a blank under a number and a value under a category, exactly as the import will read it', () => {
    const r = review(make(40, (i) => ({ region: i % 4 === 0 ? 'NA' : 'EU', amount: i % 5 === 0 ? 'NA' : String(i) })), { softBlanks: 'never' })
    expect(r.checks.some((c) => c.column === 'region' && c.kind === 'blanks')).toBe(false)
    const auto = review(make(40, (i) => ({ region: ['EU', 'US'][i % 2], amount: i % 5 === 0 ? 'NA' : String(i) })))
    expect(auto.checks.find((c) => c.column === 'amount')).toMatchObject({ kind: 'blanks', count: 8 })
    expect(auto.notes.find((n) => n.key === 'amount')).toMatchObject({ softBlank: true, softTokens: [{ token: 'NA', count: 8 }] })
  })
  it('a few negatives among positive values are pointed out; a column that is often negative is not', () => {
    const r = review(make(200, (i) => ({ qty: i === 3 || i === 90 ? '-4' : String(1 + (i % 9)), delta: String((i % 7) - 3) })))
    expect(r.checks.find((c) => c.kind === 'negative')).toMatchObject({ column: 'qty', count: 2, severity: 'info', examples: ['-4'], rows: [4, 91] })
    expect(r.checks.some((c) => c.column === 'delta')).toBe(false)
  })
  it('likely identifiers: a counter stored as a number, and an ID kept as a label', () => {
    const r = review(make(50, (i) => ({ Row: String(i + 1), order_id: String(5000 + Math.floor(i / 2)), sales: String((i * 37) % 91) })))
    expect(kinds(r)).toEqual(expect.arrayContaining(['Row:identifier:info', 'order_id:identifier:info']))
    expect(r.checks.find((c) => c.column === 'Row')!.fix).toEqual({ label: 'Treat as a label', type: 'category' })
    expect(r.checks.some((c) => c.column === 'sales')).toBe(false)
  })
  it('follows the user’s choices: a type override and the decimal separator change what is flagged', () => {
    const rows = make(30, (i) => ({ price: `${i},5`, code: String(100 + i) }))
    expect(review(rows, { decimal: ',' }).checks.filter((c) => c.kind === 'type')).toEqual([])
    const forced = review(rows, { overrides: { price: 'number' } })
    expect(forced.checks.find((c) => c.column === 'price')).toMatchObject({ kind: 'type', severity: 'warning', count: 30 })
  })
  it('never alters the source rows', () => {
    const rows = make(30, (i) => ({ d: i === 2 ? '2099-01-01' : '2024-01-01', v: i === 4 ? 'x' : '1', z: i % 3 ? 'NA' : 'a' }))
    const before = JSON.stringify(rows)
    review(rows)
    expect(JSON.stringify(rows)).toBe(before)
  })
  it('large files are sampled evenly: no copy of all rows, counts and row numbers from the sample', () => {
    const rows = make(200_000, (i) => ({ v: i % 1000 === 0 ? 'bad' : String(i) }))
    const t0 = performance.now()
    const r = reviewImport(['v'], rows, { now: NOW, limit: 20_000 })
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(r).toMatchObject({ inspected: 20_000, total: 200_000 })
    const c = r.checks.find((x) => x.kind === 'type')!
    // every tenth row is looked at; the bad rows (every thousandth) all fall on those
    expect(c.count).toBe(200)
    expect(c.rows.slice(0, 2)).toEqual([1, 1001])
  })
  it('raises on first import what Update data would raise for the same bad rows', async () => {
    const good = (await parseSample('seattle-weather.csv')).sheets[0]
    const bad = (await parseSample('seattle-bad.csv', FIXTURES)).sheets[0]
    const mapping = Object.fromEntries(good.headers.map((h) => [h, h]))
    const atUpdate = checkIncoming(good.headers, good.rows, bad.rows, mapping, { now: NOW })
    // the same rows arriving as part of a first import
    const atImport = reviewImport(good.headers, [...good.rows, ...bad.rows], { now: NOW })
    // the checks that do not depend on history (wrong type, future dates) show up both times, on the same columns
    const shared = atUpdate.filter((c) => c.kind === 'type' || c.kind === 'future')
    expect(shared.map((c) => `${c.column}:${c.kind}`).sort()).toEqual(['date:future', 'temp_max:type'])
    for (const u of shared) {
      const c = atImport.checks.find((x) => x.column === u.column && x.kind === u.kind)
      expect(c, `${u.column}:${u.kind}`).toBeTruthy()
      expect(c!.count).toBe(u.count)
    }
    // "blank where it was always filled" and "negative where it never was" compare with earlier data: on a first import
    // the negative still stands out against the rest of the column
    expect(atImport.checks.find((c) => c.column === 'precipitation' && c.kind === 'negative')).toMatchObject({ count: 1 })
  })
  it('what was accepted is recorded compactly, without row values', () => {
    const r = review(make(40, (i) => ({ released: i === 7 ? '2046-03-10' : '2023-01-15', secret: i === 3 ? 'hunter2' : String(i) })))
    const ack = acknowledge(r, 123)
    expect(ack.at).toBe(123)
    expect(ack.checks.map((c) => c.kind)).toEqual(expect.arrayContaining(['future', 'type']))
    expect(Object.keys(ack.checks[0]).sort()).toEqual(['column', 'count', 'kind', 'message', 'severity'])
    expect(JSON.stringify(ack)).not.toContain('hunter2')
  })
})
