import { useEffect, useMemo, useState } from 'react'
import {
  ArrowDown, ArrowUp, Combine, Copy, Eraser, Eye, EyeOff, Filter as FilterIcon, GitMerge, ListOrdered, PaintBucket, Pencil, Plus,
  Replace, Rows3, Scissors, Trash2, Type, Undo2, Wand2, AlertTriangle, Columns3, X,
} from 'lucide-react'
import type { Dataset, FilterCmp, PrepOp, PrepStep } from '../types'
import { CMP_LABEL, describeStep, OP_LABEL } from '../lib/prep'
import { fmtValue } from '../lib/format'
import { uid } from '../lib/suggest'
import { engine } from '../engine/client'
import { useStore } from '../store'
import { Badge, Button, cx, Empty, MenuItem, Modal, Popover, SectionLabel, Toggle, TypeIcon } from './ui'

const OP_ICON: Record<PrepOp, typeof Wand2> = {
  dedupe: Copy, dropBlank: Eraser, fill: PaintBucket, trim: Scissors, case: Type, replace: Replace, split: Scissors,
  remove: Columns3, reorder: ListOrdered, filter: FilterIcon, unpivot: Rows3, join: GitMerge, append: Combine,
}
const OP_ORDER: PrepOp[] = ['dedupe', 'dropBlank', 'fill', 'trim', 'case', 'replace', 'split', 'filter', 'remove', 'reorder', 'unpivot', 'join', 'append']

function blankStep(op: PrepOp, headers: string[]): PrepStep {
  const c = headers[0] ?? ''
  const id = uid('s')
  switch (op) {
    case 'dedupe': return { id, op }
    case 'dropBlank': return { id, op, column: c }
    case 'fill': return { id, op, column: c, method: 'previous' }
    case 'trim': return { id, op }
    case 'case': return { id, op, column: c, mode: 'proper' }
    case 'replace': return { id, op, find: '', replace: '' }
    case 'split': return { id, op, column: c, separator: ',', parts: 2 }
    case 'remove': return { id, op, columns: [] }
    case 'reorder': return { id, op, columns: [...headers] }
    case 'filter': return { id, op, column: c, cmp: 'eq', value: '', keep: true }
    case 'unpivot': return { id, op, columns: [], nameColumn: 'Attribute', valueColumn: 'Value' }
    case 'join': return { id, op, datasetId: '', leftKey: c, rightKey: '', how: 'left' }
    case 'append': return { id, op, datasetId: '' }
  }
}

export function PrepareView({ ds }: { ds: Dataset }) {
  const prep = useStore((s) => s.prep)
  const updating = useStore((s) => s.updating)
  const { addPrep, updatePrep, removePrep, movePrep } = useStore.getState()
  const [editing, setEditing] = useState<{ step: PrepStep; isNew: boolean } | null>(null)
  const steps = ds.model.prep
  const reports = new Map(prep.reports.map((r) => [r.id, r]))

  return (
    <div className="grid gap-5 xl:grid-cols-[380px_1fr]">
      <section className="space-y-3">
        <div className="card p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-ink"><Wand2 size={17} /></div>
            <div className="text-[13px] leading-relaxed text-ink-2">
              Clean and reshape the data without formulas. Steps run in order on the original file every time it loads or refreshes — the source itself is never modified.
            </div>
          </div>
        </div>

        <SectionLabel action={
          <Popover align="right" width={240} trigger={(_, toggle) => <Button size="sm" variant="primary" onClick={toggle}><Plus size={14} />Add step</Button>}>
            {(close) => (
              <div className="max-h-96 overflow-auto">
                {OP_ORDER.map((op) => {
                  const Icon = OP_ICON[op]
                  return <MenuItem key={op} icon={<Icon size={14} />} onClick={() => { setEditing({ step: blankStep(op, prep.headers), isNew: true }); close() }}>{OP_LABEL[op]}</MenuItem>
                })}
              </div>
            )}
          </Popover>
        }>Steps · {steps.length}</SectionLabel>

        {!steps.length && (
          <div className="card"><Empty icon={<Wand2 size={18} />} title="No prep steps yet">Remove duplicates, fill blanks, split columns, unpivot, or join another dataset.</Empty></div>
        )}
        <ol className="space-y-2">
          {steps.map((s, i) => {
            const Icon = OP_ICON[s.op]
            const r = reports.get(s.id)
            return (
              <li key={s.id} className={cx('card fade-up p-3', s.disabled && 'opacity-60')}>
                <div className="flex items-start gap-2.5">
                  <span className="tabular mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-3 text-[11px] font-semibold text-ink-2">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[13px] font-medium"><Icon size={13} className="text-ink-3" />{OP_LABEL[s.op]}</div>
                    <div className="truncate text-[12px] text-ink-3" title={describeStep(s)}>{describeStep(s)}</div>
                    {r && (r.error
                      ? <div className="mt-1 flex items-center gap-1 text-[11.5px] text-bad"><AlertTriangle size={12} />{r.error}</div>
                      : <div className="mt-1"><Badge tone={s.disabled ? 'neutral' : 'accent'}>{r.summary}</Badge></div>)}
                  </div>
                  <div className="flex shrink-0 items-center">
                    <IconBtn label="Move up" disabled={i === 0} onClick={() => void movePrep(s.id, -1)}><ArrowUp size={13} /></IconBtn>
                    <IconBtn label="Move down" disabled={i === steps.length - 1} onClick={() => void movePrep(s.id, 1)}><ArrowDown size={13} /></IconBtn>
                    <IconBtn label={s.disabled ? 'Enable step' : 'Disable step'} onClick={() => void updatePrep(s.id, { ...s, disabled: !s.disabled })}>{s.disabled ? <EyeOff size={13} /> : <Eye size={13} />}</IconBtn>
                    <IconBtn label="Edit step" onClick={() => setEditing({ step: s, isNew: false })}><Pencil size={13} /></IconBtn>
                    <IconBtn label="Delete step" onClick={() => void removePrep(s.id)}><Trash2 size={13} /></IconBtn>
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
        {!!steps.length && <p className="flex items-center gap-1.5 text-[12px] text-ink-3"><Undo2 size={12} />Every change can be undone with ⌘Z.</p>}
      </section>

      <section className="min-w-0">
        <SectionLabel>Result · {ds.rows.length.toLocaleString()} rows × {ds.columns.length} columns{updating && ' · updating…'}</SectionLabel>
        <div className="card overflow-hidden">
          <div className="max-h-[calc(100vh-300px)] min-h-[300px] overflow-auto" tabIndex={0} role="region" aria-label="Prepared data preview">
            <table className="tabular w-full border-separate border-spacing-0 text-[12.5px]">
              <thead className="sticky top-0 z-10">
                <tr>
                  {ds.columns.map((c) => (
                    <th key={c.key} className="min-w-[120px] border-b border-line bg-surface-2 px-3 py-2 text-left font-medium">
                      <span className="flex items-center gap-1.5"><TypeIcon type={c.type} /><span className="truncate">{c.name}</span></span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ds.rows.slice(0, 60).map((r, i) => (
                  <tr key={i}>
                    {ds.columns.map((c) => (
                      <td key={c.key} className={cx('max-w-[260px] truncate border-b border-line px-3 py-1.5', c.type === 'number' && 'text-right', r[c.key] == null && 'text-ink-3')}>
                        {r[c.key] == null ? <i className="text-[11px]">null</i> : fmtValue(r[c.key], c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {editing && (
        <StepEditor
          ds={ds}
          initial={editing.step}
          isNew={editing.isNew}
          headers={prep.headers}
          onClose={() => setEditing(null)}
          onSave={(st) => { void (editing.isNew ? addPrep(st) : updatePrep(st.id, st)); setEditing(null) }}
        />
      )}
    </div>
  )
}

function IconBtn({ label, children, onClick, disabled }: { label: string; children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button aria-label={label} title={label} disabled={disabled} onClick={onClick} className="rounded-md p-1.5 text-ink-3 transition hover:bg-surface-3 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent">
      {children}
    </button>
  )
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-3">{hint}</span>}
    </label>
  )
}

function ColumnSelect({ headers, value, onChange, optional, label }: { headers: string[]; value?: string; onChange: (v: string | undefined) => void; optional?: string; label: string }) {
  return (
    <select aria-label={label} className="field" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
      {optional && <option value="">{optional}</option>}
      {headers.map((h) => <option key={h} value={h}>{h}</option>)}
    </select>
  )
}

function MultiColumns({ headers, value, onChange, label }: { headers: string[]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  const sel = new Set(value)
  return (
    <div role="group" aria-label={label} className="max-h-48 space-y-0.5 overflow-auto rounded-xl border border-line p-1.5">
      {headers.map((h) => (
        <label key={h} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-surface-3">
          <input type="checkbox" className="accent-[var(--accent)]" checked={sel.has(h)} onChange={() => onChange(sel.has(h) ? value.filter((x) => x !== h) : [...value, h])} />
          <span className="truncate">{h}</span>
        </label>
      ))}
    </div>
  )
}

function StepEditor({ ds, initial, isNew, headers, onClose, onSave }: {
  ds: Dataset; initial: PrepStep; isNew: boolean; headers: string[]; onClose: () => void; onSave: (s: PrepStep) => void
}) {
  const [s, setS] = useState<PrepStep>(initial)
  const set = (patch: Partial<PrepStep>) => setS({ ...s, ...patch } as PrepStep)
  const metas = useStore((st) => st.metas).filter((m) => m.id !== ds.id)
  const [otherHeaders, setOtherHeaders] = useState<string[]>([])
  const otherId = s.op === 'join' || s.op === 'append' ? s.datasetId : ''
  useEffect(() => {
    if (!otherId) { setOtherHeaders([]); return }
    let live = true
    void engine('source', { id: otherId }).then((r) => live && setOtherHeaders(r?.headers ?? []))
    return () => { live = false }
  }, [otherId])
  // the step's own columns stay selectable even if a later step removed them
  const cols = useMemo(() => [...new Set([...headers, ...('column' in s && s.column ? [s.column] : []), ...('columns' in s && s.columns ? s.columns : [])])], [headers, s])
  const valid = (() => {
    switch (s.op) {
      case 'replace': return !!s.find
      case 'split': return !!s.separator && !!s.column
      case 'remove': return s.columns.length > 0
      case 'unpivot': return s.columns.length > 0 && !!s.nameColumn && !!s.valueColumn
      case 'join': return !!s.datasetId && !!s.leftKey && !!s.rightKey
      case 'append': return !!s.datasetId
      case 'fill': return s.method !== 'value' || s.value != null
      default: return true
    }
  })()

  return (
    <Modal title={`${isNew ? 'Add' : 'Edit'} step · ${OP_LABEL[s.op]}`} onClose={onClose} width={520}>
      <div className="space-y-3.5">
        {s.op === 'dedupe' && <Field label="Compare columns" hint="Leave empty to remove rows that are identical in every column"><MultiColumns label="Compare columns" headers={cols} value={s.columns ?? []} onChange={(v) => set({ columns: v })} /></Field>}
        {s.op === 'dropBlank' && <Field label="Remove rows where"><ColumnSelect label="Column" headers={cols} value={s.column} optional="Every cell is blank" onChange={(v) => set({ column: v })} /></Field>}
        {s.op === 'fill' && (
          <>
            <Field label="Column"><ColumnSelect label="Column" headers={cols} value={s.column} onChange={(v) => set({ column: v! })} /></Field>
            <Field label="Fill with">
              <select aria-label="Fill method" className="field" value={s.method} onChange={(e) => set({ method: e.target.value as typeof s.method })}>
                <option value="previous">Previous value (fill down)</option>
                <option value="next">Next value (fill up)</option>
                <option value="mean">Column average</option>
                <option value="median">Column median</option>
                <option value="zero">Zero</option>
                <option value="value">A fixed value…</option>
              </select>
            </Field>
            {s.method === 'value' && <Field label="Value"><input aria-label="Fill value" className="field" value={s.value ?? ''} onChange={(e) => set({ value: e.target.value })} /></Field>}
          </>
        )}
        {s.op === 'trim' && <Field label="Columns" hint="Removes leading, trailing and repeated spaces. Leave empty for every column."><MultiColumns label="Columns" headers={cols} value={s.columns ?? []} onChange={(v) => set({ columns: v })} /></Field>}
        {s.op === 'case' && (
          <>
            <Field label="Column"><ColumnSelect label="Column" headers={cols} value={s.column} onChange={(v) => set({ column: v! })} /></Field>
            <Field label="Case">
              <select aria-label="Case" className="field" value={s.mode} onChange={(e) => set({ mode: e.target.value as typeof s.mode })}>
                <option value="proper">Proper Case</option><option value="upper">UPPER CASE</option><option value="lower">lower case</option>
              </select>
            </Field>
          </>
        )}
        {s.op === 'replace' && (
          <>
            <Field label="Column"><ColumnSelect label="Column" headers={cols} value={s.column} optional="All columns" onChange={(v) => set({ column: v })} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Find"><input aria-label="Find" autoFocus className="field" value={s.find} onChange={(e) => set({ find: e.target.value })} /></Field>
              <Field label="Replace with"><input aria-label="Replace with" className="field" value={s.replace} onChange={(e) => set({ replace: e.target.value })} /></Field>
            </div>
            <div className="divide-y divide-line rounded-xl border border-line px-3">
              <Toggle label="Match case" checked={!!s.matchCase} onChange={(v) => set({ matchCase: v })} />
              <Toggle label="Whole cell only" checked={!!s.wholeCell} onChange={(v) => set({ wholeCell: v })} />
            </div>
          </>
        )}
        {s.op === 'split' && (
          <>
            <Field label="Column"><ColumnSelect label="Column" headers={cols} value={s.column} onChange={(v) => set({ column: v! })} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Separator"><input aria-label="Separator" className="field" value={s.separator} onChange={(e) => set({ separator: e.target.value })} /></Field>
              <Field label="Into parts"><input aria-label="Parts" type="number" min={2} max={20} className="field" value={s.parts} onChange={(e) => set({ parts: +e.target.value || 2 })} /></Field>
            </div>
            <div className="rounded-xl border border-line px-3"><Toggle label="Keep the original column" checked={s.keepOriginal !== false} onChange={(v) => set({ keepOriginal: v })} /></div>
          </>
        )}
        {s.op === 'filter' && (
          <>
            <div className="flex gap-1.5">
              {[true, false].map((k) => (
                <button key={String(k)} onClick={() => set({ keep: k })} className={cx('flex-1 rounded-lg border px-3 py-2 text-[13px] font-medium transition', s.keep === k ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line text-ink-2')}>
                  {k ? 'Keep rows where…' : 'Remove rows where…'}
                </button>
              ))}
            </div>
            <Field label="Column"><ColumnSelect label="Column" headers={cols} value={s.column} onChange={(v) => set({ column: v! })} /></Field>
            <div className="grid grid-cols-[1fr_1fr] gap-2">
              <Field label="Condition">
                <select aria-label="Condition" className="field" value={s.cmp} onChange={(e) => set({ cmp: e.target.value as FilterCmp })}>
                  {(Object.keys(CMP_LABEL) as FilterCmp[]).map((c) => <option key={c} value={c}>{CMP_LABEL[c]}</option>)}
                </select>
              </Field>
              {s.cmp !== 'blank' && s.cmp !== 'notBlank' && <Field label="Value"><input aria-label="Value" className="field" value={s.value ?? ''} onChange={(e) => set({ value: e.target.value })} /></Field>}
            </div>
            <p className="text-[11px] text-ink-3">Numbers and dates compare by value (e.g. “is greater than 100”, “is at least 2020-01-01”); text compares ignoring case.</p>
          </>
        )}
        {s.op === 'remove' && <Field label="Columns to remove"><MultiColumns label="Columns to remove" headers={cols} value={s.columns} onChange={(v) => set({ columns: v })} /></Field>}
        {s.op === 'reorder' && (
          <Field label="Column order">
            <ol className="max-h-72 space-y-1 overflow-auto rounded-xl border border-line p-1.5">
              {[...s.columns.filter((c) => cols.includes(c)), ...cols.filter((c) => !s.columns.includes(c))].map((c, i, arr) => (
                <li key={c} className="flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1 text-[13px]">
                  <span className="tabular w-5 text-[11px] text-ink-3">{i + 1}</span>
                  <span className="flex-1 truncate">{c}</span>
                  <IconBtn label={`Move ${c} up`} disabled={i === 0} onClick={() => { const a = [...arr]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; set({ columns: a }) }}><ArrowUp size={12} /></IconBtn>
                  <IconBtn label={`Move ${c} down`} disabled={i === arr.length - 1} onClick={() => { const a = [...arr]; [a[i + 1], a[i]] = [a[i], a[i + 1]]; set({ columns: a }) }}><ArrowDown size={12} /></IconBtn>
                </li>
              ))}
            </ol>
          </Field>
        )}
        {s.op === 'unpivot' && (
          <>
            <Field label="Columns to turn into rows" hint="e.g. one column per year → a Year column and a Value column"><MultiColumns label="Columns to unpivot" headers={cols} value={s.columns} onChange={(v) => set({ columns: v })} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Name column"><input aria-label="Name column" className="field" value={s.nameColumn} onChange={(e) => set({ nameColumn: e.target.value })} /></Field>
              <Field label="Value column"><input aria-label="Value column" className="field" value={s.valueColumn} onChange={(e) => set({ valueColumn: e.target.value })} /></Field>
            </div>
          </>
        )}
        {(s.op === 'join' || s.op === 'append') && (
          <Field label="Other dataset">
            <select aria-label="Other dataset" className="field" value={s.datasetId} onChange={(e) => set({ datasetId: e.target.value })}>
              <option value="">Choose…</option>
              {metas.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.rowCount.toLocaleString()} rows</option>)}
            </select>
            {!metas.length && <span className="mt-1 block text-[11px] text-ink-3">Import another dataset first.</span>}
          </Field>
        )}
        {s.op === 'join' && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Key in this dataset"><ColumnSelect label="Left key" headers={cols} value={s.leftKey} onChange={(v) => set({ leftKey: v! })} /></Field>
              <Field label="Matching key in the other"><ColumnSelect label="Right key" headers={otherHeaders} value={s.rightKey} optional="Choose…" onChange={(v) => set({ rightKey: v ?? '' })} /></Field>
            </div>
            <Field label="Keep">
              <select aria-label="Join type" className="field" value={s.how} onChange={(e) => set({ how: e.target.value as 'left' | 'inner' })}>
                <option value="left">All rows of this dataset (left join)</option>
                <option value="inner">Only rows with a match (inner join)</option>
              </select>
            </Field>
            {!!otherHeaders.length && <Field label="Columns to bring in" hint="Leave empty to bring every column"><MultiColumns label="Columns to bring in" headers={otherHeaders.filter((h) => h !== s.rightKey)} value={s.columns ?? []} onChange={(v) => set({ columns: v })} /></Field>}
          </>
        )}
        {s.op === 'append' && <p className="text-[12px] text-ink-3">Rows from the other dataset are added below these. Columns are matched by name; missing ones are left blank.</p>}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button size="sm" onClick={onClose}><X size={14} />Cancel</Button>
        <Button size="sm" variant="primary" disabled={!valid} onClick={() => onSave(s)}>{isNew ? 'Add step' : 'Save step'}</Button>
      </div>
    </Modal>
  )
}
