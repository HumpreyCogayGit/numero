import { beforeAll, describe, expect, it } from 'vitest'
import { applyPrep } from '../../src/lib/prep'
import { buildDataset, emptyModel } from '../../src/lib/model'
import { compileMeasure, evalMeasure } from '../../src/lib/measure'
import { aggregate, colMap, filteredRows, runGrouped, runKpi, runPivot } from '../../src/lib/aggregate'
import { buildChart } from '../../src/lib/chartOptions'
import { anomalies, forecast, seasonalProfile } from '../../src/lib/forecast'
import { ask } from '../../src/lib/ask'
import { exportDashboard, exportRows, planImport } from '../../src/lib/share'
import { detectGeo, detectLatLon, resolveRegion } from '../../src/lib/geo'
import { fmtNumber, fmtValue } from '../../src/lib/format'
import { parseFile } from '../../src/lib/parse'
import { parseNumber } from '../../src/lib/infer'
import { renameRefs } from '../../src/lib/computed'
import { TOKENS } from '../../src/lib/palette'
import { suggest } from '../../src/lib/suggest'
import type { Dataset, DatasetModel, PrepStep, Widget } from '../../src/types'
import { col, loadDataset, makeDataset } from './helpers'

// Omit doesn't distribute over unions, so strip `id` per variant
type StepInput = PrepStep extends unknown ? (PrepStep extends infer S ? S extends PrepStep ? Omit<S, 'id'> : never : never) : never
const step = (s: StepInput) => ({ id: 's', ...s }) as PrepStep
const T = (headers: string[], rows: Record<string, unknown>[]) => ({ headers, rows: rows as never })

let sw: Dataset
let st: Dataset
let gm: Dataset
beforeAll(async () => {
  sw = await loadDataset('seattle-weather.csv')
  st = await loadDataset('tech-stock-prices.xls')
  gm = await loadDataset('gapminder.json')
})

describe('prep steps (F6)', () => {
  const base = T(['name', 'city', 'amount'], [
    { name: ' Ann ', city: 'nyc', amount: '10' },
    { name: 'Bob', city: 'NYC', amount: '' },
    { name: ' Ann ', city: 'nyc', amount: '10' },
    { name: 'Cy', city: '', amount: '30' },
  ])
  it('dedupes, trims, fills and filters', () => {
    const r = applyPrep(base, [
      step({ op: 'dedupe' }),
      step({ op: 'trim' }),
      step({ op: 'fill', column: 'amount', method: 'mean' }),
      step({ op: 'case', column: 'city', mode: 'upper' }),
      step({ op: 'filter', column: 'city', cmp: 'notBlank', keep: true }),
    ])
    expect(r.rows).toEqual([{ name: 'Ann', city: 'NYC', amount: '10' }, { name: 'Bob', city: 'NYC', amount: 20 }])
    expect(r.reports.map((x) => x.summary)).toEqual(['Removed 1 duplicate', 'Cleaned 1 cell', 'Filled 1 cell', 'Changed 1 cell', 'Kept 2 rows, removed 1'])
  })
  it('fills from the previous / next value', () => {
    const t = T(['v'], [{ v: '1' }, { v: '' }, { v: '' }, { v: '4' }, { v: null }])
    expect(applyPrep(t, [step({ op: 'fill', column: 'v', method: 'previous' })]).rows.map((r) => r.v)).toEqual(['1', '1', '1', '4', '4'])
    expect(applyPrep(t, [step({ op: 'fill', column: 'v', method: 'next' })]).rows.map((r) => r.v)).toEqual(['1', '4', '4', '4', null])
  })
  it('splits, removes, reorders and replaces', () => {
    const t = T(['full', 'x'], [{ full: 'Smith, Jo, Jr', x: 'a-b' }])
    const r = applyPrep(t, [
      step({ op: 'split', column: 'full', separator: ', ', parts: 2 }),
      step({ op: 'replace', column: 'x', find: '-', replace: '+' }),
      step({ op: 'remove', columns: ['full'] }),
      step({ op: 'reorder', columns: ['x'] }),
    ])
    expect(r.headers).toEqual(['x', 'full 1', 'full 2'])
    expect(r.rows[0]).toMatchObject({ x: 'a+b', 'full 1': 'Smith', 'full 2': 'Jo, Jr' })
  })
  it('unpivots wide columns into long rows', () => {
    const t = T(['region', '2023', '2024'], [{ region: 'N', 2023: '5', 2024: '7' }, { region: 'S', 2023: '1', 2024: '2' }])
    const r = applyPrep(t, [step({ op: 'unpivot', columns: ['2023', '2024'], nameColumn: 'Year', valueColumn: 'Sales' })])
    expect(r.headers).toEqual(['region', 'Year', 'Sales'])
    expect(r.rows).toHaveLength(4)
    expect(r.rows[1]).toEqual({ region: 'N', Year: '2024', Sales: '7' })
  })
  it('joins (left / inner) and appends other datasets', () => {
    const left = T(['id', 'v'], [{ id: '1', v: 'a' }, { id: '2', v: 'b' }, { id: '3', v: 'c' }])
    const other = { name: 'Lookup', headers: ['key', 'v', 'label'], rows: [{ key: '1', v: 'x', label: 'One' }, { key: '3', v: 'y', label: 'Three' }] as never }
    const resolve = (id: string) => (id === 'L' ? other : undefined)
    const l = applyPrep(left, [step({ op: 'join', datasetId: 'L', leftKey: 'id', rightKey: 'key', how: 'left' })], resolve)
    expect(l.headers).toEqual(['id', 'v', 'Lookup · v', 'label'])
    expect(l.rows.map((r) => r.label)).toEqual(['One', null, 'Three'])
    expect(applyPrep(left, [step({ op: 'join', datasetId: 'L', leftKey: 'id', rightKey: 'key', how: 'inner' })], resolve).rows).toHaveLength(2)
    const a = applyPrep(left, [step({ op: 'append', datasetId: 'L' })], resolve)
    expect(a.rows).toHaveLength(5)
    expect(a.headers).toContain('label')
  })
  it('reports a step whose column disappeared instead of failing', () => {
    const r = applyPrep(base, [step({ op: 'remove', columns: ['city'] }), step({ op: 'case', column: 'city', mode: 'upper' })])
    expect(r.reports[1].error).toMatch(/no longer exists/)
    expect(r.rows).toHaveLength(4)
  })
})

describe('rebuild pipeline', () => {
  it('applies prep → types → names → computed columns', () => {
    const model: DatasetModel = {
      ...emptyModel(),
      prep: [step({ op: 'filter', column: 'weather', cmp: 'eq', value: 'snow', keep: true })],
      names: { temp_max: 'High' },
      overrides: { wind: 'category' },
      computed: [{ key: 'calc_range', name: 'Range', formula: '[High] - [temp_min]' }],
    }
    const b = buildDataset({ headers: sw.columns.map((c) => c.key), rows: sw.rows.map(() => ({})) as never }, emptyModel())
    expect(b.rows.length).toBe(1461)
    const raw = { headers: ['date', 'precipitation', 'temp_max', 'temp_min', 'wind', 'weather'], rows: sw.rows.map((r) => ({ ...r, date: new Date(r.date as number).toISOString().slice(0, 10) })) as never }
    const built = buildDataset(raw, model)
    expect(built.rows).toHaveLength(26)
    expect(col(built, 'temp_max').name).toBe('High')
    expect(col(built, 'wind').type).toBe('category')
    expect(col(built, 'calc_range').type).toBe('number')
  })
  it('reads European decimals and day-first dates', async () => {
    const csv = 'Datum;Betrag\n03/04/2024;1.234,50\n05/06/2024;12,5\n'
    const p = await parseFile(new File([csv], 'eu.csv'), { delimiter: ';' })
    const b = buildDataset({ headers: p.sheets[0].headers, rows: p.sheets[0].rows }, { ...emptyModel(), options: { decimal: ',', dateOrder: 'dmy' } })
    expect(b.rows.map((r) => r.Betrag)).toEqual([1234.5, 12.5])
    expect(new Date(b.rows[0].Datum as number).toISOString().slice(0, 10)).toBe('2024-04-03')
    expect(parseNumber('1.234,5', ',')).toBe(1234.5)
  })
  it('decodes Windows-1252 files', async () => {
    const bytes = new Uint8Array([0x43, 0x69, 0x74, 0x79, 0x0a, 0x4d, 0xfc, 0x6e, 0x63, 0x68, 0x65, 0x6e, 0x0a]) // "City\nMünchen\n" in cp1252
    const p = await parseFile(new File([bytes], 'de.csv'))
    expect(p.detected.encoding).toBe('windows-1252')
    expect(p.sheets[0].rows[0].City).toBe('München')
  })
  it('skips title rows, handles headerless files and row limits', async () => {
    const p = await parseFile(new File(['Report 2024\n\na,b\n1,2\n3,4\n5,6\n'], 'r.csv'), { skipRows: 1, rowLimit: 2 })
    expect(p.sheets[0].headers).toEqual(['a', 'b'])
    expect(p.sheets[0].rows).toHaveLength(2)
    expect(p.sheets[0].truncated).toBe(true)
    const h = await parseFile(new File(['1,2\n3,4\n'], 'h.csv'), { header: false })
    expect(h.sheets[0].headers).toEqual(['Column 1', 'Column 2'])
    expect(h.sheets[0].rows).toHaveLength(2)
  })
})

describe('calculated measures (F2)', () => {
  const ds = () => ({ ...makeDataset([
    { region: 'N', profit: 10, revenue: 100, returned: 'yes' },
    { region: 'N', profit: 30, revenue: 100, returned: 'no' },
    { region: 'S', profit: 5, revenue: 50, returned: 'no' },
  ]), model: { ...emptyModel(), measures: [
    { key: 'm_margin', name: 'Margin', formula: 'SUM([profit]) / SUM([revenue])', format: 'ratio' as const },
    { key: 'm_share', name: 'Share', formula: 'SUM([revenue]) / SUM_ALL([revenue]) * 100' },
    { key: 'm_ret', name: 'Returned revenue', formula: 'SUM(IF([returned], [revenue], 0))' },
  ] } })
  it('is evaluated per group, so ratios stay correct under grouping and filters', () => {
    const d = ds()
    const g = runGrouped(d, { id: 'w', type: 'bar', title: '', size: 'md', dimension: 'region', measures: [{ id: 'm', agg: 'calc', calc: 'm_margin' }], sort: 'label-asc' })
    expect(g.categories).toEqual(['N', 'S'])
    expect(g.series[0].values).toEqual([0.2, 0.1])
    expect(g.series[0].name).toBe('Margin')
    const filtered = runGrouped(d, { id: 'w', type: 'bar', title: '', size: 'md', dimension: 'region', measures: [{ id: 'm', agg: 'calc', calc: 'm_share' }] }, [{ id: 'f', column: 'region', values: ['N'] }])
    expect(filtered.series[0].values).toEqual([100])
  })
  it('supports row logic inside aggregates', () => {
    const d = ds()
    expect(aggregate(d.rows, { id: 'm', agg: 'calc', calc: 'm_ret' }, { cols: colMap(d), all: d.rows })).toBe(100)
  })
  it('works in KPIs and pivots', () => {
    const d = ds()
    expect(runKpi(d, { id: 'k', type: 'kpi', title: '', size: 'xs', measures: [{ id: 'm', agg: 'calc', calc: 'm_margin' }] }).value).toBeCloseTo(0.18)
    const p = runPivot(d, ['region'], undefined, { id: 'm', agg: 'calc', calc: 'm_share' }, [])
    expect(p.rowTotals).toEqual([80, 20])
  })
  it('rejects bare columns, nested aggregates and row windows with clear errors', () => {
    const cols = ds().columns
    expect(() => compileMeasure('[profit] / SUM([revenue])', cols)).toThrow(/Wrap \[Profit\] in an aggregate/)
    expect(() => compileMeasure('SUM(SUM([profit]))', cols)).toThrow(/can't be nested/)
    expect(() => compileMeasure('RANK(SUM([profit]))', cols)).toThrow(/computed column instead/)
    const m = compileMeasure('MAX(SUM([profit]), 1)', cols)
    expect(evalMeasure(m, ds().rows, ds().rows)).toBe(45)
  })
})

describe('KPI periods (B4, B5, F9)', () => {
  it('skips a trailing partial period in comparisons', () => {
    const rows = [...Array.from({ length: 60 }, (_, i) => ({ d: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10), v: '1' }))]
    const d = makeDataset(rows) // Jan 1 → Feb 29: complete Jan + complete Feb
    const k1 = runKpi(d, { id: 'k', type: 'kpi', title: '', size: 'xs', dimension: 'd', bucket: 'month', measures: [{ id: 'm', agg: 'count' }] })
    expect(k1.partial).toBeUndefined()
    const d2 = makeDataset([...rows, ...Array.from({ length: 5 }, (_, i) => ({ d: `2024-03-0${i + 1}`, v: '1' }))])
    const k2 = runKpi(d2, { id: 'k', type: 'kpi', title: '', size: 'xs', dimension: 'd', bucket: 'month', measures: [{ id: 'm', agg: 'count' }] })
    expect(k2.partial).toBe('Mar 2024')
    expect(k2.deltaLabel).toBe('Feb 2024 vs Jan 2024')
  })
  it('judges period completeness on the whole dataset, not the filtered rows', () => {
    // the last rainy day is before Dec 31, but December 2015 is complete in the data
    const k = runKpi(sw, { id: 'k', type: 'kpi', title: '', size: 'xs', dimension: 'date', bucket: 'month', measures: [{ id: 'm', agg: 'count' }] }, [{ id: 'f', column: 'weather', values: ['rain'] }])
    expect(k.partial).toBeUndefined()
    expect(k.deltaLabel).toBe('Dec 2015 vs Nov 2015')
  })
  it('averages snapshot measures in suggested charts that are not split by time', () => {
    const ws = suggest(gm).widgets
    const bar = ws.find((w) => (w.type === 'bar' || w.type === 'hbar') && w.measures[0]?.column === 'pop')!
    expect(bar.measures[0].agg).toBe('avg')
  })
  it('keeps forecasts of non-negative series at or above zero', () => {
    const f = forecast([0, 30, 0, 0, 25, 0, 0, 40, 0, 0, 35, 0, 0, 30, 0, 0, 20, 0, 0, 45, 0, 0, 30, 0], 12, 12)!
    expect(Math.min(...f.lower, ...f.forecast)).toBeGreaterThanOrEqual(0)
  })
  it('latest-period mode shows snapshot measures without summing across time', () => {
    const k = runKpi(gm, { id: 'k', type: 'kpi', title: '', size: 'xs', dimension: 'year', kpiMode: 'latest', measures: [{ id: 'm', column: 'pop', agg: 'sum' }] })
    expect(k.period).toBe('2005')
    // 2005 world population across the 63 countries, not 39B summed over every year
    expect(k.value!).toBeGreaterThan(4e9)
    expect(k.value!).toBeLessThan(6e9)
    const s = suggest(gm).widgets.find((w) => w.type === 'kpi' && w.measures[0]?.column === 'pop')!
    expect(s.kpiMode).toBe('latest')
  })
  it('compares year over year', () => {
    const k = runKpi(sw, { id: 'k', type: 'kpi', title: '', size: 'xs', dimension: 'date', bucket: 'month', compare: 'yoy', measures: [{ id: 'm', agg: 'count' }] })
    expect(k.deltaLabel).toBe('Dec 2015 vs Dec 2014')
  })
  it('adds a previous-year comparison series to time charts', () => {
    const g = runGrouped(sw, { id: 'w', type: 'line', title: '', size: 'md', dimension: 'date', bucket: 'month', compare: 'yoy', measures: [{ id: 'm', column: 'temp_max', agg: 'avg' }] })
    expect(g.series.map((s) => s.name)).toEqual(['Average of Temp max', 'Previous year'])
    expect(g.series[1].values.slice(0, 12).every((v) => v == null)).toBe(true)
    expect(g.series[1].values[12]).toBeCloseTo(g.series[0].values[0]!)
  })
})

describe('cross-filtering and drill-down (F5)', () => {
  it('maps a clicked category to a filter', () => {
    const b = buildChart(sw, { id: 'w', type: 'bar', title: '', size: 'md', dimension: 'weather', measures: [{ id: 'm', agg: 'count' }] }, [], TOKENS.light)
    expect(b.interact!.filterAt!(0, 0)).toEqual({ column: 'weather', values: ['rain'] })
    const t = buildChart(sw, { id: 'w', type: 'line', title: '', size: 'md', dimension: 'date', bucket: 'year', measures: [{ id: 'm', agg: 'count' }] }, [], TOKENS.light)
    const f = t.interact!.filterAt!(1, 0)!
    expect([new Date(f.min!).toISOString().slice(0, 10), new Date(f.max!).toISOString().slice(0, 10)]).toEqual(['2013-01-01', '2013-12-31'])
    expect(filteredRows(sw, [{ id: 'x', ...f }])).toHaveLength(365)
  })
  it('drills from year to quarter and applies the drill stack', () => {
    const w: Widget = { id: 'w', type: 'bar', title: '', size: 'md', dimension: 'date', bucket: 'year', measures: [{ id: 'm', agg: 'count' }] }
    const level = buildChart(sw, w, [], TOKENS.light).interact!.drillAt!(0)!
    expect(level.bucket).toBe('quarter')
    const g = runGrouped(sw, { ...w, drill: [level] })
    expect(g.categories).toEqual(['Q1 2012', 'Q2 2012', 'Q3 2012', 'Q4 2012'])
  })
  it('drills a category into the drill-to dimension', () => {
    const w: Widget = { id: 'w', type: 'bar', title: '', size: 'md', dimension: 'Symbol', drillTo: 'Date', measures: [{ id: 'm', column: 'Price', agg: 'avg' }] }
    const b = buildChart(st, w, [], TOKENS.light)
    const level = b.interact!.drillAt!(0)!
    expect(level.dimension).toBe('Date')
    const g = runGrouped(st, { ...w, drill: [level] })
    expect(g.isTime).toBe(true)
  })
})

describe('forecasting (F16)', () => {
  it('captures seasonality and trend', () => {
    const y = Array.from({ length: 48 }, (_, i) => 100 + i * 2 + 20 * Math.sin((2 * Math.PI * i) / 12))
    const f = forecast(y, 12, 12)!
    expect(f.method).toBe('holt-winters')
    const truth = Array.from({ length: 12 }, (_, h) => 100 + (48 + h) * 2 + 20 * Math.sin((2 * Math.PI * (48 + h)) / 12))
    const mae = truth.reduce((a, v, i) => a + Math.abs(v - f.forecast[i]), 0) / 12
    expect(mae).toBeLessThan(6)
    expect(f.upper[11] - f.lower[11]).toBeGreaterThan(f.upper[0] - f.lower[0])
    expect(seasonalProfile(y, 12)!.strength).toBeGreaterThan(0.9)
  })
  it('falls back to trend for short series and flags anomalies', () => {
    const y = [10, 11, 12, 13, 14, 60, 16, 17, 18, 19, 20, 21]
    expect(forecast(y, 3)!.method).toBe('holt')
    expect(anomalies(y)).toContain(5)
    expect(forecast([1, 2], 3)).toBeNull()
  })
  it('renders a forecast band on time charts', () => {
    const b = buildChart(sw, { id: 'w', type: 'line', title: 't', size: 'md', dimension: 'date', bucket: 'month', forecast: 6, measures: [{ id: 'm', column: 'temp_max', agg: 'avg' }] }, [], TOKENS.light)
    const names = (b.option.series as { name: string }[]).map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining(['Forecast', '__band']))
    expect(((b.option.xAxis as { data: string[] }).data).at(-1)).toBe('Jun 2016')
  })
})

describe('natural-language questions (F18)', () => {
  const ok = (q: string, ds: Dataset) => {
    const r = ask(q, ds)
    if (!r.ok) throw new Error(`“${q}”: ${r.message}`)
    return r
  }
  it('aggregation by a dimension with a date window', () => {
    const r = ok('average price by symbol since 2005', st)
    expect(r.widget).toMatchObject({ type: 'bar', dimension: 'Symbol', measures: [{ column: 'Price', agg: 'avg' }] })
    expect(new Date(r.widget.filters![0].min!).getUTCFullYear()).toBe(2005)
    expect(r.reading).toEqual(['Average of Price', 'by Symbol', 'Date from 2005'])
  })
  it('time series with buckets and splits', () => {
    const r = ok('monthly average temp max by weather', sw)
    expect(r.widget).toMatchObject({ type: 'line', dimension: 'date', bucket: 'month', series: 'weather' })
  })
  it('counts, top N and values as filters', () => {
    expect(ok('how many days per weather', sw).widget).toMatchObject({ dimension: 'weather', measures: [{ agg: 'count' }] })
    const top = ok('top 3 symbols by max price', st).widget
    expect(top).toMatchObject({ limit: 3, sort: 'value-desc', measures: [{ agg: 'max', column: 'Price' }] })
    const f = ok('total precipitation by month excluding sun', sw).widget
    expect(f.filters![0]).toMatchObject({ column: 'weather', values: ['sun'], exclude: true })
  })
  it('numeric comparisons, chart words and special charts', () => {
    expect(ok('count of days where wind over 6 by weather', sw).widget.filters![0]).toMatchObject({ column: 'wind' })
    expect(ok('share of days by weather', sw).widget.type).toBe('donut')
    expect(ok('temp max vs temp min', sw).widget).toMatchObject({ type: 'scatter', y: 'temp_max', x: 'temp_min' })
    expect(ok('distribution of wind', sw).widget).toMatchObject({ type: 'histogram', x: 'wind' })
    expect(ok('life expect by country on a map', gm).widget).toMatchObject({ type: 'map', geo: 'world', dimension: 'country' })
    expect(ok('total precipitation', sw).widget.type).toBe('kpi')
  })
  it('explains when it cannot match anything', () => {
    const r = ask('banana smoothie recipes', sw)
    expect(r.ok).toBe(false)
  })
})

describe('saved views (F28)', () => {
  it('tells which view is showing, ignoring ids, order and inactive filters', async () => {
    const { sameFilters } = await import('../../src/lib/aggregate')
    const a = [{ id: '1', column: 'weather', values: ['rain'] }, { id: '2', column: 'wind', min: 5 }]
    const b = [{ id: 'x', column: 'wind', min: 5 }, { id: 'y', column: 'weather', values: ['rain'] }, { id: 'z', column: 'date' }]
    expect(sameFilters(a, b)).toBe(true)
    expect(sameFilters(a, [a[0]])).toBe(false)
    expect(sameFilters([], [{ id: 'q', column: 'date' }])).toBe(true)
    // relative date ranges are nested objects: they must still tell views apart (R3)
    const rel = (last: number) => [{ id: 'r', column: 'date', relative: { last, unit: 'month' as const, calendar: true } }]
    expect(sameFilters(rel(1), rel(3))).toBe(false)
    expect(sameFilters(rel(3), [{ id: 's', column: 'date', relative: { calendar: true, unit: 'month' as const, last: 3 } }])).toBe(true)
  })
})

describe('dashboard export / import (F3)', () => {
  it('round-trips onto the same dataset and remaps by column name', () => {
    const page = { id: 'p1', name: 'Main', filters: [{ id: 'f', column: 'weather', values: ['rain'] }], widgets: suggest(sw).widgets, views: [{ id: 'v', name: 'Windy', filters: [{ id: 'g', column: 'wind', min: 5 }] }] }
    const dash = { datasetId: sw.id, pages: [page], activePage: 'p1' }
    const swm = { ...sw, model: { ...emptyModel(), computed: [{ key: 'calc_r', name: 'Range', formula: '[temp_max] - [temp_min]' }] } }
    const json = JSON.parse(JSON.stringify(exportDashboard(swm, dash)))
    const same = planImport(json, swm)
    expect(same.unmatched).toEqual([])
    expect(same.dashboard.pages[0].widgets).toHaveLength(page.widgets.length)
    expect(same.model.computed).toHaveLength(1)
    // a renamed copy of the data: keys differ, names match
    const renamed = makeDataset(sw.rows.slice(0, 50).map((r) => ({ Date: new Date(r.date as number).toISOString().slice(0, 10), Precipitation: r.precipitation, 'Temp max': r.temp_max, 'Temp min': r.temp_min, Wind: r.wind, Weather: r.weather })))
    const other = planImport(json, renamed)
    expect(other.unmatched).toEqual([])
    expect(other.dashboard.pages[0].filters[0].column).toBe('Weather')
    // saved views travel with the dashboard, remapped like page filters (F28)
    expect(other.dashboard.pages[0].views).toMatchObject([{ name: 'Windy', filters: [{ column: 'Wind', min: 5 }] }])
    expect(() => planImport({ hello: 1 }, sw)).toThrow(/not a Numero dashboard/)
  })
  it('exports formatted rows including computed columns', () => {
    const rows = exportRows(sw, sw.rows.slice(0, 1))
    expect(rows[0]).toEqual(['Jan 1, 2012', 0, 12.8, 5, 4.7, 'drizzle'])
  })
})

describe('geo detection (F17)', () => {
  it('finds countries, states and coordinates', async () => {
    expect(detectGeo(col(gm, 'country'), gm.rows)).toBe('world')
    expect(resolveRegion('United States', 'world')).toBe('United States of America')
    expect(resolveRegion('tx', 'usa')).toBe('Texas')
    const ap = await loadDataset('us-airports.csv')
    expect(detectGeo(col(ap, 'state'), ap.rows)).toBe('usa')
    expect(detectLatLon(ap.columns, ap.rows)).toEqual({ lat: 'latitude', lon: 'longitude' })
    expect(detectGeo(col(sw, 'weather'), sw.rows)).toBeNull()
  })
  it('builds choropleth and point maps', async () => {
    const m = buildChart(gm, { id: 'w', type: 'map', title: '', size: 'lg', geo: 'world', dimension: 'country', measures: [{ id: 'm', column: 'life_expect', agg: 'avg' }] }, [], TOKENS.light)
    expect(m.map).toBe('world')
    expect(m.note).toMatch(/not on the map/)
    const ap = await loadDataset('us-airports.csv')
    const p = buildChart(ap, { id: 'w', type: 'points', title: '', size: 'lg', geo: 'usa', x: 'longitude', y: 'latitude', measures: [] }, [], TOKENS.light)
    expect(p.empty).toBeFalsy()
  })
})

describe('formatting (F12, B15)', () => {
  const c = (over: object) => ({ key: 'x', name: 'x', type: 'number', detected: 'number', distinct: 0, missing: 0, ...over }) as never
  it('applies decimals, prefix/suffix, compact and the two percent modes', () => {
    expect(fmtNumber(1234567, c({ display: { compact: false } }))).toBe('1,234,567')
    expect(fmtNumber(1234567, c({}))).toBe('1.2M')
    expect(fmtNumber(3.14159, c({ display: { decimals: 3 } }))).toBe('3.142')
    expect(fmtNumber(0.256, c({ format: 'ratio' }))).toBe('25.6%')
    expect(fmtNumber(25.6, c({ format: 'percent' }))).toBe('25.6%')
    expect(fmtNumber(42, c({ display: { prefix: '≈', suffix: ' kg' } }))).toBe('≈42 kg')
    expect(fmtNumber(-5, c({ format: 'currency', currency: '€' }))).toBe('-€5')
    expect(fmtNumber(5, c({}), { format: { num: 'currency', currency: '¥' } })).toBe('¥5')
  })
  it('formats dates with a display pattern', () => {
    const d = { ...col(sw, 'date'), display: { datePattern: 'DD/MM/YYYY' } }
    expect(fmtValue(sw.rows[0].date, d)).toBe('01/01/2012')
  })
})

describe('renaming columns in formulas (B11)', () => {
  it('rewrites bracketed and bare references but not strings or functions', () => {
    const defs = [
      { key: 'a', name: 'A', formula: '[Revenue] * 2 + Revenue - SUM(revenue)' },
      { key: 'b', name: 'B', formula: 'IF(CONTAINS([Notes], "Revenue"), 1, 0)' },
      { key: 'c', name: 'C', formula: 'revenue_key + 1' },
    ]
    const out = renameRefs(defs, 'Revenue', 'Net Revenue', 'revenue_key')
    expect(out[0].formula).toBe('[Net Revenue] * 2 + [Net Revenue] - SUM([Net Revenue])')
    expect(out[1].formula).toBe('IF(CONTAINS([Notes], "Revenue"), 1, 0)')
    expect(out[2].formula).toBe('revenue_key + 1')
    expect(renameRefs([{ key: 'x', name: 'X', formula: 'Sales*2' }], 'Sales', 'Units')[0].formula).toBe('Units*2')
  })
})
