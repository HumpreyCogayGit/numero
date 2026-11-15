import { useRef, useState } from 'react'
import { AlertTriangle, Archive, Download, Loader2, Upload } from 'lucide-react'
import { engine } from '../engine/client'
import type { BackupInspection } from '../engine/protocol'
import { BACKUP_EXT, estimateBackupBytes, type RestoreMode, type RestoreSummary } from '../lib/backup'
import { downloadBlob } from '../lib/download'
import { fmtBytes } from '../lib/format'
import { listDashboards } from '../lib/db'
import { useStore, type ThemePref } from '../store'
import { Button, cx, Modal } from './ui'

const describe = (s: RestoreSummary) => [
  s.added && `${s.added} added`,
  s.replaced && `${s.replaced} brought back to the backup’s rows and settings`,
  s.settings && `${s.settings} get their settings and dashboard back (rows stay as they are)`,
  s.skipped.length && `${s.skipped.length} skipped`,
].filter(Boolean).join(' · ') || 'nothing to restore'

/** Backs up every dataset's settings and dashboards (optionally with the rows) to one file, and restores such a file. */
export function BackupDialog({ onClose }: { onClose: () => void }) {
  const metas = useStore((s) => s.metas)
  const [includeData, setIncludeData] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [found, setFound] = useState<{ file: File; info: BackupInspection } | null>(null)
  const [mode, setMode] = useState<RestoreMode>('merge')
  const input = useRef<HTMLInputElement>(null)
  const size = estimateBackupBytes(metas, includeData)

  const create = async () => {
    setBusy('Creating the backup'); setError(null); setDone(null)
    try {
      const s = useStore.getState()
      const res = await engine('backupExport', { includeData, settings: { theme: s.themePref, patterns: s.patterns }, appVersion: __APP_VERSION__ })
      downloadBlob(`numero-${new Date().toISOString().slice(0, 10)}${BACKUP_EXT}`, res.blob)
      setDone(`Backup saved: ${res.datasets} dataset${res.datasets === 1 ? '' : 's'}, ${fmtBytes(res.blob.size)}${res.skipped.length ? `. ${res.skipped.map((x) => `“${x.name}”: ${x.reason}`).join('; ')}.` : '.'}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  const inspect = async (file: File) => {
    setBusy('Checking the backup'); setError(null); setDone(null); setFound(null)
    try {
      const info = await engine('backupInspect', { file })
      setFound({ file, info })
      setMode(info.conflicts.ids ? 'merge' : 'copy')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  const restore = async () => {
    if (!found) return
    setBusy('Restoring'); setError(null)
    try {
      const res = await engine('backupRestore', { file: found.file, mode })
      // show what is in storage now
      const [list, trash, dashboards] = await Promise.all([engine('list', {}), engine('listTrash', {}), listDashboards()])
      const active = useStore.getState().active
      useStore.setState({ metas: list.sort((a, b) => b.createdAt - a.createdAt), trash, dashboards, ...(active ? { active: null } : {}) })
      if (res.prefs.theme && ['system', 'light', 'dark'].includes(res.prefs.theme)) useStore.getState().setTheme(res.prefs.theme as ThemePref)
      if (typeof res.prefs.patterns === 'boolean') useStore.getState().setPatterns(res.prefs.patterns)
      setDone(`Restored: ${describe(res)}.${res.skipped.length ? ` Skipped — ${res.skipped.map((x) => `“${x.name}”: ${x.reason}`).join('; ')}.` : ''}`)
      setFound(null)
    } catch (e) {
      setError(`${e instanceof Error ? e.message : String(e)} Nothing was changed.`.replace(/Nothing was (restored|changed)\. Nothing was changed\.$/, 'Nothing was changed.'))
    } finally { setBusy(null) }
  }

  return (
    <Modal title={<span className="flex items-center gap-2"><Archive size={17} className="text-accent" />Back up and restore</span>} onClose={onClose} width={600}>
      <p className="text-[13px] leading-relaxed text-ink-2">
        Everything Numero stores lives in this one browser. A backup file is a copy you keep yourself — on disk, in your cloud folder, wherever you choose. Numero never uploads it.
      </p>

      <section className="mt-4 rounded-xl border border-line p-3.5" aria-label="Create a backup">
        <h3 className="text-[13px] font-semibold">Create a backup</h3>
        <div className="mt-2 space-y-1.5 text-[13px]" role="radiogroup" aria-label="What to include">
          <label className="flex items-start gap-2">
            <input type="radio" name="backup-scope" className="mt-1" checked={!includeData} onChange={() => setIncludeData(false)} />
            <span><span className="font-medium">Dashboards and settings only</span><span className="block text-[12px] text-ink-3">Pages, charts, formulas, preparation steps, formats and source details — small. Restoring needs the datasets to be here already, or their source files.</span></span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="backup-scope" className="mt-1" checked={includeData} onChange={() => setIncludeData(true)} />
            <span><span className="font-medium">Include the data rows</span><span className="block text-[12px] text-ink-3">A complete copy that restores on any browser. The file contains your data in readable form: store it as carefully as the source files.</span></span>
          </label>
        </div>
        {includeData && size > 50e6 && (
          <div role="alert" className="mt-2.5 flex items-start gap-2 rounded-lg bg-[#eda100]/12 px-2.5 py-2 text-[12.5px] text-ink-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[#c98500]" />This backup will be large — about {fmtBytes(size)} — and is built in memory. If it fails, back up dashboards only and keep the source files.
          </div>
        )}
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-3">{metas.length} dataset{metas.length === 1 ? '' : 's'} · about {fmtBytes(size)}</span>
          <Button size="sm" variant="primary" disabled={!!busy || !metas.length} onClick={() => void create()}><Download size={14} />Create backup</Button>
        </div>
      </section>

      <section className="mt-3 rounded-xl border border-line p-3.5" aria-label="Restore a backup">
        <h3 className="text-[13px] font-semibold">Restore a backup</h3>
        <p className="mt-1 text-[12px] text-ink-3">The file is checked in full before anything is written. If any part of it is damaged, nothing is changed.</p>
        <input ref={input} type="file" accept=".json,application/json" aria-label="Backup file" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void inspect(f); e.target.value = '' }} />
        {!found && <div className="mt-2.5"><Button size="sm" disabled={!!busy} onClick={() => input.current?.click()}><Upload size={14} />Choose a backup file…</Button></div>}
        {found && (
          <div className="mt-2.5 text-[13px]">
            <div className="text-ink-2">
              <span className="font-medium text-ink">{found.file.name}</span> · made {new Date(found.info.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · {found.info.datasets.length} dataset{found.info.datasets.length === 1 ? '' : 's'} · {found.info.includesData ? 'with data rows' : 'dashboards and settings only'}
            </div>
            {(found.info.conflicts.ids > 0 || found.info.conflicts.names > 0) && (
              <div className="mt-1.5 text-[12.5px] text-ink-2">
                {found.info.conflicts.ids > 0 && `${found.info.conflicts.ids} of them ${found.info.conflicts.ids === 1 ? 'is' : 'are'} already here. `}
                {found.info.conflicts.names > 0 && `${found.info.conflicts.names} share a name with a different dataset here and will be renamed “… (restored)”.`}
              </div>
            )}
            <div className="mt-2.5 space-y-1.5" role="radiogroup" aria-label="How to restore">
              {([['merge', 'Bring this workspace back to the backup', 'Datasets already here return to the backup’s state; the rest are added. Nothing else is removed.'], ['copy', 'Add as separate copies', 'Nothing here is touched. Every dataset in the backup that has rows arrives as a new one.']] as const).map(([m, title, text]) => (
                <label key={m} className={cx('flex items-start gap-2 rounded-lg border px-2.5 py-2', mode === m ? 'border-accent bg-accent-soft' : 'border-line')}>
                  <input type="radio" name="restore-mode" className="mt-1" checked={mode === m} onChange={() => setMode(m)} />
                  <span>
                    <span className="font-medium">{title}</span>
                    <span className="block text-[12px] text-ink-3">{text}</span>
                    <span className="block text-[12px] text-ink-2" data-plan={m}>Result: {describe(found.info[m])}</span>
                  </span>
                </label>
              ))}
            </div>
            {found.info[mode].skipped.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-[12px] text-ink-3">
                {found.info[mode].skipped.map((x) => <li key={x.name}>Skipped “{x.name}”: {x.reason}.</li>)}
              </ul>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" disabled={!!busy} onClick={() => setFound(null)}>Choose another file</Button>
              <Button size="sm" variant="primary" disabled={!!busy || found.info[mode].added + found.info[mode].replaced + found.info[mode].settings === 0} onClick={() => void restore()}>Restore</Button>
            </div>
          </div>
        )}
      </section>

      <div className="mt-3 min-h-5 text-[12.5px]" aria-live="polite">
        {busy && <span className="inline-flex items-center gap-1.5 text-ink-2"><Loader2 size={13} className="animate-spin" />{busy}…</span>}
        {done && <span role="status" className="text-ink-2">{done}</span>}
        {error && <span role="alert" className="text-bad">{error}</span>}
      </div>
    </Modal>
  )
}
