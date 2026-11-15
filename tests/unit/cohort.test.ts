import { describe, expect, it } from 'vitest'
import { averageRetention, cohortCellFilters, runCohort } from '../../src/lib/cohort'
import { rowsBehind } from '../../src/lib/aggregate'
import type { Widget } from '../../src/types'
import { makeDataset } from './helpers'

describe('cohort tables (F30)', () => {
  const ds = makeDataset([
    // a: Jan, Feb, Apr · b: Jan · c: Feb, Mar · d: Mar
    { day: '2025-01-03', who: 'a' }, { day: '2025-01-20', who: 'a' }, { day: '2025-02-02', who: 'a' }, { day: '2025-04-09', who: 'a' },
    { day: '2025-01-15', who: 'b' },
    { day: '2025-02-10', who: 'c' }, { day: '2025-03-01', who: 'c' },
    { day: '2025-03-12', who: 'd' },
  ])
  const w: Widget = { id: 'c', type: 'cohort', title: '', size: 'full', measures: [], dimension: 'day', entity: 'who', bucket: 'month' }

  it('groups entities by first month and counts who comes back', () => {
    const r = runCohort(ds, w)!
    expect(r.periods).toBe(4)
    expect(r.cohorts.map(({ label, size, active }) => ({ label, size, active }))).toEqual([
      { label: 'Jan 2025', size: 2, active: [2, 1, 0, 1] },
      { label: 'Feb 2025', size: 1, active: [1, 1, 0, null] },
      { label: 'Mar 2025', size: 1, active: [1, 0, null, null] },
    ])
    // the rows behind a cell: January's customers, active in month 3 (April)
    const rows = rowsBehind(ds, w, [], cohortCellFilters(w, r.cohorts[0], 3))
    expect(rows.map((x) => x.who)).toEqual(['a'])
    expect(averageRetention(r)).toEqual([1, 2 / 4, 0, 1 / 2])
  })
  it('respects filters and other buckets', () => {
    expect(runCohort(ds, w, [{ id: 'f', column: 'who', values: ['a'] }])!.cohorts[0]).toMatchObject({ label: 'Jan 2025', size: 1, active: [1, 1, 0, 1] })
    const q = runCohort(ds, { ...w, bucket: 'quarter' })!
    expect(q.cohorts).toMatchObject([{ label: 'Q1 2025', size: 4, active: [4, 1] }])
    expect(runCohort(ds, { ...w, entity: undefined })).toBeNull()
  })
})
