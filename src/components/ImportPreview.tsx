import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, FileSpreadsheet, Info, Loader2 } from 'lucide-react'
import type { ColType, ImportOptions, PrepStep } from '../types'
import { inferColumn, localeDayFirst, type ColumnNote } from '../lib/infer'
import { fmtBytes } from '../lib/format'
import type { ImportCheck, ImportReview, PrepFix } from '../lib/quality'
import type { RaggedReport } from '../lib/parse'
import { engine } from '../engine/client'
import { uid } from '../lib/suggest'
import { useStore } from '../store'
import { Button, cx, Modal, Toggle, TypeIcon, typeLabel } from './ui'

const TYPES: ColType[] = ['number', 'date', 'category', 'text', 'boolean']
const DELIMS: [string, string][] = [['', 'Detect'], [',', 'Comma ,'], [';', 'Semicolon ;'], ['\t', 'Tab'], ['|', 'Pipe |']]
const ENCODINGS: [string, string][] = [['', 'Detect'], ['utf-8', 'UTF-8'], ['windows-1252', 'Windows-1252 (Western, Latin-1)'], ['iso-8859-15', 'ISO-8859-15 (Latin-9)'], ['utf-16le', 'UTF-16 LE'], ['shift_jis', 'Shift-JIS'], ['gb18030', 'GB18030']]
const BIG = 1_000_000

export function ImportPreview() {
  const pending = useStore((s) => s.pending)
  const { reparse, commitImport, cancelImport } = useStore.getState()
  const preview = pending?.preview
  const [sheetName, setSheetName] = useState(preview?.sheets[0]?.name ?? '')
  const [name, setName] = useState(() => (preview?.fileName ?? '').replace(/\.[^.]+$/, ''))
  const [overrides, setOverrides] = useState<Record<string, ColType>>({})
  // the decimal comma is preselected when the file is clear about it (see startImport); otherwise it is proposed below
  const [infer, setInfer] = useState<Pick<ImportOptions, 'decimal' | 'dateOrder' | 'softBlanks'>>(() => (pending?.options.decimal ? { decimal: pending.options.decimal } : {}))
  /** preparation steps the user picked from the checks ("leave those rows out"): added to the dataset on import */
  const [fixes, setFixes] = useState<Record<string, PrepFix>>({})
  const [review, setReview] = useState<ImportReview | null>(null)
  const token = preview?.token
  const activeSheet = preview?.sheets.find((s) => s.name === sheetName)?.name ?? preview?.sheets[0]?.name
  // the checks run in the data engine on the parsed file, again whenever a setting that changes detection is touched
  useEffect(() => {
    if (!token || !activeSheet) return
    let live = true
    void engine('importReview', { token, sheet: activeSheet, options: infer, overrides }).then((r) => { if (live) setReview(r) }).catch(() => { if (live) setReview(null) })
    return () => { live = false }
  }, [token, activeSheet, infer, overrides])
  if (!pending || !preview) return null

  const sheet = preview.sheets.find((s) => s.name === sheetName) ?? preview.sheets[0]
  const o = pending.options
  const delimited = preview.format === 'csv' || preview.format === 'tsv'
  const spreadsheet = preview.format === 'xlsx' || preview.format === 'xls'
  const set = (patch: ImportOptions) => reparse({ ...o, ...patch })

  return (
    <Modal title={<span className="flex items-center gap-2"><FileSpreadsheet size={17} className="text-accent" />Import {preview.fileName}</span>} onClose={cancelImport} width={1120}>
      <div className="grid gap-5 lg:grid-cols-[270px_1fr]">
        <aside className="space-y-4">
          <Field label="Dataset name"><input aria-label="Dataset name" className="field" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          {preview.sheets.length > 1 && (
            <Field label="Sheet">
              <select aria-label="Sheet" className="field" value={sheet.name} onChange={(e) => { setSheetName(e.target.value); setOverrides({}) }}>
                {preview.sheets.map((s) => <option key={s.name} value={s.name}>{s.name} · {s.rowCount.toLocaleString()} rows</option>)}
              </select>
            </Field>
          )}
          {delimited && (
            <Field label="Delimiter" hint={!o.delimiter && preview.detected.delimiter ? `Detected: ${preview.detected.delimiter === '\t' ? 'tab' : `“${preview.detected.delimiter}”`}` : undefined}>
              <select aria-label="Delimiter" className="field" value={o.delimiter ?? ''} onChange={(e) => set({ delimiter: e.target.value })}>
                {DELIMS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
              </select>
            </Field>
          )}
          {!spreadsheet && (
            <Field label="Encoding" hint={!o.encoding && preview.detected.encoding ? `Detected: ${preview.detected.encoding}` : undefined}>
              <select aria-label="Encoding" className="field" value={o.encoding ?? ''} onChange={(e) => set({ encoding: e.target.value })}>
                {ENCODINGS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
              </select>
            </Field>
          )}
          {preview.format !== 'json' && (
            <>
              <Field label="Rows to skip above the header">
                <input aria-label="Rows to skip" type="number" min={0} className="field" value={o.skipRows ?? 0} onChange={(e) => set({ skipRows: Math.max(0, +e.target.value || 0) })} />
              </Field>
              <div className="rounded-xl border border-line px-3"><Toggle label="First row is the header" checked={o.header !== false} onChange={(v) => set({ header: v })} /></div>
            </>
          )}
          <Field label="Dates are written">
            <select aria-label="Date order" className="field" value={infer.dateOrder ?? 'auto'} onChange={(e) => setInfer({ ...infer, dateOrder: e.target.value as ImportOptions['dateOrder'] })}>
              <option value="auto">Detect (if unclear: {localeDayFirst() ? 'day/month' : 'month/day'}, from your browser)</option>
              <option value="mdy">Month / Day / Year (US)</option>
              <option value="dmy">Day / Month / Year</option>
              <option value="ymd">Year / Month / Day</option>
            </select>
          </Field>
          <Field label="Decimal separator" hint={infer.decimal === ',' && preview.detected.decimal?.preselect ? 'Detected: comma (semicolon-delimited file)' : undefined}>
            <select aria-label="Decimal separator" className="field" value={infer.decimal ?? '.'} onChange={(e) => setInfer({ ...infer, decimal: e.target.value as '.' | ',' })}>
              <option value=".">Dot — 1,234.5</option>
              <option value=",">Comma — 1.234,5</option>
            </select>
          </Field>
          <Field label="NA, None and - mean">
            <select aria-label="Blank markers" className="field" value={infer.softBlanks ?? 'auto'} onChange={(e) => setInfer({ ...infer, softBlanks: e.target.value as ImportOptions['softBlanks'] })}>
              <option value="auto">Blank in numbers and dates, a value in text</option>
              <option value="always">Always blank</option>
              <option value="never">Always a value, as written</option>
            </select>
          </Field>
          <Field label="Rows to import">
            <select aria-label="Row limit" className="field" value={o.rowLimit ?? 0} onChange={(e) => set({ rowLimit: +e.target.value || undefined })}>
              <option value={0}>All rows</option>
              {[1000, 10_000, 100_000, 500_000, BIG].map((n) => <option key={n} value={n}>First {n.toLocaleString()}</option>)}
            </select>
          </Field>
        </aside>

        <div className="min-w-0">
          <SheetGrid key={`${sheet.name}:${preview.token}`} sheet={sheet} infer={infer} overrides={overrides} setOverrides={setOverrides} busy={!!pending.busy} notes={review?.notes ?? []} />
          <Assumptions
            review={review} ragged={sheet.ragged} files={preview.files}
            decimal={infer.decimal !== ',' && preview.detected.decimal?.decimal === ',' ? preview.detected.decimal.columns : undefined}
            onDecimal={() => setInfer({ ...infer, decimal: ',' })}
            onType={(column, type) => setOverrides({ ...overrides, [column]: type })}
            fixes={fixes} onFix={(key, fix) => setFixes((f) => { const next = { ...f }; if (fix) next[key] = fix; else delete next[key]; return next })}
          />
          {!o.rowLimit && sheet.rowCount > BIG && (
            <div className="mt-3 flex items-start gap-2 rounded-xl bg-[#eda100]/12 px-3 py-2.5 text-[12.5px] text-ink-2">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[#c98500]" />
              <span>This sheet has {sheet.rowCount.toLocaleString()} rows. Everything stays responsive, but memory use is high above a million rows — consider importing the first 1,000,000.</span>
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <span className="text-[12px] text-ink-3">
          {sheet.rowCount.toLocaleString()} rows{sheet.truncated ? ' (row limit)' : ''} · {sheet.headers.length} columns · {fmtBytes(preview.bytes)} · {preview.format.toUpperCase()}
          {sheet.truncated && preview.bytesRead != null && preview.bytesRead < preview.bytes && ` · read ${fmtBytes(preview.bytesRead)} of the file`}
        </span>
        <div className="flex gap-2">
          <Button size="sm" onClick={cancelImport}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={pending.busy || !name.trim()} onClick={() => {
            useStore.setState({ pending: { ...pending, options: { ...pending.options, ...infer } } })
            const prep: PrepStep[] = Object.values(fixes).map((f) => ({ ...f, id: uid('s') }) as PrepStep)
            void commitImport({ sheet: sheet.name, name: name.trim(), overrides, prep })
          }}>
            {pending.busy ? <><Loader2 size={14} className="animate-spin" />Importing…</> : `Import ${sheet.rowCount.toLocaleString()} rows`}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-3">{hint}</span>}
    </label>
  )
}

const pctText = (x: number) => (x < 0.01 ? '<1%' : `${Math.round(x * 100)}%`)

/**
 * "What Numero assumed": everything detection decided that the user might want to check before a dashboard is built
 * on it — uneven rows, blank markers, the decimal separator, and the data-quality checks. Importing anyway is always possible.
 */
function Assumptions({ review, ragged, files, decimal, onDecimal, onType, fixes, onFix }: {
  review: ImportReview | null
  ragged?: RaggedReport
  files?: string[]
  /** columns that only read as numbers with a decimal comma (when comma is not already chosen) */
  decimal?: string[]
  onDecimal: () => void
  onType: (column: string, type: ColType) => void
  fixes: Record<string, PrepFix>
  onFix: (key: string, fix: PrepFix | null) => void
}) {
  const [open, setOpen] = useState<string | null>(null)
  const blanks = (review?.notes ?? []).filter((n) => n.softTokens?.length)
  const checks = review?.checks ?? []
  const nothing = !ragged && !files && !decimal && !blanks.length && !checks.length
  const sampled = review && review.inspected < review.total
  return (
    <section aria-label="What Numero assumed" className="mt-3 rounded-xl border border-line">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h3 className="text-[12.5px] font-semibold">What Numero assumed</h3>
        <span className="text-[11.5px] text-ink-3">
          {!review ? 'Checking…' : sampled ? `Checked an even sample of ${review.inspected.toLocaleString()} of ${review.total.toLocaleString()} rows` : `Checked all ${review.total.toLocaleString()} rows`}
        </span>
      </div>
      {review && nothing ? (
        <p className="flex items-center gap-2 px-3 py-2.5 text-[12.5px] text-ink-2"><Check size={14} className="text-[#0e8f63]" />Nothing unusual: every column read cleanly.</p>
      ) : (
        <ul className="divide-y divide-line text-[12.5px]">
          {files && <Row tone="info">Combined {files.length} files with the same columns: {files.join(', ')}.</Row>}
          {decimal && (
            <Row tone="warning" action={<Button size="sm" onClick={onDecimal}>Use decimal comma</Button>}>
              {decimal.length === 1 ? `“${decimal[0]}” reads` : `${decimal.length} columns (${decimal.slice(0, 3).join(', ')}${decimal.length > 3 ? '…' : ''}) read`} as numbers only with a decimal comma (12,5). They are text for now.
            </Row>
          )}
          {ragged && (
            <Row tone="warning" action={<button className="text-[12px] font-medium text-accent-ink hover:underline" aria-expanded={open === 'ragged'} onClick={() => setOpen(open === 'ragged' ? null : 'ragged')}>{open === 'ragged' ? 'Hide rows' : 'Show rows'}</button>}>
              {(ragged.long + ragged.short).toLocaleString()} {ragged.long + ragged.short === 1 ? 'row has' : 'rows have'} a different number of cells than the header ({ragged.expected}).
              {ragged.long > 0 && ` ${ragged.long.toLocaleString()} with extra cells: the extra cells are not imported.`}
              {ragged.short > 0 && ` ${ragged.short.toLocaleString()} with too few: the missing cells are blank.`}
              {' '}Often a delimiter or quote problem — check the Delimiter setting.
              {open === 'ragged' && (
                <ul className="mt-1.5 space-y-0.5 font-mono text-[11.5px] text-ink-3">
                  {ragged.examples.map((e) => <li key={e.row}>line {e.row} · {e.cells} cells · {e.text}</li>)}
                </ul>
              )}
            </Row>
          )}
          {blanks.map((n) => (
            <Row key={`b:${n.key}`} tone="info">
              In “{n.key}”, {n.softTokens!.map((t) => `${t.token} (${t.count.toLocaleString()})`).join(', ')} {n.softBlank ? 'is read as blank' : 'is kept as a value'}. Change this under “NA, None and - mean”.
            </Row>
          ))}
          {checks.map((c) => {
            const key = `${c.column}:${c.kind}`
            const fix = c.fix
            return (
              <Row key={key} tone={c.severity} action={
                <span className="flex shrink-0 items-center gap-2">
                  {(c.rows.length > 0 || c.examples.length > 0) && <button className="text-[12px] font-medium text-accent-ink hover:underline" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>{open === key ? 'Hide rows' : 'Show rows'}</button>}
                  {fix && 'type' in fix && <Button size="sm" onClick={() => onType(c.column, fix.type)}>{fix.label}</Button>}
                  {fix && 'prep' in fix && (
                    <Button size="sm" variant={fixes[key] ? 'primary' : 'secondary'} aria-pressed={!!fixes[key]} onClick={() => onFix(key, fixes[key] ? null : fix.prep)}>
                      {fixes[key] ? <><Check size={13} />Will be left out</> : fix.label}
                    </Button>
                  )}
                </span>
              }>
                {c.message}{sampled ? ` (${pctText(c.share)} of the rows checked)` : ''}.
                {open === key && <CheckDetail check={c} />}
              </Row>
            )
          })}
        </ul>
      )}
      {checks.length > 0 && <p className="border-t border-line px-3 py-2 text-[11.5px] text-ink-3">None of this changes the file’s values. Change a type above, pick a fix, or import as it is — these notes stay with the dataset under “Source”.</p>}
    </section>
  )
}

function CheckDetail({ check }: { check: ImportCheck }) {
  return (
    <div className="mt-1.5 text-[11.5px] text-ink-3">
      {check.examples.length > 0 && <div>As written: {check.examples.map((e) => `“${e}”`).join(', ')}</div>}
      {check.rows.length > 0 && <div>Data rows: {check.rows.join(', ')}{check.count > check.rows.length ? '…' : ''}</div>}
    </div>
  )
}

function Row({ tone, action, children }: { tone: 'warning' | 'info'; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 px-3 py-2" data-severity={tone}>
      {tone === 'warning' ? <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[#c98500]" aria-label="Warning" /> : <Info size={14} className="mt-0.5 shrink-0 text-ink-3" aria-label="Note" />}
      <div className="min-w-0 flex-1 text-ink-2">{children}</div>
      {action}
    </li>
  )
}

function SheetGrid({ sheet, infer, overrides, setOverrides, busy, notes }: {
  sheet: { headers: string[]; sample: Record<string, unknown>[] }
  infer: Pick<ImportOptions, 'decimal' | 'dateOrder' | 'softBlanks'>
  overrides: Record<string, ColType>
  setOverrides: (o: Record<string, ColType>) => void
  busy: boolean
  /** what detection found per column over the whole file (the grid itself only has the first rows) */
  notes: ColumnNote[]
}) {
  const noteOf = useMemo(() => new Map(notes.map((n) => [n.key, n])), [notes])
  const detected = useMemo(
    () => Object.fromEntries(sheet.headers.map((h) => [h, inferColumn(h, sheet.sample.map((r) => r[h] as never), infer).type])),
    [sheet, infer],
  )
  return (
    <div className={cx('relative overflow-hidden rounded-xl border border-line', busy && 'opacity-60')}>
      {busy && <div className="absolute inset-0 z-10 flex items-center justify-center"><Loader2 className="animate-spin text-accent" /></div>}
      <div className="max-h-[480px] overflow-auto">
        <table className="tabular w-full border-separate border-spacing-0 text-[12.5px]">
          <thead className="sticky top-0 z-[5] bg-surface-2">
            <tr>
              {sheet.headers.map((h) => {
                const t = overrides[h] ?? detected[h]
                return (
                  <th key={h} className="min-w-[140px] border-b border-line px-2.5 py-2 text-left align-top font-medium">
                    <div className="truncate text-ink" title={h}>{h}</div>
                    <label className="mt-1 flex items-center gap-1.5">
                      <TypeIcon type={t} className="h-4 w-4" />
                      <select aria-label={`Type of ${h}`} value={t} onChange={(e) => {
                        const v = e.target.value as ColType
                        const next = { ...overrides }
                        if (v === detected[h]) delete next[h]
                        else next[h] = v
                        setOverrides(next)
                      }} className={cx('rounded-md bg-transparent py-0.5 text-[11.5px] outline-none', overrides[h] ? 'font-semibold text-accent-ink' : 'text-ink-3')}>
                        {TYPES.map((ty) => <option key={ty} value={ty}>{typeLabel(ty)}{ty === detected[h] ? ' (detected)' : ''}</option>)}
                      </select>
                    </label>
                    {(() => {
                      const n = noteOf.get(h)
                      if (!n) return null
                      return (
                        <div className="mt-0.5 space-y-0.5 text-[11px] font-normal">
                          {n.misfit != null && !overrides[h] && <div className="text-[#a86f00] dark:text-[#f0c060]" title={`e.g. ${n.misfits?.join(', ')}`}>{pctText(n.misfit)} didn’t fit</div>}
                          {n.unit && <div className="text-ink-3">unit: {n.unit}</div>}
                        </div>
                      )
                    })()}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {sheet.sample.slice(0, 50).map((r, i) => (
              <tr key={i}>
                {sheet.headers.map((h) => {
                  const v = r[h]
                  return (
                    <td key={h} className="max-w-[220px] truncate border-b border-line/70 px-2.5 py-1.5 text-ink-2">
                      {v == null || v === '' ? <i className="text-ink-3">blank</i> : v instanceof Date ? v.toISOString().slice(0, 10) : String(v)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
