import { describe, expect, it } from 'vitest'
import { CSV_BOM, neutralizeFormula, toCsv } from '../../src/lib/csv'
import { exportXlsx } from '../../src/lib/share'
import { parseFile } from '../../src/lib/parse'
import { makeDataset } from './helpers'

describe('R9 CSV export opens correctly in Excel', () => {
  it('starts with a byte-order mark so non-ASCII text survives a double-click', async () => {
    const csv = toCsv(['Stadt', 'Notiz'], [['München', 'Größe ✓'], ['東京', '日本語']])
    expect(csv.startsWith(CSV_BOM)).toBe(true)
    // as bytes: EF BB BF first
    expect([...new TextEncoder().encode(csv).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    // and it reads back unchanged, the mark removed
    const back = await parseFile(new File([csv], 'round.csv'))
    expect(back.sheets[0].headers).toEqual(['Stadt', 'Notiz'])
    expect(back.sheets[0].rows).toEqual([{ Stadt: 'München', Notiz: 'Größe ✓' }, { Stadt: '東京', Notiz: '日本語' }])
  })
  it('a text cell that would run as a formula is written as text', () => {
    expect(neutralizeFormula('=1+1')).toBe("'=1+1")
    expect(neutralizeFormula('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(neutralizeFormula('+cmd|calc')).toBe("'+cmd|calc")
    expect(neutralizeFormula('-2+3')).toBe("'-2+3")
    expect(neutralizeFormula('\t=1+1')).toBe("'\t=1+1")
    const csv = toCsv(['a', 'b'], [['=1+1', 2], ['=HYPERLINK("http://x","y")', 3]], { bom: false })
    expect(csv).toBe(`a,b\n'=1+1,2\n"'=HYPERLINK(""http://x"",""y"")",3`)
  })
  it('real numbers are untouched, whether stored as numbers or shown as formatted text', () => {
    expect(toCsv(['n'], [[-5], [3.5], [0]], { bom: false })).toBe('n\n-5\n3.5\n0')
    for (const s of ['-5', '+3.2', '-12.5%', '-$1,200.50', '-1.2M', 'plain', 'a=b', '2024-01-15']) expect(neutralizeFormula(s), s).toBe(s)
  })
  it('keeps quoting, blanks and booleans as before', () => {
    expect(toCsv(['a,b', 'c'], [['x "y"', null], [true, 'line\nbreak']], { bom: false })).toBe('"a,b",c\n"x ""y""",\ntrue,"line\nbreak"')
  })
  it('the Excel export stores such a cell as text, with no formula', async () => {
    const ds = { ...makeDataset([{ note: '=1+1', n: '2' }, { note: 'ok', n: '3' }, { note: '+cmd', n: '4' }]), name: 'x' }
    const XLSX = await import('xlsx')
    const wb = XLSX.read(await (await exportXlsx(ds)).arrayBuffer(), { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    expect(ws.A2).toMatchObject({ t: 's', v: '=1+1' })
    expect(ws.A2.f).toBeUndefined()
    expect(ws.B2).toMatchObject({ t: 'n', v: 2 })
  })
})
