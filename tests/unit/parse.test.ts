import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { CHUNK_BYTES, FileTooLargeError, ImportCancelled, UnsupportedFileError, explainJsonError, explainReadError, formatOf, lastRowBreak, parseFile, parseText, raggedReport, sniffBinary } from '../../src/lib/parse'

const bytes = (...b: number[]) => new Uint8Array(b)
const file = (parts: BlobPart[], name: string) => new File(parts, name)
const rejects = async (f: File) => parseFile(f).then(() => { throw new Error(`${f.name} was accepted`) }, (e: Error) => e)

describe('R3 files that are not tables are refused', () => {
  it('a PDF never becomes a one-column table, whatever it is called', async () => {
    const pdf = '%PDF-1.7\n%âãÏÓ\n1 0 obj\n<< /Type /Catalog >>\nendobj\n'
    for (const name of ['report.pdf', 'report.csv', 'report', 'report.txt']) {
      const e = await rejects(file([pdf], name))
      expect(e, name).toBeInstanceOf(UnsupportedFileError)
      expect(e.message).toMatch(/PDF/)
      // the message names what can be read
      expect(e.message).toMatch(/CSV or TSV text, JSON, and Excel/)
    }
  })
  it('recognises images, archives and other binary signatures', () => {
    expect(sniffBinary(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe('an image')
    expect(sniffBinary(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('an image')
    expect(sniffBinary(bytes(0x50, 0x4b, 0x03, 0x04))).toMatch(/ZIP/)
    expect(sniffBinary(bytes(0x50, 0x41, 0x52, 0x31))).toMatch(/Parquet/)
  })
  it('refuses unsigned binary data by its control characters, and a ZIP renamed to .csv', async () => {
    const noise = new Uint8Array(2000).map((_, i) => (i * 7) % 32)
    expect(sniffBinary(noise)).toBe('a binary file')
    expect(await rejects(file([noise], 'dump.csv'))).toBeInstanceOf(UnsupportedFileError)
    expect((await rejects(file([bytes(0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0)], 'archive.csv'))).message).toMatch(/ZIP archive or Office document/)
    expect((await rejects(file(['hello'], 'photo.png'))).message).toMatch(/an image/)
  })
  it('lets text through: plain, tabs and line breaks, UTF-16 with a byte-order mark, unknown extensions', async () => {
    expect(sniffBinary(new TextEncoder().encode('a,b\r\n1,2\n\tx'))).toBeNull()
    expect(sniffBinary(bytes(0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00))).toBeNull()
    const utf16 = new Uint8Array([0xff, 0xfe, ...[...'a,b\n1,2\n'].flatMap((c) => [c.charCodeAt(0), 0])])
    const p = await parseFile(file([utf16], 'wide.csv'))
    expect(p.detected.encoding).toBe('utf-16le')
    expect(p.sheets[0].rows).toEqual([{ a: '1', b: '2' }])
    expect((await parseFile(file(['a,b\n1,2\n'], 'export.dat'))).sheets[0].headers).toEqual(['a', 'b'])
    expect((await parseFile(file(['a,b\n1,2\n'], 'noextension'))).format).toBe('csv')
  })
  it('a damaged workbook is explained, not shown as an engine error', async () => {
    const e = await rejects(file([bytes(1, 2, 3, 4, 5, 6, 7, 8)], 'broken.xlsx'))
    expect(e.message).toMatch(/could not be read as a spreadsheet|No sheets with data/)
  })
  it('maps extensions, including the newly accepted ones', () => {
    expect(formatOf('a.ods')).toBe('xlsx')
    expect(formatOf('a.xlsb')).toBe('xlsx')
    expect(formatOf('a.jsonl')).toBe('json')
    expect(formatOf('a.csv.gz')).toBe('csv')
    expect(formatOf('a.pdf')).toBeNull()
  })
})

describe('R3 ragged rows are counted, and the rows imported stay the same', () => {
  it('reports rows longer and shorter than the header, with examples', async () => {
    const p = await parseText('a,b\n1,2,3,4\n5,6\n7\n8,9\n')
    const s = p.sheets[0]
    expect(s.ragged).toMatchObject({ expected: 2, long: 1, short: 1 })
    expect(s.ragged!.examples).toEqual([{ row: 2, cells: 4, text: '1,2,3,4' }, { row: 4, cells: 1, text: '7' }])
    // exactly what was imported before: extra cells dropped, missing ones blank
    expect(s.rows).toEqual([{ a: '1', b: '2' }, { a: '5', b: '6' }, { a: '7', b: null }, { a: '8', b: '9' }])
  })
  it('a delimiter at the end of every line is not a difference, and a clean file reports nothing', async () => {
    expect((await parseText('a,b,\n1,2,\n3,4,\n')).sheets[0].ragged).toBeUndefined()
    expect((await parseText('a,b\n1,2\n3,4\n')).sheets[0].ragged).toBeUndefined()
    expect(raggedReport([['1', '2', ''], ['1', '2']], 2)).toBeUndefined()
  })
})

describe('R3 JSON errors say what is wrong and where', () => {
  it('malformed JSON names the line and the problem, without the engine wording', async () => {
    const e = await rejects(file(['[\n  {"a": 1},\n  {"a": 2 "b": 3}\n]'], 'bad.json'))
    expect(e.message).toMatch(/^bad\.json can’t be read as JSON — line 3, column \d+: a comma or a closing } is missing\.$/)
    expect(e.message).not.toMatch(/position|in JSON at/)
  })
  it('a file cut off part-way is described as such', async () => {
    const e = await rejects(file(['[{"a": 1}, {"a": 2'], 'cut.json'))
    expect(e.message).toMatch(/the text stops before the data is complete/)
    expect(explainJsonError('{"a":', new SyntaxError('Unexpected end of JSON input'))).toMatch(/^line 1, column 6: /)
  })
  it('NDJSON names the first bad line', async () => {
    const e = await rejects(file(['{"a":1}\n{"a":2}\n{"a":3,}\n{"a":4}\n{oops}\n'], 'events.ndjson'))
    expect(e.message).toMatch(/^events\.ndjson can’t be read: line 3 is not valid JSON/)
    // and when the file is called .json but holds one value per line
    const e2 = await rejects(file(['{"a":1}\n{"a" 2}\n'], 'events.json'))
    expect(e2.message).toMatch(/line 2 is not valid JSON/)
  })
  it('good NDJSON and JSON still load', async () => {
    expect((await parseFile(file(['{"a":1}\n\n{"a":2}\n'], 'ok.ndjson'))).sheets[0].rows).toEqual([{ a: 1 }, { a: 2 }])
    expect((await parseFile(file(['{"a":1}\n{"a":2}\n'], 'ok.json'))).sheets[0].rows).toHaveLength(2)
    expect((await parseFile(file(['[{"a":1}]'], 'ok.json'))).sheets[0].rows).toEqual([{ a: 1 }])
  })
})

describe('R4 CSV is read in pieces', () => {
  const big = (rows: number) => {
    const lines = ['id,name,note']
    for (let i = 0; i < rows; i++) lines.push(`${i},"item ${i}","line one\nline two, with ""quotes"" ${'x'.repeat(40)}"`)
    return lines.join('\n') + '\n'
  }
  it('a row limit stops the read early: the first 1,000 rows of a large file do not read the whole file', async () => {
    const text = big(200_000)
    const f = file([text], 'big.csv')
    expect(f.size).toBeGreaterThan(CHUNK_BYTES * 3)
    const p = await parseFile(f, { rowLimit: 1000 })
    expect(p.sheets[0].rows).toHaveLength(1000)
    expect(p.sheets[0].truncated).toBe(true)
    expect(p.bytesRead).toBe(CHUNK_BYTES)
    expect(p.sheets[0].rows[999]).toMatchObject({ id: '999', name: 'item 999' })
  })
  it('rows that span a piece boundary (quoted line breaks, multi-byte characters) come out whole', async () => {
    const lines = ['id,city,note']
    for (let i = 0; i < 120_000; i++) lines.push(`${i},"Zürich ✓ ${i}","first\nsecond ""q"" ${'é'.repeat(30)}"`)
    const text = lines.join('\r\n')
    const f = file([text], 'multi.csv')
    expect(f.size).toBeGreaterThan(CHUNK_BYTES * 2)
    const p = await parseFile(f)
    const rows = p.sheets[0].rows
    expect(rows).toHaveLength(120_000)
    expect(p.sheets[0].ragged).toBeUndefined()
    expect(p.bytesRead).toBe(f.size)
    for (const i of [0, 40_000, 80_000, 119_999]) expect(rows[i]).toEqual({ id: String(i), city: `Zürich ✓ ${i}`, note: `first\nsecond "q" ${'é'.repeat(30)}` })
  })
  it('finds row breaks outside quoted fields only', () => {
    expect(lastRowBreak('a,b\n1,2\n3,"x')).toBe(8)
    expect(lastRowBreak('a,b\n1,"x\ny"\n3,"z\nw')).toBe(12)
    expect(lastRowBreak('no break here')).toBe(0)
    expect(lastRowBreak('"all\nquoted')).toBe(0)
  })
  it('can be cancelled between pieces', async () => {
    let calls = 0
    const p = parseFile(file([big(200_000)], 'big.csv'), {}, undefined, { cancelled: () => ++calls > 2 })
    await expect(p).rejects.toBeInstanceOf(ImportCancelled)
  })
  it('falls back to Windows-1252 when the text is not UTF-8, also past the first piece', async () => {
    const head = new TextEncoder().encode('city,n\n' + 'Oslo,1\n'.repeat(700_000))
    const tail = new Uint8Array([0x4d, 0xfc, 0x6e, 0x63, 0x68, 0x65, 0x6e, 0x2c, 0x32, 0x0a]) // "München,2" in Latin-1
    const f = file([head, tail], 'latin.csv')
    expect(f.size).toBeGreaterThan(CHUNK_BYTES)
    const p = await parseFile(f)
    expect(p.detected.encoding).toBe('windows-1252')
    expect(p.sheets[0].rows.at(-1)).toEqual({ city: 'München', n: '2' })
    expect(p.sheets[0].rows).toHaveLength(700_001)
  })
  it('keeps detecting delimiters, header rows, skipped rows and exact limits', async () => {
    const p = await parseText('title row\nx;y\n1;2\n3;4\n5;6\n', 'semi.csv', { skipRows: 1, rowLimit: 2, delimiter: ';' })
    expect((await parseText('x;y\n1;2\n3;4\n', 'semi.csv')).detected.delimiter).toBe(';')
    expect(p.sheets[0]).toMatchObject({ headers: ['x', 'y'], rows: [{ x: '1', y: '2' }, { x: '3', y: '4' }], truncated: true })
    const all = await parseText('x,y\n1,2\n3,4\n', 'c.csv', { rowLimit: 2 })
    expect(all.sheets[0].truncated).toBe(false)
    expect((await parseText('a\tb\n1\t2\n', 'p.txt')).format).toBe('tsv')
    await expect(parseText('', 'empty.csv')).rejects.toThrow(/appears to be empty/)
  })
  it('out-of-memory failures suggest a row limit', () => {
    const e = explainReadError(new RangeError('Invalid string length'), 'huge.csv')
    expect(e).toBeInstanceOf(FileTooLargeError)
    expect(e.message).toMatch(/huge\.csv is too large .* row limit/)
    expect(explainReadError(new Error('Array buffer allocation failed'), 'x.csv')).toBeInstanceOf(FileTooLargeError)
    const plain = new Error('The file appears to be empty.')
    expect(explainReadError(plain, 'x.csv')).toBe(plain)
  })
})

describe('R11 gzipped text', () => {
  it('reads .csv.gz and .json.gz', async () => {
    const csv = await parseFile(file([gzipSync('a,b\n1,2\n3,4\n')], 'data.csv.gz'))
    expect(csv.sheets[0].rows).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }])
    expect(csv.fileName).toBe('data.csv')
    const json = await parseFile(file([gzipSync('[{"a":1}]')], 'data.json.gz'))
    expect(json.sheets[0].rows).toEqual([{ a: 1 }])
  })
})

describe('R11 more spreadsheet formats', () => {
  it.each(['ods', 'xlsb'] as const)('reads .%s workbooks', async (bookType) => {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['city', 'sales'], ['Oslo', 10], ['Rome', 12.5]]), 'Data')
    const bytes = XLSX.write(wb, { type: 'array', bookType }) as ArrayBuffer
    const p = await parseFile(new File([bytes], `book.${bookType}`))
    expect(p.format).toBe('xlsx')
    expect(p.sheets[0].headers).toEqual(['city', 'sales'])
    expect(p.sheets[0].rows).toEqual([{ city: 'Oslo', sales: 10 }, { city: 'Rome', sales: 12.5 }])
  })
})
