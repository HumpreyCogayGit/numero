import Papa from 'papaparse'
import type { FileFormat, ImportOptions, RawRow, RawValue } from '../types'

/** Rows whose number of cells differs from the header's. They are imported as before; this only reports them. */
export interface RaggedReport {
  /** cells the header row has */
  expected: number
  /** rows with more cells than the header: the extra cells are not imported */
  long: number
  /** rows with fewer cells than the header: the missing cells are blank */
  short: number
  /** the first few, with their row number in the file (1 = the first line) */
  examples: { row: number; cells: number; text: string }[]
}

export interface ParsedSheet { name: string; headers: string[]; rows: RawRow[]; truncated?: boolean; ragged?: RaggedReport }
export interface ParsedFile {
  fileName: string
  format: FileFormat
  /** one entry per sheet (CSV/JSON always have exactly one) */
  sheets: ParsedSheet[]
  /** what detection settled on, so the import preview can show it */
  detected: { delimiter?: string; encoding?: string }
  /** bytes actually read from the file: less than its size when a row limit stopped the read early */
  bytesRead?: number
}

export type Progress = (fraction: number, label: string) => void
/** Lets a long read be stopped between chunks. */
export interface ParseControl { cancelled?: () => boolean }

export const ACCEPT = '.csv,.tsv,.txt,.json,.ndjson,.jsonl,.xlsx,.xls,.xlsm,.xlsb,.ods,.gz'
export const SUPPORTED = 'CSV or TSV text, JSON, and Excel or OpenDocument spreadsheets (.xlsx, .xls, .xlsb, .ods)'

/** Above this size a local file is offered a row-limited import first (see startImport). */
export const LARGE_FILE_BYTES = 200 * 1024 * 1024
/** JSON and workbooks have to be read in one piece; text that large is beyond what a browser string can hold. */
export const MAX_WHOLE_FILE_BYTES = 500 * 1024 * 1024
/** CSV is read from the file in pieces of this size. */
export const CHUNK_BYTES = 4 * 1024 * 1024

export class UnsupportedFileError extends Error {
  constructor(what: string) {
    super(`${what} Numero reads ${SUPPORTED}.`)
    this.name = 'UnsupportedFileError'
  }
}
export class ImportCancelled extends Error {
  constructor() { super('Import cancelled.'); this.name = 'ImportCancelled' }
}
export class FileTooLargeError extends Error {
  constructor(message: string) { super(message); this.name = 'FileTooLargeError' }
}

const WORKBOOK_EXT = new Set(['xlsx', 'xlsm', 'xlsb', 'ods'])
const TEXT_EXT = new Set(['csv', 'txt', 'dat', 'log', 'text', 'psv'])
/** extensions that are certainly not tables, named so the message can say what the file is */
const KNOWN_OTHER: Record<string, string> = {
  pdf: 'a PDF', doc: 'a Word document', docx: 'a Word document', ppt: 'a presentation', pptx: 'a presentation', zip: 'a ZIP archive', rar: 'an archive', '7z': 'an archive',
  png: 'an image', jpg: 'an image', jpeg: 'an image', gif: 'an image', webp: 'an image', bmp: 'an image', heic: 'an image', svg: 'an image',
  mp3: 'an audio file', wav: 'an audio file', mp4: 'a video', mov: 'a video', exe: 'a program', dmg: 'a disk image', parquet: 'a Parquet file', sqlite: 'a database file', db: 'a database file',
}

const extOf = (fileName: string) => (fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '')

/** The format an extension stands for; null when the extension says nothing (the content then decides). */
export const formatOf = (fileName: string): FileFormat | null => {
  const ext = extOf(fileName.replace(/\.gz$/i, ''))
  if (ext === 'xls') return 'xls'
  if (WORKBOOK_EXT.has(ext)) return 'xlsx'
  if (ext === 'json' || ext === 'ndjson' || ext === 'jsonl') return 'json'
  if (ext === 'tsv' || ext === 'tab') return 'tsv'
  if (TEXT_EXT.has(ext)) return 'csv'
  return null
}

const SIGNATURES: [number[], string][] = [
  [[0x25, 0x50, 0x44, 0x46], 'a PDF'],
  [[0x89, 0x50, 0x4e, 0x47], 'an image'],
  [[0xff, 0xd8, 0xff], 'an image'],
  [[0x47, 0x49, 0x46, 0x38], 'an image'],
  [[0x42, 0x4d], 'an image'],
  [[0x52, 0x49, 0x46, 0x46], 'a media file'],
  [[0x50, 0x4b, 0x03, 0x04], 'a ZIP archive or Office document'],
  [[0x50, 0x4b, 0x05, 0x06], 'a ZIP archive'],
  [[0xd0, 0xcf, 0x11, 0xe0], 'an older Office document'],
  [[0x37, 0x7a, 0xbc, 0xaf], 'an archive'],
  [[0x52, 0x61, 0x72, 0x21], 'an archive'],
  [[0x50, 0x41, 0x52, 0x31], 'a Parquet file'],
  [[0x53, 0x51, 0x4c, 0x69, 0x74, 0x65], 'a database file'],
  [[0x7f, 0x45, 0x4c, 0x46], 'a program'],
  [[0x4d, 0x5a, 0x90, 0x00], 'a program'],
  [[0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], 'a video'],
  [[0x49, 0x44, 0x33], 'an audio file'],
]
const startsWith = (bytes: Uint8Array, sig: number[]) => sig.every((b, i) => bytes[i] === b)
const isGzip = (bytes: Uint8Array) => bytes[0] === 0x1f && bytes[1] === 0x8b

/**
 * What the first bytes of a file say it is, when that is not text: a known binary signature, or too many
 * control characters for a table. Returns null for text (UTF-16 with a byte-order mark included).
 */
export function sniffBinary(bytes: Uint8Array): string | null {
  for (const [sig, what] of SIGNATURES) if (startsWith(bytes, sig)) return what
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return null
  const n = Math.min(bytes.length, 4096)
  if (!n) return null
  let control = 0
  for (let i = 0; i < n; i++) { const b = bytes[i]; if (b < 9 || (b > 13 && b < 32 && b !== 27)) control++ }
  return control / n > 0.02 ? 'a binary file' : null
}

/** Engine failures that mean "too big", said in a way the user can act on. */
export function explainReadError(e: unknown, fileName: string): Error {
  const err = e instanceof Error ? e : new Error(String(e))
  if (err instanceof UnsupportedFileError || err instanceof ImportCancelled || err instanceof FileTooLargeError) return err
  if (err instanceof RangeError || /invalid string length|allocation failed|out of memory|array buffer allocation|invalid array length|NotReadableError/i.test(`${err.name} ${err.message}`)) {
    return new FileTooLargeError(`${fileName} is too large to read in one piece — the browser ran out of memory. Import it with a row limit (Rows to import → First 1,000,000), or split the file.`)
  }
  return err
}

export async function parseFile(file: File | Blob & { name: string }, options: ImportOptions = {}, onProgress?: Progress, ctl: ParseControl = {}): Promise<ParsedFile> {
  try {
    return await readAny(file, options, onProgress, ctl)
  } catch (e) {
    throw explainReadError(e, file.name)
  }
}

async function readAny(file: File | Blob & { name: string }, options: ImportOptions, onProgress: Progress | undefined, ctl: ParseControl): Promise<ParsedFile> {
  const ext = extOf(file.name)
  if (KNOWN_OTHER[ext]) throw new UnsupportedFileError(`${file.name} is ${KNOWN_OTHER[ext]}, not a table.`)
  const first = new Uint8Array(await file.slice(0, 4096).arrayBuffer())
  if (isGzip(first)) return readAny(await gunzip(file), options, onProgress, ctl)
  const fmt = formatOf(file.name)
  if (fmt === 'xlsx' || fmt === 'xls') {
    if (file.size > MAX_WHOLE_FILE_BYTES) throw new FileTooLargeError(`${file.name} is ${Math.round(file.size / 1e6).toLocaleString()} MB. A workbook has to be read in one piece, and that is more than a browser can hold — save the sheet as CSV and import that (CSV can be read with a row limit).`)
    try {
      return await parseWorkbook(await file.arrayBuffer(), file.name, fmt, options, onProgress)
    } catch (e) {
      const err = explainReadError(e, file.name)
      if (err instanceof FileTooLargeError || /No sheets with data/.test(err.message)) throw err
      throw new UnsupportedFileError(`${file.name} could not be read as a spreadsheet — it may be damaged, password-protected or another kind of file.`)
    }
  }
  // an explicit encoding is the user saying "this is text": trust it over the byte check (UTF-16 without a byte-order mark is full of zero bytes)
  const binary = options.encoding ? null : sniffBinary(first)
  if (binary) throw new UnsupportedFileError(`${file.name} looks like ${binary}, not a table.`)
  const headText = decode(first.buffer as ArrayBuffer, options.encoding).text
  const looksJson = fmt === 'json' || (!options.delimiter && /^\s*[[{]/.test(headText.slice(0, 200)))
  if (looksJson) {
    if (file.size > MAX_WHOLE_FILE_BYTES) throw new FileTooLargeError(`${file.name} is ${Math.round(file.size / 1e6).toLocaleString()} MB. JSON has to be read in one piece, and that is more than a browser can hold — convert it to CSV, which can be read with a row limit.`)
    const { text, encoding } = decode(await file.arrayBuffer(), options.encoding)
    try {
      return { ...parseJson(text, file.name, options, /\.(ndjson|jsonl)$/i.test(file.name.replace(/\.gz$/i, ''))), detected: { encoding }, bytesRead: file.size }
    } catch (e) {
      if (fmt === 'json') throw e
    }
  }
  return parseDelimited(file, fmt === 'tsv' ? 'tsv' : 'csv', options, onProgress, ctl)
}

async function gunzip(file: Blob & { name: string }): Promise<File> {
  if (typeof DecompressionStream === 'undefined') throw new UnsupportedFileError(`${file.name} is gzip-compressed and this browser cannot unpack it — unzip it first.`)
  const blob = await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).blob()
  return new File([blob], file.name.replace(/\.gz$/i, '') || 'data.csv')
}

export async function parseText(text: string, fileName = 'pasted.csv', options: ImportOptions = {}): Promise<ParsedFile> {
  return parseFile(new File([text], fileName), { ...options, encoding: 'utf-8' })
}

// ---------- encoding ----------

/** Honors an explicit encoding; otherwise BOM → strict UTF-8 → Windows-1252 (covers Latin-1 exports from Excel). */
export function decode(buf: ArrayBuffer, encoding?: string): { text: string; encoding: string } {
  const bytes = new Uint8Array(buf)
  if (encoding) return { text: new TextDecoder(encoding).decode(bytes).replace(/^\ufeff/, ''), encoding }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\ufeff/, ''), encoding: 'utf-8' }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' }
  }
}

// ---------- CSV / TSV ----------

/** Index just past the last line break that is not inside a quoted field, or 0 when the text holds no complete row. */
export function lastRowBreak(text: string): number {
  let quotes = 0
  for (let i = text.indexOf('"'); i >= 0; i = text.indexOf('"', i + 1)) quotes++
  let end = text.length
  for (;;) {
    const nl = text.lastIndexOf('\n', end - 1)
    if (nl < 0) return 0
    // quotes after this break; an even number before it means the break is between rows
    let after = 0
    for (let i = text.indexOf('"', nl + 1); i >= 0 && i < end; i = text.indexOf('"', i + 1)) after++
    quotes -= after
    if (quotes % 2 === 0) return nl + 1
    end = nl
  }
}

/**
 * Reads delimited text from the file a piece at a time. Memory follows the rows that are kept, not the file:
 * a row limit stops the read as soon as enough rows are in.
 */
async function parseDelimited(file: Blob & { name: string }, format: 'csv' | 'tsv', o: ImportOptions, onProgress?: Progress, ctl: ParseControl = {}): Promise<ParsedFile> {
  try {
    return await readDelimited(file, format, o, o.encoding, onProgress, ctl)
  } catch (e) {
    // text that turned out not to be UTF-8 part-way through: read again as Windows-1252 (Latin-1 exports from Excel)
    if (e instanceof TypeError && !o.encoding) return readDelimited(file, format, o, 'windows-1252', onProgress, ctl)
    throw e
  }
}

async function readDelimited(file: Blob & { name: string }, format: 'csv' | 'tsv', o: ImportOptions, forced: string | undefined, onProgress: Progress | undefined, ctl: ParseControl): Promise<ParsedFile> {
  const data: string[][] = []
  const limit = o.rowLimit ? o.rowLimit + (o.skipRows ?? 0) + (o.header === false ? 0 : 1) : Infinity
  let truncated = false
  let delimiter = o.delimiter || (format === 'tsv' ? '\t' : '')
  let decoder: TextDecoder | null = null
  let encoding = forced ?? 'utf-8'
  let carry = ''
  let offset = 0

  const feed = (text: string) => {
    if (!text) return
    const res = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy', delimiter })
    // the first piece settles the delimiter for the rest of the file
    if (!delimiter) delimiter = res.meta.delimiter || ','
    for (const row of res.data) {
      if (data.length >= limit) { truncated = true; return }
      data.push(row)
    }
  }

  while (offset < file.size && !truncated) {
    if (ctl.cancelled?.()) throw new ImportCancelled()
    const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer())
    if (!decoder) {
      let skip = 0
      if (!forced) {
        if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; skip = 2 } else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; skip = 2 }
      }
      // strict UTF-8 throws a TypeError on bytes that aren't: the caller then retries as Windows-1252
      decoder = new TextDecoder(encoding, { fatal: !forced && encoding === 'utf-8' })
      carry = decoder.decode(bytes.subarray(skip), { stream: true })
    } else carry += decoder.decode(bytes, { stream: true })
    offset += bytes.length
    const last = offset >= file.size
    if (last) carry += decoder.decode()
    // a stray quote inside an unquoted cell (5" pipe) leaves no "safe" break: past a few pieces, cut at the last line break anyway
    const cut = last ? carry.length : carry.length > CHUNK_BYTES * 8 ? carry.lastIndexOf('\n') + 1 : lastRowBreak(carry)
    if (cut) {
      feed(carry.slice(0, cut))
      carry = carry.slice(cut)
    }
    // rows still to come when the limit is reached inside the last piece
    if (!truncated && data.length >= limit && (!last || carry.length > 0)) truncated = true
    onProgress?.(Math.min(1, offset / Math.max(1, file.size)), `Parsed ${data.length.toLocaleString()} rows`)
  }
  if (data.length > limit) data.length = limit

  const body = data.slice(o.skipRows ?? 0)
  if (!body.length) throw new Error('The file appears to be empty.')
  const width = Math.max(...body.slice(0, 50).map((r) => r.length))
  const headers = o.header === false ? Array.from({ length: width }, (_, i) => `Column ${i + 1}`) : uniqueHeaders(body[0])
  const records = o.header === false ? body : body.slice(1)
  const firstRow = (o.skipRows ?? 0) + (o.header === false ? 1 : 2)
  const ragged = raggedReport(records, headers.length, firstRow, delimiter || ',')
  const rows = records.map((r) => {
    const obj: RawRow = {}
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = r[i] ?? null
    return obj
  })
  return {
    fileName: file.name,
    format: delimiter === '\t' ? 'tsv' : format,
    sheets: [{ name: 'Data', headers, rows, truncated, ...(ragged ? { ragged } : {}) }],
    detected: { delimiter: delimiter || ',', encoding },
    bytesRead: offset,
  }
}

/** Counts rows whose cell count differs from the header's. Trailing empty cells (a delimiter at the end of each line) are not a difference. */
export function raggedReport(records: string[][], expected: number, firstRow = 2, delimiter = ','): RaggedReport | undefined {
  let long = 0, short = 0
  const examples: RaggedReport['examples'] = []
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    if (r.length === expected) continue
    let cells = r.length
    while (cells > expected && (r[cells - 1] == null || r[cells - 1] === '')) cells--
    if (cells === expected) continue
    if (cells > expected) long++
    else short++
    if (examples.length < 5) examples.push({ row: i + firstRow, cells, text: r.join(delimiter === '\t' ? ' ⇥ ' : delimiter).slice(0, 120) })
  }
  return long || short ? { expected, long, short, examples } : undefined
}

// ---------- JSON ----------

/** Line and column (1-based) of a character position. */
function lineCol(text: string, pos: number): { line: number; column: number } {
  let line = 1, start = 0
  for (let i = text.indexOf('\n'); i >= 0 && i < pos; i = text.indexOf('\n', i + 1)) { line++; start = i + 1 }
  return { line, column: pos - start + 1 }
}

/** The engine's JSON error in plain words: what is wrong and on which line. */
export function explainJsonError(text: string, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const posM = /position (\d+)/.exec(msg)
  const lcM = /line (\d+) column (\d+)/.exec(msg)
  const body = text.trimEnd().length
  // an error at the very end of the text means the text ran out
  const ended = /Unexpected end|Unterminated|end of data/i.test(msg) || (!!posM && +posM[1] >= body)
  const at = ended ? lineCol(text, body) : lcM ? { line: +lcM[1], column: +lcM[2] } : posM ? lineCol(text, +posM[1]) : null
  const why = ended ? 'the text stops before the data is complete — the file may be cut off, or a closing bracket or quote is missing'
    : /Expected ',' or '}'/.test(msg) ? 'a comma or a closing } is missing'
      : /Expected ',' or ']'/.test(msg) ? 'a comma or a closing ] is missing'
        : /property name|Expected double-quoted/.test(msg) ? 'a name is missing or not in double quotes (often a comma left after the last item)'
          : /control character/i.test(msg) ? 'a line break or tab sits inside a quoted text'
            : /Unexpected token|Unexpected (string|number|non-whitespace)|is not valid JSON/i.test(msg) ? 'there is a character that does not belong there'
              : 'the text there is not valid JSON'
  return at ? `line ${at.line}, column ${at.column}: ${why}` : why
}

function parseJson(text: string, fileName: string, o: ImportOptions, ndjson = false): Omit<ParsedFile, 'detected'> {
  let data: unknown
  const lines = () => text.split(/\r?\n/)
  const readLines = () => {
    const out: unknown[] = []
    const all = lines()
    for (let i = 0; i < all.length; i++) {
      if (!all[i].trim()) continue
      try {
        out.push(JSON.parse(all[i]))
      } catch (e) {
        const why = explainJsonError(all[i], e).replace(/^line 1, /, '')
        throw new Error(`${fileName} can’t be read: line ${i + 1} is not valid JSON (${why}). Each line of an NDJSON file must be one complete JSON value.`)
      }
    }
    return out
  }
  if (ndjson) data = readLines()
  else {
    try {
      data = JSON.parse(text)
    } catch (e) {
      // newline-delimited JSON without the extension: the first line is a complete value by itself
      const all = lines().filter((l) => l.trim())
      let first = false
      try { first = all.length > 1 && typeof JSON.parse(all[0]) === 'object' } catch { /* not NDJSON */ }
      if (first) data = readLines()
      else throw new Error(`${fileName} can’t be read as JSON — ${explainJsonError(text, e)}.`)
    }
  }
  let records = findRecords(data)
  if (!records) throw new Error('Could not find a list of records in this JSON file.')
  let truncated = false
  if (o.rowLimit && records.length > o.rowLimit) { records = records.slice(0, o.rowLimit); truncated = true }
  const rows = records.map((r) => flatten(r))
  const headerSet = new Set<string>()
  rows.forEach((r) => Object.keys(r).forEach((k) => headerSet.add(k)))
  return { fileName, format: 'json', sheets: [{ name: 'Data', headers: [...headerSet], rows, truncated }] }
}

/** Accepts an array of objects, an object wrapping one ({data: [...]}), column arrays, or a keyed map. */
function findRecords(data: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(data)) {
    if (!data.length) return []
    if (data.every((d) => d && typeof d === 'object' && !Array.isArray(d))) return data as Record<string, unknown>[]
    if (Array.isArray(data[0])) {
      const [head, ...body] = data as unknown[][]
      const headers = uniqueHeaders(head.map(String))
      return body.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])))
    }
    return data.map((v) => ({ value: v }))
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    let best: Record<string, unknown>[] | null = null
    for (const v of Object.values(obj)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
        if (!best || v.length > best.length) best = v as Record<string, unknown>[]
      }
    }
    if (best) return best
    const vals = Object.values(obj)
    // column-oriented: {a: [..], b: [..]}
    if (vals.length && vals.every((v) => Array.isArray(v) && v.length === (vals[0] as unknown[]).length)) {
      const keys = Object.keys(obj)
      return (vals[0] as unknown[]).map((_, i) => Object.fromEntries(keys.map((k) => [k, (obj[k] as unknown[])[i]])))
    }
    // keyed map: {id1: {...}, id2: {...}}
    if (vals.length && vals.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
      return Object.entries(obj).map(([k, v]) => ({ key: k, ...(v as object) }))
    }
    for (const v of vals) {
      const nested = v && typeof v === 'object' ? findRecords(v) : null
      if (nested?.length) return nested
    }
  }
  return null
}

function flatten(obj: Record<string, unknown>, prefix = '', out: RawRow = {}, depth = 0): RawRow {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) {
      flatten(v as Record<string, unknown>, key, out, depth + 1)
    } else if (Array.isArray(v)) {
      out[key] = v.every((x) => typeof x !== 'object') ? v.join(', ') : JSON.stringify(v)
    } else {
      out[key] = v as RawValue
    }
  }
  return out
}

// ---------- Excel ----------

async function parseWorkbook(buf: ArrayBuffer, fileName: string, format: 'xlsx' | 'xls', o: ImportOptions, onProgress?: Progress): Promise<ParsedFile> {
  onProgress?.(0.1, 'Reading workbook')
  const XLSX = await import('xlsx')
  const wb = XLSX.read(buf, { type: 'array', cellDates: true, dense: true })
  onProgress?.(0.5, 'Reading sheets')
  const names = o.sheet && wb.SheetNames.includes(o.sheet) ? [o.sheet, ...wb.SheetNames.filter((n) => n !== o.sheet)] : wb.SheetNames
  const sheets = names.map((name) => {
    let aoa = XLSX.utils.sheet_to_json<RawValue[]>(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false })
    aoa = aoa.slice(o.skipRows ?? 0)
    const headerIdx = o.header === false ? -1 : findHeaderRow(aoa)
    const width = Math.max(0, ...aoa.slice(0, 50).map((r) => r.length))
    const headers = headerIdx < 0
      ? Array.from({ length: width }, (_, i) => `Column ${i + 1}`)
      : uniqueHeaders(aoa[headerIdx].map((h) => (h == null ? '' : String(h))))
    let body = aoa.slice(headerIdx + 1)
    let truncated = false
    if (o.rowLimit && body.length > o.rowLimit) { body = body.slice(0, o.rowLimit); truncated = true }
    const rows = body.map((r) => {
      const obj: RawRow = {}
      headers.forEach((h, i) => {
        const v = r[i]
        obj[h] = v instanceof Date ? toUtcDate(v) : v
      })
      return obj
    })
    return { name, headers, rows, truncated }
  }).filter((s) => s.rows.length > 0)
  if (!sheets.length) throw new Error('No sheets with data were found in this workbook.')
  return { fileName, format, sheets, detected: {} }
}

/** SheetJS 0.20 returns UTC-midnight Dates, older builds local-midnight; normalize both to UTC. */
function toUtcDate(v: Date): Date {
  if (!v.getUTCHours() && !v.getUTCMinutes() && !v.getUTCSeconds()) return v
  if (!v.getHours() && !v.getMinutes() && !v.getSeconds()) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()))
  return v
}

/** First row in the top 10 where most cells are non-empty strings — skips title rows above a table. */
function findHeaderRow(aoa: RawValue[][]): number {
  const width = Math.max(0, ...aoa.slice(0, 20).map((r) => r.filter((c) => c != null && c !== '').length))
  for (let i = 0; i < Math.min(10, aoa.length); i++) {
    const filled = aoa[i].filter((c) => c != null && c !== '')
    if (filled.length >= Math.max(1, width * 0.6) && filled.every((c) => typeof c === 'string')) return i
  }
  return aoa.length ? 0 : -1
}

export function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>()
  return raw.map((h, i) => {
    let name = String(h ?? '').trim() || `Column ${i + 1}`
    const n = seen.get(name) ?? 0
    seen.set(name, n + 1)
    if (n) name = `${name} (${n + 1})`
    return name
  })
}
