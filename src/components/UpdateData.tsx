import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, CalendarRange, CheckCircle2, ShieldCheck, FilePlus2, History, Link2, Loader2, RefreshCcw, Replace, RotateCcw, Rows3, Trash2, Unlink, Upload } from 'lucide-react'
import type { Dataset, DataVersion, Widget } from '../types'
import type { UpdateMode } from '../lib/update'
import { ACCEPT } from '../lib/parse'
import { fmtBytes, fmtDate } from '../lib/format'
import { widgetColumns } from '../lib/aggregate'
import { SAMPLE_UPDATES, sampleUrl } from '../lib/samples'
import { engine } from '../engine/client'
import { canLink, linkedHandle, linkedModified, pickLinked, readLinked, unlink, type FileHandle } from '../lib/linked'
import { useDashboardFull, useStore } from '../store'
import { Button, cx, IconButton, Modal, Toggle } from './ui'

/** Loads a fresh file into an existing dataset, keeping every page, chart, formula and prep step. */
export function UpdateData({ ds }: { ds: Dataset }) {
  const pending = useStore((s) => s.pendingUpdate)
  const { previewUpdate, cancelUpdate } = useStore.getState()
  const preview = pending?.preview
  return (
    <Modal title={<span className="flex items-center gap-2"><RefreshCcw size={16} className="text-accent" />Update data · {ds.name}</span>} onClose={cancelUpdate} width={preview ? 980 : 620}>
      {preview ? <Review ds={ds} /> : <Pick ds={ds} busy={!!pending?.busy} onFile={(f) => void previewUpdate(f)} />}
    </Modal>
  )
}

function Pick({ ds, busy, onFile }: { ds: Dataset; busy: boolean; onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [versions, setVersions] = useState<DataVersion[]>([])
  const { restoreVersion, cancelUpdate, notify, showChanges, deleteVersions } = useStore.getState()
  useEffect(() => { void engine('listVersions', { id: ds.id }).then(setVersions) }, [ds.id, ds.source.versions])
  const sampleUpdate = ds.source.kind === 'sample' ? SAMPLE_UPDATES[ds.fileName] : undefined
  const history = ds.source.updates ?? []
  const [linked, setLinked] = useState<{ handle: FileHandle; modified?: number } | null>(null)
  useEffect(() => {
    let live = true
    void linkedHandle(ds.id).then(async (h) => { if (live) setLinked(h ? { handle: h, modified: await linkedModified(h) } : null) })
    return () => { live = false }
  }, [ds.id])
  // Chromium: the picker returns a handle, so the file can be re-read next time without choosing it again
  const choose = async () => {
    if (!canLink()) { input.current?.click(); return }
    const f = await pickLinked(ds.id)
    if (f) onFile(f)
  }
  const fromLinked = async () => {
    try { onFile(await readLinked(ds.id)) } catch (e) { notify('error', e instanceof Error ? e.message : String(e)) }
  }
  const loadSample = async () => {
    if (!sampleUpdate) return
    const res = await fetch(sampleUrl(sampleUpdate.file))
    if (!res.ok) return notify('error', `Could not load ${sampleUpdate.label}`)
    onFile(new File([await res.blob()], sampleUpdate.file.split('/').pop()!))
  }
  return (
    <div className="space-y-5">
      <p className="text-[13px] leading-relaxed text-ink-2">
        Load the latest export — a new month, or a corrected full file. Every page, chart, filter, computed column, measure and prep step stays as designed and is re-applied to the new data.
      </p>
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}
        className={cx('flex flex-col items-center rounded-2xl border-2 border-dashed px-6 py-8 text-center transition', over ? 'border-accent bg-accent-soft' : 'border-line-strong')}
      >
        {busy ? <Loader2 className="animate-spin text-accent" /> : <Upload size={22} className="text-accent" />}
        <div className="mt-3 text-[14px] font-medium">{busy ? 'Reading the file…' : 'Drop the new file here'}</div>
        <div className="mt-1 text-[12px] text-ink-3">Read with the same settings as “{ds.fileName}” · {ds.format.toUpperCase()}</div>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {linked && <Button size="sm" variant="primary" disabled={busy} onClick={() => void fromLinked()}><Link2 size={14} />Update from {linked.handle.name}</Button>}
          <Button size="sm" variant={linked ? 'secondary' : 'primary'} disabled={busy} onClick={() => void choose()}><FilePlus2 size={14} />{linked ? 'Choose another file' : 'Choose file'}</Button>
          {sampleUpdate && <Button size="sm" disabled={busy} onClick={() => void loadSample()}><CalendarRange size={14} />Try it: {sampleUpdate.label}</Button>}
        </div>
        <input ref={input} type="file" accept={ACCEPT} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
        {linked ? (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-2 text-[12px] text-ink-3">
            <span>Linked file{linked.modified ? ` · modified ${new Date(linked.modified).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : ''}{linked.modified && ds.source.lastLoaded && linked.modified > ds.source.lastLoaded ? ' · changed since the last update' : ''}</span>
            <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => { void unlink(ds.id); setLinked(null) }}><Unlink size={12} />Unlink</button>
          </div>
        ) : canLink() && <div className="mt-3 text-[12px] text-ink-3">The file you choose is remembered, so next time it’s one click.</div>}
      </div>

      {versions.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-ink-3"><RotateCcw size={13} />Saved versions</div>
          <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Saved versions">
            {versions.map((v) => (
              <li key={v.key} className="flex items-center gap-3 px-3 py-1.5 text-[12.5px]">
                <span className="w-36 shrink-0 text-ink-3">{when(v.at)}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2" title={v.label}>{v.label}</span>
                {v.rows > 0 && <span className="tabular shrink-0 text-ink-2">{v.rows.toLocaleString()} rows</span>}
                <Button size="sm" variant="ghost" aria-label={`Restore: ${v.label}`} onClick={() => { cancelUpdate(); void restoreVersion(v.key) }}>Restore</Button>
                <IconButton label={`Delete version: ${v.label}`} onClick={() => void deleteVersions(ds.id, v.key)}><Trash2 size={13} /></IconButton>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11.5px] text-ink-3">The last {versions.length > 1 ? `${versions.length} versions are` : 'version is'} kept (up to 5; fewer for very large data). Restoring one saves the current data as a version, so it can be undone.</p>
        </div>
      )}

      {history.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-ink-3"><History size={13} />Update history</div>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {history.slice(0, 6).map((u) => (
              <li key={u.at} className="flex items-center gap-3 px-3 py-1.5 text-[12.5px]">
                <span className="w-36 shrink-0 text-ink-3">{when(u.at)}</span>
                <span className="font-medium capitalize">{u.mode}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2">{u.fileName}{u.updated ? ` · ${u.updated.toLocaleString()} updated` : ''}{u.mode === 'append' && u.removed ? ` · ${u.removed.toLocaleString()} removed` : ''}</span>
                <span className="tabular shrink-0 text-ink-2">{u.rowsBefore.toLocaleString()} → {u.rowsAfter.toLocaleString()} rows</span>
                {u.changes && <Button size="sm" variant="ghost" onClick={() => { cancelUpdate(); showChanges(u.changes!) }}>What changed</Button>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function Review({ ds }: { ds: Dataset }) {
  const pu = useStore((s) => s.pendingUpdate)!
  const p = pu.preview!
  const dash = useDashboardFull()
  const { commitUpdate, cancelUpdate, previewUpdate } = useStore.getState()
  // a file much smaller than the current data looks like a new period; similar size or bigger looks like a full re-export
  const [mode, setMode] = useState<UpdateMode>(p.rowCount < p.existingRows * 0.6 ? 'append' : 'replace')
  const unmatched = p.incomingHeaders.filter((h) => !p.check.matched.some((m) => m.incoming === h))
  const [mapping, setMapping] = useState<Record<string, string | undefined>>(() => Object.fromEntries(p.check.matched.map((m) => [m.old, m.incoming])))
  const [dedupe, setDedupe] = useState(true)
  const [key, setKey] = useState<string>(p.suggestedKey ?? '')
  const [sync, setSync] = useState(false)
  const used = useMemo(() => usage(ds, dash?.pages.flatMap((pg) => pg.widgets) ?? []), [ds, dash])
  // checks cover hand-mapped columns too: re-run them when the mapping changes
  const [checks, setChecks] = useState(p.checks)
  const mapKey = JSON.stringify(mapping)
  const first = useRef(mapKey)
  useEffect(() => {
    if (mapKey === first.current) return
    let live = true
    void engine('updateChecks', { id: ds.id, token: p.token, mapping }).then((c) => { if (live) setChecks(c) })
    return () => { live = false }
    // `mapping` is read through mapKey, its serialized form
  }, [mapKey, ds.id, p.token])
  const stillMissing = p.check.missing.filter((h) => !mapping[h])
  const newCols = unmatched.filter((h) => !Object.values(mapping).includes(h))
  const d = p.dates
  const fmt = (t: number) => fmtDate(t)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-[13px]">
        <span><b className="font-medium">{p.fileName}</b> <span className="text-ink-3">· {p.rowCount.toLocaleString()} rows · {p.incomingHeaders.length} columns · {fmtBytes(p.bytes)}</span></span>
        {p.sheets.length > 1 && (
          <select aria-label="Sheet" className="field h-8 w-48" value={p.sheet} onChange={(e) => { if (pu.file) void previewUpdate(pu.file, e.target.value) }}>
            {p.sheets.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
      </div>

      <section>
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-ink-3">How should it be loaded?</div>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Update mode">
          {([
            ['append', Rows3, 'Append new rows', 'Add these rows after the existing ones — for a new month or week.'],
            ['replace', Replace, 'Replace all rows', 'Use only this file — for a full re-export or corrected data.'],
          ] as const).map(([m, Icon, title, desc]) => (
            <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
              className={cx('flex gap-3 rounded-xl border p-3 text-left transition', mode === m ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong')}>
              <Icon size={18} className={mode === m ? 'mt-0.5 text-accent-ink' : 'mt-0.5 text-ink-3'} />
              <span>
                <span className="block text-[13.5px] font-medium">{title}</span>
                <span className="block text-[12px] text-ink-3">{desc}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {d && (
        <section className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-4 py-3 text-[13px]">
          <CalendarRange size={16} className="text-ink-3" />
          <span><span className="text-ink-3">Now:</span> {fmt(d.existing[0])} – {fmt(d.existing[1])}</span>
          <ArrowRight size={14} className="text-ink-3" />
          <span><span className="text-ink-3">{mode === 'append' ? 'Adding:' : 'New file:'}</span> {fmt(d.incoming[0])} – {fmt(d.incoming[1])}</span>
          {mode === 'append' && d.overlapping > 0 && (
            <span className="flex w-full items-start gap-1.5 text-[12px] text-[#a06a00] dark:text-[#eda100]">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {d.overlapping.toLocaleString()} of these rows are dated on or before {fmt(d.existing[1])}, the current last date. If the file repeats earlier data, keep “match rows already loaded” on, or choose Replace.
            </span>
          )}
        </section>
      )}

      <section>
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-ink-3">Columns</div>
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-[13px] text-ink-2"><CheckCircle2 size={15} className="text-good" />{p.check.matched.length} of {p.existingHeaders.length} columns match{p.check.matched.some((m) => m.old !== m.incoming) && ' (some by a slightly different name)'}</div>
          {p.check.missing.length > 0 && (
            <div className="rounded-xl border border-[#eda100]/40 bg-[#eda100]/8 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium"><AlertTriangle size={14} className="text-[#c98500]" />Not found in the new file — map each to a column, or leave it blank</div>
              <div className="space-y-1.5">
                {p.check.missing.map((h) => (
                  <div key={h} className="grid items-center gap-2 text-[13px] sm:grid-cols-[1fr_1fr_1.4fr]">
                    <span className="truncate font-medium">{h}</span>
                    <select aria-label={`Map ${h}`} className="field h-8" value={mapping[h] ?? ''} onChange={(e) => setMapping({ ...mapping, [h]: e.target.value || undefined })}>
                      <option value="">Leave blank</option>
                      {unmatched.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                    <span className="truncate text-[11.5px] text-ink-3">{used[h] ? `Used by ${used[h]}` : 'Not used by any chart or formula'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {newCols.length > 0 && <div className="text-[12.5px] text-ink-2">New in this file: {newCols.map((h) => <code key={h} className="mr-1 rounded bg-surface-3 px-1 text-[11.5px]">{h}</code>)} — added as new columns{mode === 'append' ? ' (blank for existing rows)' : ''}.</div>}
        </div>
      </section>

      <section aria-label="Data checks">
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-ink-3">Data checks</div>
        {checks.length ? (
          <ul className="space-y-1.5">
            {checks.map((c) => (
              <li key={c.column + c.kind} className="flex items-start gap-2 rounded-xl border border-[#eda100]/40 bg-[#eda100]/8 px-3 py-2 text-[13px]">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[#c98500]" />
                <span>
                  {c.message}
                  {c.examples.length > 0 && <span className="text-ink-3"> · e.g. {c.examples.map((x) => <code key={x} className="mr-1 rounded bg-surface-3 px-1 text-[11.5px]">{x}</code>)}</span>}
                </span>
              </li>
            ))}
            <li className="text-[12px] text-ink-3">You can still load the file: prep steps (fill blanks, filter rows) can clean these up, and the update can be undone.</li>
          </ul>
        ) : (
          <div className="flex items-center gap-2 text-[13px] text-ink-2"><ShieldCheck size={15} className="text-good" />No problems found — values look like the data already loaded</div>
        )}
      </section>

      {mode === 'append' && (
        <section className="space-y-2">
          <div className="rounded-xl border border-line px-3"><Toggle label="Match rows that are already loaded" checked={dedupe} onChange={setDedupe} /></div>
          {dedupe && (
            <label className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
              Match rows by
              <select aria-label="Match rows by" className="field h-8 w-56" value={key} onChange={(e) => setKey(e.target.value)}>
                <option value="">Every column (identical rows)</option>
                {p.check.matched.map((m) => <option key={m.old} value={m.old}>{m.old}{m.old === p.suggestedKey ? ' (looks like an ID)' : ''}</option>)}
              </select>
              <span className="text-[12px] text-ink-3">{key ? `A row whose ${key} is already loaded overwrites it with the new values; unchanged rows are skipped.` : 'Rows identical to a loaded row are skipped.'}</span>
            </label>
          )}
          {dedupe && key && (
            <div className="rounded-xl border border-line px-3">
              <Toggle label={`Remove loaded rows whose ${key} isn’t in this file (it’s a full export)`} checked={sync} onChange={setSync} />
            </div>
          )}
        </section>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <span className="text-[12.5px] text-ink-3">
          {mode === 'append' ? `${p.existingRows.toLocaleString()} rows + up to ${p.rowCount.toLocaleString()} new` : `${p.existingRows.toLocaleString()} rows → ${p.rowCount.toLocaleString()}`}
          {stillMissing.length > 0 && ` · ${stillMissing.length} column${stillMissing.length > 1 ? 's' : ''} left blank`} · you can undo this
        </span>
        <div className="flex gap-2">
          <Button size="sm" onClick={cancelUpdate}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={pu.busy} onClick={() => void commitUpdate({ mode, mapping, dedupe: { enabled: mode === 'append' && dedupe, keys: key ? [key] : [] }, sync: mode === 'append' && dedupe && !!key && sync })}>
            {pu.busy ? <><Loader2 size={14} className="animate-spin" />Updating…</> : mode === 'append' ? 'Append and update dashboard' : 'Replace and update dashboard'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Which charts and formulas use each source column — shown next to columns missing from the new file. */
function usage(ds: Dataset, widgets: Widget[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of ds.columns.filter((x) => x.formula == null)) {
    const charts = widgets.filter((w) => widgetColumns(w).includes(c.key)).length
    const formulas = [...ds.model.computed, ...ds.model.measures].filter((f) => new RegExp(`\\[\\s*${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]`, 'i').test(f.formula)).map((f) => f.name)
    const parts = [charts ? `${charts} chart${charts > 1 ? 's' : ''}` : '', formulas.length ? `formula${formulas.length > 1 ? 's' : ''} ${formulas.join(', ')}` : ''].filter(Boolean)
    if (parts.length) out[c.key] = parts.join(' and ')
  }
  return out
}
