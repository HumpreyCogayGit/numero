import { useDeferredValue, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, RotateCcw, Search, Pencil, FunctionSquare, Trash2, AlertCircle, FileSpreadsheet, Paintbrush } from 'lucide-react'
import type { ColType, Column, ColumnFormat, Dataset, NumFormat } from '../types'
import { filteredRows } from '../lib/aggregate'
import { exportRows, exportXlsx } from '../lib/share'
import { fmtValue } from '../lib/format'
import { downloadText, downloadUrl, slug, toCsv } from '../lib/hooks'
import { useDashboard, useStore } from '../store'
import { FilterBar } from './FilterBar'
import { Button, confirmDialog, cx, MenuItem, Modal, Popover, Toggle, TypeIcon, typeLabel } from './ui'

const PAGE = 50
const TYPES: ColType[] = ['number', 'date', 'category', 'text', 'boolean']

export function DataTable({ ds }: { ds: Dataset }) {
  const dash = useDashboard()
  const { setFilters } = useStore.getState()
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null)
  const [page, setPage] = useState(0)
  const filters = dash?.filters ?? []

  // search and sort over large tables run as a background render, so typing stays responsive
  const dq = useDeferredValue(q)
  const dsort = useDeferredValue(sort)
  const rows = useMemo(() => {
    const q = dq, sort = dsort
    let r = filteredRows(ds, filters)
    if (q) {
      const s = q.toLowerCase()
      r = r.filter((row) => ds.columns.some((c) => {
        const v = row[c.key]
        return v != null && fmtValue(v, c).toLowerCase().includes(s)
      }))
    }
    if (sort) {
      const k = sort.key
      r = [...r].sort((a, b) => {
        const x = a[k], y = b[k]
        if (x == null) return 1
        if (y == null) return -1
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sort.dir
      })
    }
    return r
  }, [ds, filters, dq, dsort])

  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const p = Math.min(page, pages - 1)
  const slice = rows.slice(p * PAGE, p * PAGE + PAGE)

  const exportCsv = () => downloadText(`${slug(ds.name)}.csv`, toCsv(ds.columns.map((c) => c.name), exportRows(ds, rows)))
  const exportExcel = async () => downloadUrl(`${slug(ds.name)}.xlsx`, URL.createObjectURL(await exportXlsx(ds, rows)))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar ds={ds} filters={filters} onChange={setFilters} />
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-2.5 text-ink-3" />
            <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} placeholder="Search all columns…" className="field h-8 w-56 pl-8" />
          </div>
          <Button size="sm" onClick={() => useStore.getState().openFormula()}><FunctionSquare size={14} />Add column</Button>
          <Popover align="right" width={200} trigger={(_, toggle) => <Button size="sm" onClick={toggle}><Download size={14} />Export</Button>}>
            {(close) => (
              <>
                <MenuItem icon={<Download size={14} />} onClick={() => { exportCsv(); close() }}>CSV ({rows.length.toLocaleString()} rows)</MenuItem>
                <MenuItem icon={<FileSpreadsheet size={14} />} onClick={() => { void exportExcel(); close() }}>Excel (.xlsx)</MenuItem>
              </>
            )}
          </Popover>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="max-h-[calc(100vh-280px)] min-h-[300px] overflow-auto">
          <table className="tabular w-full border-separate border-spacing-0 text-[13px]">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className="sticky left-0 z-20 w-12 border-b border-r border-line bg-surface-2 px-3 py-2 text-right text-[11px] font-medium text-ink-3">#</th>
                {ds.columns.map((c) => (
                  <th key={c.key} className="min-w-[120px] border-b border-line bg-surface-2 px-3 py-2 text-left align-middle font-medium">
                    <HeaderCell col={c} sort={sort?.key === c.key ? sort.dir : 0} onSort={(dir) => { setSort(dir ? { key: c.key, dir } : null); setPage(0) }} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slice.map((r, i) => (
                <tr key={p * PAGE + i} className="hover:bg-surface-2">
                  <td className="sticky left-0 border-b border-r border-line bg-surface px-3 py-1.5 text-right text-[11px] text-ink-3">{p * PAGE + i + 1}</td>
                  {ds.columns.map((c) => {
                    const v = r[c.key]
                    return (
                      <td key={c.key} className={cx('max-w-[320px] truncate border-b border-line px-3 py-1.5', c.type === 'number' ? 'text-right' : 'text-left', v == null ? 'text-ink-3' : 'text-ink')}>
                        {v == null ? <span className="text-[11px] italic">null</span> : fmtValue(v, c)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[12px] text-ink-3">
          <span>{rows.length.toLocaleString()} of {ds.rows.length.toLocaleString()} rows · {ds.columns.length} columns</span>
          <div className="flex items-center gap-2">
            <span>Page {p + 1} of {pages}</span>
            <Button size="sm" variant="ghost" disabled={p === 0} onClick={() => setPage(p - 1)} aria-label="Previous page"><ChevronLeft size={14} /></Button>
            <Button size="sm" variant="ghost" disabled={p >= pages - 1} onClick={() => setPage(p + 1)} aria-label="Next page"><ChevronRight size={14} /></Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function HeaderCell({ col, sort, onSort }: { col: Column; sort: 0 | 1 | -1; onSort: (d: 0 | 1 | -1) => void }) {
  const { setColumnType, renameColumn, openFormula, deleteComputed } = useStore.getState()
  const computed = col.formula != null
  const [renaming, setRenaming] = useState(false)
  const [formatting, setFormatting] = useState(false)
  return (
    <div className={cx('flex items-center gap-1.5', col.type === 'number' && 'justify-end')}>
      {renaming ? (
        <input autoFocus aria-label={`Rename ${col.name}`} defaultValue={col.name} className="field h-7 w-40 px-2 text-[13px] font-normal"
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== col.name) void renameColumn(col.key, v); setRenaming(false) }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { e.stopPropagation(); setRenaming(false) } }} />
      ) : (
      <Popover width={220} trigger={(_, toggle) => (
        <button onClick={toggle} onDoubleClick={() => setRenaming(true)} title="Click for options, double-click to rename" className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-surface-3">
          <TypeIcon type={col.type} />
          <span className="truncate text-ink">{col.name}</span>
          {computed && <span title={col.formula} className="rounded bg-accent-soft px-1 font-mono text-[10px] font-semibold text-accent-ink">ƒ</span>}
          {col.formulaError && <span title={col.formulaError}><AlertCircle size={13} className="text-bad" /></span>}
        </button>
      )}>
        {(close) => computed ? (
          <>
            <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-ink-3">Computed column</div>
            <code className="mx-2.5 mb-1.5 block truncate rounded-md bg-surface-2 px-2 py-1 font-mono text-[11px] text-ink-2" title={col.formula}>{col.formula}</code>
            {col.formulaError && <div className="mx-2.5 mb-1.5 text-[11px] text-bad">{col.formulaError}</div>}
            <MenuItem icon={<FunctionSquare size={14} />} onClick={() => { openFormula(col.key); close() }}>Edit formula…</MenuItem>
            {(col.type === 'number' || col.type === 'date') && <MenuItem icon={<Paintbrush size={14} />} onClick={() => { setFormatting(true); close() }}>Format…</MenuItem>}
            <MenuItem icon={<ArrowUp size={14} />} onClick={() => { onSort(1); close() }}>Sort ascending</MenuItem>
            <MenuItem icon={<ArrowDown size={14} />} onClick={() => { onSort(-1); close() }}>Sort descending</MenuItem>
            <div className="my-1 border-t border-line" />
            <MenuItem danger icon={<Trash2 size={14} />} onClick={async () => {
              close()
              if (await confirmDialog({ title: `Delete computed column “${col.name}”?`, body: 'Charts using it will be flagged. You can undo this.', confirmLabel: 'Delete', danger: true })) void deleteComputed(col.key)
            }}>Delete column</MenuItem>
          </>
        ) : (
          <>
            <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-ink-3">Column type</div>
            {TYPES.map((t) => (
              <MenuItem key={t} active={col.type === t} icon={<TypeIcon type={t} />} onClick={() => { if (t !== col.type) void setColumnType(col.key, t === col.detected ? null : t); close() }}>
                {typeLabel(t)}{col.detected === t && <span className="ml-auto text-[10px] text-ink-3">detected</span>}
              </MenuItem>
            ))}
            {col.type !== col.detected && (
              <MenuItem icon={<RotateCcw size={14} />} onClick={() => { void setColumnType(col.key, null); close() }}>Reset to detected</MenuItem>
            )}
            <div className="my-1 border-t border-line" />
            <MenuItem icon={<Pencil size={14} />} onClick={() => { setRenaming(true); close() }}>Rename</MenuItem>
            {(col.type === 'number' || col.type === 'date') && <MenuItem icon={<Paintbrush size={14} />} onClick={() => { setFormatting(true); close() }}>Format…</MenuItem>}
            <MenuItem icon={<ArrowUp size={14} />} onClick={() => { onSort(1); close() }}>Sort ascending</MenuItem>
            <MenuItem icon={<ArrowDown size={14} />} onClick={() => { onSort(-1); close() }}>Sort descending</MenuItem>
          </>
        )}
      </Popover>
      )}
      <button onClick={() => onSort(sort === 0 ? -1 : sort === -1 ? 1 : 0)} className={cx('rounded p-0.5', sort ? 'text-accent' : 'text-ink-3 hover:text-ink')} aria-label={`Sort by ${col.name}`}>
        {sort === 1 ? <ArrowUp size={13} /> : <ArrowDown size={13} className={sort ? '' : 'opacity-40'} />}
      </button>
      {formatting && <ColumnFormatDialog col={col} onClose={() => setFormatting(false)} />}
    </div>
  )
}

/** Display settings for a column — used everywhere the column's values appear. */
function ColumnFormatDialog({ col, onClose }: { col: Column; onClose: () => void }) {
  const [f, setF] = useState<ColumnFormat>(col.display ?? {})
  const upd = (p: Partial<ColumnFormat>) => setF(Object.fromEntries(Object.entries({ ...f, ...p }).filter(([, v]) => v !== undefined && v !== '')) as ColumnFormat)
  const sample = col.type === 'date' ? Date.UTC(2024, 2, 7, 14, 30) : 1234567.891
  const preview = fmtValue(sample, { ...col, display: f, format: f.num ?? col.format })
  return (
    <Modal title={`Format “${col.name}”`} onClose={onClose} width={440}>
      <div className="space-y-3 text-left font-normal">
        {col.type === 'number' ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <label className="block"><span className="mb-1.5 block text-[12px] font-medium text-ink-2">Show as</span>
                <select aria-label="Show as" className="field" value={f.num ?? ''} onChange={(e) => upd({ num: (e.target.value || undefined) as NumFormat | undefined })}>
                  <option value="">Detected ({col.format ?? 'decimal'})</option>
                  <option value="integer">Number</option><option value="decimal">Decimal</option><option value="currency">Currency</option>
                  <option value="percent">Percent (value is %)</option><option value="ratio">Percent (ratio ×100)</option>
                </select>
              </label>
              <label className="block"><span className="mb-1.5 block text-[12px] font-medium text-ink-2">Decimals</span>
                <select aria-label="Decimals" className="field" value={f.decimals ?? ''} onChange={(e) => upd({ decimals: e.target.value === '' ? undefined : +e.target.value })}>
                  <option value="">Auto</option>{[0, 1, 2, 3, 4].map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <label className="block"><span className="mb-1.5 block text-[12px] font-medium text-ink-2">Prefix</span><input aria-label="Prefix" className="field" value={f.prefix ?? ''} onChange={(e) => upd({ prefix: e.target.value })} /></label>
              <label className="block"><span className="mb-1.5 block text-[12px] font-medium text-ink-2">Suffix</span><input aria-label="Suffix" className="field" value={f.suffix ?? ''} onChange={(e) => upd({ suffix: e.target.value })} /></label>
              <label className="block"><span className="mb-1.5 block text-[12px] font-medium text-ink-2">Currency</span><input aria-label="Currency symbol" className="field" placeholder={col.currency ?? '$'} value={f.currency ?? ''} onChange={(e) => upd({ currency: e.target.value })} /></label>
            </div>
            <div className="rounded-xl border border-line px-3"><Toggle label="Short numbers in charts (1.2M)" checked={f.compact !== false} onChange={(v) => upd({ compact: v ? undefined : false })} /></div>
          </>
        ) : (
          <label className="block"><span className="mb-1.5 block text-[12px] font-medium text-ink-2">Date pattern</span>
            <select aria-label="Date pattern" className="field" value={f.datePattern ?? ''} onChange={(e) => upd({ datePattern: e.target.value || undefined })}>
              <option value="">Automatic</option>
              {['MMM D, YYYY', 'D MMM YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'MMMM YYYY', 'YYYY', "'Q'Q YYYY", 'ddd, MMM D', 'YYYY-MM-DD HH:mm'].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
        )}
        <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px]"><span className="text-ink-3">Preview </span><b className="tabular font-semibold">{preview}</b></div>
      </div>
      <div className="mt-5 flex justify-between">
        <Button size="sm" variant="ghost" onClick={() => { void useStore.getState().setColumnFormat(col.key, undefined); onClose() }}>Reset</Button>
        <div className="flex gap-2">
          <Button size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={() => { void useStore.getState().setColumnFormat(col.key, f); onClose() }}>Apply</Button>
        </div>
      </div>
    </Modal>
  )
}
