import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import type { Dataset, Filter, Page } from '../types'
import { colMap, labelOf } from '../lib/aggregate'
import { fmtDate } from '../lib/format'
import { relativeLabel } from './FilterBar'
import { useDashboardFull, useStore } from '../store'
import { ThemeContext } from './theme'
import { WidgetCard } from './WidgetCard'
import { Button } from './ui'

/**
 * Share → Print report: every dashboard page on its own sheet, after a cover with the data's date range.
 * Rendered over the app at a fixed width (so screen and paper layouts match), printed, then closed.
 */
export function PrintReport({ ds }: { ds: Dataset }) {
  const dash = useDashboardFull()
  const { setPrinting } = useStore.getState()
  const cover = useMemo(() => coverFacts(ds), [ds])

  useEffect(() => {
    document.body.classList.add('printing-report')
    const done = () => setPrinting(false)
    window.addEventListener('afterprint', done)
    // charts draw on mount and animate briefly; print once they have
    const t = setTimeout(() => window.print(), 1200)
    return () => { clearTimeout(t); window.removeEventListener('afterprint', done); document.body.classList.remove('printing-report') }
  }, [setPrinting])

  if (!dash) return null
  const noop = () => {}
  return createPortal(
    <div className="print-report fixed inset-0 z-[95] overflow-auto bg-page" role="region" aria-label="Report">
      <div className="no-print sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-surface px-5 py-2.5 text-[13px]">
        <span className="flex items-center gap-2 text-ink-2"><Loader2 size={14} className="animate-spin text-accent" />Preparing the report for printing — one sheet per page…</span>
        <Button size="sm" variant="ghost" onClick={() => setPrinting(false)}><X size={14} />Close</Button>
      </div>
      {/* paper is light: charts follow */}
      <ThemeContext.Provider value="light">
        <div className="mx-auto w-[1000px] py-6">
          <section className="report-sheet flex min-h-[640px] flex-col justify-center px-2">
            <div className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">Report</div>
            <h1 className="mt-2 text-[34px] font-semibold tracking-tight">{ds.name}</h1>
            <dl className="mt-6 grid max-w-[640px] grid-cols-[160px_1fr] gap-y-2 text-[14px]">
              {cover.range && <><dt className="text-ink-3">Data covers</dt><dd>{cover.range}</dd></>}
              <dt className="text-ink-3">Rows</dt><dd>{ds.rows.length.toLocaleString()}</dd>
              <dt className="text-ink-3">Source</dt><dd>{ds.fileName}</dd>
              {ds.source.lastLoaded && <><dt className="text-ink-3">Last updated</dt><dd>{fmtDate(ds.source.lastLoaded)}</dd></>}
              <dt className="text-ink-3">Printed</dt><dd>{fmtDate(Date.now())}</dd>
            </dl>
            <h2 className="mt-8 text-[13px] font-semibold uppercase tracking-wider text-ink-3">Contents</h2>
            <ol className="mt-2 list-decimal pl-5 text-[14px]">
              {dash.pages.map((p) => <li key={p.id}>{p.name} <span className="text-ink-3">· {p.widgets.length} widget{p.widgets.length === 1 ? '' : 's'}</span></li>)}
            </ol>
          </section>
          {dash.pages.map((page, i) => (
            <section key={page.id} className="report-sheet pt-4" aria-label={`Page ${i + 1}: ${page.name}`}>
              <div className="mb-3 flex items-baseline justify-between border-b border-line pb-2">
                <h2 className="text-[20px] font-semibold">{page.name}</h2>
                <span className="text-[12px] text-ink-3">{ds.name} · page {i + 1} of {dash.pages.length}</span>
              </div>
              {page.filters.length > 0 && <p className="mb-3 text-[12px] text-ink-2">Filtered: {describeFilters(ds, page)}</p>}
              <div className="grid grid-cols-12 gap-3">
                {page.widgets.map((w) => (
                  <WidgetCard key={w.id} ds={ds} widget={w} filters={page.filters} selected={false} dragging={false}
                    onDragStart={noop} onDragOver={noop} onDrop={noop} onMove={noop} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </ThemeContext.Provider>
    </div>,
    document.body,
  )
}

/** First and last date of the main date column. */
function coverFacts(ds: Dataset): { range?: string } {
  const date = ds.columns.find((c) => c.type === 'date' && c.formula == null)
  if (!date) return {}
  let lo = Infinity, hi = -Infinity
  for (const r of ds.rows) { const v = r[date.key]; if (typeof v === 'number') { if (v < lo) lo = v; if (v > hi) hi = v } }
  return Number.isFinite(lo) ? { range: `${fmtDate(lo)} – ${fmtDate(hi)} (${date.name})` } : {}
}

function describeFilters(ds: Dataset, page: Page): string {
  const cols = colMap(ds)
  return page.filters.map((f: Filter) => {
    const c = cols.get(f.column)
    if (!c) return null
    if (f.relative) return `${c.name}: ${relativeLabel(f.relative)}`
    if (f.values?.length) return `${c.name}${f.exclude ? ' is not' : ''}: ${f.values.join(', ')}`
    if (f.min != null || f.max != null) return `${c.name}: ${f.min != null ? labelOf(f.min, c) : '…'} – ${f.max != null ? labelOf(f.max, c) : '…'}`
    if (f.text) return `${c.name} contains “${f.text}”`
    return null
  }).filter(Boolean).join(' · ')
}
