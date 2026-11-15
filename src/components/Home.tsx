import { useEffect, useRef, useState } from 'react'
import { ArrowRight, BarChart3, Braces, ClipboardPaste, FileSpreadsheet, FileText, Globe, HardDrive, Link2, Scale, Table2, Trash2, Upload, Wand2, Clock, RotateCcw, ShieldCheck, AlertTriangle, Archive } from 'lucide-react'
import { ACCEPT } from '../lib/parse'
import { SAMPLES, sampleUrl, type Sample } from '../lib/samples'
import { PRESETS } from '../lib/presets'
import { fmtBytes } from '../lib/format'
import { describeStorage, quotaWarning, storageStatus, type StorageStatus } from '../lib/durability'
import { trashRemaining } from '../lib/trash'
import { useStore } from '../store'
import type { DatasetMeta } from '../types'
import { Button, confirmDialog, cx, Modal } from './ui'
import { BackupDialog } from './BackupDialog'

const FORMAT_ICON = { CSV: FileText, JSON: Braces, XLSX: FileSpreadsheet, XLS: FileSpreadsheet }
const FORMAT_TONE = {
  CSV: 'text-[#08704d] bg-[#1baf7a]/12 dark:text-[#4fd1a0]',
  JSON: 'text-[#a3470a] bg-[#eb6834]/12 dark:text-[#f0a070]',
  XLSX: 'text-[#1c5cab] bg-[#2a78d6]/10 dark:text-[#86b6ef]',
  XLS: 'text-[#6250d6] bg-[#6250d6]/10 dark:text-[#a99ff0]',
}

/** Opens a sample with its showcase; an already-imported copy is reopened, and required samples come first. */
export async function openSample(s: Sample) {
  const st = useStore.getState()
  const existing = st.metas.find((m) => m.fileName === s.file && m.source.kind === 'sample')
  if (existing) return st.open(existing.id)
  try {
    for (const req of PRESETS[s.file]?.requires ?? []) {
      if (useStore.getState().metas.some((m) => m.fileName === req)) continue
      const dep = SAMPLES.find((x) => x.file === req)
      if (dep) await importSample(dep, `Loading ${dep.title} (needed for ${s.title})`)
    }
    await importSample(s, `Loading ${s.title}`)
  } catch (e) {
    useStore.setState({ progress: null })
    st.notify('error', e instanceof Error ? e.message : String(e))
  }
}

async function importSample(s: Sample, label: string) {
  useStore.setState({ progress: { fraction: 0.02, label } })
  const res = await fetch(sampleUrl(s.file))
  if (!res.ok) throw new Error(`Could not load ${s.title} (${res.status})`)
  const file = new File([await res.blob()], s.file)
  await useStore.getState().startImport(file, { kind: 'sample' }, { skipPreview: true, name: s.file.replace(/\.[^.]+$/, ''), sample: s.file })
}

export function Home() {
  const metas = useStore((s) => s.metas)
  const trash = useStore((s) => s.trash)
  const { open, remove, startImports, restoreRemoved, purgeRemoved } = useStore.getState()
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [dialog, setDialog] = useState<'url' | 'paste' | 'storage' | 'backup' | null>(null)

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-8 sm:pt-14">
      <section className="fade-up text-center">
        <p className="mx-auto max-w-xl text-[15px] leading-relaxed text-ink-2">
          Numero reads CSV, JSON and Excel files, detects dates, numbers and categories, and builds charts, summaries and statistical insights you can shape to your needs.
        </p>
      </section>

      <section
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); const files = [...e.dataTransfer.files]; if (files.length) void startImports(files) }}
        className={cx(
          'fade-up mx-auto mt-10 max-w-3xl rounded-3xl border-2 border-dashed px-6 py-10 text-center transition',
          over ? 'border-accent bg-accent-soft' : 'border-line-strong bg-surface',
        )}
        style={{ animationDelay: '60ms' }}
      >
        <button onClick={() => input.current?.click()} className="group mx-auto flex flex-col items-center rounded-2xl px-6 py-2 outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
          <span className={cx('flex h-14 w-14 items-center justify-center rounded-2xl transition', over ? 'bg-accent text-white' : 'bg-accent-soft text-accent-ink group-hover:scale-105')}>
            <Upload size={24} />
          </span>
          <span className="mt-4 text-[16px] font-semibold">Drop a file here, or click to browse</span>
          <span className="mt-1 text-[13px] text-ink-3">.csv · .tsv · .json · .xlsx · .xls · .ods · .gz — large files are processed in the background</span>
        </button>
        <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { const files = [...(e.target.files ?? [])]; if (files.length) void startImports(files); e.target.value = '' }} />
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button size="sm" onClick={() => setDialog('url')}><Link2 size={14} />From a URL</Button>
          <Button size="sm" onClick={() => setDialog('paste')}><ClipboardPaste size={14} />Paste data</Button>
        </div>
      </section>

      <section className="mx-auto mt-6 grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { icon: Wand2, title: 'Auto-detects types', text: 'Dates, numbers, currency, categories and IDs' },
          { icon: BarChart3, title: 'Suggests a layout', text: 'KPIs, trends, rankings and distributions' },
          { icon: Table2, title: 'You stay in control', text: 'Clean, regroup, re-aggregate, filter and pivot' },
        ].map((f, i) => (
          <div key={f.title} className="fade-up flex items-start gap-3 rounded-2xl px-3 py-2" style={{ animationDelay: `${120 + i * 40}ms` }}>
            <f.icon size={18} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <div className="text-[13px] font-medium">{f.title}</div>
              <div className="text-[12px] text-ink-3">{f.text}</div>
            </div>
          </div>
        ))}
      </section>

      {(metas.length > 0 || trash.length > 0) && (
        <section className="mt-14">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wider text-ink-3"><Clock size={14} />Recent</h2>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setDialog('backup')}><Archive size={14} />Backup</Button>
              <Button size="sm" variant="ghost" onClick={() => setDialog('storage')}><HardDrive size={14} />Storage</Button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {metas.slice(0, 6).map((d) => (
              <div key={d.id} className="card group flex items-center gap-3 p-3.5 transition hover:border-line-strong">
                <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => void open(d.id)}>
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-3 text-ink-2">{d.source.kind === 'url' ? <Globe size={18} /> : <FileSpreadsheet size={18} />}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-medium">{d.name}</span>
                    <span className="block text-[12px] text-ink-3">{d.rowCount.toLocaleString()} rows · {d.columnCount} columns · {d.format.toUpperCase()}</span>
                  </span>
                </button>
                <button onClick={() => void remove(d.id)} className="rounded-lg p-1.5 text-ink-3 opacity-0 transition hover:bg-surface-3 hover:text-bad focus:opacity-100 group-hover:opacity-100" aria-label={`Remove ${d.name}`}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          {!metas.length && <p className="text-[13px] text-ink-3">No datasets right now.</p>}
          {trash.length > 0 && (
            <div className="mt-6" role="region" aria-label="Recently removed">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-ink-3"><Trash2 size={13} />Recently removed</h3>
                <button className="text-[12px] font-medium text-ink-3 hover:text-bad hover:underline" onClick={async () => {
                  if (await confirmDialog({ title: `Erase ${trash.length} removed dataset${trash.length > 1 ? 's' : ''} now?`, body: 'Their rows, saved versions and dashboards are deleted from this browser. This cannot be undone.', confirmLabel: 'Erase', danger: true })) void purgeRemoved()
                }}>Erase all now</button>
              </div>
              <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                {trash.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] text-ink-2">{d.name}</span>
                      <span className="block text-[12px] text-ink-3">
                        {d.rowCount.toLocaleString()} rows{d.source.versions?.length ? ` · ${d.source.versions.length} saved version${d.source.versions.length > 1 ? 's' : ''}` : ''} · removed {new Date(d.trashedAt ?? 0).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {trashRemaining(d, Date.now())}
                      </span>
                    </span>
                    <Button size="sm" onClick={() => void restoreRemoved(d.id)} aria-label={`Restore ${d.name}`}><RotateCcw size={13} />Restore</Button>
                    <button aria-label={`Erase ${d.name} now`} className="rounded-lg p-1.5 text-ink-3 hover:bg-surface-3 hover:text-bad" onClick={async () => {
                      if (await confirmDialog({ title: `Erase “${d.name}” now?`, body: 'Its rows, saved versions and dashboard are deleted from this browser. This cannot be undone.', confirmLabel: 'Erase', danger: true })) void purgeRemoved(d.id)
                    }}><Trash2 size={14} /></button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <section className="mt-14">
        <div className="mb-4">
          <h2 className="text-[20px] font-semibold tracking-tight">Try a sample dataset</h2>
          <p className="mt-0.5 text-[13px] text-ink-3">Each one opens with a ready-made showcase — extra pages, formulas and prep steps you can inspect and change.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SAMPLES.map((s, i) => {
            const Icon = FORMAT_ICON[s.format]
            return (
              <button
                key={s.file}
                onClick={() => void openSample(s)}
                className="card fade-up group flex flex-col p-5 text-left transition hover:-translate-y-0.5 hover:border-line-strong hover:shadow-pop"
                style={{ animationDelay: `${i * 35}ms` }}
              >
                {/* the title comes first for screen readers ("Open sample …"); the format row is moved above it visually */}
                <div className="mt-4 flex items-center gap-2 text-[15px] font-semibold">
                  <span className="sr-only">Open sample </span>{s.title}
                  {s.featured && <span className="rounded-md bg-accent-fill px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">Full tour</span>}
                </div>
                <div className="-order-1 flex items-center justify-between">
                  <span className={cx('inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-semibold', FORMAT_TONE[s.format])}>
                    <Icon size={13} />{s.format}
                  </span>
                  <span className="tabular text-[12px] text-ink-3">{s.rows} rows</span>
                </div>
                <p className="mt-1 flex-1 text-[13px] leading-relaxed text-ink-2">{s.description}</p>
                <div className="mt-3 flex flex-wrap gap-1" aria-label="Shows">
                  {s.shows.map((t) => <span key={t} className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] text-ink-2">{t}</span>)}
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <span className="flex items-center gap-1 text-[11px] text-ink-3" title={s.source}><Scale size={11} />{s.license}</span>
                  <span className="inline-flex items-center gap-1 text-[12px] font-medium text-accent-ink opacity-0 transition group-hover:opacity-100">Open <ArrowRight size={13} /></span>
                </div>
              </button>
            )
          })}
        </div>
        <p className="mt-4 text-[12px] text-ink-3">
          Sources: <a className="underline hover:text-ink" href="https://github.com/vega/vega-datasets" target="_blank" rel="noreferrer">vega-datasets</a> (BSD-3-Clause) and{' '}
          <a className="underline hover:text-ink" href="https://github.com/allisonhorst/palmerpenguins" target="_blank" rel="noreferrer">palmerpenguins</a> (CC0). The XLSX and XLS samples are converted from vega-datasets files; Coffee Chain Sales is synthetic (CC0).
        </p>
      </section>

      {dialog === 'url' && <UrlDialog onClose={() => setDialog(null)} />}
      {dialog === 'paste' && <PasteDialog onClose={() => setDialog(null)} />}
      {dialog === 'storage' && <StorageDialog onClose={() => setDialog(null)} onBackup={() => setDialog('backup')} />}
      {dialog === 'backup' && <BackupDialog onClose={() => setDialog(null)} />}
    </div>
  )
}

function UrlDialog({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('')
  const [refresh, setRefresh] = useState(0)
  const valid = /^https?:\/\/\S+$/i.test(url.trim())
  const go = () => { if (!valid) return; onClose(); void useStore.getState().importUrl(normalizeUrl(url.trim()), { refreshMinutes: refresh || undefined }) }
  return (
    <Modal title="Import from a URL" onClose={onClose} width={560}>
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-medium text-ink-2">CSV, JSON or Excel file URL</span>
        <input aria-label="URL" autoFocus className="field" placeholder="https://example.com/data.csv" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
      </label>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
        Works with public CSV/JSON endpoints and Google Sheets links (use <em>File → Share → Publish to web → CSV</em>, or paste the sheet link and Numero asks for its CSV export). The server must allow browser downloads (CORS). The only thing sent is the request for this address — your data is never uploaded. You can cancel a slow download; one that does not answer within 30 seconds stops by itself.
      </p>
      <label className="mt-4 block">
        <span className="mb-1.5 block text-[12px] font-medium text-ink-2">Refresh automatically while open</span>
        <select aria-label="Refresh interval" className="field" value={refresh} onChange={(e) => setRefresh(+e.target.value)}>
          <option value={0}>Never — refresh by hand</option>
          {[5, 15, 30, 60].map((m) => <option key={m} value={m}>Every {m} minutes</option>)}
        </select>
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <Button size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!valid} onClick={go}><Globe size={14} />Import</Button>
      </div>
    </Modal>
  )
}

/** Google Sheets edit links become their CSV export. */
export function normalizeUrl(url: string): string {
  const m = /docs\.google\.com\/spreadsheets\/d\/([\w-]+)\/(edit|view)?[^#]*(#gid=(\d+))?/.exec(url)
  if (m && !/output=csv|format=csv/.test(url)) return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${m[4] ? `&gid=${m[4]}` : ''}`
  return url
}

function PasteDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('')
  const [name, setName] = useState('Pasted data')
  const lines = text.trim() ? text.trim().split(/\r?\n/).length : 0
  return (
    <Modal title="Paste data" onClose={onClose} width={640}>
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-medium text-ink-2">Dataset name</span>
        <input aria-label="Dataset name" className="field" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="mt-3 block">
        <span className="mb-1.5 block text-[12px] font-medium text-ink-2">Rows copied from a spreadsheet, CSV text or JSON</span>
        <textarea aria-label="Pasted data" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={'Region\tSales\nNorth\t1200\nSouth\t950'}
          className="field h-64 resize-y py-2 font-mono text-[12.5px]" />
      </label>
      <div className="mt-4 flex items-center justify-between">
        <span className="text-[12px] text-ink-3">{lines ? `${lines.toLocaleString()} lines` : 'Tip: copy cells in Excel or Google Sheets and paste here'}</span>
        <div className="flex gap-2">
          <Button size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={lines < 2} onClick={() => { onClose(); void useStore.getState().importText(text, name.trim() || 'Pasted data') }}>Continue</Button>
        </div>
      </div>
    </Modal>
  )
}

function StorageDialog({ onClose, onBackup }: { onClose: () => void; onBackup: () => void }) {
  const metas = useStore((s) => s.metas)
  const trash = useStore((s) => s.trash)
  const { deleteVersions } = useStore.getState()
  const [status, setStatus] = useState<StorageStatus | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => { void storageStatus().then(setStatus) }, [metas, trash])
  // saved versions are full copies, so they count toward a dataset's size
  const versionBytes = (m: DatasetMeta) => (m.source.versions ?? []).reduce((a, v) => a + (v.bytes ?? m.bytes ?? 0), 0)
  const sorted = [...metas].sort((a, b) => (b.bytes ?? 0) + versionBytes(b) - (a.bytes ?? 0) - versionBytes(a))
  const about = status ? describeStorage(status) : null
  const warning = status ? quotaWarning(status) : null
  const trashBytes = trash.reduce((a, m) => a + (m.bytes ?? 0) + versionBytes(m), 0)
  return (
    <Modal title="Browser storage" onClose={onClose} width={600}>
      {about && (
        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-line px-3 py-2.5" role="status" aria-label="How your data is kept" data-persist={status!.state}>
          <ShieldCheck size={16} className={cx('mt-0.5 shrink-0', about.tone === 'good' ? 'text-[#0e8f63]' : about.tone === 'warn' ? 'text-[#c98500]' : 'text-ink-3')} />
          <div className="min-w-0">
            <div className="text-[13px] font-medium">{about.headline}</div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-3">{about.detail}</p>
            <button className="mt-1 text-[12px] font-medium text-accent-ink hover:underline" onClick={onBackup}>Back up everything to a file…</button>
          </div>
        </div>
      )}
      {status?.usage != null && status.quota ? (
        <div className="mb-4">
          <div className="flex justify-between text-[12px] text-ink-2"><span>{fmtBytes(status.usage)} used</span><span className="text-ink-3">of about {fmtBytes(status.quota)} this browser allows the site</span></div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-3"><div className={cx('h-full rounded-full', status.level === 'critical' ? 'bg-bad' : status.level === 'warn' ? 'bg-[#eda100]' : 'bg-accent')} style={{ width: `${Math.min(100, (status.usage / Math.max(1, status.quota)) * 100)}%` }} /></div>
        </div>
      ) : status && <p className="mb-4 text-[12px] text-ink-3">This browser does not report how much space is used.</p>}
      {warning && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl bg-[#eda100]/12 px-3 py-2.5 text-[12.5px] text-ink-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[#c98500]" />{warning}
        </div>
      )}
      <div className="divide-y divide-line rounded-xl border border-line">
        {sorted.map((m) => {
          const versions = m.source.versions ?? []
          return (
            <div key={m.id}>
              <div className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{m.name}</div>
                  <div className="text-[11px] text-ink-3">{m.rowCount.toLocaleString()} rows · added {new Date(m.createdAt).toLocaleDateString()}</div>
                </div>
                {versions.length > 0 && (
                  <button aria-expanded={open === m.id} className="rounded-md px-1.5 py-0.5 text-[11.5px] text-ink-3 hover:bg-surface-3 hover:text-ink" onClick={() => setOpen(open === m.id ? null : m.id)}>
                    {versions.length} saved version{versions.length > 1 ? 's' : ''}
                  </button>
                )}
                <span className="tabular text-[12px] text-ink-2" title={versionBytes(m) ? `${fmtBytes(m.bytes ?? 0)} data + ${fmtBytes(versionBytes(m))} in saved versions` : undefined}>{m.bytes ? fmtBytes(m.bytes + versionBytes(m)) : '—'}</span>
                <button aria-label={`Remove ${m.name}`} onClick={() => void useStore.getState().remove(m.id)} className="rounded-md p-1.5 text-ink-3 hover:bg-surface-3 hover:text-bad"><Trash2 size={14} /></button>
              </div>
              {open === m.id && versions.length > 0 && (
                <ul aria-label={`Saved versions of ${m.name}`} className="mx-3 mb-2.5 divide-y divide-line rounded-lg bg-surface-2">
                  {versions.map((v) => (
                    <li key={v.key} className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
                      <span className="min-w-0 flex-1 truncate text-ink-2" title={v.label}>{v.label}</span>
                      <span className="shrink-0 text-ink-3">{new Date(v.at).toLocaleDateString()}</span>
                      {v.rows > 0 && <span className="tabular shrink-0 text-ink-3">{v.rows.toLocaleString()} rows</span>}
                      <span className="tabular w-16 shrink-0 text-right text-ink-2">{fmtBytes(v.bytes ?? m.bytes ?? 0)}</span>
                      <button aria-label={`Delete version: ${v.label}`} onClick={() => void deleteVersions(m.id, v.key)} className="rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-bad"><Trash2 size={12} /></button>
                    </li>
                  ))}
                  <li className="px-2.5 py-1.5"><button className="text-[12px] font-medium text-accent-ink hover:underline" onClick={() => void deleteVersions(m.id)}>Clear all {versions.length}</button></li>
                </ul>
              )}
            </div>
          )
        })}
      </div>
      {trash.length > 0 && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2.5 text-[12.5px]">
          <span className="text-ink-2">{trash.length} removed dataset{trash.length > 1 ? 's' : ''} kept for restoring{trashBytes ? ` · about ${fmtBytes(trashBytes)}` : ''}</span>
          <button className="font-medium text-accent-ink hover:underline" onClick={async () => {
            if (await confirmDialog({ title: 'Erase removed datasets now?', body: 'This frees their space and cannot be undone.', confirmLabel: 'Erase', danger: true })) void useStore.getState().purgeRemoved()
          }}>Erase now</button>
        </div>
      )}
      <p className="mt-3 text-[12px] text-ink-3">Each dataset is stored once, as its original rows, plus up to 5 earlier versions kept by Update data (fewer for datasets over 50 MB). A removed dataset keeps its space for 7 days, so it can be restored, unless you erase it sooner.</p>
    </Modal>
  )
}
