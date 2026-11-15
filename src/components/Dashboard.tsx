import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, ArrowRight, Copy, Download, FileJson, FileUp, Image, LayoutDashboard, MoreHorizontal, Pencil, Plus, Printer, RotateCcw,
  Share2, Sheet, Sparkles, Trash2, X, CornerDownLeft, FileSpreadsheet, BookOpen,
} from 'lucide-react'
import type { ChartType, Dataset, Widget } from '../types'
import { suggest, signature, uid } from '../lib/suggest'
import { ask, askExamples, type AskOk } from '../lib/ask'
import { buildChart } from '../lib/chartOptions'
import { filteredRows } from '../lib/aggregate'
import { TOKENS } from '../lib/palette'
import { downloadText, downloadUrl, slug, toCsv } from '../lib/hooks'
import { exportDashboard, exportRows, exportXlsx, planImport } from '../lib/share'
import { detectGeo, detectLatLon } from '../lib/geo'
import { currentPage, useDashboardFull, useStore } from '../store'
import { WidgetCard, FullscreenWidget } from './WidgetCard'
import { WidgetEditor, CHART_TYPES } from './WidgetEditor'
import { FilterBar } from './FilterBar'
import { Chart, useTheme } from './Chart'
import { WhatChanged } from './WhatChanged'
import { RowsView } from './RowsView'
import { ViewsMenu } from './ViewsMenu'
import { Button, confirmDialog, cx, Empty, InlineEdit, MenuItem, Modal, Popover } from './ui'

export function Dashboard({ ds }: { ds: Dataset }) {
  const dash = useDashboardFull()
  const page = currentPage(dash)
  const editing = useStore((s) => s.editing)
  const fullscreen = useStore((s) => s.fullscreen)
  const changes = useStore((s) => (s.changes?.datasetId === ds.id ? s.changes : null))
  const rowsView = useStore((s) => s.rowsView)
  const { setFilters, moveWidget, resetDashboard, mutatePage } = useStore.getState()
  const [drag, setDrag] = useState<string | null>(null)
  const gallery = useStore((s) => s.gallery)
  const { setGallery } = useStore.getState()
  const gridRef = useRef<HTMLDivElement>(null)

  // filter changes re-render widgets in the background, so typing and clicking never wait on charts
  const filters = page?.filters ?? []
  const deferredFilters = useDeferredValue(filters)
  const stale = deferredFilters !== filters

  // very large datasets mount a few widgets per frame instead of all at once
  const big = ds.rows.length > 150_000
  const total = page?.widgets.length ?? 0
  const [visible, setVisible] = useState(big ? 4 : Infinity)
  useEffect(() => {
    if (!big) { setVisible(Infinity); return }
    setVisible(4)
    let n = 4
    const t = setInterval(() => { n += 2; setVisible(n); if (n >= total) clearInterval(t) }, 60)
    return () => clearInterval(t)
  }, [big, total, ds.id, page?.id])

  if (!dash || !page) return null
  const editingWidget = page.widgets.find((w) => w.id === editing)
  const fullscreenWidget = page.widgets.find((w) => w.id === fullscreen)
  const rowsWidget = rowsView && page.widgets.find((w) => w.id === rowsView.widgetId)

  const move = (id: string, dir: -1 | 1) => {
    const i = page.widgets.findIndex((w) => w.id === id)
    const j = i + dir
    if (j < 0 || j >= page.widgets.length) return
    mutatePage(`move:${id}`, (p) => {
      const ws = [...p.widgets]
      ;[ws[i], ws[j]] = [ws[j], ws[i]]
      return { ...p, widgets: ws }
    })
    // keep keyboard focus on the moved card
    requestAnimationFrame(() => (gridRef.current?.children[j] as HTMLElement | undefined)?.focus())
  }

  return (
    <div className={editingWidget ? 'lg:pr-[380px]' : ''}>
      <PageTabs />
      {changes && <WhatChanged report={changes} />}
      <AskBar ds={ds} />
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ViewsMenu page={page} />
          <FilterBar ds={ds} filters={page.filters} onChange={setFilters} />
        </div>
        <div className="flex items-center gap-2">
          <ShareMenu ds={ds} gridRef={gridRef} />
          <Button size="sm" variant="ghost" onClick={async () => {
            if (await confirmDialog({ title: 'Reset to the suggested layout?', body: 'This replaces every widget on this page with Numero’s suggested layout. Filters are kept, and you can undo it.', confirmLabel: 'Reset layout' })) resetDashboard()
          }}><RotateCcw size={14} />Reset</Button>
          <Button size="sm" variant="primary" onClick={() => setGallery(true)}><Plus size={14} />Add chart</Button>
        </div>
      </div>

      {/* the page is the section the widget titles (h3) belong to */}
      <h2 className="sr-only">{page.name}</h2>
      {page.widgets.length ? (
        <div ref={gridRef} className="grid grid-cols-12 gap-4" aria-busy={stale}>
          {page.widgets.map((w, i) => i < visible ? (
            <WidgetCard
              key={w.id}
              ds={ds}
              widget={w}
              filters={deferredFilters}
              stale={stale}
              selected={editing === w.id}
              dragging={drag === w.id}
              onDragStart={() => setDrag(w.id)}
              onDragOver={() => { if (drag && drag !== w.id) moveWidget(drag, w.id) }}
              onDrop={() => setDrag(null)}
              onMove={(dir) => move(w.id, dir)}
            />
          ) : (
            <div key={w.id} className={cx('card animate-pulse', w.type === 'kpi' ? 'h-[150px]' : 'h-[340px]', SPAN_SKELETON[w.size])} />
          ))}
        </div>
      ) : (
        <div className="card">
          <Empty icon={<LayoutDashboard size={18} />} title="This page is empty">
            <div className="mt-2 flex justify-center gap-2">
              <Button size="sm" onClick={resetDashboard}><Sparkles size={14} />Use suggested layout</Button>
              <Button size="sm" variant="primary" onClick={() => setGallery(true)}><Plus size={14} />Add chart</Button>
            </div>
          </Empty>
        </div>
      )}

      {editingWidget && <WidgetEditor key={editingWidget.id} ds={ds} widget={editingWidget} />}
      {fullscreenWidget && <FullscreenWidget ds={ds} widget={fullscreenWidget} filters={page.filters} />}
      {rowsView && rowsWidget && <RowsView ds={ds} widget={rowsWidget} filters={page.filters} extra={rowsView.filters} label={rowsView.label} />}
      {gallery && <AddChart ds={ds} existing={page.widgets} onClose={() => setGallery(false)} />}
    </div>
  )
}

const SPAN_SKELETON: Record<Widget['size'], string> = {
  xs: 'col-span-12 sm:col-span-6 xl:col-span-3', sm: 'col-span-12 lg:col-span-4', md: 'col-span-12 lg:col-span-6', lg: 'col-span-12 lg:col-span-8', full: 'col-span-12',
}

// ---------- pages ----------

function PageTabs() {
  const dash = useDashboardFull()!
  const { setPage, addPage, renamePage, duplicatePage, removePage, movePage } = useStore.getState()
  const active = dash.pages.find((p) => p.id === dash.activePage) ?? dash.pages[0]
  const i = dash.pages.indexOf(active)
  return (
    <div className="no-print mb-3 flex flex-wrap items-center gap-1">
      {/* only tabs inside the tablist; page options and "add page" sit beside it */}
      <div role="tablist" aria-label="Dashboard pages" className="flex flex-wrap items-center gap-1">
        {dash.pages.map((p) => p.id === active.id ? (
          <span key={p.id} className="rounded-lg border border-line bg-surface px-1 py-1 text-[13px] font-medium shadow-card">
            <InlineEdit value={p.name} label="page" role="tab" selected onSave={(v) => renamePage(p.id, v)} />
          </span>
        ) : (
          <button key={p.id} role="tab" aria-selected={false} onClick={() => setPage(p.id)} className="rounded-lg border border-transparent px-2.5 py-1.5 text-[13px] text-ink-2 transition hover:bg-surface-2">{p.name}</button>
        ))}
      </div>
      <Popover width={200} trigger={(_, toggle) => (
        <button aria-label={`Page options for ${active.name}`} onClick={toggle} className="rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-ink"><MoreHorizontal size={14} /></button>
      )}>
        {(close) => (
          <>
            <MenuItem icon={<Copy size={14} />} onClick={() => { duplicatePage(active.id); close() }}>Duplicate page</MenuItem>
            <MenuItem icon={<ArrowLeft size={14} />} onClick={() => { movePage(active.id, -1); close() }}>{i === 0 ? 'Already first' : 'Move left'}</MenuItem>
            <MenuItem icon={<ArrowRight size={14} />} onClick={() => { movePage(active.id, 1); close() }}>{i === dash.pages.length - 1 ? 'Already last' : 'Move right'}</MenuItem>
            {dash.pages.length > 1 && <><div className="my-1 border-t border-line" /><MenuItem danger icon={<Trash2 size={14} />} onClick={async () => {
              close()
              if (await confirmDialog({ title: `Delete page “${active.name}”?`, body: 'Its widgets are removed. You can undo this.', confirmLabel: 'Delete page', danger: true })) removePage(active.id)
            }}>Delete page</MenuItem></>}
          </>
        )}
      </Popover>
      <button aria-label="Add page" onClick={() => addPage()} className="ml-1 inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] text-ink-3 hover:bg-surface-2 hover:text-ink"><Plus size={14} />Page</button>
    </div>
  )
}

// ---------- ask ----------

function AskBar({ ds }: { ds: Dataset }) {
  const [q, setQ] = useState('')
  const [focused, setFocused] = useState(false)
  const [result, setResult] = useState<ReturnType<typeof ask> | null>(null)
  const page = currentPage(useDashboardFull())
  const theme = useTheme()
  const examples = useMemo(() => askExamples(ds), [ds])
  const run = (text = q) => { if (text.trim()) setResult(ask(text, ds)) }
  const ok = result?.ok ? (result as AskOk) : null
  const preview = useMemo(() => (ok && ok.widget.type !== 'kpi' && ok.widget.type !== 'table' ? buildChart(ds, ok.widget, page?.filters ?? [], TOKENS[theme]) : null), [ok, ds, page?.filters, theme])
  const add = (editFirst: boolean) => {
    if (!ok) return
    useStore.getState().addWidget({ ...ok.widget, id: uid() })
    if (!editFirst) useStore.getState().edit(null)
    setResult(null)
    setQ('')
  }
  return (
    <div className="no-print mb-4">
      <form onSubmit={(e) => { e.preventDefault(); run() }} className="relative">
        <Sparkles size={15} className="pointer-events-none absolute left-3.5 top-3 text-accent" />
        <input
          aria-label="Ask a question about this data"
          value={q}
          onChange={(e) => { setQ(e.target.value); if (!e.target.value) setResult(null) }}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder={`Ask a question — e.g. “${examples[0] ?? 'total by category'}”`}
          className="field h-10 rounded-xl pl-10 pr-24 text-[14px]"
        />
        <button type="submit" className="absolute right-1.5 top-1.5 inline-flex h-7 items-center gap-1 rounded-lg bg-surface-3 px-2.5 text-[12px] font-medium text-ink-2 hover:text-ink">
          <CornerDownLeft size={12} />Ask
        </button>
      </form>
      {focused && !q && !result && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {examples.map((e) => (
            <button key={e} onMouseDown={(ev) => { ev.preventDefault(); setQ(e); run(e) }} className="rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] text-ink-2 hover:border-accent hover:text-accent-ink">{e}</button>
          ))}
        </div>
      )}
      {result && (
        <div className="card fade-up mt-2 p-4">
          {result.ok ? (
            <>
              <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                <span className="text-ink-3">Reading this as</span>
                {result.reading.map((r) => <span key={r} className="rounded-md bg-accent-soft px-2 py-0.5 font-medium text-accent-ink">{r}</span>)}
              </div>
              {preview && !preview.empty && <div className="mt-3 h-[220px]"><Chart option={preview.option} label={preview.label} map={preview.map} /></div>}
              {preview?.empty && <p className="mt-3 text-[12.5px] text-ink-3">No rows match — try loosening the question.</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="primary" onClick={() => add(false)}><Plus size={14} />Add to dashboard</Button>
                <Button size="sm" onClick={() => add(true)}><Pencil size={14} />Add and edit</Button>
                <Button size="sm" variant="ghost" onClick={() => setResult(null)}><X size={14} />Dismiss</Button>
              </div>
            </>
          ) : (
            <div className="flex items-start justify-between gap-3 text-[13px] text-ink-2">
              <span>{result.message}</span>
              <button aria-label="Dismiss" onClick={() => setResult(null)} className="text-ink-3 hover:text-ink"><X size={14} /></button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------- share / export ----------

function ShareMenu({ ds, gridRef }: { ds: Dataset; gridRef: React.RefObject<HTMLDivElement | null> }) {
  const dash = useDashboardFull()!
  const page = currentPage(dash)!
  const fileRef = useRef<HTMLInputElement>(null)
  const { notify, setDashboard, updateModel } = useStore.getState()

  const exportJson = () => downloadText(`${slug(ds.name)}.numero.json`, JSON.stringify(exportDashboard(ds, dash), null, 2), 'application/json')
  const importJson = async (file: File) => {
    try {
      const plan = planImport(JSON.parse(await file.text()), ds)
      const ok = await confirmDialog({
        title: 'Replace this dashboard?',
        body: <>The imported dashboard has {plan.dashboard.pages.length} page{plan.dashboard.pages.length > 1 ? 's' : ''}. Its computed columns and measures are added to this dataset.{plan.unmatched.length ? <><br /><br /><b>Not found in this dataset:</b> {plan.unmatched.join(', ')} — charts using them will be flagged.</> : null} You can undo this.</>,
        confirmLabel: 'Import',
      })
      if (!ok) return
      setDashboard(plan.dashboard)
      await updateModel('import', () => plan.model)
      notify('info', 'Dashboard imported')
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Could not read that file.')
    }
  }
  const png = async () => {
    if (!gridRef.current) return
    const { toPng } = await import('html-to-image')
    try {
      const url = await toPng(gridRef.current, { backgroundColor: getComputedStyle(document.body).backgroundColor, pixelRatio: 2, filter: (n) => !(n instanceof HTMLElement && n.classList.contains('no-print')) })
      downloadUrl(`${slug(ds.name)}-${slug(page.name)}.png`, url)
    } catch {
      notify('error', 'Could not render the image.')
    }
  }
  const rows = () => filteredRows(ds, page.filters)
  return (
    <>
      <Popover align="right" width={240} trigger={(_, toggle) => <Button size="sm" variant="ghost" onClick={toggle}><Share2 size={14} />Share</Button>}>
        {(close) => (
          <>
            <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-ink-3">Dashboard</div>
            <MenuItem icon={<FileJson size={14} />} onClick={() => { exportJson(); close() }}>Export dashboard (.json)</MenuItem>
            <MenuItem icon={<FileUp size={14} />} onClick={() => { fileRef.current?.click(); close() }}>Import dashboard…</MenuItem>
            <MenuItem icon={<Image size={14} />} onClick={() => { void png(); close() }}>Download page as PNG</MenuItem>
            <MenuItem icon={<BookOpen size={14} />} onClick={() => { close(); useStore.getState().setPrinting(true) }}>Print report (all pages) / PDF</MenuItem>
            <MenuItem icon={<Printer size={14} />} onClick={() => { close(); setTimeout(() => window.print(), 50) }}>Print this page</MenuItem>
            <div className="my-1 border-t border-line" />
            <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-ink-3">Data{page.filters.length ? ' (with page filters)' : ''}</div>
            <MenuItem icon={<Sheet size={14} />} onClick={() => { downloadText(`${slug(ds.name)}.csv`, toCsv(ds.columns.map((c) => c.name), exportRows(ds, rows()))); close() }}>Export CSV</MenuItem>
            <MenuItem icon={<FileSpreadsheet size={14} />} onClick={async () => { close(); const b = await exportXlsx(ds, rows()); downloadUrl(`${slug(ds.name)}.xlsx`, URL.createObjectURL(b)) }}>Export Excel (.xlsx)</MenuItem>
          </>
        )}
      </Popover>
      <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.target.value = '' }} />
    </>
  )
}

// ---------- add chart gallery ----------

function blankWidget(ds: Dataset, type: ChartType): Widget {
  const num = ds.columns.find((c) => c.type === 'number')
  const date = ds.columns.find((c) => c.type === 'date')
  const cat = ds.columns.find((c) => c.type === 'category' && c.distinct <= 60) ?? ds.columns.find((c) => c.type === 'category')
  const nums = ds.columns.filter((c) => c.type === 'number')
  const label = CHART_TYPES.find((c) => c.type === type)!.label
  const measure = num ? { id: uid('m'), column: num.key, agg: 'sum' as const } : { id: uid('m'), agg: 'count' as const }
  const base: Widget = { id: uid(), type, title: `New ${label.toLowerCase()} chart`, size: 'md', measures: [measure] }
  switch (type) {
    case 'kpi': return { ...base, size: 'xs', title: 'New KPI', dimension: date?.key }
    case 'waterfall': return { ...base, dimension: (date ?? cat)?.key, bucket: date ? 'month' : undefined, limit: date ? undefined : 10 }
    case 'pareto': return { ...base, dimension: cat?.key, limit: 20 }
    case 'funnel': return { ...base, dimension: cat?.key, limit: 8 }
    case 'cohort': return { ...base, size: 'full', title: 'Retention by first month', measures: [], dimension: date?.key, bucket: 'month', entity: (ds.columns.find((c) => c.isId) ?? ds.columns.find((c) => (c.type === 'category' || c.type === 'text') && c.distinct > 50))?.key }
    case 'text': return { ...base, size: 'full', title: '', measures: [], text: `# ${ds.name}\n${date ? 'Data through {latest date} · ' : ''}{rows} rows${num ? `\n\n- Total ${num.name}: **{sum ${num.name}}**` : ''}` }
    case 'line': case 'area': return { ...base, dimension: (date ?? cat)?.key, bucket: date ? 'auto' : undefined }
    case 'scatter': return { ...base, measures: [], x: nums[0]?.key, y: nums[1]?.key ?? nums[0]?.key, trend: true }
    case 'histogram': return { ...base, measures: [], x: num?.key, bins: 20 }
    case 'box': return { ...base, measures: [], y: num?.key, dimension: cat?.key }
    case 'correlation': return { ...base, measures: nums.slice(0, 6).map((c) => ({ id: uid('m'), column: c.key, agg: 'avg' as const })) }
    case 'heatmap': return { ...base, measures: [{ id: uid('m'), agg: 'count' }], dimension: (date ?? cat)?.key, bucket: date ? 'auto' : undefined, series: ds.columns.find((c) => c.type === 'category' && c.key !== cat?.key && c.distinct <= 30)?.key ?? cat?.key }
    case 'table': return { ...base, size: 'full', dimension: cat?.key, measures: [{ id: uid('m'), agg: 'count' }, measure], limit: 25 }
    case 'map': {
      const geoCol = ds.columns.find((c) => detectGeo(c, ds.rows))
      return { ...base, size: 'lg', title: 'New map', dimension: geoCol?.key, geo: geoCol ? detectGeo(geoCol, ds.rows)! : 'world', measures: [measure] }
    }
    case 'points': {
      const ll = detectLatLon(ds.columns, ds.rows)
      return { ...base, size: 'lg', title: 'New point map', x: ll?.lon, y: ll?.lat, geo: 'world', measures: [] }
    }
    default: return { ...base, dimension: cat?.key ?? date?.key, limit: type === 'donut' ? 7 : 12 }
  }
}

function AddChart({ ds, existing, onClose }: { ds: Dataset; existing: Widget[]; onClose: () => void }) {
  const addWidget = useStore((s) => s.addWidget)
  const ideas = useMemo(() => {
    const s = suggest(ds)
    const have = new Set(existing.map(signature))
    return [...s.widgets, ...s.extra].filter((w) => !have.has(signature(w)) && w.type !== 'kpi').slice(0, 9)
  }, [ds, existing])
  const add = (w: Widget) => { addWidget({ ...structuredClone(w), id: uid() }); onClose() }

  return (
    <Modal title="Add a chart" onClose={onClose} width={760}>
      {ideas.length > 0 && (
        <>
          <div className="mb-2.5 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-ink-3"><Sparkles size={13} />Suggested for this data</div>
          <div className="mb-6 grid gap-2 sm:grid-cols-3">
            {ideas.map((w) => {
              const meta = CHART_TYPES.find((c) => c.type === w.type)!
              return (
                <button key={w.id} onClick={() => add(w)} className="group flex flex-col items-start gap-2 rounded-xl border border-line p-3 text-left transition hover:border-accent hover:bg-accent-soft">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-3 text-ink-2 group-hover:bg-surface group-hover:text-accent-ink">{meta.icon}</span>
                  <span className="text-[13px] font-medium leading-snug text-ink">{w.title}</span>
                  <span className="text-[11px] text-ink-3">{w.reason ?? meta.hint}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
      <div className="mb-2.5 text-[12px] font-semibold uppercase tracking-wider text-ink-3">Start from a chart type</div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {CHART_TYPES.map((c) => (
          <button key={c.type} onClick={() => add(blankWidget(ds, c.type))} className="flex flex-col items-center gap-1.5 rounded-xl border border-line px-2 py-3 text-[12px] font-medium text-ink-2 transition hover:border-accent hover:text-accent-ink">
            {c.icon}{c.label}
            <span className="text-center text-[10px] font-normal text-ink-3">{c.hint}</span>
          </button>
        ))}
      </div>
      <p className="mt-4 flex items-center gap-1.5 text-[12px] text-ink-3"><Download size={12} />Tip: type a question in the bar above the filters to build a chart from plain English.</p>
    </Modal>
  )
}
