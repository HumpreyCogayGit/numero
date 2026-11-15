// Conditional formatting for table widgets: data bars, a sequential color scale and value rules.

import type { CondRule, TableFormat } from '../types'

export interface CellLook {
  /** data bar length, 0–100 */
  bar?: number
  /** color-scale strength, 0–1 (light → dark, one hue) */
  scale?: number
  /** the rule that matched */
  rule?: CondRule
}

export function matches(v: number, r: CondRule): boolean {
  switch (r.cmp) {
    case 'gt': return v > r.value
    case 'gte': return v >= r.value
    case 'lt': return v < r.value
    case 'lte': return v <= r.value
    case 'eq': return v === r.value
    case 'between': return v >= Math.min(r.value, r.value2 ?? r.value) && v <= Math.max(r.value, r.value2 ?? r.value)
  }
}

export const CMP_LABEL: Record<CondRule['cmp'], string> = { gt: 'above', gte: 'at least', lt: 'below', lte: 'at most', eq: 'equal to', between: 'between' }

/** How one cell looks, given its measure's value range across the table. */
export function cellLook(v: number | null, measureId: string, range: { min: number; max: number }, tf: TableFormat | undefined): CellLook {
  if (v == null || !Number.isFinite(v)) return {}
  const look: CellLook = {}
  const absMax = Math.max(Math.abs(range.min), Math.abs(range.max))
  if (tf?.bars !== false && absMax) look.bar = (Math.abs(v) / absMax) * 100
  if (tf?.scale && range.max > range.min) look.scale = (v - range.min) / (range.max - range.min)
  look.rule = tf?.rules?.find((r) => (!r.measure || r.measure === measureId) && Number.isFinite(r.value) && matches(v, r))
  return look
}

/** "below 100", "between 1 and 5" — for tooltips and screen readers. */
export const describeRule = (r: CondRule, fmt: (n: number) => string = String) =>
  r.cmp === 'between' ? `between ${fmt(r.value)} and ${fmt(r.value2 ?? r.value)}` : `${CMP_LABEL[r.cmp]} ${fmt(r.value)}`
