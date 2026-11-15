import { describe, expect, it } from 'vitest'
import { buildChart } from '../../src/lib/chartOptions'
import { groupExtras } from '../../src/lib/aggregate'
import { defaultAgg } from '../../src/lib/suggest'
import { TOKENS } from '../../src/lib/palette'
import type { Widget } from '../../src/types'
import { makeDataset } from './helpers'

const ds = makeDataset([
  { month: '2025-01-15', stage: 'Visit', region: 'North', amount: '100' },
  { month: '2025-01-20', stage: 'Visit', region: 'South', amount: '50' },
  { month: '2025-02-15', stage: 'Visit', region: 'North', amount: '80' },
  { month: '2025-02-16', stage: 'Cart', region: 'East', amount: '-30' },
  { month: '2025-03-15', stage: 'Cart', region: 'East', amount: '120' },
  { month: '2025-03-16', stage: 'Buy', region: 'West', amount: '10' },
])
const W = (p: Partial<Widget>): Widget => ({ id: 'w', title: 'T', size: 'md', type: 'bar', measures: [{ id: 'm', column: 'amount', agg: 'sum' }], ...p })
const build = (w: Widget) => buildChart(ds, w, [], TOKENS.light)

describe('waterfall, pareto and funnel (F29)', () => {
  it('waterfall over categories adds up to a total', () => {
    const b = build(W({ type: 'waterfall', dimension: 'region', sort: 'label-asc' }))
    expect(b.table.rows).toEqual([['East', 90, 90], ['North', 180, 270], ['South', 50, 320], ['West', 10, 330], ['Total', null, 330]])
  })
  it('waterfall over time starts at the first level and shows each change', () => {
    const b = build(W({ type: 'waterfall', dimension: 'month', bucket: 'month' }))
    expect(b.table.rows).toEqual([['Jan 2025', null, 150], ['Feb 2025', -100, 50], ['Mar 2025', 80, 130]])
    expect(b.interact!.filterAt!(1, 0)).toMatchObject({ column: 'month' })
  })
  it('pareto sorts largest first and accumulates to 100%, leaving out negatives', () => {
    const b = build(W({ type: 'pareto', dimension: 'region' }))
    expect(b.table.rows.map((r) => r[0])).toEqual(['North', 'East', 'South', 'West'])
    expect(b.table.rows.at(-1)![3]).toBe(100)
    expect(b.note).toMatch(/2 of 4 categories make up 80%/)
  })
  it('funnel shows conversion from the first and previous stage', () => {
    const b = build(W({ type: 'funnel', dimension: 'stage', measures: [{ id: 'm', agg: 'count' }] }))
    expect(b.table.rows).toEqual([['Visit', 3, 100, null], ['Cart', 2, 66.67, 66.67], ['Buy', 1, 33.33, 50]])
  })
})

describe('tooltip fields on grouped charts (N9a)', () => {
  it('aggregates numbers, picks the latest date and the most common category per bar', () => {
    const w = W({ type: 'bar', dimension: 'stage', tooltipFields: ['amount', 'month', 'region'] })
    const ex = groupExtras(ds, w, [], w.tooltipFields!, defaultAgg)
    expect(ex.get('Visit')).toEqual([['Sum of Amount', '230'], ['Latest Month', 'Feb 15, 2025'], ['Region', 'North (+1 more)']])
    expect(ex.get('Buy')).toEqual([['Sum of Amount', '10'], ['Latest Month', 'Mar 16, 2025'], ['Region', 'West']])
  })
})
