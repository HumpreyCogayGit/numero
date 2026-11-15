import { useMemo, useState } from 'react'
import { Download, Plus, X } from 'lucide-react'
import type { Agg, Dataset, DateBucket, Measure } from '../types'
import { AGG_LABEL, BUCKET_LABEL, colMap, measureColumn, measureLabel, runPivot } from '../lib/aggregate'
import { fmtNumber, fmtPct } from '../lib/format'
import { TOKENS, inkOn } from '../lib/palette'
import { downloadText, slug, toCsv } from '../lib/hooks'
import { dimensionCols, measureCols } from '../lib/profile'
import { defaultAgg } from '../lib/suggest'
import { useDashboard } from '../store'
import { useTheme } from './theme'
import { Button, cx, SectionLabel, Segmented, Toggle } from './ui'

type ShowAs = 'value' | 'row' | 'col' | 'total'

export function PivotView({ ds }: { ds: Dataset }) {
  const dash = useDashboard()
  const theme = useTheme()
  const t = TOKENS[theme]
  const dims = useMemo(() => [...ds.columns.filter((c) => c.type === 'date'), ...dimensionCols(ds), ...ds.columns.filter((c) => c.type === 'number' && c.discrete)], [ds])
  const nums = measureCols(ds)
  const [rows, setRows] = useState<string[]>(() => [dimensionCols(ds)[0]?.key ?? dims[0]?.key].filter(Boolean) as string[])
  const firstDate = ds.columns.find((c) => c.type === 'date')
  // columns default to another small category, else the date by year
  const [colDim, setColDim] = useState<string | undefined>(() => dims.find((d) => !rows.includes(d.key) && d.type !== 'date' && d.distinct <= 12)?.key ?? firstDate?.key)
  const [measure, setMeasure] = useState<Measure>(() => (nums[0] ? { id: 'p', column: nums[0].key, agg: defaultAgg(nums[0]) } : { id: 'p', agg: 'count' }))
  const [buckets, setBuckets] = useState<Record<string, DateBucket>>(() => (firstDate ? { [firstDate.key]: 'year' } : {}))
  const [showAs, setShowAs] = useState<ShowAs>('value')
  const [heat, setHeat] = useState(true)
  const cols = colMap(ds)

  const pv = useMemo(() => (rows.length ? runPivot(ds, rows, colDim, measure, dash?.filters ?? [], buckets) : null), [ds, rows, colDim, measure, dash?.filters, buckets])
  const fmtCol = measureColumn(measure, cols)

  const transform = (v: number | null, ri: number, ci: number): number | null => {
    if (v == null || !pv) return v
    if (showAs === 'row') return pv.rowTotals[ri] ? v / pv.rowTotals[ri]! : null
    if (showAs === 'col') return pv.colTotals[ci] ? v / pv.colTotals[ci]! : null
    if (showAs === 'total') return pv.grand ? v / pv.grand : null
    return v
  }
  // % views only make sense for additive measures
  const additive = measure.agg === 'count' || measure.agg === 'sum' || measure.agg === 'distinct'
  const fmt = (v: number | null) => (v == null ? '' : showAs === 'value' ? fmtNumber(v, fmtCol, { compact: false }) : fmtPct(v))

  let min = Infinity, max = -Infinity
  pv?.cells.forEach((r, ri) => r.forEach((v, ci) => { const x = transform(v, ri, ci); if (x != null) { if (x < min) min = x; if (x > max) max = x } }))
  const cellColor = (x: number | null) => {
    if (!heat || x == null || max === min) return undefined
    const step = Math.round(((x - min) / (max - min)) * 5)
    return t.sequential[step]
  }

  const exportCsv = () => {
    if (!pv) return
    const headers = [...rows.map((r) => cols.get(r)!.name), ...(colDim ? pv.colHeaders : []), 'Total']
    const body = pv.rowHeaders.map((rh, i) => [...rh, ...pv.cells[i].map((v, j) => transform(v, i, j)), pv.rowTotals[i]])
    downloadText(`${slug(ds.name)}-pivot.csv`, toCsv(headers, body))
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <aside className="card h-fit space-y-5 p-4">
        <div>
          <SectionLabel>Rows</SectionLabel>
          <div className="space-y-1.5">
            {rows.map((r, i) => (
              <div key={i} className="flex gap-1.5">
                <select aria-label={`Row field ${i + 1}`} className="field" value={r} onChange={(e) => setRows(rows.map((x, j) => (j === i ? e.target.value : x)))}>
                  {dims.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
                </select>
                {rows.length > 1 && <button className="px-1 text-ink-3 hover:text-ink" aria-label="Remove row field" onClick={() => setRows(rows.filter((_, j) => j !== i))}><X size={14} /></button>}
              </div>
            ))}
            {rows.length < 3 && (
              <button className="inline-flex items-center gap-1 text-[12px] font-medium text-accent-ink hover:underline" onClick={() => setRows([...rows, dims.find((d) => !rows.includes(d.key))?.key ?? dims[0].key])}>
                <Plus size={13} />Add row field
              </button>
            )}
          </div>
        </div>
        <div>
          <SectionLabel>Columns</SectionLabel>
          <select aria-label="Column field" className="field" value={colDim ?? ''} onChange={(e) => setColDim(e.target.value || undefined)}>
            <option value="">None</option>
            {dims.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
          </select>
        </div>
        {[...rows, colDim].filter((k): k is string => !!k && cols.get(k)?.type === 'date').map((k) => (
          <div key={k}>
            <SectionLabel>{cols.get(k)!.name} granularity</SectionLabel>
            <select aria-label={`${cols.get(k)!.name} granularity`} className="field" value={buckets[k] ?? 'auto'} onChange={(e) => setBuckets({ ...buckets, [k]: e.target.value as DateBucket })}>
              {(Object.keys(BUCKET_LABEL) as DateBucket[]).map((b) => <option key={b} value={b}>{BUCKET_LABEL[b]}</option>)}
            </select>
          </div>
        ))}
        <div>
          <SectionLabel>Values</SectionLabel>
          <div className="space-y-1.5">
            <select aria-label="Aggregation" className="field" value={measure.agg === 'calc' ? `calc:${measure.calc}` : measure.agg} onChange={(e) => {
              const v = e.target.value
              if (v.startsWith('calc:')) { setMeasure({ id: 'p', agg: 'calc', calc: v.slice(5) }); return }
              const agg = v as Agg
              setMeasure(agg === 'count' ? { id: 'p', agg } : { id: 'p', agg, column: measure.column ?? nums[0]?.key })
            }}>
              <optgroup label="Aggregate a column">
                {(Object.keys(AGG_LABEL) as Agg[]).filter((a) => a !== 'calc').map((a) => <option key={a} value={a}>{a === 'count' ? 'Count rows' : AGG_LABEL[a]}</option>)}
              </optgroup>
              {ds.model.measures.length > 0 && (
                <optgroup label="Calculated measures">
                  {ds.model.measures.map((d) => <option key={d.key} value={`calc:${d.key}`}>ƒ {d.name}</option>)}
                </optgroup>
              )}
            </select>
            {measure.agg !== 'count' && measure.agg !== 'calc' && (
              <select aria-label="Value column" className="field" value={measure.column} onChange={(e) => setMeasure({ ...measure, column: e.target.value })}>
                {(measure.agg === 'distinct' ? ds.columns : nums).map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
              </select>
            )}
          </div>
        </div>
        <div>
          <SectionLabel>Show as</SectionLabel>
          <select aria-label="Show as" className="field" value={showAs} onChange={(e) => setShowAs(e.target.value as ShowAs)}>
            <option value="value">Values</option>
            <option value="row" disabled={!additive || !colDim}>% of row total</option>
            <option value="col" disabled={!additive || !colDim}>% of column total</option>
            <option value="total" disabled={!additive}>% of grand total</option>
          </select>
        </div>
        <div className="rounded-xl border border-line px-3"><Toggle label="Heatmap shading" checked={heat} onChange={setHeat} /></div>
      </aside>

      <div className="card min-w-0 overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-[13px] text-ink-2">
            <span className="font-medium text-ink">{measureLabel(measure, cols)}</span>
            {pv && <span className="text-ink-3"> · {pv.rowHeaders.length.toLocaleString()} rows{colDim ? ` × ${pv.colHeaders.length} columns` : ''}</span>}
          </div>
          <div className="flex items-center gap-2">
            <Segmented<ShowAs> size="sm" value={showAs} onChange={(v) => (v === 'value' || additive) && setShowAs(v)} options={[
              { value: 'value', label: '123' }, { value: 'total', label: '%', title: '% of grand total' },
            ]} />
            <Button size="sm" onClick={exportCsv}><Download size={14} />CSV</Button>
          </div>
        </div>
        {pv && (
          <div className="max-h-[calc(100vh-260px)] overflow-auto">
            <table className="tabular w-full border-separate border-spacing-0 text-[13px]">
              <thead className="sticky top-0 z-10 bg-surface-2">
                <tr>
                  {rows.map((r) => <th key={r} className="sticky left-0 border-b border-line bg-surface-2 px-3 py-2 text-left font-medium text-ink-2">{cols.get(r)?.name}</th>)}
                  {pv.colHeaders.map((h) => <th key={h} className="whitespace-nowrap border-b border-line px-3 py-2 text-right font-medium text-ink-2">{h}</th>)}
                  <th className="border-b border-l border-line px-3 py-2 text-right font-semibold text-ink">Total</th>
                </tr>
              </thead>
              <tbody>
                {pv.rowHeaders.map((rh, i) => (
                  <tr key={i} className="hover:bg-surface-2">
                    {rh.map((h, j) => {
                      const repeat = i > 0 && j < rh.length - 1 && pv.rowHeaders[i - 1].slice(0, j + 1).join('\u0000') === rh.slice(0, j + 1).join('\u0000')
                      return <td key={j} className={cx('max-w-[220px] truncate border-b border-line px-3 py-1.5', repeat ? 'text-transparent' : 'text-ink')}>{h}</td>
                    })}
                    {pv.cells[i].map((v, j) => {
                      const x = transform(v, i, j)
                      const bg = cellColor(x)
                      return (
                        <td key={j} className="border-b border-line px-1 py-0.5 text-right">
                          <span className="block rounded-md px-2 py-1" style={bg ? { background: bg, color: inkOn(bg) } : undefined}>{fmt(x)}</span>
                        </td>
                      )
                    })}
                    <td className="border-b border-l border-line px-3 py-1.5 text-right font-medium">{fmt(showAs === 'total' && pv.grand ? (pv.rowTotals[i] ?? 0) / pv.grand : showAs === 'value' ? pv.rowTotals[i] : showAs === 'row' ? 1 : null)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 bg-surface-2">
                <tr>
                  <td colSpan={rows.length} className="border-t border-line px-3 py-2 font-semibold">Total</td>
                  {pv.colTotals.map((v, j) => <td key={j} className="border-t border-line px-3 py-2 text-right font-medium">{fmt(showAs === 'total' && pv.grand ? (v ?? 0) / pv.grand : showAs === 'value' ? v : showAs === 'col' ? 1 : null)}</td>)}
                  <td className="border-l border-t border-line px-3 py-2 text-right font-semibold">{fmt(showAs === 'value' ? pv.grand : 1)}</td>
                </tr>
              </tfoot>
            </table>
            {(pv.hiddenRows > 0 || pv.hiddenCols > 0) && (
              <div className="flex flex-wrap items-center gap-2 border-t border-line p-3 text-[12px] text-ink-3">
                <span>
                  Showing the first {pv.rowHeaders.length.toLocaleString()} row groups{pv.hiddenRows ? ` (${pv.hiddenRows.toLocaleString()} more hidden)` : ''}
                  {pv.hiddenCols ? ` and ${pv.colHeaders.length} columns (${pv.hiddenCols.toLocaleString()} more hidden)` : ''}.
                </span>
                {[...rows, colDim].some((k) => k && cols.get(k)?.type === 'date' && (buckets[k] ?? 'auto') !== 'year') && (
                  <Button size="sm" variant="ghost" onClick={() => setBuckets(Object.fromEntries([...rows, colDim].filter((k): k is string => !!k && cols.get(k)?.type === 'date').map((k) => [k, 'year' as DateBucket])))}>Group dates by year</Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
