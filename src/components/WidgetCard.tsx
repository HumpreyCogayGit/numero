import { memo, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  Copy, Download, GripVertical, Image, MoreHorizontal, Pencil, Sheet, Table2, Trash2, BarChart3, Maximize2, SearchX,
  Expand, ChevronLeft, AlertTriangle, LayoutGrid, Rows3, CircleCheck, OctagonAlert, Filter as FilterIcon, ZoomIn,
} from 'lucide-react'
import type { Dataset, Filter, Widget, WidgetSize } from '../types'
import { buildChart, type BuiltChart } from '../lib/chartOptions'
import { TOKENS } from '../lib/palette'
import { downloadText, downloadUrl, slug, toCsv } from '../lib/hooks'
import { colMap, labelOf, measureColumn, missingColumns, runGrouped, runKpi } from '../lib/aggregate'
import { fmtNumber } from '../lib/format'
import { uid } from '../lib/suggest'
import { useStore } from '../store'
import { Chart, useTheme, type ChartEvent, type ChartHandle } from './Chart'
import { KpiTile } from './KpiTile'
import { hasInsights, renderText, type Span } from '../lib/text'
import { cellLook, describeRule } from '../lib/condfmt'
import { averageRetention, cohortCellFilters, runCohort, type CohortRow } from '../lib/cohort'
import { inkOn } from '../lib/palette'
import { Button, cx, Empty, IconButton, MenuItem, Modal, Popover } from './ui'

export const SPAN: Record<WidgetSize, string> = {
  xs: 'col-span-12 sm:col-span-6 xl:col-span-3',
  sm: 'col-span-12 lg:col-span-4',
  md: 'col-span-12 lg:col-span-6',
  lg: 'col-span-12 lg:col-span-8',
  full: 'col-span-12',
}
const SIZES: WidgetSize[] = ['xs', 'sm', 'md', 'lg', 'full']
const SIZE_LABEL: Record<WidgetSize, string> = { xs: 'Quarter', sm: 'Third', md: 'Half', lg: 'Two thirds', full: 'Full width' }
const SORT_CYCLE: NonNullable<Widget['sort']>[] = ['value-desc', 'value-asc', 'label-asc', 'natural']

/** Adds (or with shift, extends) a dashboard filter from a clicked mark; clicking the same mark again clears it. */
export function crossFilter(widget: Widget, f: Omit<Filter, 'id'>, filters: Filter[], extend: boolean): Filter[] {
  const same = (x: Filter) => x.column === f.column && x.fromWidget === widget.id
  const existing = filters.find(same)
  if (existing) {
    if (f.values && existing.values) {
      const v = f.values[0]
      const has = existing.values.includes(v)
      if (!extend && has && existing.values.length === 1) return filters.filter((x) => x !== existing)
      const values = extend ? (has ? existing.values.filter((x) => x !== v) : [...existing.values, v]) : [v]
      return values.length ? filters.map((x) => (x === existing ? { ...x, values } : x)) : filters.filter((x) => x !== existing)
    }
    if (existing.min === f.min && existing.max === f.max) return filters.filter((x) => x !== existing)
    return filters.map((x) => (x === existing ? { ...x, ...f, id: x.id, fromWidget: widget.id } : x))
  }
  return [...filters, { ...f, id: uid('f'), fromWidget: widget.id }]
}

export const WidgetCard = memo(function WidgetCard({ ds, widget, filters, selected, dragging, stale, onDragStart, onDragOver, onDrop, onMove }: {
  ds: Dataset
  widget: Widget
  filters: Filter[]
  selected: boolean
  dragging: boolean
  /** filters changed and this card is still showing the previous result */
  stale?: boolean
  onDragStart: () => void
  onDragOver: () => void
  onDrop: () => void
  onMove: (dir: -1 | 1) => void
}) {
  const { edit, removeWidget, duplicateWidget, updateWidget, setFilters, setFullscreen, showRows } = useStore.getState()
  const [asTable, setAsTable] = useState(false)
  const [handleHover, setHandleHover] = useState(false)
  const chartRef = useRef<ChartHandle>(null)
  const theme = useTheme()
  const isKpi = widget.type === 'kpi'
  const isTable = widget.type === 'table'
  const isText = widget.type === 'text'
  const isCohort = widget.type === 'cohort'
  const cols = colMap(ds)
  const missing = useMemo(() => missingColumns(widget, cols), [widget, cols])
  const faceted = !!widget.facet && cols.has(widget.facet) && !isKpi && !isTable && widget.type !== 'map' && widget.type !== 'points'

  // untitled text widgets are named after their first line ("Text: Jun 2025 at a glance"), not just "Text"
  const textName = useMemo(() => {
    if (!isText || widget.title) return ''
    const b = renderText(ds, widget, filters)[0]
    return b ? (b.kind === 'ul' ? b.items[0] ?? [] : b.spans).map((x) => x.text).join('').slice(0, 80) : ''
  }, [isText, ds, widget, filters])

  const built = useMemo(
    () => (isKpi || isTable || isText || isCohort || faceted || missing.length ? null : buildChart(ds, widget, filters, TOKENS[theme])),
    [ds, widget, filters, theme, isKpi, isTable, isText, isCohort, faceted, missing.length],
  )

  const onChartClick = (e: ChartEvent) => {
    if (e.componentType === 'xAxis' || e.componentType === 'yAxis') {
      // clicking a category label cycles the sort order
      const i = SORT_CYCLE.indexOf(widget.sort ?? 'value-desc')
      updateWidget(widget.id, { sort: SORT_CYCLE[(i + 1) % SORT_CYCLE.length] })
      return
    }
    const f = built?.interact?.filterAt?.(e.dataIndex, e.seriesIndex)
    if (!f) return
    setFilters(crossFilter(widget, f, filters, !!e.event?.event?.shiftKey))
  }
  const onChartDbl = (e: ChartEvent) => {
    const level = built?.interact?.drillAt?.(e.dataIndex)
    if (level) updateWidget(widget.id, { drill: [...(widget.drill ?? []), level] })
  }
  // right-click a mark: the rows behind it
  const onChartContext = (e: ChartEvent) => { if (built) contextRows(built, widget, e) }
  const drillUp = () => updateWidget(widget.id, { drill: widget.drill?.slice(0, -1) })

  const exportCsv = () => {
    const tbl = built?.table ?? (isTable ? tableData(ds, widget, filters) : isCohort ? cohortTable(ds, widget, filters) : null)
    if (tbl) downloadText(`${slug(widget.title)}.csv`, toCsv(tbl.headers, tbl.rows))
  }

  // keyboard: Alt+←/→ moves, Alt+Shift+←/→ resizes, Enter edits
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter') { e.preventDefault(); edit(widget.id); return }
    if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    const dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1
    if (e.shiftKey) {
      const i = SIZES.indexOf(widget.size)
      updateWidget(widget.id, { size: SIZES[Math.max(0, Math.min(SIZES.length - 1, i + dir))] })
    } else onMove(dir)
  }

  const drillLabel = widget.drill?.length ? widget.drill.map((d) => describeDrill(d.filter, ds)).join(' › ') : null
  const crossFromHere = filters.some((f) => f.fromWidget === widget.id)

  return (
    <div
      tabIndex={0}
      data-widget={widget.id}
      data-size={widget.size}
      role="group"
      aria-label={`${widget.title || (isText ? `Text: ${textName || 'empty'}` : 'Widget')}. Press Enter to edit, Alt+arrows to move, Alt+Shift+arrows to resize.`}
      onKeyDown={onKey}
      className={cx(
        'card fade-up group relative flex flex-col outline-none transition focus-visible:ring-2 focus-visible:ring-accent/60',
        SPAN[widget.size],
        selected && 'ring-2 ring-accent/60',
        dragging && 'opacity-40',
      )}
      draggable={handleHover}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart() }}
      onDragOver={(e) => { e.preventDefault(); onDragOver() }}
      onDrop={(e) => { e.preventDefault(); onDrop() }}
      onDragEnd={() => setHandleHover(false)}
    >
      <div className={cx('flex items-start gap-1 px-4', isText && !widget.title ? 'absolute inset-x-0 top-0 z-10 pt-2' : 'pb-1 pt-3.5')}>
        <button
          className="-ml-2 mt-0.5 cursor-grab rounded p-0.5 text-ink-3 opacity-0 transition hover:text-ink group-hover:opacity-100 active:cursor-grabbing"
          onMouseEnter={() => setHandleHover(true)}
          onMouseLeave={() => setHandleHover(false)}
          aria-label="Drag to reorder"
          tabIndex={-1}
        >
          <GripVertical size={14} />
        </button>
        <div className="min-w-0 flex-1 cursor-pointer" onClick={() => edit(widget.id)}>
          {(!isText || widget.title) && <h3 className={cx('truncate font-medium text-ink', isKpi ? 'text-[13px] text-ink-2' : 'text-[14px]')} title={widget.title}>{widget.title}</h3>}
          {!isKpi && (widget.subtitle || built?.note) && (
            <p className="truncate text-[12px] text-ink-3">{[widget.subtitle, built?.note].filter(Boolean).join('  ·  ')}</p>
          )}
        </div>
        <div className="-mr-1.5 -mt-1 flex items-center opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          {!isKpi && !isTable && !isText && !isCohort && !faceted && (
            <IconButton label={asTable ? 'Show chart' : 'Show data table'} onClick={() => setAsTable((v) => !v)}>
              {asTable ? <BarChart3 size={15} /> : <Table2 size={15} />}
            </IconButton>
          )}
          {!isKpi && !isText && <IconButton label="Fullscreen" onClick={() => setFullscreen(widget.id)}><Expand size={14} /></IconButton>}
          <IconButton label="Edit" onClick={() => edit(widget.id)}><Pencil size={14} /></IconButton>
          <Popover align="right" width={200} trigger={(_, toggle) => <IconButton label="More" onClick={toggle}><MoreHorizontal size={15} /></IconButton>}>
            {(close) => (
              <>
                {!isText && <MenuItem icon={<Rows3 size={14} />} onClick={() => {
                  // a "latest period" KPI shows one period, so its rows are that period's
                  const k = isKpi && widget.kpiMode === 'latest' ? runKpi(ds, widget, filters) : undefined
                  showRows({ widgetId: widget.id, filters: k?.periodFilter ? [k.periodFilter] : [], label: k?.periodFilter ? k.period : undefined })
                  close()
                }}>Show rows</MenuItem>}
                {!isKpi && !isText && <MenuItem icon={<Sheet size={14} />} onClick={() => { exportCsv(); close() }}>Download CSV</MenuItem>}
                {built && !asTable && (
                  <MenuItem icon={<Image size={14} />} onClick={() => {
                    const url = chartRef.current?.toPng(TOKENS[theme].surface)
                    if (url) downloadUrl(`${slug(widget.title)}.png`, url)
                    close()
                  }}>Download PNG</MenuItem>
                )}
                <MenuItem icon={<Copy size={14} />} onClick={() => { duplicateWidget(widget.id); close() }}>Duplicate</MenuItem>
                <div className="my-1 border-t border-line" />
                <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-ink-3"><Maximize2 size={11} className="mr-1 inline" />Width</div>
                <div className="grid grid-cols-5 gap-1 px-1.5 pb-1.5">
                  {SIZES.map((s) => (
                    <button key={s} title={SIZE_LABEL[s]} aria-label={`Width: ${SIZE_LABEL[s]}`} onClick={() => updateWidget(widget.id, { size: s })}
                      className={cx('h-7 rounded-md text-[11px] font-medium transition', widget.size === s ? 'bg-accent-fill text-white' : 'bg-surface-3 text-ink-2 hover:text-ink')}>
                      {{ xs: '¼', sm: '⅓', md: '½', lg: '⅔', full: '1' }[s]}
                    </button>
                  ))}
                </div>
                <div className="my-1 border-t border-line" />
                <MenuItem danger icon={<Trash2 size={14} />} onClick={() => { removeWidget(widget.id); close() }}>Remove</MenuItem>
              </>
            )}
          </Popover>
        </div>
      </div>

      {(drillLabel || crossFromHere) && !missing.length && (
        <div className="flex items-center gap-2 px-4 pb-1 text-[11.5px]">
          {drillLabel && (
            <button onClick={drillUp} className="inline-flex items-center gap-1 rounded-md bg-accent-soft px-1.5 py-0.5 font-medium text-accent-ink hover:brightness-95">
              <ChevronLeft size={12} />Drill up · {drillLabel}
            </button>
          )}
          {crossFromHere && <span className="text-ink-3">Filtering the dashboard — click the mark again to clear · right-click a mark to see its rows</span>}
        </div>
      )}

      <div className={cx('relative', stale && 'opacity-60 transition-opacity')}>
        {missing.length ? (
          <div className="flex h-[200px] flex-col items-center justify-center gap-2 px-6 text-center">
            <AlertTriangle size={20} className="text-[#c98500]" />
            <div className="text-[13px] font-medium">Missing column{missing.length > 1 ? 's' : ''}: {missing.join(', ')}</div>
            <div className="text-[12px] text-ink-3">It was deleted or renamed away. Pick another column to fix this chart.</div>
            <Button size="sm" onClick={() => edit(widget.id)}>Fix</Button>
          </div>
        ) : isText ? (
          <TextWidget ds={ds} widget={widget} filters={filters} />
        ) : isCohort ? (
          <CohortTable ds={ds} widget={widget} filters={filters} />
        ) : isKpi ? (
          <KpiTile ds={ds} widget={widget} filters={filters} />
        ) : isTable ? (
          <GroupTable ds={ds} widget={widget} filters={filters} />
        ) : faceted ? (
          <Facets ds={ds} widget={widget} filters={filters} />
        ) : built?.empty ? (
          <div className="h-[290px]"><Empty icon={<SearchX size={18} />} title="Nothing to show">{built.note ?? 'Pick different fields or loosen the filters.'}</Empty></div>
        ) : asTable && built ? (
          <div className="h-[290px] overflow-auto px-4 pb-4">
            <MiniTable headers={built.table.headers} rows={built.table.rows} actions={rowActions(built, widget, filters)} />
          </div>
        ) : built ? (
          <div className={cx('px-3 pb-3', widget.size === 'full' && (widget.type === 'heatmap' || widget.type === 'map' || widget.type === 'points') ? 'h-[380px]' : widget.type === 'map' || widget.type === 'points' ? 'h-[330px]' : 'h-[290px]')}>
            <Chart ref={chartRef} option={built.option} label={built.label} map={built.map} onClick={built.interact?.filterAt ? onChartClick : undefined} onDblClick={built.interact?.drillAt ? onChartDbl : undefined}
              onContextMenu={built.interact?.rowsAt || built.interact?.filterAt ? onChartContext : undefined} />
          </div>
        ) : null}
      </div>
    </div>
  )
})

/** Headings, notes and bullets with live values; placeholders that match nothing are flagged. */
function TextWidget({ ds, widget, filters }: { ds: Dataset; widget: Widget; filters: Filter[] }) {
  const blocks = useMemo(() => renderText(ds, widget, filters), [ds, widget, filters])
  const spans = (xs: Span[]) => xs.map((x, i) => (
    <span key={i} className={cx(x.bold && 'font-semibold', x.italic && 'italic', x.value && 'tabular font-medium text-ink', x.missing && 'rounded bg-[#eda100]/15 px-0.5 text-[#a06a00] dark:text-[#eda100]')}
      title={x.missing ? 'No column, measure or value with this name' : undefined}>{x.text}</span>
  ))
  if (!blocks.length) return <p className="px-4 pb-4 text-[13px] text-ink-3">Empty text — click Edit to write a heading or a note.</p>
  return (
    <div className={cx('space-y-2 px-4 pb-4 text-[13.5px] leading-relaxed text-ink-2', !widget.title && 'pt-4')}>
      {blocks.map((b, i) => b.kind === 'h1' ? <h2 key={i} className="text-[20px] font-semibold leading-tight tracking-tight text-ink">{spans(b.spans)}</h2>
        : b.kind === 'h2' ? <h3 key={i} className="text-[15px] font-semibold text-ink">{spans(b.spans)}</h3>
          : b.kind === 'ul' ? <ul key={i} className="list-disc space-y-0.5 pl-5">{b.items.map((it, j) => <li key={j}>{spans(it)}</li>)}</ul>
            : <p key={i}>{spans(b.spans)}</p>)}
      {hasInsights(widget) && (
        <p className="text-[12.5px]">
          <button className="font-medium text-accent-ink hover:underline" onClick={() => useStore.getState().setTab('insights')}>See all insights and what they rest on →</button>
        </p>
      )}
    </div>
  )
}

function cohortTable(ds: Dataset, w: Widget, filters: Filter[]) {
  const r = runCohort(ds, w, filters)
  if (!r) return null
  return {
    headers: ['Cohort', 'Size', ...Array.from({ length: r.periods }, (_, i) => `${r.unit} ${i}`)],
    rows: r.cohorts.map((c) => [c.label, c.size, ...c.active.map((v) => (v == null ? null : w.cohortMode === 'count' ? v : +(v / c.size * 100).toFixed(1)))]),
  }
}

/** Retention heat table: one row per cohort, one column per period since first seen, shaded by share retained. */
function CohortTable({ ds, widget, filters }: { ds: Dataset; widget: Widget; filters: Filter[] }) {
  const theme = useTheme()
  const r = useMemo(() => runCohort(ds, widget, filters), [ds, widget, filters])
  if (!r) return <div className="h-[200px]"><Empty icon={<SearchX size={18} />} title="Pick a date and an entity">Choose the date column and what to follow (e.g. Customer ID) in the editor.</Empty></div>
  if (!r.cohorts.length) return <div className="h-[200px]"><Empty icon={<SearchX size={18} />} title="No rows match" /></div>
  const ramp = TOKENS[theme].sequential
  const shade = (p: number) => ramp[Math.min(ramp.length - 1, Math.floor(p * ramp.length))]
  const pct = widget.cohortMode !== 'count'
  const avg = averageRetention(r)
  const { showRows } = useStore.getState()
  const cell = (v: number | null, c: CohortRow, o: number) => {
    if (v == null) return <td key={o} className="px-1 py-1" />
    const p = c.size ? v / c.size : 0
    const bg = shade(p)
    const what = `${c.label} cohort · ${r.unit} ${o}`
    const shown = pct ? `${Math.round(p * 100)}%` : v.toLocaleString()
    return (
      <td key={o} className="px-0.5 py-0.5">
        {/* a button, so the rows behind a cell are one click (or Enter) away */}
        <button className="block w-full rounded-[4px] px-1.5 py-1 text-center text-[11.5px] outline-offset-1 hover:brightness-110" style={{ backgroundColor: bg, color: inkOn(bg) }}
          title={`${v.toLocaleString()} of ${c.size.toLocaleString()} (${(p * 100).toFixed(1)}%) · click to see their rows`}
          // the visible number leads the name (voice control users say what they see)
          aria-label={`${shown}, ${what}: ${v.toLocaleString()} of ${c.size.toLocaleString()} active. Show rows`}
          onClick={() => v && showRows({ widgetId: widget.id, filters: cohortCellFilters(widget, c, o), label: what })}>
          {shown}
        </button>
      </td>
    )
  }
  return (
    <div className="max-h-[440px] overflow-auto px-4 pb-4">
      <table className="tabular w-full border-separate border-spacing-0 text-[12px]" aria-label={`Cohort table: ${widget.title}`}>
        <thead className="sticky top-0 z-10 bg-surface">
          <tr>
            <th className="py-1.5 pr-3 text-left font-medium text-ink-3">Cohort</th>
            <th className="py-1.5 pr-3 text-right font-medium text-ink-3">Size</th>
            {Array.from({ length: r.periods }, (_, i) => <th key={i} className="px-0.5 py-1.5 text-center font-medium text-ink-3">{i === 0 ? `${r.unit} 0` : `+${i}`}</th>)}
          </tr>
        </thead>
        <tbody>
          {r.cohorts.map((c) => (
            <tr key={c.label}>
              <td className="whitespace-nowrap py-0.5 pr-3 text-ink-2">{c.label}</td>
              <td className="py-0.5 pr-3 text-right text-ink">{c.size.toLocaleString()}</td>
              {c.active.map((v, i) => cell(v, c, i))}
            </tr>
          ))}
          <tr>
            <td className="border-t border-line pt-1.5 pr-3 font-medium text-ink">Average</td>
            <td className="border-t border-line pt-1.5 pr-3" />
            {avg.map((a, i) => <td key={i} className="border-t border-line px-0.5 pt-1.5 text-center font-medium text-ink">{a == null ? '' : `${Math.round(a * 100)}%`}</td>)}
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function describeDrill(f: Filter, ds: Dataset): string {
  const c = colMap(ds).get(f.column)
  if (!c) return f.column
  if (f.values?.length) return f.values.join(', ')
  if (c.type === 'date' && f.min != null) return labelOf(f.min, { ...c, grain: 'day' }).replace(/, \d{4}$/, '') + (f.max != null ? ` – ${labelOf(f.max, { ...c, grain: 'day' })}` : '')
  return `${c.name} ${f.min ?? ''}–${f.max ?? ''}`
}

/** Small multiples: one compact chart per value of the facet column, all sharing one value axis. */
function Facets({ ds, widget, filters }: { ds: Dataset; widget: Widget; filters: Filter[] }) {
  const theme = useTheme()
  const panels = useMemo(() => {
    const cols = colMap(ds)
    const fc = cols.get(widget.facet!)!
    const g = runGrouped(ds, { id: 'f', type: 'bar', title: '', size: 'md', dimension: fc.key, measures: [{ id: 'c', agg: 'count' }], limit: 12, sort: fc.type === 'date' ? 'natural' : 'value-desc' }, filters)
    const keys = g.categoryKeys.filter((k) => k !== 'Other').slice(0, 12)
    const charts = keys.map((k, i) => {
      const f = g.filterFor!(k)
      const w: Widget = { ...widget, facet: undefined, filters: [...(widget.filters ?? []), { id: `facet_${i}`, ...f }] }
      return { name: g.categories[g.categoryKeys.indexOf(k)], built: buildChart(ds, w, filters, TOKENS[theme], { compact: true }) }
    })
    const yMax = Math.max(0, ...charts.map((c) => c.built.maxValue ?? 0))
    // rebuild with the shared axis so panels compare at a glance
    return charts.map((c, i) => ({ name: c.name, built: yMax && c.built.maxValue != null ? buildChart(ds, { ...widget, facet: undefined, filters: [...(widget.filters ?? []), { id: `facet_${i}`, ...g.filterFor!(keys[i]) }] }, filters, TOKENS[theme], { compact: true, yMax: niceMax(yMax) }) : c.built }))
  }, [ds, widget, filters, theme])
  const n = panels.length
  const colsCls = n <= 2 ? 'grid-cols-2' : n <= 4 ? 'grid-cols-2' : n <= 6 ? 'grid-cols-3' : 'grid-cols-4'
  return (
    <div className="px-3 pb-3">
      <div className={cx('grid gap-2', colsCls)}>
        {panels.map((p) => (
          <div key={p.name} className="rounded-lg border border-line/70 p-1.5">
            <div className="truncate px-1 text-[11.5px] font-medium text-ink-2" title={p.name}><LayoutGrid size={10} className="mr-1 inline text-ink-3" />{p.name}</div>
            <div className="h-[120px]">{p.built.empty ? <div className="flex h-full items-center justify-center text-[11px] text-ink-3">No data</div> : <Chart option={p.built.option} label={`${p.name}: ${p.built.label ?? ''}`} />}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function niceMax(v: number) {
  const mag = 10 ** Math.floor(Math.log10(v))
  return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * mag).find((x) => x >= v) ?? v
}

/** Chart types whose data-table rows line up one-to-one with their marks. */
const ROW_ACTION_TYPES = new Set<Widget['type']>(['bar', 'hbar', 'line', 'area', 'donut', 'waterfall', 'pareto', 'funnel'])

type RowActions = { filter?: () => void; rows?: () => void; drill?: () => void }

/** The keyboard path to what clicking a mark does: filter the dashboard, show its rows, drill in. */
function rowActions(built: BuiltChart, widget: Widget, filters: Filter[]): ((i: number) => RowActions) | undefined {
  if (!ROW_ACTION_TYPES.has(widget.type) || !built.interact) return undefined
  const { setFilters, showRows, updateWidget } = useStore.getState()
  const it = built.interact
  return (i) => {
    const f = it.filterAt?.(i, 0)
    const r = it.rowsAt?.(i, 0)
    const d = it.drillAt?.(i)
    return {
      filter: f ? () => setFilters(crossFilter(widget, f, filters, false)) : undefined,
      rows: r ? () => showRows({ widgetId: widget.id, ...r }) : undefined,
      drill: d ? () => updateWidget(widget.id, { drill: [...(widget.drill ?? []), d] }) : undefined,
    }
  }
}

/** Right-click on a mark: the rows behind it (or, without a row filter, behind the clicked category). */
function contextRows(built: BuiltChart, widget: Widget, e: ChartEvent) {
  const { showRows } = useStore.getState()
  const r = built.interact?.rowsAt?.(e.dataIndex, e.seriesIndex)
  if (r) { showRows({ widgetId: widget.id, ...r }); return }
  const f = built.interact?.filterAt?.(e.dataIndex, e.seriesIndex)
  if (f) showRows({ widgetId: widget.id, filters: [f], label: f.values?.join(', ') ?? e.name })
}

function MiniTable({ headers, rows, actions }: { headers: string[]; rows: (string | number | null)[][]; actions?: (i: number) => RowActions }) {
  return (
    <table className="tabular w-full text-[12px]">
      <thead className="sticky top-0 bg-surface">
        <tr>
          {headers.map((h, i) => <th key={i} className={cx('border-b border-line py-1.5 pr-3 font-medium text-ink-3', i ? 'text-right' : 'text-left')}>{h}</th>)}
          {actions && <th className="border-b border-line py-1.5 text-right font-medium text-ink-3"><span className="sr-only">Actions</span></th>}
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 500).map((r, i) => {
          const a = actions?.(i)
          const name = String(r[0] ?? '')
          return (
            <tr key={i} className="border-b border-line/60">
              {r.map((v, j) => <td key={j} className={cx('py-1.5 pr-3', j ? 'text-right text-ink' : 'text-ink-2')}>{typeof v === 'number' ? fmtNumber(v, undefined, { compact: false }) : v ?? '—'}</td>)}
              {actions && (
                <td className="whitespace-nowrap py-1 text-right">
                  {a?.filter && <IconButton label={`Filter the dashboard by ${name}`} onClick={a.filter}><FilterIcon size={12} /></IconButton>}
                  {a?.rows && <IconButton label={`Show rows for ${name}`} onClick={a.rows}><Rows3 size={12} /></IconButton>}
                  {a?.drill && <IconButton label={`Drill into ${name}`} onClick={a.drill}><ZoomIn size={12} /></IconButton>}
                </td>
              )}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function tableData(ds: Dataset, w: Widget, filters: Filter[]) {
  const g = runGrouped(ds, w, filters)
  return { headers: [g.dimension?.name ?? '', ...g.series.map((s) => s.name)], rows: g.categories.map((c, i) => [c, ...g.series.map((s) => s.values[i])]), g }
}

/** Grouped summary table with in-cell data bars on each measure; rows cross-filter the dashboard. */
function GroupTable({ ds, widget, filters }: { ds: Dataset; widget: Widget; filters: Filter[] }) {
  const { g } = useMemo(() => tableData(ds, widget, filters), [ds, widget, filters])
  const { setFilters, showRows } = useStore.getState()
  const cols = colMap(ds)
  const ranges = g.series.map((s) => {
    const xs = s.values.filter((v): v is number => v != null && Number.isFinite(v))
    return { min: Math.min(0, ...xs), max: Math.max(0, ...xs) }
  })
  const tf = widget.tableFormat
  if (!g.categories.length) return <Empty icon={<SearchX size={18} />} title="No rows match" />
  const active = filters.find((f) => f.fromWidget === widget.id)
  return (
    <div className="max-h-[420px] overflow-auto px-4 pb-4">
      <table className="tabular w-full text-[13px]">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr>
            <th className="border-b border-line py-2 pr-4 text-left font-medium text-ink-3">{g.dimension?.name ?? 'Group'}</th>
            {g.series.map((s) => <th key={s.name} className="border-b border-line py-2 pl-4 text-right font-medium text-ink-3">{s.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {g.categories.map((c, i) => {
            const f = g.filterFor && g.categoryKeys[i] !== 'Other' ? g.filterFor(g.categoryKeys[i]) : null
            const on = !!active && !!f && (active.values?.includes(c) || (active.min === f.min && active.max === f.max))
            return (
              <tr key={c + i} onClick={(e) => f && setFilters(crossFilter(widget, f, filters, e.shiftKey))}
                onContextMenu={(e) => { if (!f) return; e.preventDefault(); showRows({ widgetId: widget.id, filters: [f], label: `${g.dimension?.name ?? ''}: ${c}` }) }}
                className={cx('border-b border-line/60 transition', f && 'cursor-pointer', on ? 'bg-accent-soft' : 'hover:bg-surface-2')}>
                <td className="max-w-[260px] truncate py-2 pr-4 text-ink" title={c}>{c}</td>
                {g.series.map((s, j) => {
                  const v = s.values[i]
                  const col = measureColumn(s.measure, cols)
                  const fmt = (n: number | null) => fmtNumber(n, col, { compact: false, format: widget.format })
                  const look = cellLook(v, s.measure.id, ranges[j], tf)
                  const tone = look.rule?.tone
                  const Icon = tone === 'good' ? CircleCheck : tone === 'bad' ? OctagonAlert : AlertTriangle
                  return (
                    <td key={j} className="py-2 pl-4 text-right"
                      // one hue, light → dark; text keeps its ink so it stays readable on any step
                      style={look.scale != null ? { backgroundColor: `color-mix(in srgb, var(--accent) ${Math.round(6 + look.scale * 34)}%, transparent)` } : undefined}>
                      <div className="flex items-center justify-end gap-2.5">
                        <span className={cx('inline-flex items-center gap-1', tone && look.scale != null && 'rounded bg-surface px-1', tone === 'good' ? 'font-medium text-good' : tone === 'bad' ? 'font-medium text-bad' : tone === 'warning' ? 'font-medium text-[#a06a00] dark:text-[#eda100]' : 'text-ink')}
                          title={look.rule ? `${s.name} ${describeRule(look.rule, (n) => fmt(n))}` : undefined}>
                          {tone && <Icon size={12} aria-label={tone === 'good' ? 'Good' : tone === 'bad' ? 'Alert' : 'Warning'} />}
                          {fmt(v)}
                        </span>
                        {look.bar != null && (
                          <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-surface-3 sm:block">
                            <span className="block h-full rounded-full bg-accent/70" style={{ width: `${look.bar}%` }} />
                          </span>
                        )}
                      </div>
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="mt-2 flex justify-end">
        <button className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink" onClick={() => {
          const tbl = tableData(ds, widget, filters)
          downloadText(`${slug(widget.title)}.csv`, toCsv(tbl.headers, tbl.rows))
        }}><Download size={12} />CSV</button>
      </div>
    </div>
  )
}

/** Large view of one widget with zoom (time charts) and a data table underneath. */
export function FullscreenWidget({ ds, widget, filters }: { ds: Dataset; widget: Widget; filters: Filter[] }) {
  const theme = useTheme()
  const { setFullscreen, setFilters, updateWidget } = useStore.getState()
  const built: BuiltChart | null = useMemo(
    () => (widget.type === 'kpi' || widget.type === 'table' || widget.type === 'cohort' || widget.type === 'text' ? null : buildChart(ds, { ...widget, facet: undefined }, filters, TOKENS[theme], { fullscreen: true })),
    [ds, widget, filters, theme],
  )
  return (
    <Modal title={widget.title} onClose={() => setFullscreen(null)} width={1280}>
      {widget.subtitle && <p className="-mt-2 mb-3 text-[13px] text-ink-3">{widget.subtitle}</p>}
      {built && !built.empty ? (
        <>
          <div className="h-[62vh]">
            <Chart option={built.option} label={built.label} map={built.map}
              onClick={built.interact?.filterAt ? (e) => { const f = built.interact!.filterAt!(e.dataIndex, e.seriesIndex); if (f) setFilters(crossFilter(widget, f, filters, !!e.event?.event?.shiftKey)) } : undefined}
              onDblClick={built.interact?.drillAt ? (e) => { const l = built.interact!.drillAt!(e.dataIndex); if (l) updateWidget(widget.id, { drill: [...(widget.drill ?? []), l] }) } : undefined}
              onContextMenu={built.interact?.rowsAt || built.interact?.filterAt ? (e) => contextRows(built, widget, e) : undefined} />
          </div>
          {built.note && <p className="mt-2 text-[12px] text-ink-3">{built.note}</p>}
          <details className="mt-4 rounded-xl border border-line">
            <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-medium">Data table</summary>
            <div className="max-h-[40vh] overflow-auto px-4 pb-4"><MiniTable headers={built.table.headers} rows={built.table.rows} actions={rowActions(built, widget, filters)} /></div>
          </details>
        </>
      ) : widget.type === 'table' ? (
        <GroupTable ds={ds} widget={widget} filters={filters} />
      ) : widget.type === 'cohort' ? (
        <CohortTable ds={ds} widget={widget} filters={filters} />
      ) : (
        <Empty icon={<SearchX size={18} />} title="Nothing to show" />
      )}
    </Modal>
  )
}
