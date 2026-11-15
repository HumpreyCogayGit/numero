import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { suggest } from '../../src/lib/suggest'
import { FIXTURES, SAMPLES, loadDataset } from './helpers'

// Guards the plan's rule that detection and default-aggregation changes must not silently alter the bundled samples.
// The baseline was recorded before the R1/R2 changes; intended differences are edited into the JSON by hand, after review.
// Reviewed changes so far:
//   us-flights-2001.json — distance is now summed (R2 lists distance as additive), which also moves it ahead of delay.
// Regenerate (only after reviewing the diff): delete tests/fixtures/sample-baseline.json and run the tests once.

const BASELINE = `${FIXTURES}/sample-baseline.json`

async function snapshot() {
  const out: Record<string, unknown> = {}
  for (const f of readdirSync(SAMPLES).filter((x) => /\.(csv|json|xlsx|xls)$/.test(x)).sort()) {
    const ds = await loadDataset(f)
    const columns = Object.fromEntries(ds.columns.map((c) => [c.key, [c.type, c.format, c.grain, c.isId && 'id', c.discrete && 'discrete'].filter(Boolean).join(' ')]))
    const kpis = suggest(ds).widgets.filter((w) => w.type === 'kpi').map((w) => `${w.measures[0].agg}:${w.measures[0].column ?? '*'}${w.kpiMode === 'latest' ? ' (latest)' : ''}`)
    out[f] = { columns, kpis }
  }
  return out
}

describe('bundled samples keep their detected types and suggested KPIs', () => {
  it('matches the reviewed baseline', async () => {
    const now = await snapshot()
    if (!existsSync(BASELINE)) writeFileSync(BASELINE, JSON.stringify(now, null, 2) + '\n')
    expect(now).toEqual(JSON.parse(readFileSync(BASELINE, 'utf8')))
  })
})
