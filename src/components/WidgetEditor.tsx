import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  AreaChart, BarChart3, BarChartHorizontal, BoxSelect, Grid3x3, LineChart, PieChart, Plus, ScatterChart,
  Sigma, Table2, Trash2, X, LayoutGrid, Activity, Network, FunctionSquare, Map as MapIcon, MapPin, Type, Funnel, ChartColumnStacked, ChartColumnIncreasing, UsersRound,
} from 'lucide-react'
import type { Agg, Band, ChartType, ColType, Column, ColumnFormat, CondRule, Dataset, DateBucket, Measure, Note, NumFormat, RefLine, SortMode, Widget, WidgetSize } from '../types'
import { AGG_LABEL, BUCKET_LABEL, measureColumn, measureLabel, colMap, runGrouped } from '../lib/aggregate'
import { detectGeo, detectLatLon } from '../lib/geo'
import { defaultAgg, uid } from '../lib/suggest'
import { useStore } from '../store'
import { Button, cx, IconButton, SectionLabel, Segmented, Toggle } from './ui'
import { FilterEditor, ColumnPicker } from './FilterBar'
import { Popover } from './ui'
import { placeholderExamples } from '../lib/text'
import { CMP_LABEL } from '../lib/condfmt'
import { useRef } from 'react'

export const CHART_TYPES: { type: ChartType; label: string; icon: ReactNode; hint: string }[] = [
  { type: 'bar', label: 'Column', icon: <BarChart3 size={18} />, hint: 'Compare categories' },
  { type: 'hbar', label: 'Bar', icon: <BarChartHorizontal size={18} />, hint: 'Rank long labels' },
  { type: 'line', label: 'Line', icon: <LineChart size={18} />, hint: 'Trend over time' },
  { type: 'area', label: 'Area', icon: <AreaChart size={18} />, hint: 'Volume over time' },
  { type: 'donut', label: 'Donut', icon: <PieChart size={18} />, hint: 'Part of a whole' },
  { type: 'kpi', label: 'KPI', icon: <Activity size={18} />, hint: 'Single headline number' },
  { type: 'table', label: 'Table', icon: <Table2 size={18} />, hint: 'Grouped summary' },
  { type: 'scatter', label: 'Scatter', icon: <ScatterChart size={18} />, hint: 'Relationship of two numbers' },
  { type: 'histogram', label: 'Histogram', icon: <Sigma size={18} />, hint: 'Distribution of a number' },
  { type: 'box', label: 'Box plot', icon: <BoxSelect size={18} />, hint: 'Spread per group' },
  { type: 'heatmap', label: 'Heatmap', icon: <Grid3x3 size={18} />, hint: 'Two dimensions' },
  { type: 'treemap', label: 'Treemap', icon: <LayoutGrid size={18} />, hint: 'Many categories' },
  { type: 'correlation', label: 'Correlation', icon: <Network size={18} />, hint: 'Pairwise relationships' },
  { type: 'map', label: 'Map', icon: <MapIcon size={18} />, hint: 'Values by country or state' },
  { type: 'points', label: 'Point map', icon: <MapPin size={18} />, hint: 'Latitude / longitude' },
  { type: 'waterfall', label: 'Waterfall', icon: <ChartColumnStacked size={18} />, hint: 'What adds up to a total or change' },
  { type: 'pareto', label: 'Pareto', icon: <ChartColumnIncreasing size={18} />, hint: 'The few that make most of it' },
  { type: 'funnel', label: 'Funnel', icon: <Funnel size={18} />, hint: 'Stages and conversion' },
  { type: 'cohort', label: 'Cohort', icon: <UsersRound size={18} />, hint: 'Who comes back, by first period' },
  { type: 'text', label: 'Text', icon: <Type size={18} />, hint: 'Heading or note with live values' },
]

const AGGS: Agg[] = ['count', 'sum', 'avg', 'median', 'min', 'max', 'distinct', 'std', 'p90', 'p10']
const GROUP_ORDER: [ColType, string][] = [['date', 'Dates'], ['category', 'Categories'], ['boolean', 'Yes / No'], ['number', 'Numbers'], ['text', 'Text']]

function ColumnSelect({ ds, value, onChange, types, placeholder = 'None', allowNone = true, label }: {
  ds: Dataset; value?: string; onChange: (v: string | undefined) => void; types?: ColType[]; placeholder?: string; allowNone?: boolean; label?: string
}) {
  const cols = ds.columns.filter((c) => !types || types.includes(c.type))
  return (
    <select aria-label={label} className="field" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
      {allowNone && <option value="">{placeholder}</option>}
      {GROUP_ORDER.map(([t, label]) => {
        const g = cols.filter((c) => c.type === t)
        return g.length ? <optgroup key={t} label={label}>{g.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</optgroup> : null
      })}
    </select>
  )
}

/** A labelled control. `group` is for button sets (segmented controls): a <label> would name only the first button. */
function Field({ label, children, hint, group }: { label: string; children: ReactNode; hint?: string; group?: boolean }) {
  const body = (
    <>
      <span className="mb-1.5 block text-[12px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-3">{hint}</span>}
    </>
  )
  return group ? <div role="group" aria-label={label} className="block">{body}</div> : <label className="block">{body}</label>
}

function MeasureRow({ ds, m, onChange, onRemove }: { ds: Dataset; m: Measure; onChange: (m: Measure) => void; onRemove?: () => void }) {
  const numeric = ds.columns.filter((c) => c.type === 'number' || c.type === 'boolean')
  const calcs = ds.model.measures
  return (
    <div className="flex items-center gap-1.5">
      <select aria-label="Aggregation" className={cx('field shrink-0', m.agg === 'calc' ? 'flex-1' : 'w-[42%]')} value={m.agg === 'calc' ? `calc:${m.calc}` : m.agg} onChange={(e) => {
        const v = e.target.value
        if (v === '__new') { useStore.getState().openFormula(undefined, 'measure'); return }
        if (v.startsWith('calc:')) { onChange({ id: m.id, agg: 'calc', calc: v.slice(5) }); return }
        const agg = v as Agg
        if (agg === 'count') onChange({ id: m.id, agg, column: undefined })
        else onChange({ id: m.id, agg, column: m.column ?? (agg === 'distinct' ? ds.columns[0]?.key : numeric[0]?.key) })
      }}>
        <optgroup label="Aggregate a column">
          {AGGS.map((a) => <option key={a} value={a}>{a === 'count' ? 'Count rows' : AGG_LABEL[a]}</option>)}
        </optgroup>
        <optgroup label="Calculated measures">
          {calcs.map((d) => <option key={d.key} value={`calc:${d.key}`}>ƒ {d.name}</option>)}
          <option value="__new">+ New calculated measure…</option>
        </optgroup>
      </select>
      {m.agg !== 'count' && m.agg !== 'calc' && (
        <ColumnSelect label="Measure column" ds={ds} value={m.column} allowNone={false} types={m.agg === 'distinct' ? undefined : ['number', 'boolean']} onChange={(v) => onChange({ ...m, column: v })} />
      )}
      {onRemove && <IconButton label="Remove measure" onClick={onRemove} className="shrink-0"><X size={14} /></IconButton>}
    </div>
  )
}

/** When the chart type changes, carry fields across so the chart keeps showing the same data. */
function adapt(w: Widget, type: ChartType, ds: Dataset): Partial<Widget> {
  const nums = ds.columns.filter((c) => c.type === 'number')
  const firstNum = w.measures.find((m) => m.column)?.column ?? w.x ?? w.y ?? nums[0]?.key
  const dims = ds.columns.filter((c) => c.type === 'category' || c.type === 'boolean' || c.type === 'date')
  const p: Partial<Widget> = { type }
  if (type === 'scatter') { p.x = w.x ?? nums[0]?.key; p.y = w.y ?? nums.find((c) => c.key !== p.x)?.key }
  if (type === 'histogram') p.x = firstNum
  if (type === 'box') { p.y = w.y ?? firstNum; p.dimension = w.dimension ?? dims.find((c) => c.type !== 'date')?.key }
  if (type === 'correlation' && w.measures.filter((m) => m.column).length < 2) {
    p.measures = nums.slice(0, 6).map((c) => ({ id: uid('m'), column: c.key, agg: 'avg' }))
  }
  if (['bar', 'hbar', 'line', 'area', 'donut', 'treemap', 'table', 'heatmap', 'kpi', 'waterfall', 'pareto', 'funnel'].includes(type)) {
    if (!w.measures.length) p.measures = [firstNum ? { id: uid('m'), column: firstNum, agg: defaultAgg(ds.columns.find((c) => c.key === firstNum)!) } : { id: uid('m'), agg: 'count' }]
    if (type !== 'kpi' && !w.dimension) p.dimension = (type === 'line' || type === 'area' || type === 'waterfall' ? dims.find((c) => c.type === 'date') : undefined)?.key ?? dims[0]?.key
    if (type === 'pareto' || type === 'funnel') p.series = undefined
    if (type === 'kpi') { p.size = 'xs'; p.dimension = ds.columns.find((c) => c.type === 'date')?.key }
    else if (w.type === 'kpi') p.size = 'md'
  }
  if (type === 'heatmap' && !w.series) p.series = dims.find((c) => c.key !== (p.dimension ?? w.dimension) && c.type !== 'date')?.key
  if (type === 'map') {
    const geoCol = ds.columns.find((c) => detectGeo(c, ds.rows))
    p.dimension = geoCol?.key ?? w.dimension
    p.geo = geoCol ? detectGeo(geoCol, ds.rows)! : w.geo ?? 'world'
    if (!w.measures.length) p.measures = [{ id: uid('m'), agg: 'count' }]
    if (w.size === 'xs' || w.size === 'sm') p.size = 'lg'
  }
  if (type === 'cohort') {
    p.dimension = ds.columns.find((c) => c.type === 'date')?.key
    p.entity = w.entity ?? (ds.columns.find((c) => c.isId) ?? ds.columns.find((c) => (c.type === 'category' || c.type === 'text') && c.distinct > 50))?.key
    p.bucket = 'month'
    p.size = 'full'
  }
  if (type === 'points') {
    const ll = detectLatLon(ds.columns, ds.rows)
    p.x = ll?.lon ?? w.x
    p.y = ll?.lat ?? w.y
    p.geo = w.geo ?? 'world'
    if (w.size === 'xs' || w.size === 'sm') p.size = 'lg'
  }
  return p
}

export function WidgetEditor({ ds, widget }: { ds: Dataset; widget: Widget }) {
  const { updateWidget, edit, removeWidget } = useStore.getState()
  const set = (p: Partial<Widget>) => updateWidget(widget.id, p)
  const cols = colMap(ds)
  const dim = widget.dimension ? cols.get(widget.dimension) : undefined
  const t = widget.type
  const grouped = ['bar', 'hbar', 'line', 'area', 'donut', 'treemap', 'table', 'heatmap', 'waterfall', 'pareto', 'funnel'].includes(t)
  const single = t === 'waterfall' || t === 'pareto' || t === 'funnel'
  const multiMeasure = ['bar', 'hbar', 'line', 'area', 'table'].includes(t) && !widget.series
  const cartesian = ['bar', 'hbar', 'line', 'area'].includes(t)

  const setMeasure = (i: number, m: Measure) => {
    const ms = [...widget.measures]
    ms[i] = m
    set({ measures: ms })
  }

  const autoTitle = () => {
    const m = widget.measures[0]
    const ml = m ? measureLabel(m, cols) : ''
    const name = (k?: string) => (k ? cols.get(k)?.name : '') ?? ''
    switch (t) {
      case 'scatter': return `${name(widget.y)} vs ${name(widget.x)}`
      case 'histogram': return `Distribution of ${name(widget.x)}`
      case 'box': return `${name(widget.y)} spread by ${name(widget.dimension)}`
      case 'correlation': return 'Correlation matrix'
      case 'kpi': return ml
      default: return dim ? `${ml} by ${dim.name}${widget.series ? ` and ${name(widget.series)}` : ''}` : ml
    }
  }

  return createPortal(
    <aside className="slide-in fixed inset-y-0 right-0 z-30 flex w-full max-w-[380px] flex-col border-l border-line bg-surface shadow-pop">
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Edit widget</div>
          <div className="text-[15px] font-semibold">Customize</div>
        </div>
        <IconButton label="Close editor" onClick={() => edit(null)}><X size={16} /></IconButton>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
        <section className="space-y-3">
          <Field label="Title">
            <div className="flex gap-1.5">
              <input className="field" value={widget.title} onChange={(e) => set({ title: e.target.value })} />
              <Button size="sm" variant="ghost" className="h-9" title="Generate from fields" onClick={() => set({ title: autoTitle() })}>Auto</Button>
            </div>
          </Field>
          <Field label="Subtitle">
            <input className="field" value={widget.subtitle ?? ''} placeholder="Optional" onChange={(e) => set({ subtitle: e.target.value || undefined })} />
          </Field>
        </section>

        <section>
          <SectionLabel>Visualization</SectionLabel>
          <div className="grid grid-cols-4 gap-1.5">
            {CHART_TYPES.map((c) => (
              <button key={c.type} title={c.hint} onClick={() => set(adapt(widget, c.type, ds))}
                className={cx('flex flex-col items-center gap-1 rounded-xl border px-1 py-2.5 text-[11px] font-medium transition',
                  t === c.type ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line text-ink-2 hover:border-line-strong hover:text-ink')}>
                {c.icon}{c.label}
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <SectionLabel action={
            <button onClick={() => useStore.getState().openFormula()} className="inline-flex items-center gap-1 text-[12px] font-medium text-accent-ink hover:underline">
              <FunctionSquare size={13} />New computed column
            </button>
          }>Data</SectionLabel>

          {t === 'text' && <TextFields ds={ds} widget={widget} set={set} />}
          {t === 'cohort' && (
            <>
              <Field label="Date" hint="Each entity's cohort is the period it first appears in">
                <ColumnSelect label="Cohort date" ds={ds} value={widget.dimension} types={['date']} allowNone={false} onChange={(v) => set({ dimension: v })} />
              </Field>
              <Field label="Period">
                <select aria-label="Cohort period" className="field" value={widget.bucket && widget.bucket !== 'auto' ? widget.bucket : 'month'} onChange={(e) => set({ bucket: e.target.value as DateBucket })}>
                  {(['day', 'week', 'month', 'quarter', 'year'] as const).map((b) => <option key={b} value={b}>{BUCKET_LABEL[b]}</option>)}
                </select>
              </Field>
              <Field label="Follow" hint="What returns: a customer, user or account ID">
                <ColumnSelect label="Cohort entity" ds={ds} value={widget.entity} types={['category', 'text', 'number']} allowNone={false} onChange={(v) => set({ entity: v })} />
              </Field>
              <Field label="Show" group>
                <Segmented size="sm" value={widget.cohortMode ?? 'percent'} onChange={(v) => set({ cohortMode: v })} options={[{ value: 'percent', label: 'Retention %' }, { value: 'count', label: 'Active count' }]} />
              </Field>
            </>
          )}
          {(grouped || t === 'box') && (
            <Field label={t === 'heatmap' ? 'Columns (x-axis)' : t === 'table' ? 'Group rows by' : 'Group by'}>
              <ColumnSelect ds={ds} value={widget.dimension} placeholder="No grouping (total)" onChange={(v) => set({ dimension: v, bucket: v && cols.get(v)?.type === 'date' ? 'auto' : undefined })} />
            </Field>
          )}
          {t === 'kpi' && (
            <Field label="Trend date column" hint="Adds a sparkline and change vs the previous period">
              <ColumnSelect ds={ds} value={widget.dimension} types={['date']} onChange={(v) => set({ dimension: v })} />
            </Field>
          )}
          {dim?.type === 'date' && (grouped || t === 'box' || t === 'kpi') && (
            <Field label="Date granularity">
              <select className="field" value={widget.bucket ?? 'auto'} onChange={(e) => set({ bucket: e.target.value as DateBucket })}>
                {(Object.keys(BUCKET_LABEL) as DateBucket[]).map((b) => <option key={b} value={b}>{BUCKET_LABEL[b]}</option>)}
              </select>
            </Field>
          )}

          {(cartesian || t === 'heatmap') && (
            <Field label={t === 'heatmap' ? 'Rows (y-axis)' : 'Split into series'} hint={cartesian ? 'One color per value, up to 8 (the rest fold into “Other”)' : undefined}>
              <ColumnSelect ds={ds} value={widget.series} types={['category', 'boolean', 'date', 'number']} placeholder="No split" onChange={(v) => set({ series: v, measures: v ? widget.measures.slice(0, 1) : widget.measures })} />
            </Field>
          )}

          {(grouped || t === 'kpi') && (
            <div>
              <span className="mb-1.5 block text-[12px] font-medium text-ink-2">{multiMeasure ? 'Measures' : 'Measure'}</span>
              <div className="space-y-1.5">
                {(widget.measures.length ? widget.measures : [{ id: 'new', agg: 'count' as Agg }]).map((m, i) => (
                  <MeasureRow key={m.id} ds={ds} m={m} onChange={(nm) => setMeasure(i, nm)}
                    onRemove={widget.measures.length > 1 ? () => set({ measures: widget.measures.filter((_, j) => j !== i) }) : undefined} />
                ))}
              </div>
              {multiMeasure && widget.measures.length < 6 && (
                <button className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-accent-ink hover:underline"
                  onClick={() => {
                    const used = new Set(widget.measures.map((m) => m.column))
                    const next = ds.columns.find((c) => c.type === 'number' && !used.has(c.key))
                    set({ measures: [...widget.measures, next ? { id: uid('m'), column: next.key, agg: defaultAgg(next) } : { id: uid('m'), agg: 'count' }] })
                  }}>
                  <Plus size={13} />Add measure
                </button>
              )}
              {multiMeasure && widget.measures.length > 1 && cartesian && (
                <p className="mt-1.5 text-[11px] text-ink-3">Measures share one axis — combine only those on a similar scale.</p>
              )}
            </div>
          )}

          {t === 'scatter' && (
            <>
              <Field label="X axis"><ColumnSelect ds={ds} value={widget.x} types={['number']} allowNone={false} onChange={(v) => set({ x: v })} /></Field>
              <Field label="Y axis"><ColumnSelect ds={ds} value={widget.y} types={['number']} allowNone={false} onChange={(v) => set({ y: v })} /></Field>
              <Field label="Color by" hint="Up to 3 groups stay distinguishable; the rest fold into “Other”"><ColumnSelect ds={ds} value={widget.color} types={['category', 'boolean']} onChange={(v) => set({ color: v })} /></Field>
            </>
          )}
          {t === 'histogram' && (
            <>
              <Field label="Column"><ColumnSelect ds={ds} value={widget.x} types={['number']} allowNone={false} onChange={(v) => set({ x: v })} /></Field>
              <Field label={`Target bins · ${widget.bins ?? 20}`}>
                <input type="range" min={5} max={60} value={widget.bins ?? 20} onChange={(e) => set({ bins: +e.target.value })} className="w-full accent-[var(--accent)]" />
              </Field>
            </>
          )}
          {t === 'box' && (
            <Field label="Value"><ColumnSelect ds={ds} value={widget.y} types={['number']} allowNone={false} onChange={(v) => set({ y: v })} /></Field>
          )}
          {t === 'correlation' && (
            <div>
              <span className="mb-1.5 block text-[12px] font-medium text-ink-2">Numeric columns</span>
              <div className="max-h-56 space-y-0.5 overflow-auto rounded-lg border border-line p-1.5">
                {ds.columns.filter((c) => c.type === 'number').map((c) => {
                  const on = widget.measures.some((m) => m.column === c.key)
                  return (
                    <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-surface-3">
                      <input type="checkbox" checked={on} className="accent-[var(--accent)]" onChange={() => set({
                        measures: on ? widget.measures.filter((m) => m.column !== c.key) : [...widget.measures, { id: uid('m'), column: c.key, agg: 'avg' }],
                      })} />
                      {c.name}
                    </label>
                  )
                })}
              </div>
            </div>
          )}
          {t === 'map' && (
            <>
              <Field label="Region column" hint="Country names or codes, or US states (names or two-letter codes)">
                <ColumnSelect label="Region column" ds={ds} value={widget.dimension} types={['category', 'text']} allowNone={false} onChange={(v) => {
                  const c = v ? cols.get(v) : undefined
                  set({ dimension: v, geo: c ? detectGeo(c, ds.rows) ?? widget.geo ?? 'world' : widget.geo })
                }} />
              </Field>
              <Field label="Map" group>
                <Segmented size="sm" value={widget.geo ?? 'world'} onChange={(geo) => set({ geo })} options={[{ value: 'world', label: 'World' }, { value: 'usa', label: 'US states' }]} />
              </Field>
              <div>
                <span className="mb-1.5 block text-[12px] font-medium text-ink-2">Color by</span>
                <MeasureRow ds={ds} m={widget.measures[0] ?? { id: 'm', agg: 'count' }} onChange={(nm) => set({ measures: [nm] })} />
              </div>
            </>
          )}
          {t === 'points' && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Latitude"><ColumnSelect label="Latitude" ds={ds} value={widget.y} types={['number']} allowNone={false} onChange={(v) => set({ y: v })} /></Field>
                <Field label="Longitude"><ColumnSelect label="Longitude" ds={ds} value={widget.x} types={['number']} allowNone={false} onChange={(v) => set({ x: v })} /></Field>
              </div>
              <Field label="Map" group>
                <Segmented size="sm" value={widget.geo ?? 'world'} onChange={(geo) => set({ geo })} options={[{ value: 'world', label: 'World' }, { value: 'usa', label: 'United States' }]} />
              </Field>
              <Field label="Size by"><ColumnSelect label="Size by" ds={ds} value={widget.sizeBy} types={['number']} placeholder="Same size" onChange={(v) => set({ sizeBy: v })} /></Field>
              <Field label="Color by" hint="Up to 3 groups; the rest fold into “Other”"><ColumnSelect label="Color by" ds={ds} value={widget.color} types={['category', 'boolean']} onChange={(v) => set({ color: v })} /></Field>
            </>
          )}
        </section>

        {(grouped || t === 'scatter') && (
          <section className="space-y-3">
            <SectionLabel>Options</SectionLabel>
            {grouped && t !== 'heatmap' && t !== 'treemap' && t !== 'pareto' && !(t === 'waterfall' && dim?.type === 'date') && (
              <Field label="Sort">
                <select className="field" value={widget.sort ?? (dim?.type === 'date' || dim?.type === 'number' ? 'natural' : 'value-desc')} onChange={(e) => set({ sort: e.target.value as SortMode })}>
                  <option value="value-desc">Value · high to low</option>
                  <option value="value-asc">Value · low to high</option>
                  <option value="label-asc">Label · A to Z</option>
                  <option value="label-desc">Label · Z to A</option>
                  <option value="natural">Natural order</option>
                </select>
              </Field>
            )}
            {grouped && dim?.type !== 'date' && t !== 'heatmap' && (
              <Field label="Show top">
                <select className="field" value={widget.limit ?? 0} onChange={(e) => set({ limit: +e.target.value || undefined })}>
                  <option value={0}>All categories</option>
                  {[5, 7, 10, 12, 15, 20, 25, 50].map((n) => <option key={n} value={n}>Top {n} + Other</option>)}
                </select>
              </Field>
            )}
            <div className="divide-y divide-line rounded-xl border border-line px-3">
              {cartesian && widget.series && <Toggle label="Stacked" checked={!!widget.stacked} onChange={(v) => set({ stacked: v })} />}
              {cartesian && (widget.series || widget.measures.length > 1) && <Toggle label="100% (share of total)" checked={!!widget.normalized} onChange={(v) => set({ normalized: v })} />}
              {cartesian && <Toggle label="Cumulative (running total)" checked={!!widget.cumulative} onChange={(v) => set({ cumulative: v })} />}
              {(t === 'line' || t === 'area') && <Toggle label="Moving-average trend" checked={!!widget.trend} onChange={(v) => set({ trend: v })} />}
              {t === 'scatter' && <Toggle label="Linear regression line" checked={!!widget.trend} onChange={(v) => set({ trend: v })} />}
              {cartesian && <Toggle label="Value labels" checked={!!widget.labels} onChange={(v) => set({ labels: v })} />}
            </div>
          </section>
        )}

        {t === 'kpi' && (
          <section className="space-y-3">
            <SectionLabel>Value &amp; comparison</SectionLabel>
            {widget.dimension && (
              <Field label="Show" hint="Use “latest period” for levels like population, price or balance that shouldn’t be added up over time" group>
                <Segmented size="sm" value={widget.kpiMode ?? 'total'} onChange={(v) => set({ kpiMode: v })} options={[{ value: 'total', label: 'Total of all rows' }, { value: 'latest', label: 'Latest period' }]} />
              </Field>
            )}
            {widget.dimension && (
              <Field label="Compare with">
                <select aria-label="Compare with" className="field" value={widget.compare ?? 'previous'} onChange={(e) => set({ compare: e.target.value as Widget['compare'] })}>
                  <option value="previous">Previous period</option>
                  <option value="yoy">Same period last year</option>
                  <option value="none">No comparison</option>
                </select>
              </Field>
            )}
            <Field label="An increase is" group>
              <Segmented size="sm" value={widget.upIsGood == null ? 'neutral' : widget.upIsGood ? 'good' : 'bad'}
                onChange={(v) => set({ upIsGood: v === 'neutral' ? undefined : v === 'good' })}
                options={[{ value: 'neutral', label: 'Neutral' }, { value: 'good', label: 'Good' }, { value: 'bad', label: 'Bad' }]} />
            </Field>
            <Field label="Target" hint="Shows progress toward a goal">
              <input aria-label="Target" type="number" className="field" value={widget.target ?? ''} placeholder="None" onChange={(e) => set({ target: e.target.value === '' ? undefined : +e.target.value })} />
            </Field>
          </section>
        )}

        {cartesian && dim?.type === 'date' && (
          <section className="space-y-3">
            <SectionLabel>Time analysis</SectionLabel>
            {!widget.series && (
              <Field label="Compare with" hint="Adds a dashed series for the comparison period">
                <select aria-label="Compare with" className="field" value={widget.compare ?? 'none'} onChange={(e) => set({ compare: e.target.value as Widget['compare'] })}>
                  <option value="none">Nothing</option>
                  <option value="yoy">Same period last year</option>
                  <option value="previous">Previous period</option>
                </select>
              </Field>
            )}
            {!widget.series && !widget.stacked && (
              <Field label="Forecast ahead" hint="Seasonal model with a 95% confidence band">
                <select aria-label="Forecast" className="field" value={widget.forecast ?? 0} onChange={(e) => set({ forecast: +e.target.value || undefined })}>
                  <option value={0}>No forecast</option>
                  {[3, 6, 12, 24].map((n) => <option key={n} value={n}>{n} periods</option>)}
                </select>
              </Field>
            )}
            {!widget.series && <div className="rounded-xl border border-line px-3"><Toggle label="Flag anomalies" checked={!!widget.anomalies} onChange={(v) => set({ anomalies: v })} /></div>}
          </section>
        )}

        {cartesian && <Annotations ds={ds} widget={widget} set={set} />}
        {t === 'table' && <TableFormatFields ds={ds} widget={widget} set={set} />}

        {(cartesian || t === 'donut' || t === 'scatter' || t === 'histogram' || t === 'box' || t === 'treemap' || t === 'points' || t === 'table') && (
          <section className="space-y-3">
            <SectionLabel>More</SectionLabel>
            {(cartesian || t === 'donut' || t === 'scatter' || t === 'histogram' || t === 'box' || t === 'treemap') && (
              <Field label="Small multiples" hint="One mini chart per value (up to 12), sharing one axis">
                <ColumnSelect label="Small multiples" ds={ds} value={widget.facet} types={['category', 'boolean', 'date']} placeholder="Off" onChange={(v) => set({ facet: v })} />
              </Field>
            )}
            {grouped && !single && dim && dim.type !== 'date' && t !== 'table' && (
              <Field label="Double-click drills into" hint="Double-clicking a bar filters to it and regroups by this column. Date axes drill year → quarter → month automatically.">
                <ColumnSelect label="Drill into" ds={ds} value={widget.drillTo} placeholder="Nothing" onChange={(v) => set({ drillTo: v, drill: undefined })} />
              </Field>
            )}
            {(t === 'scatter' || t === 'points' || cartesian) && (
              <Field label="Extra tooltip fields" hint={cartesian ? 'Shown for each bar or point: numbers summed or averaged, categories as their most common value' : undefined}>
                <div className="max-h-36 space-y-0.5 overflow-auto rounded-lg border border-line p-1.5">
                  {ds.columns.filter((c) => c.key !== widget.x && c.key !== widget.y && c.key !== widget.dimension && !widget.measures.some((m) => m.column === c.key)).map((c) => {
                    const on = widget.tooltipFields?.includes(c.key)
                    return (
                      <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-surface-3">
                        <input type="checkbox" checked={!!on} className="accent-[var(--accent)]" onChange={() => set({ tooltipFields: on ? widget.tooltipFields!.filter((k) => k !== c.key) : [...(widget.tooltipFields ?? []), c.key].slice(0, 6) })} />
                        {c.name}
                      </label>
                    )
                  })}
                </div>
              </Field>
            )}
            {t !== 'scatter' && t !== 'points' && t !== 'histogram' && t !== 'box' && <FormatFields value={widget.format} onChange={(format) => set({ format })} />}
          </section>
        )}
        {t === 'kpi' && <section className="space-y-3"><SectionLabel>Number format</SectionLabel><FormatFields value={widget.format} onChange={(format) => set({ format })} /></section>}

        <section>
          <SectionLabel>Width</SectionLabel>
          <Segmented<WidgetSize> size="sm" value={widget.size} onChange={(size) => set({ size })} options={[
            { value: 'xs', label: '¼' }, { value: 'sm', label: '⅓' }, { value: 'md', label: '½' }, { value: 'lg', label: '⅔' }, { value: 'full', label: 'Full' },
          ]} />
        </section>

        <section>
          <SectionLabel action={
            <Popover align="right" width={260} trigger={(_, toggle) => <button onClick={toggle} className="inline-flex items-center gap-1 text-[12px] font-medium text-accent-ink hover:underline"><Plus size={13} />Add</button>}>
              {(close) => <ColumnPicker ds={ds} onPick={(c: Column) => { set({ filters: [...(widget.filters ?? []), { id: uid('f'), column: c.key }] }); close() }} />}
            </Popover>
          }>Widget filters</SectionLabel>
          {!widget.filters?.length && <p className="text-[12px] text-ink-3">Applies only to this widget, on top of dashboard filters.</p>}
          <div className="space-y-2">
            {widget.filters?.map((f) => {
              const c = cols.get(f.column)
              if (!c) return null
              return (
                <div key={f.id} className="rounded-xl border border-line p-1.5">
                  <FilterEditor ds={ds} col={c} filter={f} onChange={(nf) => set({ filters: widget.filters!.map((x) => (x.id === f.id ? nf : x)) })} />
                  <button className="mt-1 inline-flex items-center gap-1 px-1 text-[12px] text-ink-3 hover:text-bad" onClick={() => set({ filters: widget.filters!.filter((x) => x.id !== f.id) })}><Trash2 size={12} />Remove filter</button>
                </div>
              )
            })}
          </div>
        </section>
      </div>

      <div className="flex items-center justify-between border-t border-line px-5 py-3">
        <Button variant="danger" size="sm" onClick={() => removeWidget(widget.id)}><Trash2 size={14} />Remove</Button>
        <Button variant="primary" size="sm" onClick={() => edit(null)}>Done</Button>
      </div>
    </aside>,
    document.body,
  )
}

/** Data bars, a color scale and value rules for table widgets. */
function TableFormatFields({ ds, widget, set }: { ds: Dataset; widget: Widget; set: (p: Partial<Widget>) => void }) {
  const cols = colMap(ds)
  const tf = widget.tableFormat ?? {}
  const rules = tf.rules ?? []
  const upd = (p: Partial<NonNullable<Widget['tableFormat']>>) => set({ tableFormat: { ...tf, ...p } })
  const setRule = (id: string, p: Partial<CondRule>) => upd({ rules: rules.map((r) => (r.id === id ? { ...r, ...p } : r)) })
  // ratio measures (0.25 shown as 25%) take rules in percent, so the number typed matches the number shown
  const isRatio = (m?: Measure) => !!m && (measureColumn(m, cols)?.display?.num ?? widget.format?.num ?? measureColumn(m, cols)?.format) === 'ratio'
  const scaleOf = (r: CondRule) => {
    const ms = r.measure ? widget.measures.filter((m) => m.id === r.measure) : widget.measures
    return ms.length && ms.every(isRatio) ? 100 : 1
  }
  const shown = (v: number | undefined, k: number) => (v == null || !Number.isFinite(v) ? '' : +(v * k).toPrecision(12))
  const typed = (s: string, k: number) => (s === '' ? NaN : +s / k)
  return (
    <section className="space-y-3">
      <SectionLabel>Conditional formatting</SectionLabel>
      <div className="divide-y divide-line rounded-xl border border-line px-3">
        <Toggle label="Data bars" checked={tf.bars !== false} onChange={(v) => upd({ bars: v ? undefined : false })} />
        <Toggle label="Color scale (light → dark by value)" checked={!!tf.scale} onChange={(v) => upd({ scale: v || undefined })} />
      </div>
      <div className="space-y-2">
        {rules.map((r) => (
          <div key={r.id} className="space-y-1.5 rounded-xl border border-line p-2">
            <div className="flex items-center gap-1.5">
              <select aria-label="Rule measure" className="field" value={r.measure ?? ''} onChange={(e) => setRule(r.id, { measure: e.target.value || undefined })}>
                <option value="">Any measure</option>
                {widget.measures.map((m) => <option key={m.id} value={m.id}>{measureLabel(m, cols)}</option>)}
              </select>
              <IconButton label="Remove rule" onClick={() => upd({ rules: rules.filter((x) => x.id !== r.id) })}><X size={14} /></IconButton>
            </div>
            <div className="flex items-center gap-1.5">
              <select aria-label="Rule comparison" className="field w-28 shrink-0" value={r.cmp} onChange={(e) => setRule(r.id, { cmp: e.target.value as CondRule['cmp'] })}>
                {(Object.keys(CMP_LABEL) as CondRule['cmp'][]).map((c) => <option key={c} value={c}>{CMP_LABEL[c]}</option>)}
              </select>
              <input aria-label="Rule value" type="number" className="field" value={shown(r.value, scaleOf(r))} onChange={(e) => setRule(r.id, { value: typed(e.target.value, scaleOf(r)) })} />
              {r.cmp === 'between' && <><span className="text-[12px] text-ink-3">and</span><input aria-label="Rule second value" type="number" className="field" value={shown(r.value2, scaleOf(r))} onChange={(e) => { const v = typed(e.target.value, scaleOf(r)); setRule(r.id, { value2: Number.isFinite(v) ? v : undefined }) }} /></>}
              {scaleOf(r) === 100 && <span className="text-[12px] text-ink-3">%</span>}
            </div>
            <Segmented<CondRule['tone']> size="sm" value={r.tone} onChange={(tone) => setRule(r.id, { tone })} options={[{ value: 'good', label: 'Good' }, { value: 'warning', label: 'Warning' }, { value: 'bad', label: 'Bad' }]} />
          </div>
        ))}
      </div>
      <button className="inline-flex items-center gap-1 text-[12px] font-medium text-accent-ink hover:underline" onClick={() => upd({ rules: [...rules, { id: uid('c'), cmp: 'lt', value: 0, tone: 'bad' }] })}><Plus size={13} />Add rule</button>
      {rules.length > 0 && <p className="text-[11px] text-ink-3">The first matching rule wins. Values are compared as shown in the table (percent measures in %).</p>}
    </section>
  )
}

/** Text widget source with clickable placeholder examples. */
function TextFields({ ds, widget, set }: { ds: Dataset; widget: Widget; set: (p: Partial<Widget>) => void }) {
  const area = useRef<HTMLTextAreaElement>(null)
  const insert = (token: string) => {
    const el = area.current
    const text = widget.text ?? ''
    const at = el ? el.selectionStart : text.length
    set({ text: text.slice(0, at) + token + text.slice(el ? el.selectionEnd : at) })
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + token.length, at + token.length) })
  }
  return (
    <div className="space-y-2">
      <Field label="Text" hint="# Heading, ## Subheading, - bullet, **bold**, *italic*. Values in {braces} update with the data and the filters.">
        <textarea ref={area} aria-label="Text" rows={7} className="field h-auto py-2 font-mono text-[12.5px] leading-relaxed" value={widget.text ?? ''} onChange={(e) => set({ text: e.target.value })} />
      </Field>
      <div className="flex flex-wrap gap-1">
        {placeholderExamples(ds).map((p) => (
          <button key={p} onClick={() => insert(p)} className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-2 hover:border-accent hover:text-accent-ink">{p}</button>
        ))}
      </div>
      <p className="text-[11px] text-ink-3">A column name gives its sum or average; prefix it with avg, sum, min, max, median or count distinct to choose. Widget filters below narrow the values (e.g. latest month).</p>
    </div>
  )
}

/** Reference lines, notes and shaded bands for cartesian charts. */
function Annotations({ ds, widget, set }: { ds: Dataset; widget: Widget; set: (p: Partial<Widget>) => void }) {
  const categories = (() => {
    try { return runGrouped(ds, { ...widget, forecast: undefined, compare: 'none' }).categories.slice(0, 400) } catch { return [] }
  })()
  const lines = widget.refLines ?? []
  const notes = widget.notes ?? []
  const bands = widget.bands ?? []
  return (
    <section className="space-y-3">
      <SectionLabel>Annotations</SectionLabel>
      <div className="space-y-1.5">
        {lines.map((r) => (
          <div key={r.id} className="flex items-center gap-1.5">
            <select aria-label="Reference line type" className="field w-28 shrink-0" value={r.kind} onChange={(e) => set({ refLines: lines.map((x) => (x.id === r.id ? { ...x, kind: e.target.value as RefLine['kind'] } : x)) })}>
              <option value="avg">Average</option><option value="median">Median</option><option value="value">Value</option>
            </select>
            {r.kind === 'value' && <input aria-label="Reference value" type="number" className="field w-24" value={r.value ?? ''} onChange={(e) => set({ refLines: lines.map((x) => (x.id === r.id ? { ...x, value: e.target.value === '' ? undefined : +e.target.value } : x)) })} />}
            <input aria-label="Reference label" className="field" placeholder="Label" value={r.label ?? ''} onChange={(e) => set({ refLines: lines.map((x) => (x.id === r.id ? { ...x, label: e.target.value || undefined } : x)) })} />
            <IconButton label="Remove line" onClick={() => set({ refLines: lines.filter((x) => x.id !== r.id) })}><X size={14} /></IconButton>
          </div>
        ))}
        {notes.map((n) => (
          <div key={n.id} className="flex items-center gap-1.5">
            <select aria-label="Note position" className="field w-32 shrink-0" value={n.at} onChange={(e) => set({ notes: notes.map((x) => (x.id === n.id ? { ...x, at: e.target.value } : x)) })}>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <input aria-label="Note text" className="field" placeholder="Note" value={n.text} onChange={(e) => set({ notes: notes.map((x) => (x.id === n.id ? { ...x, text: e.target.value } : x)) })} />
            <IconButton label="Remove note" onClick={() => set({ notes: notes.filter((x) => x.id !== n.id) })}><X size={14} /></IconButton>
          </div>
        ))}
        {bands.map((b) => (
          <div key={b.id} className="flex items-center gap-1.5">
            <select aria-label="Band start" className="field w-28 shrink-0" value={b.from} onChange={(e) => set({ bands: bands.map((x) => (x.id === b.id ? { ...x, from: e.target.value } : x)) })}>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <span className="text-[12px] text-ink-3">to</span>
            <select aria-label="Band end" className="field w-28 shrink-0" value={b.to} onChange={(e) => set({ bands: bands.map((x) => (x.id === b.id ? { ...x, to: e.target.value } : x)) })}>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <input aria-label="Band label" className="field" placeholder="Label" value={b.label ?? ''} onChange={(e) => set({ bands: bands.map((x) => (x.id === b.id ? { ...x, label: e.target.value || undefined } : x)) })} />
            <IconButton label="Remove band" onClick={() => set({ bands: bands.filter((x) => x.id !== b.id) })}><X size={14} /></IconButton>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-[12px] font-medium text-accent-ink">
        <button className="inline-flex items-center gap-1 hover:underline" onClick={() => set({ refLines: [...lines, { id: uid('r'), kind: 'avg' }] })}><Plus size={13} />Reference line</button>
        {categories.length > 0 && <button className="inline-flex items-center gap-1 hover:underline" onClick={() => set({ notes: [...notes, { id: uid('n'), at: categories[0], text: 'Note' } satisfies Note] })}><Plus size={13} />Note</button>}
        {categories.length > 1 && <button className="inline-flex items-center gap-1 hover:underline" onClick={() => set({ bands: [...bands, { id: uid('b'), from: categories[0], to: categories[Math.min(2, categories.length - 1)] } satisfies Band] })}><Plus size={13} />Shaded range</button>}
      </div>
      {widget.type !== 'kpi' && (
        <Field label="Target line">
          <input aria-label="Target line" type="number" className="field" value={widget.target ?? ''} placeholder="None" onChange={(e) => set({ target: e.target.value === '' ? undefined : +e.target.value })} />
        </Field>
      )}
    </section>
  )
}

/** Per-widget number display: format, decimals, short numbers, prefix/suffix. */
function FormatFields({ value, onChange }: { value?: ColumnFormat; onChange: (f: ColumnFormat | undefined) => void }) {
  const f = value ?? {}
  const upd = (p: Partial<ColumnFormat>) => {
    const next = { ...f, ...p }
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== '')) as ColumnFormat
    onChange(Object.keys(clean).length ? clean : undefined)
  }
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Values as">
          <select aria-label="Values as" className="field" value={f.num ?? ''} onChange={(e) => upd({ num: (e.target.value || undefined) as NumFormat | undefined })}>
            <option value="">Column default</option>
            <option value="integer">Number</option>
            <option value="decimal">Decimal</option>
            <option value="currency">Currency</option>
            <option value="percent">Percent (value is %)</option>
            <option value="ratio">Percent (ratio ×100)</option>
          </select>
        </Field>
        <Field label="Decimals">
          <select aria-label="Decimals" className="field" value={f.decimals ?? ''} onChange={(e) => upd({ decimals: e.target.value === '' ? undefined : +e.target.value })}>
            <option value="">Auto</option>
            {[0, 1, 2, 3, 4].map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Prefix"><input aria-label="Prefix" className="field" value={f.prefix ?? ''} onChange={(e) => upd({ prefix: e.target.value || undefined })} /></Field>
        <Field label="Suffix"><input aria-label="Suffix" className="field" value={f.suffix ?? ''} onChange={(e) => upd({ suffix: e.target.value || undefined })} /></Field>
        {f.num === 'currency' ? <Field label="Symbol"><input aria-label="Currency symbol" className="field" value={f.currency ?? ''} placeholder="$" onChange={(e) => upd({ currency: e.target.value || undefined })} /></Field> : <span />}
      </div>
      <div className="rounded-xl border border-line px-3"><Toggle label="Short numbers (1.2K, 3.4M)" checked={f.compact !== false} onChange={(v) => upd({ compact: v ? undefined : false })} /></div>
    </div>
  )
}
