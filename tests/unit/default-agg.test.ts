import { describe, expect, it } from 'vitest'
import { defaultAgg, nameAgg, suggest } from '../../src/lib/suggest'
import type { Column } from '../../src/types'
import { col, makeDataset } from './helpers'

const num = (key: string, extra: Partial<Column> = {}): Column => ({ key, name: key, type: 'number', detected: 'number', format: 'decimal', distinct: 100, missing: 0, ...extra })

describe('R2 default aggregation reads whole words', () => {
  it('no longer matches inside other words', () => {
    // "count" in discount / country, "per" in operating / experience, "age" in usage / mileage / postage
    for (const k of ['discount', 'country', 'operating', 'experience', 'usage', 'mileage', 'postage']) expect(nameAgg(k), k).toBeUndefined()
    expect(nameAgg('operating_cost')).toBe('sum')
    expect(nameAgg('Operating Income')).toBe('sum')
    expect(nameAgg('dataUsage')).toBeUndefined()
  })
  it('still recognises the words themselves, in any naming style', () => {
    for (const k of ['count', 'order_count', 'OrderCount', 'Total Sales', 'units sold', 'Revenue', 'gross']) expect(nameAgg(k), k).toBe('sum')
    for (const k of ['age', 'Age', 'price_per_unit', 'milesPerGallon', 'Avg Sales', 'conversion rate', 'rating', 'temp_max', 'bill_length_mm', 'body_mass_g', 'Unit Price']) expect(nameAgg(k), k).toBe('avg')
  })
  it('adds the common additive names that were missing', () => {
    for (const k of ['tax', 'fee', 'fees', 'shipping', 'tip', 'hours', 'minutes', 'duration', 'distance', 'discount amount', 'Discount_Amount', 'salary', 'payroll']) {
      expect(defaultAgg(num(k)), k).toBe('sum')
    }
  })
  it('an explicit average or rate wins over an additive word; "total" wins over a measurement word', () => {
    expect(nameAgg('avg_revenue')).toBe('avg')
    expect(nameAgg('tax rate')).toBe('avg')
    expect(nameAgg('cost per unit')).toBe('avg')
    expect(nameAgg('total price')).toBe('sum')
  })
  it('falls back on format, then on the values', () => {
    expect(defaultAgg(num('x', { format: 'currency' }))).toBe('sum')
    expect(defaultAgg(num('x', { format: 'percent' }))).toBe('avg')
    // bounded in 0–1 or 0–100: a share or a score
    expect(defaultAgg(num('x', { range: [0, 1] }))).toBe('avg')
    expect(defaultAgg(num('x', { format: 'integer', range: [0, 100] }))).toBe('avg')
    // whole, non-negative, many different values, reaching toward zero: a count
    expect(defaultAgg(num('x', { format: 'integer', range: [0, 5400] }))).toBe('sum')
    // whole numbers in a narrow band are a level (monthly headcount), negatives a balance or change
    expect(defaultAgg(num('x', { format: 'integer', range: [129726, 143093] }))).toBe('avg')
    expect(defaultAgg(num('x', { format: 'integer', range: [-50, 5400] }))).toBe('avg')
    expect(defaultAgg(num('x', { format: 'integer', range: [0, 5400], distinct: 6 }))).toBe('avg')
    expect(defaultAgg(num('x'))).toBe('avg')
  })
  it('the first KPI row shows totals for additive columns and names the aggregate in every title', () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({
      day: `2024-0${(i % 9) + 1}-1${i % 9}`, region: ['N', 'S', 'E', 'W'][i % 4],
      tax: String(3 + (i % 17) * 1.25), discount: String(((i * 7) % 30) / 100), usage: String(i * 37 % 4000), rating: String((i % 5) + 1),
    }))
    const ds = makeDataset(rows)
    expect(defaultAgg(col(ds, 'tax'))).toBe('sum')
    expect(defaultAgg(col(ds, 'discount'))).toBe('avg')
    expect(defaultAgg(col(ds, 'usage'))).toBe('sum')
    const kpis = suggest(ds).widgets.filter((w) => w.type === 'kpi')
    for (const k of kpis.slice(1)) expect(k.title).toMatch(/^(Sum|Average) of /)
    expect(kpis.map((k) => k.title)).toContain('Sum of Tax')
    expect(kpis.map((k) => k.title)).not.toContain('Sum of Discount')
  })
})
