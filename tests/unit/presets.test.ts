import { describe, expect, it } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { PRESETS } from '../../src/lib/presets'
import { SAMPLES as SAMPLE_LIST } from '../../src/lib/samples'
import { buildDataset, emptyModel } from '../../src/lib/model'
import { colMap, missingColumns, runGrouped, runKpi } from '../../src/lib/aggregate'
import { buildChart } from '../../src/lib/chartOptions'
import { renderText } from '../../src/lib/text'
import { runCohort } from '../../src/lib/cohort'
import { TOKENS } from '../../src/lib/palette'
import type { Dataset, DatasetModel } from '../../src/types'
import { parseSample, SAMPLES } from './helpers'

async function loadWithPreset(file: string) {
  const preset = PRESETS[file]
  const sources: Record<string, { name: string; headers: string[]; rows: never[] }> = {}
  for (const req of preset.requires ?? []) {
    const p = await parseSample(req)
    sources[`id:${req}`] = { name: req.replace(/\.[^.]+$/, ''), headers: p.sheets[0].headers, rows: p.sheets[0].rows as never[] }
  }
  const p = await parseSample(file)
  const model: DatasetModel = { ...emptyModel(), ...preset.model?.({ idOf: (f) => `id:${f}` }) }
  const built = buildDataset({ headers: p.sheets[0].headers, rows: p.sheets[0].rows }, model, (id) => sources[id])
  const ds: Dataset = { id: file, name: file, fileName: file, format: p.format, createdAt: 0, rowCount: built.rows.length, columnCount: built.columns.length, source: { kind: 'sample' }, model, columns: built.columns, rows: built.rows }
  return { ds, built, preset }
}

describe('sample showcase presets', () => {
  it('every sample file is listed, and every listed sample exists', () => {
    const files = readdirSync(SAMPLES).filter((f) => !f.startsWith('.') && statSync(`${SAMPLES}/${f}`).isFile())
    expect(SAMPLE_LIST.map((s) => s.file).sort()).toEqual(files.sort())
  })

  for (const file of Object.keys(PRESETS)) {
    it(`${file}: prep, formulas and every widget work`, async () => {
      const { ds, built, preset } = await loadWithPreset(file)
      expect(built.reports.filter((r) => r.error), JSON.stringify(built.reports)).toEqual([])
      expect(ds.columns.filter((c) => c.formulaError).map((c) => `${c.name}: ${c.formulaError}`)).toEqual([])
      const cols = colMap(ds)
      for (const pg of preset.pages(ds)) {
        for (const w of pg.widgets) {
          const label = `${file} › ${pg.name} › ${w.title}`
          expect(missingColumns(w, cols), label).toEqual([])
          if (w.type === 'text') {
            const spans = renderText(ds, w, pg.filters).flatMap((b) => (b.kind === 'ul' ? b.items.flat() : b.spans))
            expect(spans.filter((x) => x.missing).map((x) => x.text), label).toEqual([])
          } else if (w.type === 'cohort') {
            const c = runCohort(ds, w, pg.filters)
            expect(c?.cohorts.length, label).toBeGreaterThan(1)
          } else if (w.type === 'kpi') {
            const k = runKpi(ds, w, pg.filters)
            expect(k.value, label).not.toBeNull()
          } else if (w.type === 'table') {
            expect(runGrouped(ds, w, pg.filters).categories.length, label).toBeGreaterThan(0)
          } else {
            const b = buildChart(ds, w, pg.filters, TOKENS.light)
            expect(b.empty, label).toBeFalsy()
            // annotations must land on real categories, or they silently disappear
            const cats = runGrouped(ds, { ...w, forecast: undefined, compare: 'none', facet: undefined }, pg.filters).categories
            for (const band of w.bands ?? []) expect([cats.includes(band.from), cats.includes(band.to)], `${label} band ${band.from}–${band.to}`).toEqual([true, true])
            for (const n of w.notes ?? []) expect(cats, `${label} note`).toContain(n.at)
          }
        }
        // every page fills complete 12-column rows
        const span = { xs: 3, sm: 4, md: 6, lg: 8, full: 12 }
        let row = 0
        for (const w of pg.widgets) { row += span[w.size]; expect(row, `${file} › ${pg.name}: "${w.title}" overflows its row`).toBeLessThanOrEqual(12); if (row === 12) row = 0 }
        expect(row, `${file} › ${pg.name}: last row not full`).toBe(0)
      }
    })
  }

  it('cleans the messy coffee file', async () => {
    const { ds, built } = await loadWithPreset('coffee-chain-sales.csv')
    const stores = new Set(ds.rows.map((r) => r.Store))
    expect([...stores].sort()).toHaveLength(9)
    expect(ds.rows.some((r) => r.Product === 'TEST ITEM')).toBe(false)
    expect(ds.rows.some((r) => r.Channel == null)).toBe(false)
    expect(built.reports.map((r) => r.summary).join(' | ')).toMatch(/Removed \d+ duplicates/)
    expect(ds.columns.find((c) => c.key === 'Unit Price')).toMatchObject({ type: 'number', format: 'currency' })
  })

  it('the online store shows a funnel and month-by-month retention', async () => {
    const { ds, preset } = await loadWithPreset('online-store-events.csv')
    const ws = preset.pages(ds)[0].widgets
    const funnel = buildChart(ds, ws.find((w) => w.type === 'funnel')!, [], TOKENS.light)
    expect(funnel.table.rows.map((r) => r[0])).toEqual(['1 Visit', '2 Product view', '3 Add to cart', '4 Checkout', '5 Purchase'])
    // each step keeps fewer sessions than the one before
    expect(funnel.table.rows.every((r, i, a) => i === 0 || (r[1] as number) < (a[i - 1][1] as number))).toBe(true)
    const cohort = runCohort(ds, ws.find((w) => w.type === 'cohort')!)!
    expect(cohort.cohorts).toHaveLength(12)
    expect(cohort.cohorts[0].active[0]).toBe(cohort.cohorts[0].size)
    // retention fades: month 1 keeps more of January's customers than month 6
    expect(cohort.cohorts[0].active[1]!).toBeGreaterThan(cohort.cohorts[0].active[6]!)
  })

  it('joins flights to airports and unpivots employment', async () => {
    const f = await loadWithPreset('us-flights-2001.json')
    expect(f.ds.rows.every((r) => r.state != null)).toBe(true)
    const e = await loadWithPreset('us-employment-by-sector.csv')
    expect(e.ds.columns.map((c) => c.name)).toEqual(['Month', 'Sector', 'Jobs (thousands)'])
    expect(new Set(e.ds.rows.map((r) => r.Sector)).size).toBe(14)
    expect(e.ds.rows.some((r) => r.Sector === 'Education And Health Services')).toBe(true)
  })

  it('drops the movies with impossible future release dates', async () => {
    const { ds } = await loadWithPreset('movies.json')
    expect(Math.max(...ds.rows.map((r) => r['Release Date'] as number))).toBeLessThanOrEqual(Date.UTC(2010, 11, 31))
  })
})
