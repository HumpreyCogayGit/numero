import { describe, expect, it } from 'vitest'
import { suggest } from '../../src/lib/suggest'
import { ask } from '../../src/lib/ask'
import type { AskOk } from '../../src/lib/ask'
import { loadDataset } from './helpers'

describe('suggestions and questions know the newer chart types (N2)', () => {
  it('the online store gets a funnel and a cohort on its suggested dashboard; the gallery offers Pareto, waterfall and a heading', async () => {
    const ds = await loadDataset('online-store-events.csv')
    const s = suggest(ds)
    expect(s.widgets.find((w) => w.type === 'funnel')).toMatchObject({ dimension: 'Stage', sort: 'label-asc' })
    expect(s.widgets.find((w) => w.type === 'cohort')).toMatchObject({ dimension: 'Event Date', entity: 'Customer ID', bucket: 'month' })
    expect(s.extra.map((w) => w.type).slice(0, 3)).toEqual(expect.arrayContaining(['text', 'waterfall']))
    // long-tailed categories get a Pareto (coffee: 11 products by revenue)
    const coffee = suggest(await loadDataset('coffee-chain-sales.csv'))
    expect(coffee.extra.find((w) => w.type === 'pareto')).toBeTruthy()
  })
  it('no funnel or cohort where the data has no stages or repeating IDs', async () => {
    for (const f of ['seattle-weather.csv', 'penguins.csv', 'cars.json']) {
      const types = suggest(await loadDataset(f)).widgets.map((w) => w.type)
      expect(types, f).not.toContain('funnel')
      expect(types, f).not.toContain('cohort')
    }
  })
  it('waterfall periods follow the length of the history; levels that are averaged get none', async () => {
    const sw = await loadDataset('seattle-weather.csv')
    expect(suggest(sw).extra.find((w) => w.type === 'waterfall' && w.dimension === 'date')?.bucket).toBe('quarter')
    const co2 = await loadDataset('co2-mauna-loa.csv')
    expect(suggest(co2).extra.some((w) => w.type === 'waterfall')).toBe(false)
  })
  it('the Ask bar builds funnels, Pareto charts, waterfalls and cohorts', async () => {
    const ds = await loadDataset('online-store-events.csv')
    const ok = (q: string) => { const r = ask(q, ds); expect(r.ok, q).toBe(true); return (r as AskOk).widget }
    expect(ok('funnel')).toMatchObject({ type: 'funnel', dimension: 'Stage', sort: 'label-asc' })
    expect(ok('pareto of revenue by country')).toMatchObject({ type: 'pareto', dimension: 'Country' })
    expect(ok('revenue contribution by channel')).toMatchObject({ type: 'waterfall', dimension: 'Channel' })
    expect(ok('monthly revenue waterfall')).toMatchObject({ type: 'waterfall', dimension: 'Event Date' })
    expect(ok('customer retention by quarter')).toMatchObject({ type: 'cohort', entity: 'Customer ID', bucket: 'quarter', size: 'full' })
    // "conversion rate" is a measure name, not a funnel request
    expect(ok('conversion rate by channel').type).not.toBe('funnel')
  })
})
