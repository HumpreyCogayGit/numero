import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseFile } from '../../src/lib/parse'
import { buildTable } from '../../src/lib/infer'
import { emptyModel } from '../../src/lib/model'
import type { Column, Dataset, Row } from '../../src/types'

export const SAMPLES = resolve(__dirname, '../../public/samples')
export const FIXTURES = resolve(__dirname, '../fixtures')

export async function parseSample(file: string, dir = SAMPLES) {
  return parseFile(new File([readFileSync(`${dir}/${file}`)], file))
}

/** Parses and types a sample file into a Dataset. */
export async function loadDataset(file: string, dir = SAMPLES): Promise<Dataset> {
  const p = await parseSample(file, dir)
  const sheet = p.sheets[0]
  const { columns, rows } = buildTable(sheet.headers, sheet.rows)
  return { id: file, name: file, fileName: file, format: p.format, columns, rows, createdAt: 0, rowCount: rows.length, columnCount: columns.length, source: { kind: 'sample' }, model: emptyModel() }
}

/** Minimal dataset from literal rows; types are inferred like a real import. */
export function makeDataset(rows: Record<string, unknown>[]): Dataset {
  const headers = Object.keys(rows[0] ?? {})
  const raw = rows.map((r) => Object.fromEntries(headers.map((h) => [h, r[h] as never])))
  const t = buildTable(headers, raw)
  return { id: 'mem', name: 'mem', fileName: 'mem.csv', format: 'csv', columns: t.columns, rows: t.rows, createdAt: 0, rowCount: t.rows.length, columnCount: t.columns.length, source: { kind: 'file' }, model: emptyModel() }
}

export const col = (ds: { columns: Column[] }, key: string) => ds.columns.find((c) => c.key === key)!
export const values = (rows: Row[], key: string) => rows.map((r) => r[key])
