import { useMemo, useState } from 'react'
import type { ColType, Dataset } from '../types'
import { profileColumn, type ColumnProfile } from '../lib/profile'
import { fmtDate, fmtNumber, fmtPct } from '../lib/format'
import { useDashboard, useStore } from '../store'
import { Badge, cx, Segmented, TypeIcon, typeLabel } from './ui'

export function ProfileView({ ds }: { ds: Dataset }) {
  const dash = useDashboard()
  const filters = dash?.filters ?? []
  const [only, setOnly] = useState<'all' | ColType>('all')
  const profiles = useMemo(() => ds.columns.map((c) => profileColumn(ds, c, filters)), [ds, filters])

  const totalCells = ds.rows.length * ds.columns.length
  const missingCells = ds.columns.reduce((a, c) => a + c.missing, 0)
  const dupes = useMemo(() => {
    const seen = new Set<string>()
    let n = 0
    for (const r of ds.rows) { const k = JSON.stringify(r); if (seen.has(k)) n++; else seen.add(k) }
    return n
  }, [ds])
  const typeCounts = ds.columns.reduce<Record<string, number>>((a, c) => ((a[c.type] = (a[c.type] ?? 0) + 1), a), {})
  const shown = profiles.filter((p) => only === 'all' || p.col.type === only)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Rows" value={ds.rows.length.toLocaleString()} />
        <Stat label="Columns" value={String(ds.columns.length)} sub={Object.entries(typeCounts).map(([t, n]) => `${n} ${typeLabel(t as ColType).toLowerCase()}`).join(' · ')} />
        <Stat label="Missing cells" value={fmtPct(missingCells / Math.max(1, totalCells))} sub={`${missingCells.toLocaleString()} of ${totalCells.toLocaleString()}`} />
        <Stat label="Duplicate rows" value={dupes.toLocaleString()} sub={dupes ? fmtPct(dupes / ds.rows.length) + ' of rows' : 'None found'} />
      </div>

      <Segmented<'all' | ColType> size="sm" value={only} onChange={setOnly} options={[
        { value: 'all', label: `All ${ds.columns.length}` },
        ...(['number', 'date', 'category', 'text', 'boolean'] as ColType[]).filter((t) => typeCounts[t]).map((t) => ({ value: t, label: <><TypeIcon type={t} className="h-4 w-4" />{typeCounts[t]}</> })),
      ]} />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((p) => <ProfileCard key={p.col.key} p={p} />)}
      </div>
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card px-4 py-3.5">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="mt-1 text-[22px] font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-ink-3" title={sub}>{sub}</div>}
    </div>
  )
}

function ProfileCard({ p }: { p: ColumnProfile }) {
  const { col } = p
  const missPct = p.missing / Math.max(1, p.count)
  return (
    <div className="card fade-up flex flex-col p-4">
      <div className="flex items-start gap-2">
        <TypeIcon type={col.type} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium" title={col.name}>{col.name}</div>
          <div className="truncate text-[11px] text-ink-3">{col.formula != null ? 'Computed' : col.key !== col.name ? col.key : typeLabel(col.type)}{col.format && col.type === 'number' ? ` · ${col.format}` : ''}{col.grain && col.type === 'date' ? ` · ${col.grain}` : ''}</div>
        </div>
        <div className="flex gap-1">
          {col.isId && <Badge>ID</Badge>}
          {col.discrete && <Badge>discrete</Badge>}
          {col.type !== col.detected && <Badge tone="accent">overridden</Badge>}
        </div>
      </div>

      {col.formula != null && (
        <button onClick={() => useStore.getState().openFormula(col.key)} title="Edit formula" className="mt-3 flex w-full items-center gap-2 rounded-lg bg-accent-soft/60 px-2.5 py-1.5 text-left transition hover:bg-accent-soft">
          <span className="font-mono text-[11px] font-semibold text-accent-ink">ƒ</span>
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2">{col.formula}</code>
        </button>
      )}
      {col.formulaError && <div className="mt-1.5 text-[11px] text-bad">{col.formulaError}</div>}

      <div className="mt-3 grid grid-cols-3 gap-2 text-[12px]">
        <Mini label="Distinct" value={p.distinct.toLocaleString()} />
        <Mini label="Missing" value={fmtPct(missPct, missPct && missPct < 0.01 ? 2 : 0)} warn={missPct > 0.1} />
        <Mini label="Filled" value={(p.count - p.missing).toLocaleString()} />
      </div>

      <div className="mt-4 flex-1">
        {p.numeric && (
          <>
            <Bars data={p.numeric.hist.map((b) => ({ label: `${fmtNumber(b.x0, col)}–${fmtNumber(b.x1, col)}`, value: b.count }))} />
            <div className="mt-1 flex justify-between text-[10px] text-ink-3"><span>{fmtNumber(p.numeric.min, col)}</span><span>{fmtNumber(p.numeric.max, col)}</span></div>
            <dl className="tabular mt-3 grid grid-cols-3 gap-x-3 gap-y-1.5 text-[12px]">
              {([
                ['Mean', p.numeric.mean], ['Median', p.numeric.median], ['Std dev', p.numeric.std],
                ['Q1', p.numeric.q1], ['Q3', p.numeric.q3], ['Sum', p.numeric.sum],
              ] as [string, number][]).map(([k, v]) => <KV key={k} k={k} v={fmtNumber(v, col)} />)}
              <KV k="Skew" v={Number.isFinite(p.numeric.skew) ? p.numeric.skew.toFixed(2) : '—'} />
              <KV k="Outliers" v={p.numeric.outliers.toLocaleString()} />
              <KV k="Zeros" v={p.numeric.zeros.toLocaleString()} />
            </dl>
          </>
        )}
        {p.date && (
          <>
            <Bars data={p.date.series.map((s) => ({ label: s.label, value: s.count }))} />
            <div className="mt-1 flex justify-between text-[10px] text-ink-3"><span>{fmtDate(p.date.min, col.grain === 'year' ? 'year' : 'day')}</span><span>{fmtDate(p.date.max, col.grain === 'year' ? 'year' : 'day')}</span></div>
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]">
              <KV k="Span" v={p.date.spanDays > 730 ? `${(p.date.spanDays / 365.25).toFixed(1)} years` : `${Math.round(p.date.spanDays).toLocaleString()} days`} />
              <KV k="Periods" v={p.date.series.length.toLocaleString()} />
            </dl>
          </>
        )}
        {p.top && !p.numeric && <TopValues top={p.top} total={p.count - p.missing} />}
        {p.top && p.numeric && col.discrete && <div className="mt-3"><TopValues top={p.top.slice(0, 4)} total={p.count - p.missing} /></div>}
        {p.text && col.type === 'text' && (
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]">
            <KV k="Avg length" v={p.text.avgLen.toFixed(1)} />
            <KV k="Max length" v={String(p.text.maxLen)} />
          </dl>
        )}
      </div>
    </div>
  )
}

function Mini({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-lg bg-surface-2 px-2.5 py-1.5">
      <div className="text-[10px] text-ink-3">{label}</div>
      <div className={cx('tabular font-medium', warn ? 'text-bad' : 'text-ink')}>{value}</div>
    </div>
  )
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] text-ink-3">{k}</dt>
      <dd className="truncate font-medium text-ink" title={v}>{v}</dd>
    </div>
  )
}

/** Tiny column chart with per-bar hover readout. */
function Bars({ data }: { data: { label: string; value: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...data.map((d) => d.value))
  const d = hover != null ? data[hover] : null
  return (
    <div>
      <div className="mb-1 h-4 truncate text-[11px] text-ink-2">{d ? <><span className="text-ink-3">{d.label}</span> · <b className="font-medium text-ink">{d.value.toLocaleString()}</b></> : null}</div>
      <div className="flex h-16 items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
        {data.map((b, i) => (
          <div key={i} className="flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)}>
            <div
              className={cx('w-full rounded-t-[3px] transition-colors', hover === i ? 'bg-accent' : 'bg-accent/55')}
              style={{ height: `${Math.max(b.value ? 4 : 0, (b.value / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function TopValues({ top, total }: { top: { value: string; count: number }[]; total: number }) {
  const max = top[0]?.count ?? 1
  return (
    <div className="space-y-1.5">
      {top.map((t) => (
        <div key={t.value} className="text-[12px]">
          <div className="mb-0.5 flex justify-between gap-2">
            <span className="truncate text-ink" title={t.value}>{t.value}</span>
            <span className="tabular shrink-0 text-ink-3">{t.count.toLocaleString()} · {fmtPct(t.count / Math.max(1, total), 0)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-accent/60" style={{ width: `${(t.count / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}
