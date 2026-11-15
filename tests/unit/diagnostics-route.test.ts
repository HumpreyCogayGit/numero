import { beforeEach, describe, expect, it } from 'vitest'
import { buildDiagnostics, clearErrors, recentErrors, recordError, redact } from '../../src/lib/diagnostics'
import { formatRoute, HOME, parseRoute, sameRoute, sameView } from '../../src/lib/route'

describe('crash diagnostics', () => {
  beforeEach(() => clearErrors())
  const state = { datasets: 3, tab: 'dashboard', active: { rows: 18870, columns: 12, types: { number: 4, category: 6, date: 1, boolean: 1 }, format: 'csv', sourceKind: 'file', prepSteps: 2, computed: 1, measures: 2, pages: 3, widgets: { kpi: 4, line: 2 } } }
  it('describes the situation by counts and types', () => {
    const text = buildDiagnostics(state, { error: recordError('render', new TypeError('x is undefined')), version: '0.1.0', userAgent: 'TestBrowser/1', url: 'http://localhost/#/d/ds_abc/data', now: 0 })
    expect(text).toContain('Time: 1970-01-01T00:00:00.000Z')
    expect(text).toContain('Datasets stored: 3')
    expect(text).toContain('Open dataset: 18,870 rows × 12 columns (4 number, 6 category, 1 date, 1 boolean), csv from file')
    expect(text).toContain('[render] TypeError: x is undefined')
    // the dataset id in the address is left out
    expect(text).toContain('Page: http://localhost/')
    expect(text).not.toContain('ds_abc')
  })
  it('carries no imported values: quoted text in messages is cut out', () => {
    recordError('promise', new Error('Could not group by “Acme Corp Ltd” in column "Customer Name"'))
    const text = buildDiagnostics(state)
    expect(text).not.toContain('Acme')
    expect(text).not.toContain('Customer Name')
    expect(text).toContain('Could not group by “…” in column “…”')
    expect(text).toContain('No imported values, column names or dataset names are included.')
    expect(redact('value "42" failed')).toBe('value “…” failed')
  })
  it('keeps the most recent errors only, and accepts non-Error rejections', () => {
    for (let i = 0; i < 30; i++) recordError('promise', `plain ${i}`)
    expect(recentErrors()).toHaveLength(20)
    expect(recentErrors().at(-1)!.message).toBe('plain 29')
    expect(recordError('promise', { code: 7 }).message).toBe('{"code":7}')
    expect(buildDiagnostics({ datasets: 0 })).toContain('Open dataset: none')
  })
})

describe('R10 the view lives in the URL', () => {
  it('round-trips dataset, tab and page', () => {
    for (const r of [HOME, { dataset: 'ds_1', tab: 'dashboard' as const }, { dataset: 'ds_1', tab: 'dashboard' as const, page: 'p_2' }, { dataset: 'ds 1/x', tab: 'pivot' as const }]) {
      expect(parseRoute(formatRoute(r))).toEqual(r)
    }
    expect(formatRoute(HOME)).toBe('#/')
    expect(formatRoute({ dataset: 'ds_1', tab: 'data' })).toBe('#/d/ds_1/data')
    expect(formatRoute({ dataset: 'ds_1', tab: 'dashboard', page: 'p_2' })).toBe('#/d/ds_1/dashboard/p_2')
  })
  it('anything unreadable is Home; an unknown tab falls back to the dashboard', () => {
    for (const h of ['', '#', '#/', '#/x/y', '#/d', '#main', '#/d/']) expect(parseRoute(h), h).toEqual(HOME)
    expect(parseRoute('#/d/ds_1/nonsense')).toEqual({ dataset: 'ds_1', tab: 'dashboard' })
    expect(parseRoute('#/d/ds_1/data/p_9')).toEqual({ dataset: 'ds_1', tab: 'data' })
    expect(parseRoute('#/d/%E0%A4%A')).toEqual({ dataset: '%E0%A4%A', tab: 'dashboard' })
  })
  it('compares routes; a page becoming known is the same view', () => {
    expect(sameRoute({ dataset: 'a', tab: 'data' }, { dataset: 'a', tab: 'data' })).toBe(true)
    expect(sameRoute({ dataset: 'a', tab: 'data' }, { dataset: 'a', tab: 'pivot' })).toBe(false)
    expect(sameView({ dataset: 'a', tab: 'dashboard' }, { dataset: 'a', tab: 'dashboard', page: 'p1' })).toBe(true)
    expect(sameView({ dataset: 'a', tab: 'dashboard', page: 'p2' }, { dataset: 'a', tab: 'dashboard', page: 'p1' })).toBe(false)
  })
})
