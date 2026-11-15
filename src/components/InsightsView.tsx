import { useMemo, useState } from 'react'
import { AlertTriangle, GitCompareArrows, Lightbulb, PieChart, Plus, TrendingUp, Waves, Mountain, Trophy, Repeat, Siren } from 'lucide-react'
import type { Dataset, Widget } from '../types'
import { aggregate, applyFilters, colMap, correlationMatrix, groupKeyFn } from '../lib/aggregate'
import { buildChart } from '../lib/chartOptions'
import { fmtNumber, fmtPct } from '../lib/format'
import { TOKENS } from '../lib/palette'
import { dimensionCols, evenSample, findInsights, INSIGHT_SAMPLE, measureCols, type Insight } from '../lib/profile'
import { fiveNumber, mean, skewness, std } from '../lib/stats'
import { defaultAgg, uid } from '../lib/suggest'
import { useDashboard, useStore } from '../store'
import { Chart, useTheme } from './Chart'
import { Button, cx, Empty, SectionLabel } from './ui'

const ICON: Record<Insight['kind'], typeof Lightbulb> = {
  correlation: GitCompareArrows, dominant: PieChart, outliers: AlertTriangle, trend: TrendingUp, missing: Waves, skew: Mountain, extreme: Trophy, seasonal: Repeat, anomaly: Siren,
}

function widgetFor(ds: Dataset, ins: Insight): Widget | null {
  const [a, b] = ins.columns
  const cols = colMap(ds)
  switch (ins.kind) {
    case 'correlation': return { id: uid(), type: 'scatter', size: 'md', title: `${cols.get(b)?.name} vs ${cols.get(a)?.name}`, x: a, y: b, measures: [], trend: true }
    case 'dominant': return { id: uid(), type: 'donut', size: 'md', title: `Share by ${cols.get(a)?.name}`, dimension: a, measures: [{ id: uid('m'), agg: 'count' }] }
    case 'outliers': case 'skew': return { id: uid(), type: 'histogram', size: 'md', title: `Distribution of ${cols.get(a)?.name}`, x: a, measures: [], bins: 30 }
    case 'seasonal': {
      const c = cols.get(b)!
      return { id: uid(), type: 'bar', size: 'md', title: `${c.name} by month of year`, dimension: a, bucket: 'moy', sort: 'natural', measures: [{ id: uid('m'), column: b, agg: 'avg' }] }
    }
    case 'anomaly': {
      const c = cols.get(b)!
      return { id: uid(), type: 'line', size: 'lg', title: `${c.name} — anomalies`, dimension: a, bucket: 'month', measures: [{ id: uid('m'), column: b, agg: defaultAgg(c) }], anomalies: true }
    }
    case 'trend': case 'extreme': {
      const c = cols.get(b)!
      return { id: uid(), type: 'line', size: 'lg', title: `${c.name} over time`, dimension: a, bucket: 'auto', measures: [{ id: uid('m'), column: b, agg: defaultAgg(c) }], trend: true }
    }
    default: return null
  }
}

export function InsightsView({ ds }: { ds: Dataset }) {
  const dash = useDashboard()
  const filters = dash?.filters ?? []
  const theme = useTheme()
  const { addWidget, setTab, edit } = useStore.getState()
  const insights = useMemo(() => findInsights(ds, filters).sort((x, y) => y.strength - x.strength), [ds, filters])
  const nums = useMemo(() => measureCols(ds).slice(0, 12), [ds])
  const [added, setAdded] = useState<Set<string>>(new Set())

  const corrWidget: Widget = useMemo(() => ({ id: 'corr', type: 'correlation', size: 'full', title: '', measures: nums.map((c) => ({ id: c.key, column: c.key, agg: 'avg' })) }), [nums])

  // above INSIGHT_SAMPLE rows the statistics on this tab use an even sample, so the page stays responsive
  const sample = useMemo(() => {
    const rows = applyFilters(ds.rows, filters, colMap(ds))
    return { total: rows.length, rows: evenSample(rows) }
  }, [ds, filters])
  const sampledDs = useMemo(() => ({ ...ds, rows: sample.rows }), [ds, sample])
  const corr = useMemo(() => (nums.length >= 2 ? buildChart(sampledDs, corrWidget, [], TOKENS[theme]) : null), [sampledDs, corrWidget, theme, nums.length])
  const pairs = useMemo(() => {
    if (nums.length < 2) return []
    const cm = correlationMatrix(sampledDs, nums.map((c) => c.key), [])
    const out: { a: string; b: string; r: number }[] = []
    for (let i = 0; i < nums.length; i++) for (let j = i + 1; j < nums.length; j++) {
      if (Number.isFinite(cm.matrix[i][j])) out.push({ a: nums[i].name, b: nums[j].name, r: cm.matrix[i][j] })
    }
    return out.sort((x, y) => Math.abs(y.r) - Math.abs(x.r)).slice(0, 8)
  }, [sampledDs, nums])

  const describe = useMemo(() => {
    const rows = sample.rows
    return nums.map((c) => {
      const xs = rows.map((r) => r[c.key]).filter((v): v is number => typeof v === 'number')
      if (!xs.length) return { c, n: 0 }
      const f = fiveNumber(xs)
      return { c, n: xs.length, mean: mean(xs), std: std(xs), ...f, skew: skewness(xs) }
    })
  }, [sample, nums])

  return (
    <div className="space-y-6">
      <section>
        <SectionLabel>Automatic findings</SectionLabel>
        {sample.total > INSIGHT_SAMPLE && <p className="mb-2 text-[12px] text-ink-3">This dataset is large: correlations, distributions and the statistics table below use an even sample of {INSIGHT_SAMPLE.toLocaleString()} of {sample.total.toLocaleString()} rows. Trends over time use every row.</p>}
        {insights.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {insights.map((ins, i) => {
              const Icon = ICON[ins.kind]
              const w = widgetFor(ds, ins)
              const key = ins.title
              return (
                <div key={i} className="card fade-up flex gap-3 p-4" style={{ animationDelay: `${i * 40}ms` }}>
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-ink"><Icon size={17} /></div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium leading-snug">{ins.title}</div>
                    <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{ins.detail}</p>
                    {ins.basis && (
                      <details className="mt-1.5 text-[12px] text-ink-3">
                        <summary className="cursor-pointer select-none hover:text-ink">{ins.nature === 'model' ? 'Fitted pattern' : 'Description of the data'} · what this rests on</summary>
                        <p className="mt-1 leading-relaxed">{ins.basis}</p>
                      </details>
                    )}
                    {w && (
                      <button
                        disabled={added.has(key)}
                        onClick={() => { addWidget(w); edit(null); setAdded(new Set(added).add(key)) }}
                        className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-accent-ink hover:underline disabled:text-ink-3 disabled:no-underline"
                      >
                        {added.has(key) ? 'Added to dashboard' : <><Plus size={13} />Add chart to dashboard</>}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="card"><Empty icon={<Lightbulb size={18} />} title="No notable patterns found">Try a dataset with more numeric columns, or loosen the filters.</Empty></div>
        )}
        {added.size > 0 && <Button size="sm" className="mt-3" onClick={() => setTab('dashboard')}>View dashboard</Button>}
      </section>

      {corr && (
        <section className="grid gap-4 lg:grid-cols-3">
          <div className="card p-4 lg:col-span-2">
            <div className="mb-1 text-[14px] font-medium">Correlation matrix</div>
            <p className="mb-2 text-[12px] text-ink-3">Pearson r between numeric columns · blue = move together, red = move apart</p>
            <div style={{ height: Math.max(320, nums.length * 34 + 90) }}><Chart option={corr.option} /></div>
          </div>
          <div className="card p-4">
            <div className="mb-3 text-[14px] font-medium">Strongest relationships</div>
            <div className="space-y-3">
              {pairs.map((p, i) => (
                <div key={i}>
                  <div className="flex justify-between gap-2 text-[12px]">
                    <span className="min-w-0 truncate text-ink" title={`${p.a} × ${p.b}`}>{p.a} <span className="text-ink-3">×</span> {p.b}</span>
                    <span className="tabular shrink-0 font-medium">{p.r.toFixed(2)}</span>
                  </div>
                  <div className="relative mt-1 h-1.5 rounded-full bg-surface-3">
                    <div className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
                    <div className={cx('absolute inset-y-0 rounded-full', p.r >= 0 ? 'left-1/2 bg-accent' : 'right-1/2 bg-bad')} style={{ width: `${Math.abs(p.r) * 50}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {describe.length > 0 && (
        <section className="card overflow-hidden">
          <div className="px-4 pt-4 text-[14px] font-medium">Descriptive statistics</div>
          <div className="overflow-x-auto p-4 pt-3">
            <table className="tabular w-full text-[13px]">
              <thead>
                <tr className="text-ink-3">
                  {['Column', 'n', 'Mean', 'Std dev', 'Min', 'Q1', 'Median', 'Q3', 'Max', 'Skew', 'Outliers'].map((h, i) => (
                    <th key={h} className={cx('border-b border-line py-2 font-medium', i ? 'pl-4 text-right' : 'text-left')}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {describe.map((d) => (
                  <tr key={d.c.key} className="border-b border-line/60 hover:bg-surface-2">
                    <td className="py-2 pr-4 text-ink">{d.c.name}</td>
                    <td className="py-2 pl-4 text-right text-ink-2">{d.n.toLocaleString()}</td>
                    {'mean' in d ? (
                      <>
                        {[d.mean, d.std, d.min, d.q1, d.median, d.q3, d.max].map((v, i) => <td key={i} className="py-2 pl-4 text-right">{fmtNumber(v, d.c)}</td>)}
                        <td className={cx('py-2 pl-4 text-right', Math.abs(d.skew ?? 0) > 1 ? 'font-medium text-ink' : 'text-ink-2')}>{Number.isFinite(d.skew) ? d.skew!.toFixed(2) : '—'}</td>
                        <td className="py-2 pl-4 text-right text-ink-2">{d.outliers?.length.toLocaleString()}</td>
                      </>
                    ) : <td colSpan={9} className="py-2 pl-4 text-right text-ink-3">No values</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <Seasonality ds={ds} />
      <SegmentCompare ds={ds} />
    </div>
  )
}

/** Mean / median per segment versus the overall average — a quick group comparison. */
function SegmentCompare({ ds }: { ds: Dataset }) {
  const dash = useDashboard()
  const dims = dimensionCols(ds)
  const nums = measureCols(ds)
  const [dim, setDim] = useState(dims[0]?.key)
  const [num, setNum] = useState(nums[0]?.key)
  const data = useMemo(() => {
    const cols = colMap(ds)
    const d = dim ? cols.get(dim) : undefined
    const n = num ? cols.get(num) : undefined
    if (!d || !n) return null
    const rows = applyFilters(ds.rows, dash?.filters, cols)
    const fn = groupKeyFn(d, rows)
    const g = new Map<string | number, typeof rows>()
    for (const r of rows) { const k = fn.key(r); if (!g.has(k)) g.set(k, []); g.get(k)!.push(r) }
    const overall = aggregate(rows, { id: '', column: n.key, agg: 'avg' }) ?? 0
    const items = [...g.entries()].map(([k, rs]) => ({
      name: fn.label(k), n: rs.length,
      avg: aggregate(rs, { id: '', column: n.key, agg: 'avg' }),
      median: aggregate(rs, { id: '', column: n.key, agg: 'median' }),
    })).filter((x) => x.avg != null).sort((a, b) => b.avg! - a.avg!).slice(0, 20)
    const maxDev = Math.max(...items.map((x) => Math.abs((x.avg! - overall) / (overall || 1))), 0.0001)
    return { items, overall, n, maxDev }
  }, [ds, dim, num, dash?.filters])

  if (!dims.length || !nums.length) return null
  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[14px] font-medium">Segment comparison</div>
          <p className="text-[12px] text-ink-3">How each group's average differs from the overall average</p>
        </div>
        <div className="flex gap-2">
          <select aria-label="Compare measure" className="field h-8 w-44" value={num} onChange={(e) => setNum(e.target.value)}>{nums.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</select>
          <span className="self-center text-[12px] text-ink-3">by</span>
          <select aria-label="Compare by" className="field h-8 w-44" value={dim} onChange={(e) => setDim(e.target.value)}>{dims.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</select>
        </div>
      </div>
      {data && (
        <div className="mt-4 overflow-x-auto">
          <table className="tabular w-full text-[13px]">
            <thead>
              <tr className="text-ink-3">
                <th className="border-b border-line py-2 text-left font-medium">Segment</th>
                <th className="border-b border-line py-2 pl-4 text-right font-medium">Rows</th>
                <th className="border-b border-line py-2 pl-4 text-right font-medium">Average</th>
                <th className="border-b border-line py-2 pl-4 text-right font-medium">Median</th>
                <th className="w-[38%] border-b border-line py-2 pl-6 text-left font-medium">vs overall ({fmtNumber(data.overall, data.n)})</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((x) => {
                const dev = (x.avg! - data.overall) / (data.overall || 1)
                const w = (Math.abs(dev) / data.maxDev) * 50
                return (
                  <tr key={x.name} className="border-b border-line/60">
                    <td className="max-w-[200px] truncate py-2 text-ink">{x.name}</td>
                    <td className="py-2 pl-4 text-right text-ink-2">{x.n.toLocaleString()}</td>
                    <td className="py-2 pl-4 text-right">{fmtNumber(x.avg, data.n)}</td>
                    <td className="py-2 pl-4 text-right text-ink-2">{fmtNumber(x.median, data.n)}</td>
                    <td className="py-2 pl-6">
                      <div className="flex items-center gap-3">
                        <div className="relative h-2 flex-1 rounded-full bg-surface-3">
                          <div className="absolute inset-y-[-3px] left-1/2 w-px bg-line-strong" />
                          <div className={cx('absolute inset-y-0 rounded-full', dev >= 0 ? 'left-1/2 bg-accent' : 'right-1/2 bg-bad')} style={{ width: `${w}%` }} />
                        </div>
                        <span className="w-14 text-right text-[12px] text-ink-2">{dev >= 0 ? '+' : '−'}{fmtPct(Math.abs(dev), 0)}</span>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** Average by month of year plus a 12-month forecast for one measure. */
function Seasonality({ ds }: { ds: Dataset }) {
  const dash = useDashboard()
  const theme = useTheme()
  const date = ds.columns.find((c) => c.type === 'date' && c.distinct >= 24)
  const nums = measureCols(ds).filter((c) => !c.discrete)
  const [num, setNum] = useState(nums[0]?.key)
  const charts = useMemo(() => {
    if (!date || !num) return null
    const c = ds.columns.find((x) => x.key === num)!
    const profile: Widget = { id: 'season', type: 'bar', title: `${c.name} by month of year`, size: 'md', dimension: date.key, bucket: 'moy', sort: 'natural', measures: [{ id: 'm', column: num, agg: 'avg' }] }
    const fc: Widget = { id: 'fc', type: 'line', title: `${c.name} forecast`, size: 'md', dimension: date.key, bucket: 'month', measures: [{ id: 'm', column: num, agg: defaultAgg(c) }], forecast: 12, anomalies: true }
    return { profile: buildChart(ds, profile, dash?.filters ?? [], TOKENS[theme]), forecast: buildChart(ds, fc, dash?.filters ?? [], TOKENS[theme]) }
  }, [ds, date, num, dash?.filters, theme])
  if (!date || !nums.length || !charts) return null
  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[14px] font-medium">Seasonality &amp; forecast</div>
          <p className="text-[12px] text-ink-3">Typical yearly pattern, and the next 12 months projected from trend and season</p>
        </div>
        <select aria-label="Seasonality measure" className="field h-8 w-52" value={num} onChange={(e) => setNum(e.target.value)}>{nums.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</select>
      </div>
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div><div className="mb-1 text-[12px] font-medium text-ink-2">Average by month of year</div><div className="h-[240px]"><Chart option={charts.profile.option} label={charts.profile.label} /></div></div>
        <div><div className="mb-1 text-[12px] font-medium text-ink-2">Monthly, with forecast {charts.forecast.note ? <span className="font-normal text-ink-3">· {charts.forecast.note}</span> : null}</div><div className="h-[240px]"><Chart option={charts.forecast.option} label={charts.forecast.label} /></div></div>
      </div>
    </section>
  )
}
