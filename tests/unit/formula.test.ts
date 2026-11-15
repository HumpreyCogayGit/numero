import { beforeAll, describe, expect, it } from 'vitest'
import { evaluate, FormulaError, highlight, parse, type FValue } from '../../src/lib/formula'
import type { Dataset } from '../../src/types'
import { loadDataset } from './helpers'

let sw: Dataset
let st: Dataset
beforeAll(async () => {
  sw = await loadDataset('seattle-weather.csv')
  st = await loadDataset('tech-stock-prices.xls')
})

const norm = (v: FValue) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'number' ? +v.toFixed(4) : v)
// Seattle rows 0–2: precipitation 0 / 10.9 / 0.8, temp_max 12.8 / 10.6 / 11.7, temp_min 5 / 2.8 / 7.2, weather drizzle / rain / rain
const ev = (f: string, n = 3) => evaluate(f, sw.columns, sw.rows).values.slice(0, n).map(norm)
const one = (f: string) => norm(evaluate(f, sw.columns, sw.rows).values[0])
const errorOf = (f: string) => {
  try { evaluate(f, sw.columns, sw.rows); return null } catch (e) { return e as FormulaError }
}

describe('operators', () => {
  it('arithmetic and precedence', () => {
    expect(ev('[temp_max] - [temp_min]')).toEqual([7.8, 7.8, 4.5])
    expect(ev('2 + 3 * 4 ^ 2 / 8', 1)).toEqual([8])
    expect(ev('-[temp_min] + 1')).toEqual([-4, -1.8, -6.2])
  })
  it('column references by key, bare name and pretty name', () => {
    expect(ev('temp_max * 2', 1)).toEqual([25.6])
    expect(ev('[Temp max] > 12', 2)).toEqual([true, false])
  })
  it('logic', () => {
    expect(ev('[precipitation] = 0 AND [wind] > 4 OR FALSE', 2)).toEqual([true, false])
    expect(ev('NOT [precipitation] > 0', 2)).toEqual([true, false])
  })
  it('null and zero handling', () => {
    expect(one('1 / 0')).toBeNull()
    expect(one('NULL + 1')).toBeNull()
    expect(one('"n=" + 5')).toBe('n=5')
    expect(one('"5" + 5')).toBe(10)
  })
  it('dates compare with text', () => {
    expect(ev('[date] >= "2012-01-02"', 2)).toEqual([false, true])
    expect(ev('BETWEEN([date], "2012-01-02", "2012-01-03")', 4)).toEqual([false, true, true, false])
  })
})

describe('functions', () => {
  it('logic functions', () => {
    expect(ev('IF([precipitation] > 0, "wet", "dry")')).toEqual(['dry', 'wet', 'wet'])
    expect(ev('IFS([temp_max] > 12, "warm", [temp_max] > 11, "mild", "cold")')).toEqual(['warm', 'cold', 'mild'])
    expect(ev('SWITCH([weather], "rain", 1, "drizzle", 2, 0)')).toEqual([2, 1, 1])
    expect(ev('IN([weather], "rain", "snow")', 2)).toEqual([false, true])
    expect(one('COALESCE(NULL, "", "x")')).toBe('x')
    expect(ev('DIVIDE([precipitation], 0, -1)', 1)).toEqual([-1])
  })
  it('text functions', () => {
    expect(ev('UPPER(LEFT([weather], 3)) & LEN([weather])', 2)).toEqual(['DRI7', 'RAI4'])
    expect(one('PROPER(REPLACE("hello_big world", "_", " "))')).toBe('Hello Big World')
    expect(one('SPLIT("a/b/c", "/", -1)')).toBe('c')
    expect(one('REGEXEXTRACT("Movie (1999)", "\\((\\d{4})\\)", 1)')).toBe('1999')
    expect(one('"say ""hi"""')).toBe('say "hi"')
  })
  it('date functions', () => {
    expect(ev('YEAR([date]) & "-" & LPAD(MONTH([date]), 2, "0") & " " & DAYNAME([date], TRUE)', 2)).toEqual(['2012-01 Sun', '2012-01 Mon'])
    expect(ev('[date] + 31', 1)).toEqual(['2012-02-01'])
    expect(one('DATEADD(DATE(2024,1,31), 1, "month")')).toBe('2024-02-29')
    expect(ev('DATEDIFF([date], DATE(2013, 1, 1), "month")', 1)).toEqual([12])
    expect(ev('DATETRUNC([date], "quarter")', 1)).toEqual(['2012-01-01'])
    expect(ev(`DATEFORMAT([date], "MMM YYYY · 'Q'Q")`, 1)).toEqual(['Jan 2012 · Q1'])
    expect(one('WEEK(DATE(2021,1,4))')).toBe(1)
  })
  it('column aggregates and group aggregates', () => {
    expect(ev('ROUND([precipitation] / SUM([precipitation]) * 100, 3)', 2)).toEqual([0, 0.246])
    expect(ev('ROUND(AVG([temp_max]), 2)', 1)).toEqual([16.44])
    expect(ev('MAX([temp_min], 4, 3)')).toEqual([5, 4, 7.2])
    expect(ev('COUNTD([weather])', 1)).toEqual([5])
    expect(ev('GROUP_COUNT([weather])', 2)).toEqual([53, 641])
    expect(ev('ROUND(GROUP_AVG([temp_max], [weather]), 2)', 2)).toEqual([15.93, 13.45])
  })
  it('window functions', () => {
    expect(evaluate('RANK([precipitation])', sw.columns, sw.rows).values.filter((v) => v === 1)).toHaveLength(1)
    expect(ev('RUNNING_SUM([precipitation])')).toEqual([0, 10.9, 11.7])
    expect(ev('LAG([temp_max])')).toEqual([null, 12.8, 10.6])
    expect(ev('LEAD([temp_max], 2)', 1)).toEqual([11.7])
    expect(ev('MOVING_AVG([temp_max], 2)')).toEqual([null, 11.7, 11.15])
    expect(ev('ROUND(PCT_CHANGE([temp_max]), 2)', 2)).toEqual([null, -17.19])
    expect(ev('ROUND(ZSCORE([temp_max]), 3)', 1)).toEqual([-0.495])
    expect([...new Set(evaluate('NTILE([temp_max], 4)', sw.columns, sw.rows).values)].sort()).toEqual([1, 2, 3, 4])
  })
  it('partitioned windows restart per group, in order-by order', () => {
    const pc = evaluate('PCT_CHANGE([Price], [Date], [Symbol])', st.columns, st.rows).values
    expect(pc.filter((v) => v == null)).toHaveLength(5)
    const rk = evaluate('RANK([Price], "desc", [Symbol])', st.columns, st.rows).values as number[]
    expect(Math.max(...rk)).toBe(123)
  })
  it('binning', () => {
    expect(ev('BUCKET([temp_max], 11, 12)')).toEqual(['12+', '< 11', '11–12'])
    expect(ev('BIN([temp_max], 5)', 2)).toEqual([10, 10])
  })
})

describe('errors', () => {
  it.each([
    ['[nope] + 1', 'Unknown column [nope]', 0, 6],
    ['SUMM([wind])', 'Unknown function SUMM()', 0, 4],
    ['IF([wind] > 1)', 'IF() takes 2–3 arguments', 0, 14],
    ['1 +', 'Formula ends unexpectedly', 3, 3],
    ['(1 + 2', 'Expected a closing )', 6, 7],
    ['"open', 'Text is missing its closing quote', 0, 5],
    ['[wind', 'Column reference is missing its closing ]', 0, 5],
    ['wind wind', 'missing an operator', 5, 9],
    ['ROUND', 'add parentheses', 0, 5],
    ['foo + 1', 'wrap column names in [brackets]', 0, 3],
    ['IF([wind] > 1, "a" "b")', 'Missing a comma before "b" in IF()', 19, 22],
    ['1 + 2)', 'Extra closing )', 5, 6],
  ])('%s', (f, msg, start, end) => {
    const e = errorOf(f)!
    expect(e).toBeInstanceOf(FormulaError)
    expect(e.message).toContain(msg)
    expect([e.start, e.end]).toEqual([start, end])
  })
  it('row-level failures are counted, not thrown', () => {
    const r = evaluate('DATEADD([date], 1, "fortnight")', sw.columns, sw.rows)
    expect(r.rowErrors).toBe(sw.rows.length)
    expect(r.values[0]).toBeNull()
  })
  it('never evaluates JavaScript', () => {
    expect(errorOf('constructor.constructor("return 1")()')).toBeInstanceOf(FormulaError)
    expect(errorOf('__proto__')).toBeInstanceOf(FormulaError)
  })
})

describe('editor support', () => {
  it('highlight is lossless and classifies tokens', () => {
    const src = 'IF([wind] > 2, "a", nope)'
    expect(highlight(src, sw.columns).map((s) => s.text).join('')).toBe(src)
    expect(highlight('SUM([wind]) & "x"', sw.columns).filter((s) => s.kind !== 'plain').map((s) => s.kind)).toEqual(['fn', 'paren', 'col', 'paren', 'op', 'str'])
  })
  it('parse resolves column references to columns', () => {
    const ast = parse('[Temp max]', sw.columns)
    expect(ast.k === 'col' && ast.col.key).toBe('temp_max')
  })
})

describe('performance', () => {
  it('evaluates 100k rows quickly', () => {
    const rows = Array.from({ length: 100_000 }, (_, i) => ({ a: i, b: i % 7, c: 'g' + (i % 13) }))
    const cols = [
      { key: 'a', name: 'a', type: 'number', detected: 'number', distinct: 0, missing: 0 },
      { key: 'b', name: 'b', type: 'number', detected: 'number', distinct: 0, missing: 0 },
      { key: 'c', name: 'c', type: 'category', detected: 'category', distinct: 0, missing: 0 },
    ] as Dataset['columns']
    const t = performance.now()
    evaluate('[a] / GROUP_SUM([a], [c]) + RANK([a]) + RUNNING_SUM([a], [b], [c])', cols, rows)
    expect(performance.now() - t).toBeLessThan(1500)
  })
})
