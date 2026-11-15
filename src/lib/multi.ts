// Several files dropped together: do they hold the same columns (monthly exports of one report)?

import Papa from 'papaparse'
import { decode, formatOf, uniqueHeaders } from './parse'

/** The header row of a delimited text file, read from its first bytes only. Null for other formats. */
export async function peekHeaders(file: Blob & { name: string }): Promise<string[] | null> {
  const fmt = formatOf(file.name)
  if (fmt !== 'csv' && fmt !== 'tsv') return null
  if (/\.gz$/i.test(file.name)) return null
  const { text } = decode(await file.slice(0, 64 * 1024).arrayBuffer())
  const res = Papa.parse<string[]>(text, { preview: 1, skipEmptyLines: 'greedy', delimiter: fmt === 'tsv' ? '\t' : '' })
  const first = res.data[0]
  return first?.length ? uniqueHeaders(first) : null
}

/** Same column names, in any order. */
export const headersMatch = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && b.every((h) => a.includes(h))

/** True when every file is delimited text and all share one set of columns (two or more of them). */
export async function sameColumns(files: (Blob & { name: string })[]): Promise<boolean> {
  if (files.length < 2) return false
  const heads = await Promise.all(files.map((f) => peekHeaders(f).catch(() => null)))
  const first = heads[0]
  if (!first || first.length < 2) return false
  return heads.every((h) => !!h && headersMatch(first, h))
}
