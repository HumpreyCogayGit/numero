import { useMemo } from 'react'
import { ArrowDownRight, ArrowUpRight, Target } from 'lucide-react'
import type { Dataset, Filter, Widget } from '../types'
import { colMap, measureColumn, runKpi } from '../lib/aggregate'
import { fmtNumber, fmtPct } from '../lib/format'
import { TOKENS } from '../lib/palette'
import { useTheme } from './theme'
import { cx } from './ui'

/** Stat tile: label · value · change vs a comparison period · sparkline (current period in the accent) · optional target. */
export function KpiTile({ ds, widget, filters }: { ds: Dataset; widget: Widget; filters: Filter[] }) {
  const theme = useTheme()
  const t = TOKENS[theme]
  const r = useMemo(() => runKpi(ds, widget, filters), [ds, widget, filters])
  const m = widget.measures[0]
  const col = m ? measureColumn(m, colMap(ds)) : undefined
  const fmt = (v: number | null) => fmtNumber(v, col, { format: widget.format })
  const spark = r.spark?.filter((p) => p.value != null) ?? []

  let path = ''
  let last: [number, number] | null = null
  if (spark.length > 1) {
    const vals = spark.map((p) => p.value as number)
    const min = Math.min(...vals), max = Math.max(...vals)
    const W = 112, H = 32
    const pts = vals.map((v, i) => [(i / (vals.length - 1)) * W, H - 3 - ((v - min) / (max - min || 1)) * (H - 6)] as [number, number])
    path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')
    last = pts[pts.length - 1]
  }
  const up = (r.delta ?? 0) >= 0
  // only color the change when the user said which direction is good
  const tone = widget.upIsGood == null ? 'text-ink-2' : up === widget.upIsGood ? 'text-good' : 'text-bad'
  const progress = r.target && r.value != null ? r.value / r.target : null

  return (
    <div className="flex h-full flex-col justify-between gap-3 px-4 pb-4 pt-1">
      <div>
        <div className="text-[28px] font-semibold leading-none tracking-tight text-ink">{fmt(r.value)}</div>
        {r.period && <div className="mt-1 text-[11px] text-ink-3">{r.period}</div>}
      </div>
      {progress != null && (
        <div>
          <div className="flex justify-between text-[11px] text-ink-3"><span className="inline-flex items-center gap-1"><Target size={11} />Target {fmt(r.target!)}</span><span className="tabular">{fmtPct(progress, 0)}</span></div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-accent/15"><div className={cx('h-full rounded-full', progress >= 1 ? 'bg-good' : 'bg-accent')} style={{ width: `${Math.min(100, progress * 100)}%` }} /></div>
        </div>
      )}
      <div className="flex items-end justify-between gap-3">
        {r.delta != null ? (
          <div className="min-w-0">
            <span className={cx('inline-flex items-center gap-0.5 text-[13px] font-semibold', tone)}
              title={widget.upIsGood == null ? 'Change vs the comparison period. Set “up is good” in the editor to color it.' : undefined}>
              {up ? <ArrowUpRight size={14} strokeWidth={2.5} /> : <ArrowDownRight size={14} strokeWidth={2.5} />}
              <span className="sr-only">{up ? 'up' : 'down'}</span>
              {fmtPct(Math.abs(r.delta))}
            </span>
            <div className="truncate text-[11px] text-ink-3" title={r.partial ? `${r.deltaLabel} — ${r.partial} is incomplete and left out` : r.deltaLabel}>
              vs {r.deltaLabel?.split(' vs ')[1]?.replace(/^Wk of /, 'week of ')}{r.partial ? '*' : ''}
            </div>
          </div>
        ) : (
          <div className="text-[12px] text-ink-3">{m && m.agg !== 'count' ? `across ${r.rows.toLocaleString()} rows` : 'rows after filters'}</div>
        )}
        {path && (
          <svg viewBox="0 0 112 32" className="h-8 w-28 shrink-0 overflow-visible" aria-hidden>
            <path d={path} fill="none" stroke={t.axis} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            {last && <circle cx={last[0]} cy={last[1]} r={3.5} fill={t.series[0]} stroke={t.surface} strokeWidth={2} vectorEffect="non-scaling-stroke" />}
          </svg>
        )}
      </div>
    </div>
  )
}
