import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findInsights, INSIGHT_SAMPLE, topInsights } from '../../src/lib/profile'
import { defaultAgg, rankMeasures, suggest } from '../../src/lib/suggest'
import { hasInsights, renderText } from '../../src/lib/text'
import { SAMPLES, loadDataset, makeDataset } from './helpers'

const files = readdirSync(SAMPLES).filter((x) => /\.(csv|json|xlsx|xls)$/.test(x)).sort()

describe('R8 insights match the dashboard', () => {
  it.each(files)('%s: time insights name the dashboard’s first measure with the same aggregate', async (f) => {
    const ds = await loadDataset(f)
    const primary = rankMeasures(ds)[0]
    const timeInsights = findInsights(ds).filter((i) => ['trend', 'extreme', 'seasonal', 'anomaly'].includes(i.kind))
    if (!primary) { expect(timeInsights).toEqual([]); return }
    const word = defaultAgg(primary) === 'sum' ? 'total' : 'average'
    for (const i of timeInsights) {
      expect(i.columns[1], i.title).toBe(primary.key)
      expect(i.title.toLowerCase(), i.title).toContain(`${word} ${primary.name.toLowerCase()}`)
    }
    // …and it is the measure of the dashboard's first KPI and trend chart
    const s = suggest(ds).widgets
    const kpi = s.filter((w) => w.type === 'kpi')[1]
    expect(kpi?.measures[0]).toMatchObject({ column: primary.key, agg: defaultAgg(primary) })
    const trend = s.find((w) => (w.type === 'line' || w.type === 'area') && w.measures[0]?.column)
    if (trend) expect(trend.measures[0]).toMatchObject({ column: primary.key, agg: defaultAgg(primary) })
  })
  it('an additive measure is totalled per period, not averaged', () => {
    const rows = Array.from({ length: 240 }, (_, i) => ({ day: `2023-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`, revenue: String(100 + (i % 12) * 40 + (i % 7)), score: String(50 + (i % 9)) }))
    const ins = findInsights(makeDataset(rows))
    const trend = ins.find((i) => i.kind === 'trend')!
    expect(trend.title).toBe('Total Revenue trends upward')
    expect(trend.detail).toMatch(/^Total Revenue per (week|month) rose/)
    expect(trend.detail).not.toMatch(/Average/)
  })
  it('near-identical pairs are not reported as correlations', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ net: String(i * 3 + (i % 4)), gross: String((i * 3 + (i % 4)) * 1.2), other: String((i * 17) % 23) }))
    const pairs = findInsights(makeDataset(rows)).filter((i) => i.kind === 'correlation')
    expect(pairs.some((p) => p.columns.includes('net') && p.columns.includes('gross'))).toBe(false)
  })
  it('a peak is reported only when it stands out from the other periods', () => {
    const flat = Array.from({ length: 120 }, (_, i) => ({ day: `2023-${String((i % 12) + 1).padStart(2, '0')}-10`, sales: String(100 + (i % 3)) }))
    expect(findInsights(makeDataset(flat)).some((i) => i.kind === 'extreme')).toBe(false)
    const spiky = flat.map((r, i) => (r.day.startsWith('2023-07') ? { ...r, sales: String(900 + i) } : r))
    const peak = findInsights(makeDataset(spiky)).find((i) => i.kind === 'extreme')
    expect(peak?.title).toMatch(/^Peak total Sales: .*Jul.*2023$/)
  })
  it('every finding says what it rests on, without certainty or cause claims', async () => {
    for (const f of ['seattle-weather.csv', 'coffee-chain-sales.csv', 'cars.json']) {
      const ds = await loadDataset(f)
      const ins = findInsights(ds)
      expect(ins.length, f).toBeGreaterThan(0)
      for (const i of ins) {
        expect(i.basis, `${f}: ${i.title}`).toBeTruthy()
        expect(i.nature, i.title).toMatch(/^(descriptive|model)$/)
        expect(`${i.title} ${i.detail} ${i.basis}`).not.toMatch(/\b(will|proves?|because of|caused by|guarantee|certainly|definitely)\b/i)
      }
    }
  })
  it('the explanation follows the filters and marks a truncated import', async () => {
    const ds = await loadDataset('seattle-weather.csv')
    const all = findInsights(ds).find((i) => i.kind === 'outliers' || i.kind === 'skew')!
    expect(all.basis).toContain('1,461 rows')
    const rainy = findInsights(ds, [{ id: 'f', column: 'weather', values: ['rain'] }])
    const one = rainy.find((i) => i.basis?.includes('matching 1 filter'))
    expect(one).toBeTruthy()
    expect(one!.basis).not.toContain('1,461 rows')
    const cut = findInsights({ ...ds, source: { kind: 'file', truncated: true, rowLimit: 1461 } })
    expect(cut.find((i) => i.kind === 'trend' || i.kind === 'seasonal')!.basis).toContain('the import stopped at a row limit')
  })
  it('the suggested dashboard carries the top findings as a live text widget', async () => {
    const ds = await loadDataset('seattle-weather.csv')
    const w = suggest(ds).widgets.find((x) => x.type === 'text')!
    expect(hasInsights(w)).toBe(true)
    const blocks = renderText(ds, w, [])
    expect(blocks[0]).toMatchObject({ kind: 'h2' })
    const list = blocks.find((b) => b.kind === 'ul')!
    const top = topInsights(ds)
    expect(list.kind === 'ul' && list.items.map((it) => it[0].text)).toEqual(top.map((i) => i.title))
    // filters change what it says
    const filtered = renderText(ds, w, [{ id: 'f', column: 'weather', values: ['snow'] }])
    expect(JSON.stringify(filtered)).not.toBe(JSON.stringify(blocks))
  })
  it('large data: distribution findings use an even sample and the whole thing stays quick', () => {
    const n = INSIGHT_SAMPLE + 100_000
    const rows = Array.from({ length: n }, (_, i) => ({ g: ['a', 'b', 'c'][i % 3], v: (i * 7919) % 1000, w: (i * 104729) % 577, t: Date.UTC(2020, 0, 1) + (i % 1000) * 864e5 }))
    const ds = { rows, columns: [
      { key: 'g', name: 'G', type: 'category' as const, detected: 'category' as const, distinct: 3, missing: 0 },
      { key: 'v', name: 'V', type: 'number' as const, detected: 'number' as const, format: 'integer' as const, distinct: 1000, missing: 0, range: [0, 999] as [number, number] },
      { key: 'w', name: 'W', type: 'number' as const, detected: 'number' as const, format: 'integer' as const, distinct: 577, missing: 0, range: [0, 576] as [number, number] },
      { key: 't', name: 'T', type: 'date' as const, detected: 'date' as const, grain: 'day' as const, distinct: 1000, missing: 0 },
    ] }
    const t0 = performance.now()
    const ins = findInsights(ds)
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(4000)
    expect(ins.every((i) => !i.basis || !i.basis.includes('NaN'))).toBe(true)
  })
})
