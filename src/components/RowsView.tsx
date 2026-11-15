import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, Rows3 } from 'lucide-react'
import type { Dataset, Filter, Widget } from '../types'
import { rowsBehind } from '../lib/aggregate'
import { exportRows } from '../lib/share'
import { downloadText, slug, toCsv } from '../lib/hooks'
import { fmtValue } from '../lib/format'
import { useStore } from '../store'
import { Button, cx, IconButton, Modal } from './ui'

const PAGE = 50

/** The rows behind a widget (or one of its marks): page and widget filters, drill path, and the clicked mark. */
export function RowsView({ ds, widget, filters, extra, label }: { ds: Dataset; widget: Widget; filters: Filter[]; extra: Omit<Filter, 'id'>[]; label?: string }) {
  const { showRows } = useStore.getState()
  const rows = useMemo(() => rowsBehind(ds, widget, filters, extra), [ds, widget, filters, extra])
  const [p, setP] = useState(0)
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const slice = rows.slice(p * PAGE, (p + 1) * PAGE)
  const download = () => downloadText(`${slug(widget.title || 'rows')}${label ? `-${slug(label)}` : ''}.csv`, toCsv(ds.columns.map((c) => c.name), exportRows(ds, rows)))
  return (
    <Modal title={<span className="flex items-center gap-2"><Rows3 size={16} className="text-accent" />Rows behind “{widget.title || 'Text'}”</span>} onClose={() => showRows(null)} width={1180}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[13px]">
        <span className="text-ink-2">
          <b className="font-medium text-ink">{rows.length.toLocaleString()}</b> row{rows.length === 1 ? '' : 's'}
          {label && <> · <span className="rounded-md bg-accent-soft px-1.5 py-0.5 font-medium text-accent-ink">{label}</span></>}
          {(filters.length > 0 || (widget.filters?.length ?? 0) > 0) && <span className="text-ink-3"> · with this page’s and widget’s filters</span>}
        </span>
        <Button size="sm" onClick={download} disabled={!rows.length}><Download size={14} />Download CSV</Button>
      </div>
      <div className="max-h-[60vh] overflow-auto rounded-xl border border-line" tabIndex={0} role="region" aria-label="Rows table">
        <table className="tabular w-full text-[12.5px]" aria-label="Rows">
          <thead className="sticky top-0 bg-surface-2">
            <tr>{ds.columns.map((c) => <th key={c.key} className={cx('whitespace-nowrap border-b border-line px-3 py-2 font-medium text-ink-3', c.type === 'number' ? 'text-right' : 'text-left')}>{c.name}</th>)}</tr>
          </thead>
          <tbody>
            {slice.map((r, i) => (
              <tr key={i} className="border-b border-line/60 hover:bg-surface-2">
                {ds.columns.map((c) => <td key={c.key} className={cx('max-w-[260px] truncate whitespace-nowrap px-3 py-1.5', c.type === 'number' ? 'text-right text-ink' : 'text-ink-2')}>{fmtValue(r[c.key], c)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="p-6 text-center text-[13px] text-ink-3">No rows match.</p>}
      </div>
      {pages > 1 && (
        <div className="mt-2 flex items-center justify-end gap-1 text-[12px] text-ink-3">
          {(p * PAGE + 1).toLocaleString()}–{Math.min(rows.length, (p + 1) * PAGE).toLocaleString()} of {rows.length.toLocaleString()}
          <IconButton label="Previous page" disabled={p === 0} onClick={() => setP(p - 1)}><ChevronLeft size={14} /></IconButton>
          <IconButton label="Next page" disabled={p >= pages - 1} onClick={() => setP(p + 1)}><ChevronRight size={14} /></IconButton>
        </div>
      )}
    </Modal>
  )
}
