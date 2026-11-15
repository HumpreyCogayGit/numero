import { useMemo, useState } from 'react'
import { ListFilter, Plus, Search, X } from 'lucide-react'
import type { Column, Dataset, Filter } from '../types'
import { isActive, labelOf, resolveRelative } from '../lib/aggregate'
import { fmtDate, fmtNumber } from '../lib/format'
import { uid } from '../lib/suggest'
import { Button, cx, Popover, TypeIcon } from './ui'

export function FilterBar({ ds, filters, onChange }: { ds: Dataset; filters: Filter[]; onChange: (f: Filter[]) => void }) {
  const cols = new Map(ds.columns.map((c) => [c.key, c]))
  const [fresh, setFresh] = useState<string | null>(null)
  const update = (f: Filter) => onChange(filters.map((x) => (x.id === f.id ? f : x)))
  const remove = (id: string) => onChange(filters.filter((x) => x.id !== id))

  return (
    <div className="flex flex-wrap items-center gap-2">
      {filters.map((f) => {
        const col = cols.get(f.column)
        if (!col) return null
        return (
          <Popover key={f.id} width={300} defaultOpen={f.id === fresh} trigger={(open, toggle) => (
            <div className={cx('inline-flex h-8 items-center rounded-lg border text-[13px] transition', open ? 'border-accent bg-accent-soft' : 'border-line bg-surface shadow-card hover:border-line-strong')}>
              <button onClick={toggle} className="flex items-center gap-1.5 pl-2.5 pr-1.5">
                <TypeIcon type={col.type} className="h-4 w-4" />
                <span className="font-medium text-ink">{col.name}</span>
                <span className="max-w-[260px] truncate text-ink-2">{summary(f, col, ds)}</span>
              </button>
              <button onClick={() => remove(f.id)} aria-label={`Remove ${col.name} filter`} className="mr-1 rounded p-0.5 text-ink-3 hover:bg-surface-3 hover:text-ink"><X size={13} /></button>
            </div>
          )}>
            {() => <FilterEditor ds={ds} col={col} filter={f} onChange={update} />}
          </Popover>
        )
      })}
      <Popover width={260} trigger={(_, toggle) => (
        <Button size="sm" variant={filters.length ? 'ghost' : 'secondary'} onClick={toggle}>
          {filters.length ? <Plus size={14} /> : <ListFilter size={14} />}{filters.length ? 'Add filter' : 'Filter'}
        </Button>
      )}>
        {(close) => <ColumnPicker ds={ds} onPick={(c) => { const id = uid('f'); setFresh(id); onChange([...filters, { id, column: c.key }]); close() }} />}
      </Popover>
      {filters.length > 1 && <Button size="sm" variant="ghost" onClick={() => onChange([])}>Clear all</Button>}
    </div>
  )
}

export const RELATIVE_PRESETS: { label: string; rel: NonNullable<Filter['relative']> }[] = [
  { label: 'Latest month', rel: { last: 1, unit: 'month', calendar: true } },
  { label: 'Last 3 months', rel: { last: 3, unit: 'month', calendar: true } },
  { label: 'Last 12 months', rel: { last: 12, unit: 'month', calendar: true } },
  { label: 'Latest quarter', rel: { last: 1, unit: 'quarter', calendar: true } },
  { label: 'Year to date', rel: { last: 1, unit: 'year', calendar: true } },
  { label: 'Last 30 days', rel: { last: 30, unit: 'day' } },
  { label: 'Last 90 days', rel: { last: 90, unit: 'day' } },
  { label: 'Last 2 years', rel: { last: 2, unit: 'year', calendar: true } },
]

export function relativeLabel(rel: NonNullable<Filter['relative']>): string {
  const preset = RELATIVE_PRESETS.find((p) => p.rel.last === rel.last && p.rel.unit === rel.unit && !!p.rel.calendar === !!rel.calendar)
  if (preset) return preset.label.toLowerCase()
  return `last ${rel.last} ${rel.unit}${rel.last > 1 ? 's' : ''}`
}

function summary(f: Filter, col: Column, ds?: Dataset): string {
  if (!isActive(f)) return 'any'
  const not = f.exclude ? 'not ' : ''
  if (f.relative) {
    // show the rule and what it currently covers, e.g. "latest month · Dec 2015"
    let latest = -Infinity
    for (const r of ds?.rows ?? []) { const v = r[col.key]; if (typeof v === 'number' && v > latest) latest = v }
    if (!Number.isFinite(latest)) return not + relativeLabel(f.relative)
    const { min, max } = resolveRelative(f.relative, latest)
    const span = f.relative.calendar && f.relative.unit === 'month' && f.relative.last === 1 ? fmtDate(min, 'month') : `${fmtDate(min)} – ${fmtDate(max)}`
    return `${not}${relativeLabel(f.relative)} · ${span}`
  }
  if (f.values?.length) return not + (f.values.length <= 2 ? f.values.join(', ') : `${f.values.length} selected`)
  if (f.text) return `${not}contains “${f.text}”`
  const fmt = (v: number) => (col.type === 'date' ? fmtDate(v, col.grain === 'year' ? 'year' : 'day') : fmtNumber(v, col))
  if (f.min != null && f.max != null) return `${fmt(f.min)} – ${fmt(f.max)}`
  if (f.min != null) return `≥ ${fmt(f.min)}`
  return `≤ ${fmt(f.max!)}`
}

export function ColumnPicker({ ds, onPick }: { ds: Dataset; onPick: (c: Column) => void }) {
  const [q, setQ] = useState('')
  const list = ds.columns.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()))
  return (
    <div>
      <div className="relative mb-1">
        <Search size={14} className="absolute left-2.5 top-2.5 text-ink-3" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a column…" className="field h-8 pl-8" />
      </div>
      <div className="max-h-72 overflow-auto">
        {list.map((c) => (
          <button key={c.key} onClick={() => onPick(c)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-surface-3">
            <TypeIcon type={c.type} />
            <span className="truncate">{c.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

const toInput = (t: number | undefined) => (t == null ? '' : new Date(t).toISOString().slice(0, 10))
const fromInput = (s: string, end = false) => (s ? Date.parse(s + (end ? 'T23:59:59Z' : 'T00:00:00Z')) : undefined)

export function FilterEditor({ ds, col, filter, onChange }: { ds: Dataset; col: Column; filter: Filter; onChange: (f: Filter) => void }) {
  const [q, setQ] = useState('')
  const listMode = col.type === 'category' || col.type === 'boolean' || (col.type === 'text' && col.distinct <= 300) || (col.type === 'number' && col.discrete)

  const counts = useMemo(() => {
    if (!listMode) return []
    const m = new Map<string, number>()
    for (const r of ds.rows) { const l = labelOf(r[col.key], col); m.set(l, (m.get(l) ?? 0) + 1) }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [ds, col, listMode])

  const range = useMemo(() => {
    let min = Infinity, max = -Infinity
    for (const r of ds.rows) { const v = r[col.key]; if (typeof v === 'number') { if (v < min) min = v; if (v > max) max = v } }
    return { min, max }
  }, [ds, col])

  const header = (
    <div className="mb-2 flex items-center justify-between px-1 pt-1">
      <span className="text-[12px] font-semibold text-ink">{col.name}</span>
      <div className="inline-flex rounded-md bg-surface-3 p-0.5 text-[11px]">
        {[false, true].map((ex) => (
          <button key={String(ex)} onClick={() => onChange({ ...filter, exclude: ex })}
            className={cx('rounded px-2 py-0.5 font-medium', !!filter.exclude === ex ? 'bg-surface text-ink shadow-card' : 'text-ink-3')}>
            {ex ? 'Exclude' : 'Include'}
          </button>
        ))}
      </div>
    </div>
  )

  if (listMode) {
    const sel = new Set(filter.values ?? [])
    const shown = counts.filter(([v]) => v.toLowerCase().includes(q.toLowerCase()))
    const toggle = (v: string) => {
      const next = new Set(sel)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      onChange({ ...filter, values: [...next] })
    }
    return (
      <div className="p-1">
        {header}
        {counts.length > 8 && (
          <div className="relative mb-1.5">
            <Search size={14} className="absolute left-2.5 top-2.5 text-ink-3" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search values…" className="field h-8 pl-8" />
          </div>
        )}
        <div className="max-h-64 overflow-auto">
          {shown.slice(0, 300).map(([v, n]) => (
            <label key={v} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-surface-3">
              <input type="checkbox" checked={sel.has(v)} onChange={() => toggle(v)} className="accent-[var(--accent)]" />
              <span className="flex-1 truncate">{v}</span>
              <span className="tabular text-[11px] text-ink-3">{n.toLocaleString()}</span>
            </label>
          ))}
        </div>
        <div className="mt-2 flex justify-between border-t border-line px-1 pt-2 text-[12px]">
          <button className="text-accent-ink hover:underline" onClick={() => onChange({ ...filter, values: shown.map(([v]) => v) })}>Select {q ? 'matching' : 'all'}</button>
          <button className="text-ink-3 hover:text-ink" onClick={() => onChange({ ...filter, values: [] })}>Clear</button>
        </div>
      </div>
    )
  }

  if (col.type === 'date') {
    const max = range.max
    const isOn = (rel: NonNullable<Filter['relative']>) => !!filter.relative && filter.relative.last === rel.last && filter.relative.unit === rel.unit && !!filter.relative.calendar === !!rel.calendar
    const shown = filter.relative && Number.isFinite(max) ? resolveRelative(filter.relative, max) : filter
    return (
      <div className="p-1">
        {header}
        <div className="mb-1 text-[11px] font-medium text-ink-2">Rolls forward with new data</div>
        <div className="grid grid-cols-2 gap-1">
          {RELATIVE_PRESETS.map((p) => (
            <button key={p.label} aria-pressed={isOn(p.rel)} onClick={() => onChange({ ...filter, relative: p.rel, min: undefined, max: undefined })}
              className={cx('rounded-md px-2 py-1.5 text-left text-[12px] transition', isOn(p.rel) ? 'bg-accent-fill text-white' : 'bg-surface-3 text-ink-2 hover:text-ink')}>{p.label}</button>
          ))}
        </div>
        <div className="mt-1.5 text-[11px] text-ink-3">Measured from the latest date in the data ({Number.isFinite(max) ? fmtDate(max) : '—'}), so “Latest month” shows the new month after an update.</div>
        <div className="mb-1 mt-3 text-[11px] font-medium text-ink-2">Fixed dates</div>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[11px] text-ink-3">From<input type="date" className="field mt-1 h-8" value={toInput(shown.min)} onChange={(e) => onChange({ ...filter, relative: undefined, min: fromInput(e.target.value), max: filter.relative ? shown.max : filter.max })} /></label>
          <label className="text-[11px] text-ink-3">To<input type="date" className="field mt-1 h-8" value={toInput(shown.max)} onChange={(e) => onChange({ ...filter, relative: undefined, max: fromInput(e.target.value, true), min: filter.relative ? shown.min : filter.min })} /></label>
        </div>
        <button className="mt-2 text-[12px] text-ink-3 hover:text-ink" onClick={() => onChange({ ...filter, relative: undefined, min: undefined, max: undefined })}>Clear</button>
      </div>
    )
  }

  if (col.type === 'number') {
    return (
      <div className="p-1">
        {header}
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[11px] text-ink-3">Min<input type="number" className="field mt-1 h-8" placeholder={fmtNumber(range.min, undefined, { compact: false })} value={filter.min ?? ''} onChange={(e) => onChange({ ...filter, min: e.target.value === '' ? undefined : +e.target.value })} /></label>
          <label className="text-[11px] text-ink-3">Max<input type="number" className="field mt-1 h-8" placeholder={fmtNumber(range.max, undefined, { compact: false })} value={filter.max ?? ''} onChange={(e) => onChange({ ...filter, max: e.target.value === '' ? undefined : +e.target.value })} /></label>
        </div>
        <div className="mt-2 text-[11px] text-ink-3">Data range: {fmtNumber(range.min, col)} – {fmtNumber(range.max, col)}</div>
      </div>
    )
  }

  return (
    <div className="p-1">
      {header}
      <input autoFocus className="field h-8" placeholder="Contains text…" value={filter.text ?? ''} onChange={(e) => onChange({ ...filter, text: e.target.value || undefined })} />
    </div>
  )
}
