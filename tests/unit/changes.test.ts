import { describe, expect, it } from 'vitest'
import { whatChanged, isQuiet } from '../../src/lib/changes'
import { compareHeaders, mergeRows } from '../../src/lib/update'
import { buildDataset, emptyModel } from '../../src/lib/model'
import { PRESETS } from '../../src/lib/presets'
import type { Dataset, DatasetModel, Page, RawRow } from '../../src/types'
import { makeDataset, parseSample } from './helpers'

describe('what changed after an update', () => {
  it('reports KPI moves, movers, new values and outliers for the coffee July append', async () => {
    const base = await parseSample('coffee-chain-sales.csv')
    const july = await parseSample('updates/coffee-chain-sales-2025-07.csv')
    const model: DatasetModel = { ...emptyModel(), ...PRESETS['coffee-chain-sales.csv'].model!({ idOf: () => undefined }) }
    const build = (headers: string[], rows: RawRow[]): Dataset => {
      const b = buildDataset({ headers, rows }, model)
      return { id: 'c', name: 'c', fileName: 'c', format: 'csv', createdAt: 0, rowCount: b.rows.length, columnCount: b.columns.length, source: { kind: 'sample' }, model, columns: b.columns, rows: b.rows }
    }
    const before = build(base.sheets[0].headers, base.sheets[0].rows)
    const check = compareHeaders(base.sheets[0].headers, july.sheets[0].headers)
    const merged = mergeRows(base.sheets[0].headers, base.sheets[0].rows, july.sheets[0].headers, july.sheets[0].rows, {
      mode: 'append', mapping: Object.fromEntries(check.matched.map((m) => [m.old, m.incoming])), dedupe: { enabled: true, keys: ['Order ID'] },
    })
    const after = build(merged.headers, merged.rows)
    const pages = PRESETS['coffee-chain-sales.csv'].pages(after).map((p, i) => ({ ...p, id: `p${i}` })) as Page[]
    const r = whatChanged(before, after, pages, 'july.csv', 0)
    expect(r.period).toMatchObject({ label: 'Jul 2025', previous: 'Jun 2025', partial: false })
    expect(r.kpis.length).toBeGreaterThan(2)
    expect(r.kpis.every((k) => k.before !== k.after || k.change === 0)).toBe(true)
    expect(r.movers.length).toBeGreaterThan(0)
    expect(r.movers.every((m, i, a) => i === 0 || Math.abs(a[i - 1].change) >= Math.abs(m.change))).toBe(true)
  })

  it('finds a new category value, an outlier and a crossed target', () => {
    const rows = (n: number, month: number, extra: Record<string, unknown>[] = []) => [
      ...Array.from({ length: n }, (_, i) => ({ day: `2025-${String(month).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, store: i % 2 ? 'A' : 'B', amount: String(10 + (i % 7)) })),
      ...extra,
    ]
    const oldRows = [1, 2, 3, 4, 5, 6].flatMap((m) => rows(40, m))
    const before = makeDataset(oldRows)
    const after = makeDataset([...oldRows, ...rows(40, 7, [{ day: '2025-07-15', store: 'C', amount: '900' }, { day: '2025-07-31', store: 'A', amount: '12' }])])
    const kpi = { id: 'k', type: 'kpi' as const, title: 'Total', size: 'xs' as const, measures: [{ id: 'm', column: 'amount', agg: 'sum' as const }], target: before.rows.reduce((a, r) => a + (r.amount as number), 0) + 100 }
    const r = whatChanged(before, after, [{ id: 'p', name: 'P', widgets: [kpi], filters: [] }], 'x.csv', 0)
    expect(r.newValues).toEqual([{ column: 'Store', values: ['C'], more: 0 }])
    expect(r.outliers).toMatchObject([{ column: 'Amount', count: 1, highest: '900' }])
    expect(r.kpis[0].crossed).toBe('reached')
    expect(r.movers[0]).toMatchObject({ value: 'C' })
    // a period that stops before its end is partial: no movers until it's complete
    const partial = whatChanged(before, makeDataset([...oldRows, ...rows(40, 7)]), [], 'x.csv', 0)
    expect([partial.period?.partial, partial.movers]).toEqual([true, []])
    // the same data again has nothing to report
    expect(isQuiet(whatChanged(before, before, [], 'same', 0))).toBe(true)
  })
})
