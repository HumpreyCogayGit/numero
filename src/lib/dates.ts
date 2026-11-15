import type { DateBucket } from '../types'

/** Start of the bucket containing t (UTC); day-of-week and month-of-year return 0-based indexes. */
export function bucketDate(t: number, b: Exclude<DateBucket, 'auto'>): number {
  const d = new Date(t)
  const y = d.getUTCFullYear(), m = d.getUTCMonth()
  switch (b) {
    case 'hour': return Date.UTC(y, m, d.getUTCDate(), d.getUTCHours())
    case 'day': return Date.UTC(y, m, d.getUTCDate())
    case 'week': { const dow = (d.getUTCDay() + 6) % 7; return Date.UTC(y, m, d.getUTCDate() - dow) }
    case 'month': return Date.UTC(y, m, 1)
    case 'quarter': return Date.UTC(y, m - (m % 3), 1)
    case 'year': return Date.UTC(y, 0, 1)
    case 'dow': return (d.getUTCDay() + 6) % 7
    case 'moy': return m
  }
}
