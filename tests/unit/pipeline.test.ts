import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { parseDate, parseNumber, buildTable } from '../../src/lib/infer'
import { aggregate, applyFilters, colMap, rowsBehind, runGrouped, runKpi, runPivot } from '../../src/lib/aggregate'
import { suggest } from '../../src/lib/suggest'
import { buildChart } from '../../src/lib/chartOptions'
import { findInsights, profileColumn } from '../../src/lib/profile'
import { TOKENS } from '../../src/lib/palette'
import type { Widget } from '../../src/types'
import { col, loadDataset, makeDataset, parseSample, SAMPLES } from './helpers'

describe('parsing', () => {
  it('reads every sample format', async () => {
    for (const f of readdirSync(SAMPLES).filter((x) => x.includes('.'))) {
      const p = await parseSample(f)
      expect(p.sheets[0].rows.length, f).toBeGreaterThan(100)
    }
  })
  it('lists workbook sheets', async () => {
    const p = await parseSample('us-unemployment-by-industry.xlsx')
    expect(p.sheets.map((s) => s.name)).toEqual(['Unemployment', 'Notes'])
  })
  it('flattens nested JSON and finds wrapped arrays', async () => {
    const { parseFile } = await import('../../src/lib/parse')
    const json = JSON.stringify({ meta: { n: 2 }, data: [{ a: 1, b: { c: 'x' }, tags: ['p', 'q'] }, { a: 2, b: { c: 'y' }, tags: [] }] })
    const p = await parseFile(new File([json], 'x.json'))
    expect(p.sheets[0].headers).toEqual(['a', 'b.c', 'tags'])
    expect(p.sheets[0].rows[0]).toEqual({ a: 1, 'b.c': 'x', tags: 'p, q' })
  })
})

describe('type inference', () => {
  it('detects types across samples', async () => {
    const sw = await loadDataset('seattle-weather.csv')
    expect(sw.columns.map((c) => c.type)).toEqual(['date', 'number', 'number', 'number', 'number', 'category'])
    const cars = await loadDataset('cars.json')
    expect(col(cars, 'Year')).toMatchObject({ type: 'date', grain: 'year' })
    expect(col(cars, 'Cylinders')).toMatchObject({ type: 'number', discrete: true })
    expect(col(cars, 'Name').type).toBe('text')
  })
  it('reads Excel dates without a timezone shift', async () => {
    const st = await loadDataset('tech-stock-prices.xls')
    expect(col(st, 'Date').grain).toBe('month')
    expect(new Date(st.rows[0].Date as number).toISOString()).toBe('2000-01-01T00:00:00.000Z')
  })
  it('parses numbers in common formats', () => {
    expect(parseNumber('$1,234.50')).toBe(1234.5)
    expect(parseNumber('(42)')).toBe(-42)
    expect(parseNumber('12%')).toBe(12)
    expect(parseNumber('abc')).toBeNull()
  })
  it('parses dates in common formats as UTC', () => {
    const iso = (s: string, dayFirst = false) => new Date(parseDate(s, dayFirst)!).toISOString().slice(0, 10)
    expect(iso('2024-03-05')).toBe('2024-03-05')
    expect(iso('Jun 12 1998')).toBe('1998-06-12')
    expect(iso('03/04/2024')).toBe('2024-03-04')
    expect(iso('03/04/2024', true)).toBe('2024-04-03')
    expect(parseDate('2024-02-30')).toBeNull()
  })
  it('date order: the values decide, and the browser locale settles ambiguous files (N10a)', async () => {
    const { inferColumn, localeDayFirst } = await import('../../src/lib/infer')
    expect(localeDayFirst('en-US')).toBe(false)
    expect(localeDayFirst('en-GB')).toBe(true)
    expect(localeDayFirst('de-DE')).toBe(true)
    const day = (vals: string[], loc: boolean) => inferColumn('d', vals, { localeDayFirst: loc }).dayFirst
    // ambiguous: only days ≤ 12 → the locale decides
    expect(day(['03/04/2024', '05/06/2024'], true)).toBe(true)
    expect(day(['03/04/2024', '05/06/2024'], false)).toBe(false)
    // evidence beats the locale either way
    expect(day(['03/04/2024', '25/06/2024'], false)).toBe(true)
    expect(day(['03/04/2024', '06/25/2024'], true)).toBe(false)
    // an explicit choice in the import preview wins
    expect(inferColumn('d', ['03/04/2024'], { dateOrder: 'mdy', localeDayFirst: true }).dayFirst).toBe(false)
  })
  it('detects currency, percent, booleans and IDs', () => {
    const ds = makeDataset(Array.from({ length: 40 }, (_, i) => ({ id: String(i + 1), price: `$${i}.50`, share: `${i}%`, ok: i % 2 ? 'yes' : 'no' })))
    expect(col(ds, 'id')).toMatchObject({ type: 'category', isId: true })
    expect(col(ds, 'price')).toMatchObject({ type: 'number', format: 'currency', currency: '$' })
    expect(col(ds, 'share')).toMatchObject({ type: 'number', format: 'percent' })
    expect(col(ds, 'ok').type).toBe('boolean')
  })
  it('respects type overrides', () => {
    const t = buildTable(['n'], [{ n: '1' }, { n: '2' }, { n: '3' }], { n: 'category' })
    expect(t.columns[0].type).toBe('category')
    expect(t.rows[0].n).toBe('1')
  })
})

describe('query engine', () => {
  it('groups, aggregates, sorts and folds the tail into Other', async () => {
    const sw = await loadDataset('seattle-weather.csv')
    const g = runGrouped(sw, { id: 'w', type: 'bar', title: '', size: 'md', dimension: 'weather', measures: [{ id: 'm', agg: 'count' }], limit: 2 })
    expect(g.categories).toEqual(['rain', 'sun', 'Other'])
    expect(g.series[0].values).toEqual([641, 640, 180])
  })
  it('buckets dates and splits series with zero-filled additive cells', async () => {
    const sw = await loadDataset('seattle-weather.csv')
    const g = runGrouped(sw, { id: 'w', type: 'area', title: '', size: 'md', dimension: 'date', bucket: 'year', series: 'weather', measures: [{ id: 'm', agg: 'count' }] })
    expect(g.categories).toEqual(['2012', '2013', '2014', '2015'])
    expect(g.series).toHaveLength(5)
    expect(g.series.every((s) => s.values.every((v) => v != null))).toBe(true)
    const total = g.series.reduce((a, s) => a + s.values.reduce((x, v) => x! + (v ?? 0), 0)!, 0)
    expect(total).toBe(1461)
  })
  it('applies include/exclude, range and text filters', async () => {
    const sw = await loadDataset('seattle-weather.csv')
    const cols = colMap(sw)
    expect(applyFilters(sw.rows, [{ id: 'f', column: 'weather', values: ['rain'] }], cols)).toHaveLength(641)
    expect(applyFilters(sw.rows, [{ id: 'f', column: 'weather', values: ['rain'], exclude: true }], cols)).toHaveLength(820)
    expect(applyFilters(sw.rows, [{ id: 'f', column: 'temp_max', min: 30 }], cols).every((r) => (r.temp_max as number) >= 30)).toBe(true)
  })
  it('aggregations', () => {
    const rows = [{ x: 1 }, { x: 2 }, { x: 3 }, { x: 10 }, { x: null }]
    const a = (agg: Parameters<typeof aggregate>[1]['agg']) => aggregate(rows, { id: 'm', column: 'x', agg })
    expect([a('count'), a('sum'), a('avg'), a('median'), a('min'), a('max'), a('distinct')]).toEqual([5, 16, 4, 2.5, 1, 10, 4])
  })
  it('KPI includes a sparkline and change', async () => {
    const sw = await loadDataset('seattle-weather.csv')
    const k = runKpi(sw, { id: 'k', type: 'kpi', title: '', size: 'xs', dimension: 'date', measures: [{ id: 'm', agg: 'count' }] })
    expect(k.value).toBe(1461)
    expect(k.spark!.length).toBeGreaterThan(10)
  })
  it('finds the rows behind a widget and one of its marks', async () => {
    const sw = await loadDataset('seattle-weather.csv')
    const w: Widget = { id: 'w', type: 'bar', title: '', size: 'md', dimension: 'date', bucket: 'year', series: 'weather', measures: [{ id: 'm', agg: 'count' }], filters: [{ id: 'f', column: 'temp_max', min: 20 }] }
    const g = runGrouped(sw, w, [{ id: 'p', column: 'precipitation', max: 0 }])
    const cell = g.series.find((s) => s.name === 'sun')!
    const behind = rowsBehind(sw, w, [{ id: 'p', column: 'precipitation', max: 0 }], [g.filterFor!(g.categoryKeys[1]), g.seriesFilterFor!(cell.key!)])
    expect(behind).toHaveLength(cell.values[1]!)
    expect(behind.every((r) => r.weather === 'sun' && (r.temp_max as number) >= 20 && r.precipitation === 0)).toBe(true)
    expect(rowsBehind(sw, w, [])).toHaveLength(applyFilters(sw.rows, w.filters, colMap(sw)).length)
  })
  it('a latest-period KPI says which rows it shows (R11)', async () => {
    const sw = await loadDataset('seattle-weather.csv')
    const k = runKpi(sw, { id: 'k', type: 'kpi', title: '', size: 'xs', dimension: 'date', bucket: 'month', kpiMode: 'latest', measures: [{ id: 'm', agg: 'count' }] })
    expect(k.period).toBe('Dec 2015')
    expect(rowsBehind(sw, { id: 'k', type: 'kpi', title: '', size: 'xs', measures: [] }, [], [k.periodFilter!])).toHaveLength(31)
  })
  it('pivots with totals', async () => {
    const sw = await loadDataset('seattle-weather.csv')
    const p = runPivot(sw, ['weather'], 'date', { id: 'm', agg: 'count' }, [], { date: 'year' })
    expect(p.colHeaders).toEqual(['2012', '2013', '2014', '2015'])
    expect(p.grand).toBe(1461)
    expect(p.rowTotals.reduce((a, b) => a! + b!, 0)).toBe(1461)
  })
})

describe('suggestions and charts', () => {
  it('builds every suggested chart for every sample without errors', async () => {
    for (const f of readdirSync(SAMPLES).filter((x) => x.includes('.'))) {
      const ds = await loadDataset(f)
      const s = suggest(ds)
      expect(s.widgets.length, f).toBeGreaterThan(4)
      for (const w of [...s.widgets, ...s.extra]) {
        if (w.type === 'kpi') runKpi(ds, w)
        else if (w.type === 'table') runGrouped(ds, w)
        else expect(() => buildChart(ds, w, [], TOKENS.light), `${f}: ${w.title}`).not.toThrow()
      }
      for (const c of ds.columns) profileColumn(ds, c)
      findInsights(ds)
    }
  })
  it('packs the suggested grid into full rows', async () => {
    const span = { xs: 3, sm: 4, md: 6, lg: 8, full: 12 }
    for (const f of ['seattle-weather.csv', 'movies.json', 'penguins.csv']) {
      const ws = suggest(await loadDataset(f)).widgets
      // every row must sum to exactly 12 columns: no widget may overflow a partly filled row
      let row = 0
      for (const w of ws) {
        row += span[w.size]
        expect(row, `${f}: "${w.title}" leaves a gap in its row`).toBeLessThanOrEqual(12)
        if (row === 12) row = 0
      }
      expect(row, `${f}: last row is not full`).toBe(0)
    }
  })
  it('prefers real categories over discrete numbers and short date columns', async () => {
    const un = await loadDataset('us-unemployment-by-industry.xlsx')
    const bar = suggest(un).widgets.find((w) => w.type === 'hbar' || w.type === 'bar') as Widget
    expect(bar.dimension).toBe('Industry')
    const pg = suggest(await loadDataset('penguins.csv')).widgets
    expect(pg.some((w) => w.type === 'line' || w.type === 'area')).toBe(false)
    const heat = pg.find((w) => w.type === 'heatmap')!
    expect(heat.dimension).not.toBe(heat.series)
  })
})
