// CSV text for export. Kept free of React and the store so it can be tested on its own.

import { parseNumber } from './infer'

/** Byte-order mark: without it Excel reads a double-clicked UTF-8 file as the local code page and garbles accents. */
export const CSV_BOM = '﻿'

/**
 * A text cell that starts with = + - @ (or a tab / line break before one) runs as a formula when the file is opened
 * in a spreadsheet. An apostrophe in front makes it plain text. Real numbers ("-5", "+3.2", "-12.5%") are left alone.
 */
export function neutralizeFormula(s: string): string {
  if (!/^[=+\-@\t\r]/.test(s)) return s
  if (/^[+-]/.test(s) && parseNumber(s) != null) return s
  return `'${s}`
}

export function toCsv(headers: string[], rows: (string | number | null | boolean)[][], opts: { bom?: boolean } = {}): string {
  const esc = (v: unknown) => {
    if (v == null) return ''
    const s = typeof v === 'string' ? neutralizeFormula(v) : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return (opts.bom === false ? '' : CSV_BOM) + [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n')
}
