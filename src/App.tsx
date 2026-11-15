import { lazy, Suspense, useEffect, useState } from 'react'
import {
  BarChart3, Database, FileSpreadsheet, Home as HomeIcon, Lightbulb, LayoutDashboard, Loader2, Menu, Monitor, Moon, Plus,
  Sheet, Sun, Table2, Trash2, X, Grid2x2, AlertCircle, FunctionSquare, Undo2, Redo2, Wand2, RefreshCw, Globe, Shapes, Search, WifiOff, Info,
} from 'lucide-react'
import { useStore, useActive, useCanUndo, useCanRedo, setAsk, type Tab, type ThemePref } from './store'
import { useOnline, useResolvedTheme } from './lib/hooks'
import { startRouteSync } from './routeSync'
import { describeStatus } from './lib/refresh'
import { CrashProbe } from './components/ErrorBoundary'
import { SourceInfo } from './components/SourceInfo'
import { ThemeContext, PatternContext } from './components/theme'
import { Home } from './components/Home'
import { DataTable } from './components/DataTable'
import { ProfileView } from './components/ProfileView'
import { PivotView } from './components/PivotView'
import { PrepareView } from './components/PrepareView'
import { FormulaEditor } from './components/FormulaEditor'
import { ImportPreview } from './components/ImportPreview'
import { UpdateData } from './components/UpdateData'
import { CommandPalette } from './components/CommandPalette'
import { PrintReport } from './components/PrintReport'
import { Badge, Button, ConfirmHost, confirmDialog, cx, IconButton, Popover, Segmented, Toggle } from './components/ui'
import { ACCEPT } from './lib/parse'

// questions the store asks (large files, removing a dataset with work on it) use the app's own dialog
setAsk((q) => confirmDialog(q))

// chart-heavy views load ECharts on demand, keeping the home page light
const Dashboard = lazy(() => import('./components/Dashboard').then((m) => ({ default: m.Dashboard })))
const InsightsView = lazy(() => import('./components/InsightsView').then((m) => ({ default: m.InsightsView })))

const TABS: { id: Tab; label: string; icon: typeof BarChart3 }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'insights', label: 'Insights', icon: Lightbulb },
  { id: 'pivot', label: 'Pivot', icon: Grid2x2 },
  { id: 'profile', label: 'Columns', icon: BarChart3 },
  { id: 'data', label: 'Data', icon: Table2 },
  { id: 'prepare', label: 'Prepare', icon: Wand2 },
]

export default function App() {
  const theme = useResolvedTheme()
  const patterns = useStore((s) => s.patterns)
  const ready = useStore((s) => s.ready)
  const ds = useActive()
  const tab = useStore((s) => s.tab)
  const [nav, setNav] = useState(false)
  const [dragging, setDragging] = useState(false)

  useEffect(() => { void useStore.getState().init() }, [])
  // Back / Forward and the address bar follow the view
  useEffect(() => startRouteSync(), [])

  // drop a file anywhere to import it
  useEffect(() => {
    let depth = 0
    const enter = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) { depth++; setDragging(true) } }
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false) }
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault() }
    const drop = (e: DragEvent) => {
      depth = 0
      setDragging(false)
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length) { e.preventDefault(); void useStore.getState().startImports(files) }
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  // ⌘K / Ctrl+K: command palette, from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const { palette, setPalette } = useStore.getState()
        setPalette(!palette)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ⌘Z / ⇧⌘Z — but leave text fields their own undo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (!(e.metaKey || e.ctrlKey) || (k !== 'z' && k !== 'y')) return
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable="true"]')) return
      e.preventDefault()
      if (k === 'y' || e.shiftKey) useStore.getState().redo()
      else useStore.getState().undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // scheduled refresh for URL sources, while the dataset is open
  const refreshMinutes = ds?.source.kind === 'url' ? ds.source.refreshMinutes : undefined
  const dsId = ds?.id
  useEffect(() => {
    if (!refreshMinutes || !dsId) return
    // a tick that finds the last refresh still running, a paused source or no connection does nothing (see refreshSource)
    const tick = () => { void useStore.getState().refreshSource(dsId, { scheduled: true }) }
    const t = setInterval(tick, refreshMinutes * 60_000)
    // back online: a refresh that was waiting runs now
    const online = () => { if (useStore.getState().refresh[dsId]?.state === 'offline') tick() }
    window.addEventListener('online', online)
    return () => { clearInterval(t); window.removeEventListener('online', online) }
  }, [refreshMinutes, dsId])

  return (
    <ThemeContext.Provider value={theme}>
      <PatternContext.Provider value={patterns}>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[90] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:shadow-pop">Skip to content</a>
        <div className="flex h-full">
          <Sidebar open={nav} onClose={() => setNav(false)} />
          <main id="main" className="min-w-0 flex-1 overflow-y-auto">
            <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-line bg-page/85 px-4 py-2.5 backdrop-blur lg:hidden">
              <IconButton label="Open menu" onClick={() => setNav(true)}><Menu size={18} /></IconButton>
              <Logo />
            </div>
            {!ready ? (
              <div className="flex h-[60vh] items-center justify-center text-ink-3"><Loader2 className="animate-spin" /></div>
            ) : ds ? (
              <div className="px-4 pb-16 pt-5 sm:px-6 lg:px-8">
                <DatasetHeader />
                <FormulaHost />
                <UpdateHost />
                <div key={ds.id + tab} className="fade-up" role="tabpanel">
                  <Suspense fallback={<div className="flex h-60 items-center justify-center text-ink-3"><Loader2 className="animate-spin" /></div>}>
                  {tab === 'dashboard' && <Dashboard ds={ds} />}
                  {tab === 'data' && <DataTable ds={ds} />}
                  {tab === 'profile' && <ProfileView ds={ds} />}
                  {tab === 'insights' && <InsightsView ds={ds} />}
                  {tab === 'pivot' && <PivotView ds={ds} />}
                  {tab === 'prepare' && <PrepareView ds={ds} />}
                  </Suspense>
                </div>
              </div>
            ) : (
              <Home />
            )}
          </main>
        </div>
        <CrashProbe />
        <ImportHost />
        <PaletteHost />
        <PrintHost />
        <Overlay />
        <ConfirmHost />
        {dragging && (
          <div className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-accent/10 p-6 backdrop-blur-sm">
            <div className="rounded-3xl border-2 border-dashed border-accent bg-surface px-10 py-8 text-center shadow-pop">
              <FileSpreadsheet className="mx-auto text-accent" size={28} />
              <div className="mt-3 font-semibold">Drop to import</div>
              <div className="text-[13px] text-ink-3">CSV, JSON, Excel or OpenDocument · several files at once</div>
            </div>
          </div>
        )}
      </PatternContext.Provider>
    </ThemeContext.Provider>
  )
}

function ImportHost() {
  const pending = useStore((s) => s.pending)
  if (!pending) return null
  return <ImportPreview key={`${pending.file.name}:${pending.file.size}:${pending.file.lastModified}:${pending.more?.length ?? 0}`} />
}

function PrintHost() {
  const printing = useStore((s) => s.printing)
  const ds = useActive()
  return printing && ds ? <PrintReport ds={ds} /> : null
}

function PaletteHost() {
  const open = useStore((s) => s.palette)
  return open ? <CommandPalette /> : null
}

function UpdateHost() {
  const ds = useActive()
  const open = useStore((s) => !!s.pendingUpdate)
  return ds && open ? <UpdateData ds={ds} /> : null
}

function FormulaHost() {
  const ds = useActive()
  const target = useStore((s) => s.formulaEditor)
  if (!ds || !target) return null
  return <FormulaEditor key={`${target.mode}:${target.key ?? 'new'}`} ds={ds} mode={target.mode} />
}

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden>
        <rect width="32" height="32" rx="8" fill="var(--accent)" />
        <rect x="8" y="16" width="4" height="9" rx="1.5" fill="#fff" />
        <rect x="14" y="11" width="4" height="14" rx="1.5" fill="#fff" />
        <rect x="20" y="7" width="4" height="18" rx="1.5" fill="#fff" opacity=".75" />
      </svg>
      <span className="text-[16px] font-semibold tracking-tight">Numero</span>
    </div>
  )
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const metas = useStore((s) => s.metas)
  const activeId = useStore((s) => s.active?.id)
  const themePref = useStore((s) => s.themePref)
  const patterns = useStore((s) => s.patterns)
  const { open: openDs, remove, setTheme, setPatterns, startImports } = useStore.getState()
  const online = useOnline()
  const go = (id: string | null) => { void openDs(id); onClose() }

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={onClose} />}
      <aside aria-label="Datasets" className={cx(
        'fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-line bg-surface transition-transform lg:static lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full',
      )}>
        <div className="flex items-center justify-between px-5 pb-4 pt-5">
          <button onClick={() => go(null)} aria-label="Numero home"><Logo /></button>
          <IconButton label="Close menu" onClick={onClose} className="lg:hidden"><X size={16} /></IconButton>
        </div>
        <div className="px-3">
          <label className="flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-accent-fill text-sm font-medium text-white shadow-card transition hover:brightness-110 focus-within:ring-2 focus-within:ring-accent/50">
            <Plus size={15} />Import data
            <input id="import-file" type="file" multiple accept={ACCEPT} className="sr-only" onChange={(e) => { const files = [...(e.target.files ?? [])]; if (files.length) void startImports(files); e.target.value = ''; onClose() }} />
          </label>
          <button onClick={() => { onClose(); useStore.getState().setPalette(true) }} className="mt-2 flex h-8 w-full items-center gap-2 rounded-lg border border-line px-2.5 text-[12.5px] text-ink-3 transition hover:border-line-strong hover:text-ink">
            <Search size={14} />Search & commands<kbd className="ml-auto rounded border border-line px-1 text-[10.5px]">{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'}K</kbd>
          </button>
        </div>
        <nav className="mt-4 flex-1 overflow-y-auto px-3">
          <button onClick={() => go(null)} className={cx('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition', !activeId ? 'bg-surface-3 text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>
            <HomeIcon size={15} />Home
          </button>
          <div className="mb-1 mt-5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Datasets</div>
          {!metas.length && <p className="px-2.5 py-1 text-[12px] text-ink-3">Nothing imported yet.</p>}
          {metas.map((d) => (
            <div key={d.id} className={cx('group flex items-center rounded-lg transition', d.id === activeId ? 'bg-accent-soft' : 'hover:bg-surface-2')}>
              <button onClick={() => go(d.id)} className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left">
                {d.source.kind === 'url' ? <Globe size={15} className="shrink-0 text-ink-3" /> : d.format === 'json' ? <Database size={15} className="shrink-0 text-ink-3" /> : d.format.startsWith('xls') ? <Sheet size={15} className="shrink-0 text-ink-3" /> : <FileSpreadsheet size={15} className="shrink-0 text-ink-3" />}
                <span className="min-w-0">
                  <span className={cx('block truncate text-[13px]', d.id === activeId ? 'font-medium text-accent-ink' : 'text-ink')}>{d.name}</span>
                  <span className="block text-[11px] text-ink-3">{d.rowCount.toLocaleString()} rows</span>
                </span>
              </button>
              <button onClick={() => void remove(d.id)} aria-label={`Remove ${d.name}`} className="mr-1 rounded-md p-1 text-ink-3 opacity-0 transition hover:text-bad focus:opacity-100 group-hover:opacity-100"><Trash2 size={13} /></button>
            </div>
          ))}
        </nav>
        <div className="space-y-2 border-t border-line p-3">
          {!online && (
            <div role="status" className="flex items-start gap-2 rounded-lg bg-surface-3 px-2.5 py-2 text-[12px] leading-snug text-ink-2">
              <WifiOff size={14} className="mt-0.5 shrink-0" />
              <span><strong className="font-medium text-ink">Offline.</strong> Your datasets still work. URL imports and refreshes wait for the connection.</span>
            </div>
          )}
          <div className="rounded-lg px-1"><Toggle label="Pattern fills" checked={patterns} onChange={setPatterns} /></div>
          <Segmented<ThemePref> size="sm" value={themePref} onChange={setTheme} options={[
            { value: 'system', label: <><Monitor size={13} />Auto</>, title: 'Match system' },
            { value: 'light', label: <Sun size={13} />, title: 'Light' },
            { value: 'dark', label: <Moon size={13} />, title: 'Dark' },
          ]} />
        </div>
      </aside>
    </>
  )
}

function DatasetHeader() {
  const ds = useActive()!
  const tab = useStore((s) => s.tab)
  const updating = useStore((s) => s.updating)
  const canUndo = useCanUndo()
  const canRedo = useCanRedo()
  const { setTab, openFormula, undo, redo, refreshSource, renameDataset, openUpdate } = useStore.getState()
  const refresh = useStore((s) => s.refresh[ds.id])
  const alsoOpen = useStore((s) => s.alsoOpen)
  const refreshLine = describeStatus(refresh, (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))
  const types = ds.columns.reduce<Record<string, number>>((a, c) => ((a[c.type] = (a[c.type] ?? 0) + 1), a), {})
  const [renaming, setRenaming] = useState(false)
  return (
    <header className="mb-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          {renaming ? (
            <input autoFocus aria-label="Dataset name" defaultValue={ds.name} className="field h-10 w-80 text-[20px] font-semibold"
              onBlur={(e) => { void renameDataset(ds.id, e.target.value); setRenaming(false) }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(false) }} />
          ) : (
            <h1 className="truncate text-[24px] font-semibold tracking-tight" onDoubleClick={() => setRenaming(true)} title="Double-click to rename">{ds.name}</h1>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
            <Badge>{ds.format.toUpperCase()}</Badge>
            <span>{ds.rows.length.toLocaleString()} rows</span>·<span>{ds.columns.length} columns</span>
            <span className="hidden sm:inline">·</span>
            <span className="hidden sm:inline">{Object.entries(types).map(([t, n]) => `${n} ${t}`).join(', ')}</span>
            {!!ds.model.computed.length && <><span className="hidden sm:inline">·</span><span className="hidden sm:inline">{ds.model.computed.length} computed</span></>}
            {!!ds.model.prep.length && <><span className="hidden sm:inline">·</span><span className="hidden sm:inline">{ds.model.prep.length} prep steps</span></>}
            {ds.source.updates?.[0] && <><span className="hidden sm:inline">·</span><span className="hidden sm:inline" title={`${ds.source.updates[0].mode} from ${ds.source.updates[0].fileName}`}>updated {new Date(ds.source.updates[0].at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></>}
            {ds.source.truncated && <Badge tone="bad">First {ds.rows.length.toLocaleString()} rows only</Badge>}
            <Popover label="Source and freshness" width={340} trigger={(open, toggle) => <button aria-expanded={open} onClick={toggle} className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-ink-2 underline decoration-dotted underline-offset-2 hover:bg-surface-3 hover:text-ink" aria-label="Source and freshness"><Info size={12} />Source</button>}>
              {() => <SourceInfo ds={ds} />}
            </Popover>
            {updating && <span className="inline-flex items-center gap-1 text-accent-ink"><Loader2 size={12} className="animate-spin" />Updating</span>}
          </div>
          {refreshLine && (
            <div role="status" data-refresh-state={refresh?.state} className={cx('mt-1.5 inline-flex flex-wrap items-center gap-1.5 rounded-lg px-2 py-1 text-[12px]', refresh?.state === 'ok' ? 'text-ink-3' : 'bg-[#eda100]/12 text-ink-2')}>
              {refresh?.state === 'offline' ? <WifiOff size={12} /> : refresh?.state === 'ok' ? <RefreshCw size={12} /> : <AlertCircle size={12} className="text-[#c98500]" />}
              <span title={refresh?.message}>{refreshLine}</span>
              {refresh?.state === 'failing' && refresh.message && <span className="text-ink-3">· {refresh.message}</span>}
              {(refresh?.state === 'failing' || refresh?.state === 'paused') && <button className="font-medium text-accent-ink hover:underline" onClick={() => void refreshSource()}>{refresh.state === 'paused' ? 'Review' : 'Try now'}</button>}
            </div>
          )}
          {alsoOpen && (
            <div role="status" className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-[#eda100]/12 px-2 py-1 text-[12px] text-ink-2">
              <AlertCircle size={12} className="mt-0.5 shrink-0 text-[#c98500]" />
              <span>This dataset is also open in another tab. Changes saved there appear here; editing the same dashboard in both at once keeps only the last save.</span>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <IconButton label="Undo (⌘Z)" disabled={!canUndo} onClick={undo} className="disabled:opacity-30"><Undo2 size={16} /></IconButton>
          <IconButton label="Redo (⇧⌘Z)" disabled={!canRedo} onClick={redo} className="disabled:opacity-30"><Redo2 size={16} /></IconButton>
          {ds.source.kind === 'url'
            ? <Button size="sm" variant="ghost" onClick={() => void refreshSource()}><RefreshCw size={14} />Refresh</Button>
            : <Button size="sm" variant="ghost" onClick={() => openUpdate()} title="Load a new month or a corrected file into this dashboard"><RefreshCw size={14} />Update data</Button>}
          <Button size="sm" onClick={() => openFormula(undefined, 'measure')}><Shapes size={14} />New measure</Button>
          <Button size="sm" onClick={() => openFormula()}><FunctionSquare size={14} />New column</Button>
        </div>
      </div>
      <div role="tablist" aria-label="Dataset views" className="mt-4 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cx(
            '-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] font-medium transition',
            tab === t.id ? 'border-accent text-ink' : 'border-transparent text-ink-3 hover:text-ink',
          )}>
            <t.icon size={15} />{t.label}
          </button>
        ))}
      </div>
    </header>
  )
}

function Overlay() {
  const progress = useStore((s) => s.progress)
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore.getState().dismissToast
  return (
    <>
      {progress && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-page/60 backdrop-blur-sm" role="status" aria-live="polite">
          <div className="w-80 rounded-2xl border border-line bg-surface px-5 py-4 shadow-pop">
            <div className="flex items-center gap-3">
              <Loader2 size={18} className="animate-spin text-accent" />
              <span className="truncate text-sm font-medium">{progress.label}</span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-3">
              {progress.indeterminate
                ? <div className="indeterminate h-full w-1/3 rounded-full bg-accent" />
                : <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.round(Math.max(0.04, Math.min(1, progress.fraction)) * 100)}%` }} />}
            </div>
            {progress.cancel && (
              <div className="mt-3 flex justify-end">
                <Button size="sm" onClick={progress.cancel}>Cancel</Button>
              </div>
            )}
          </div>
        </div>
      )}
      {toasts.length > 0 && (
        <div className="pointer-events-none fixed inset-x-4 bottom-5 z-[80] flex flex-col items-center gap-2">
          {toasts.map((toast) => (
            <div key={toast.id} role={toast.kind === 'error' ? 'alert' : 'status'} className="fade-up pointer-events-auto flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface px-4 py-3 text-sm shadow-pop sm:w-auto sm:max-w-[min(640px,calc(100vw-32px))]">
              {toast.kind === 'error' && <AlertCircle size={16} className="shrink-0 text-bad" />}
              <span className="min-w-0 flex-1">{toast.text}</span>
              {toast.action && (
                <button className="ml-1 shrink-0 rounded-md px-2 py-0.5 font-semibold text-accent-ink hover:bg-accent-soft" onClick={() => { toast.action!.run(); dismiss(toast.id) }}>
                  {toast.action.label}
                </button>
              )}
              <button aria-label="Dismiss message" className="shrink-0 rounded-md p-0.5 text-ink-3 hover:bg-surface-3 hover:text-ink" onClick={() => dismiss(toast.id)}><X size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
