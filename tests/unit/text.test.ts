import { describe, expect, it } from 'vitest'
import { parseText, renderText, resolvePlaceholder } from '../../src/lib/text'
import type { Widget } from '../../src/types'
import { loadDataset, makeDataset } from './helpers'

describe('text widgets', () => {
  it('parses headings, bullets, paragraphs and emphasis', () => {
    const b = parseText('# Title {x}\n\nSome **bold** and *it*\ncontinued\n\n- one\n- two {nope}', (n) => (n === 'x' ? '42' : undefined))
    expect(b.map((x) => x.kind)).toEqual(['h1', 'p', 'ul'])
    expect(b[0]).toEqual({ kind: 'h1', spans: [{ text: 'Title ' }, { text: '42', value: true }] })
    expect(b[1]).toEqual({ kind: 'p', spans: [{ text: 'Some ' }, { text: 'bold', bold: true }, { text: ' and ' }, { text: 'it', italic: true }, { text: ' continued' }] })
    expect(b[2].kind === 'ul' && b[2].items[1]).toEqual([{ text: 'two ' }, { text: '{nope}', missing: true }])
    // emphasis may wrap placeholders
    expect(parseText('**{x}** sold, **{x} more**', () => '7')[0]).toEqual({ kind: 'p', spans: [{ text: '7', value: true, bold: true }, { text: ' sold, ' }, { text: '7', value: true, bold: true }, { text: ' more', bold: true }] })
  })

  it('fills placeholders from columns, measures and dates', async () => {
    const ds = await loadDataset('seattle-weather.csv')
    const rows = ds.rows
    expect(resolvePlaceholder('rows', ds, rows)).toBe('1,461')
    expect(resolvePlaceholder('latest month', ds, rows)).toBe('Dec 2015')
    expect(resolvePlaceholder('first date', ds, rows)).toBe('Jan 1, 2012')
    expect(resolvePlaceholder('latest year', ds, rows)).toBe('2015')
    expect(resolvePlaceholder('max temp_max', ds, rows)).toBe('35.6')
    expect(resolvePlaceholder('count distinct weather', ds, rows)).toBe('5')
    expect(resolvePlaceholder('Weather', ds, rows)).toBe('5')
    expect(resolvePlaceholder('no such thing', ds, rows)).toBeUndefined()
    // an exact column name beats an aggregate prefix (R4)
    const temps = makeDataset([{ Temp: '1', 'Max Temp': '50' }, { Temp: '2', 'Max Temp': '60' }])
    expect(resolvePlaceholder('Max Temp', temps, temps.rows)).not.toBe('2')
    expect(resolvePlaceholder('max Temp', temps, temps.rows)).not.toBe('2')
    expect(resolvePlaceholder('max Max Temp', temps, temps.rows)).toBe('60')
    const blanks = makeDataset([{ a: '1' }, { a: '' }, { a: '2' }])
    expect(resolvePlaceholder('count a', blanks, blanks.rows)).toBe('2')
    const m = makeDataset([{ a: '1' }, { a: '3' }])
    m.model.measures = [{ key: 'm_x', name: 'Double', formula: 'SUM([a]) * 2' }]
    expect(resolvePlaceholder('double', m, m.rows)).toBe('8')
  })

  it('share-of-total measures see the page rows as "all", not only the widget-filtered ones (R12)', () => {
    const ds = makeDataset([{ g: 'a', x: '1' }, { g: 'b', x: '3' }])
    ds.model.measures = [{ key: 'm_share', name: 'Share', formula: 'SUM([x]) / SUM_ALL([x])', format: 'ratio' }]
    const w: Widget = { id: 't', type: 'text', title: '', size: 'full', measures: [], text: '{Share}', filters: [{ id: 'f', column: 'g', values: ['b'] }] }
    const [p] = renderText(ds, w, [])
    expect(p.kind === 'p' && p.spans[0].text).toBe('75%')
  })

  it('values follow page and widget filters, including relative dates', async () => {
    const ds = await loadDataset('seattle-weather.csv')
    const w: Widget = { id: 't', type: 'text', title: '', size: 'full', measures: [], text: '{rows} days through {latest date}', filters: [{ id: 'f', column: 'date', relative: { last: 1, unit: 'month', calendar: true } }] }
    const [p] = renderText(ds, w, [{ id: 'g', column: 'weather', values: ['sun'] }])
    expect(p.kind === 'p' && p.spans.map((s) => s.text).join('')).toMatch(/^\d+ days through Dec \d+, 2015$/)
  })
})
