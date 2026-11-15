import { useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Flag, Minus, Sparkle, Target, TrendingUp, X } from 'lucide-react'
import type { ChangeReport } from '../types'
import { isQuiet } from '../lib/changes'
import { fmtPct } from '../lib/format'
import { useStore } from '../store'
import { cx, IconButton } from './ui'

/** Summary card shown above the dashboard after Update data: what moved, what's new, what looks off. */
export function WhatChanged({ report }: { report: ChangeReport }) {
  const { showChanges } = useStore.getState()
  const quiet = isQuiet(report)
  const [more, setMore] = useState(false)
  // KPIs from the page in view lead; the rest (e.g. the suggested Overview) wait behind "more"
  const main = report.kpis.filter((k) => !k.other)
  const rest = report.kpis.filter((k) => k.other)
  const kpis = main.length ? [...main, ...(more ? rest : [])] : rest
  return (
    <section aria-label="What changed" className="card fade-up no-print mb-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-[14px] font-semibold"><Sparkle size={15} className="text-accent" />What changed</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-3">
            {report.fileName} · {report.rowsBefore.toLocaleString()} → {report.rowsAfter.toLocaleString()} rows
            {report.period && <> · latest period {report.period.label}{report.period.partial ? ' (so far)' : ''}, compared with {report.period.previous}</>}
          </p>
        </div>
        <IconButton label="Dismiss what changed" onClick={() => showChanges(null)}><X size={15} /></IconButton>
      </div>

      {quiet ? (
        <p className="mt-3 text-[13px] text-ink-2">Nothing stands out: KPIs, categories and value ranges look like before.</p>
      ) : (
        <div className="mt-3 grid gap-x-8 gap-y-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))]">
          {report.kpis.length > 0 && (
            <Block title="KPIs">
              {kpis.map((k) => (
                <li key={k.key ?? k.title} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-ink-2" title={k.title}>{k.title}</span>
                  <span className="tabular shrink-0 text-right">
                    <span className="text-ink-3">{k.before} → </span><b className="font-medium">{k.after}</b>
                    {k.change != null && <Change value={k.change} upIsGood={k.upIsGood} />}
                  </span>
                </li>
              ))}
              {main.length > 0 && rest.length > 0 && (
                <li><button className="text-[12px] font-medium text-accent-ink hover:underline" onClick={() => setMore(!more)}>{more ? 'Fewer KPIs' : `${rest.length} more from other pages`}</button></li>
              )}
              {kpis.filter((k) => k.crossed).map((k) => (
                <li key={`${k.key ?? k.title}-target`} className={cx('flex items-center gap-1.5 text-[12px] font-medium', k.crossed === 'reached' ? 'text-good' : 'text-bad')}>
                  <Target size={13} />{k.title} {k.crossed} its target of {k.target}
                </li>
              ))}
            </Block>
          )}
          {report.movers.length > 0 && (
            <Block title={`Biggest movers · ${report.period?.label ?? ''}`} icon={<TrendingUp size={12} />}>
              {report.movers.map((m) => (
                <li key={m.dimension + m.value} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate" title={m.dimension ? `${m.dimension}: ${m.value}` : m.value}><span className="text-ink">{m.value}</span>{m.dimension && <span className="text-[11.5px] text-ink-3"> · {m.dimension}</span>}</span>
                  <span className="tabular shrink-0 text-right" title={`${m.measure}: ${m.previous} → ${m.current}`}>
                    <span className="text-ink-3">{m.previous} → </span>{m.current}
                    {m.pct != null ? <Change value={m.pct} /> : <span className="ml-1.5 text-[11.5px] text-ink-3">new</span>}
                  </span>
                </li>
              ))}
            </Block>
          )}
          {report.newValues.length > 0 && (
            <Block title="New values" icon={<Flag size={12} />}>
              {report.newValues.map((n) => (
                <li key={n.column}>
                  <span className="text-ink-3">{n.column}: </span>
                  {n.values.map((v) => <span key={v} className="mr-1 inline-block rounded-md bg-accent-soft px-1.5 text-[12px] font-medium text-accent-ink">{v}</span>)}
                  {n.more > 0 && <span className="text-[12px] text-ink-3">+{n.more} more</span>}
                </li>
              ))}
            </Block>
          )}
          {report.outliers.length > 0 && (
            <Block title="Unusual values in the new rows" icon={<AlertTriangle size={12} />}>
              {report.outliers.map((o) => (
                <li key={o.column}>
                  <b className="font-medium">{o.count.toLocaleString()}</b> in {o.column} <span className="text-ink-3">· up to {o.highest}, usually {o.usual}</span>
                </li>
              ))}
            </Block>
          )}
        </div>
      )}
    </section>
  )
}

function Block({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">{icon}{title}</div>
      <ul className="space-y-1 text-[13px]">{children}</ul>
    </div>
  )
}

/** Signed % change with an arrow; colored only when the KPI says which direction is good. */
function Change({ value, upIsGood }: { value: number; upIsGood?: boolean }) {
  const flat = Math.abs(value) < 0.0005
  const Icon = flat ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight
  const tone = flat || upIsGood == null ? 'text-ink-2' : (value > 0) === upIsGood ? 'text-good' : 'text-bad'
  return (
    <span className={cx('ml-1.5 inline-flex items-center text-[12px] font-medium', tone)}>
      <Icon size={12} />{fmtPct(Math.abs(value))}
    </span>
  )
}
