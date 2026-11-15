import { create } from 'zustand'
import type { ChangeReport, ColType, ColumnFormat, ComputedDef, Dashboard, Dataset, DatasetMeta, DatasetModel, DataSource, Filter, ImportOptions, MeasureDef, Page, PrepStep, Widget } from './types'
import type { Loaded, PreviewResult, UpdatePreview } from './engine/protocol'
import type { UpdateMode } from './lib/update'
import type { StepReport } from './lib/prep'
import { engine } from './engine/client'
import { renameRefs, uniqueKey } from './lib/computed'
import { suggest, uid } from './lib/suggest'
import { deleteDashboard, getDashboard, listDashboards, migrateLocalDashboards, putDashboard } from './lib/db'
import { emptyModel } from './lib/model'
import { PRESETS } from './lib/presets'
import { whatChanged } from './lib/changes'
import { confirmLink, linkedChanged } from './lib/linked'
import { FetchError, fetchFile } from './lib/fetchFile'
import { LARGE_FILE_BYTES } from './lib/parse'
import { dueNow, nextStatus, type RefreshStatus } from './lib/refresh'
import { requestPersistenceOnce } from './lib/durability'
import { needsConfirm, workAtStake } from './lib/trash'
import { exportDashboard } from './lib/share'
import { downloadText } from './lib/download'
import { widgetColumns } from './lib/aggregate'
import { parseRoute } from './lib/route'
import { recentErrors, recordError } from './lib/diagnostics'
import { fmtBytes } from './lib/format'

export type Tab = 'dashboard' | 'data' | 'profile' | 'insights' | 'pivot' | 'prepare'
export type ThemePref = 'system' | 'light' | 'dark'

interface Snapshot { dash?: Dashboard; model: DatasetModel }
/** a data update (or restore): undone and redone by swapping in the newest saved version */
interface DataStep { data: true }
type Step = Snapshot | DataStep
interface History { past: Step[]; future: Step[]; lastLabel?: string; lastAt?: number }
const isData = (s: Step): s is DataStep => 'data' in s

export interface PendingImport {
  preview: PreviewResult
  file: File
  source: DataSource
  options: ImportOptions
  busy?: boolean
  /** sample file name: its showcase preset is applied after import */
  sample?: string
  /** further files combined into this import */
  more?: File[]
}

export interface Toast { id: number; kind: 'error' | 'info'; text: string; action?: { label: string; run: () => void } }

/** Asks a yes/no question in the app's dialog. Set by the page; tests and headless use fall back to "yes". */
export type AskFn = (q: { title: string; body?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }) => Promise<boolean>
let ask: AskFn = async () => true
export const setAsk = (fn: AskFn) => { ask = fn }

/** Other tabs of the app: dashboards saved and datasets added or removed there are picked up here. */
type TabMessage = { from: string; type: 'dash'; id: string } | { from: string; type: 'metas' } | { from: string; type: 'open' | 'also-open'; id: string }
const TAB_ID = Math.random().toString(36).slice(2)
const channel: BroadcastChannel | null = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('numero')
type Outgoing = TabMessage extends infer M ? (M extends unknown ? Omit<M, 'from'> : never) : never
const tell = (m: Outgoing) => { try { channel?.postMessage({ ...m, from: TAB_ID }) } catch { /* other tabs catch up when they reload */ } }

interface State {
  ready: boolean
  metas: DatasetMeta[]
  active: Dataset | null
  /** prep results for the active dataset */
  prep: { headers: string[]; reports: StepReport[] }
  tab: Tab
  dashboards: Record<string, Dashboard>
  editing: string | null
  pending: PendingImport | null
  /** `cancel` puts a Cancel button on the overlay; `indeterminate` when the total is not known */
  progress: { label: string; fraction: number; cancel?: () => void; indeterminate?: boolean } | null
  /** a rebuild is running in the data engine */
  updating: boolean
  /** messages on screen, oldest first: a later message does not replace one that offers an action */
  toasts: Toast[]
  /** removed datasets that can still be restored */
  trash: DatasetMeta[]
  /** files dropped together, waiting their turn */
  queue: File[]
  /** refresh state per URL dataset: shown in the header in place of a message per attempt */
  refresh: Record<string, RefreshStatus>
  /** the open dataset is also open in another tab */
  alsoOpen: boolean
  /** startup skipped reopening the last dataset (after a crash, or on request) */
  safeStart: boolean
  /** startup has finished (the last or bookmarked dataset is open, or Home is showing): the address bar may follow the view */
  booted: boolean
  /** set by opening the page with #crash-test: a component throws on render (exercises the error boundary) */
  crashTest: boolean
  themePref: ThemePref
  formulaEditor: { mode: 'column' | 'measure'; key?: string } | null
  /** "Update data" dialog: open (no preview yet) or showing a parsed file */
  pendingUpdate: { open: true; preview?: UpdatePreview; file?: File; busy?: boolean } | null
  history: Record<string, History>
  /** "What changed" card for the active dataset, shown after an update */
  changes: (ChangeReport & { datasetId: string }) | null
  fullscreen: string | null
  /** "Show rows" view: the rows behind a widget, optionally narrowed to one mark */
  rowsView: { widgetId: string; filters: Omit<Filter, 'id'>[]; label?: string } | null
  /** "Add a chart" gallery and the ⌘K command palette */
  gallery: boolean
  palette: boolean
  /** Share → Print report: the report view is up and printing */
  printing: boolean
  patterns: boolean

  init: () => Promise<void>
  startImport: (file: File, source?: DataSource, opts?: { skipPreview?: boolean; name?: string; sample?: string; more?: File[] }) => Promise<void>
  /** one or several files chosen or dropped together */
  startImports: (files: File[]) => Promise<void>
  reparse: (options: ImportOptions) => Promise<void>
  commitImport: (args: { sheet: string; name: string; overrides?: Record<string, ColType>; prep?: PrepStep[] }) => Promise<void>
  cancelImport: () => void
  importUrl: (url: string, opts?: { refreshMinutes?: number }) => Promise<void>
  importText: (text: string, name?: string) => Promise<void>
  open: (id: string | null, view?: { tab?: Tab; page?: string }) => Promise<void>
  remove: (id: string) => Promise<void>
  /** brings back a removed dataset with its dashboard and saved versions */
  restoreRemoved: (id: string) => Promise<void>
  /** erases removed datasets for good: one, or all */
  purgeRemoved: (id?: string) => Promise<void>
  renameDataset: (id: string, name: string) => Promise<void>
  refreshSource: (id?: string, opts?: { scheduled?: boolean; force?: boolean }) => Promise<void>
  setRefresh: (minutes: number | undefined) => Promise<void>
  openUpdate: () => void
  previewUpdate: (file: File, sheet?: string) => Promise<void>
  commitUpdate: (args: { mode: UpdateMode; mapping: Record<string, string | undefined>; dedupe: { enabled: boolean; keys: string[] }; sync?: boolean }) => Promise<void>
  cancelUpdate: () => void
  /** restores a saved version of the data; the newest when no key is given */
  restoreVersion: (key?: string, via?: 'undo' | 'redo') => Promise<void>
  showChanges: (r: ChangeReport | null) => void
  /** deletes saved versions of a dataset: one (by key) or all */
  deleteVersions: (id: string, key?: string) => Promise<void>
  setTab: (t: Tab) => void
  setTheme: (t: ThemePref) => void
  setPatterns: (on: boolean) => void
  notify: (kind: Toast['kind'], text: string, action?: Toast['action']) => void
  dismissToast: (id: number) => void

  updateModel: (label: string, fn: (m: DatasetModel) => DatasetModel) => Promise<void>
  setColumnType: (key: string, type: ColType | null) => Promise<void>
  renameColumn: (key: string, name: string) => Promise<void>
  setColumnFormat: (key: string, format: ColumnFormat | undefined) => Promise<void>
  openFormula: (key?: string, mode?: 'column' | 'measure') => void
  closeFormula: () => void
  saveComputed: (def: Omit<ComputedDef, 'key'> & { key?: string }) => Promise<string | undefined>
  deleteComputed: (key: string) => Promise<void>
  saveMeasure: (def: Omit<MeasureDef, 'key'> & { key?: string }) => Promise<string | undefined>
  deleteMeasure: (key: string) => Promise<void>
  addPrep: (step: PrepStep) => Promise<void>
  updatePrep: (id: string, step: PrepStep) => Promise<void>
  removePrep: (id: string) => Promise<void>
  movePrep: (id: string, dir: -1 | 1) => Promise<void>

  edit: (id: string | null) => void
  setFullscreen: (id: string | null) => void
  showRows: (v: State['rowsView']) => void
  setGallery: (open: boolean) => void
  setPalette: (open: boolean) => void
  setPrinting: (on: boolean) => void
  mutateDash: (label: string, fn: (d: Dashboard) => Dashboard) => void
  mutatePage: (label: string, fn: (p: Page) => Page) => void
  addWidget: (w: Widget) => void
  updateWidget: (id: string, patch: Partial<Widget>) => void
  removeWidget: (id: string) => void
  duplicateWidget: (id: string) => void
  moveWidget: (from: string, to: string) => void
  resetDashboard: () => void
  setFilters: (f: Filter[]) => void
  saveView: (name: string) => void
  applyView: (id: string) => void
  updateView: (id: string) => void
  removeView: (id: string) => void
  addPage: (name?: string, widgets?: Widget[]) => void
  setPage: (id: string) => void
  renamePage: (id: string, name: string) => void
  duplicatePage: (id: string) => void
  removePage: (id: string) => void
  movePage: (id: string, dir: -1 | 1) => void
  setDashboard: (d: Dashboard) => void

  undo: () => void
  redo: () => void
}

const LAST_KEY = 'numero:last'
/** set while a dataset is being reopened at startup; still there on the next start means that attempt never finished */
const OPENING_KEY = 'numero:opening'
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* ignore */ } },
  del: (k: string) => { try { localStorage.removeItem(k) } catch { /* ignore */ } },
}

/** Clears the "reopen this dataset" pointer, so the next start lands on Home. Stored datasets are untouched. */
export function forgetLastOpen() {
  ls.del(LAST_KEY)
  ls.del(OPENING_KEY)
}
const toDataset = (l: Loaded): Dataset => ({ ...l.meta, columns: l.columns, rows: l.rows })
const clone = <T,>(v: T): T => structuredClone(v)

export const currentPage = (d: Dashboard | undefined): Page | undefined => d?.pages.find((p) => p.id === d.activePage) ?? d?.pages[0]

export function newDashboard(ds: Dataset): Dashboard {
  const page: Page = { id: uid('p'), name: 'Overview', widgets: suggest(ds).widgets, filters: [] }
  return { datasetId: ds.id, pages: [page], activePage: page.id }
}

export const useStore = create<State>((set, get) => {
  let rebuildSeq = 0
  /** bumped by every import start and cancel: a result that arrives under an older number is dropped */
  let importSeq = 0
  let download: AbortController | null = null
  const refreshing = new Set<string>()
  let toastSeq = 0
  let saveWarned = false

  /**
   * Saves the dashboards that changed, one record per dataset, and tells other tabs.
   * The screen is updated first; when the write fails the user is told the latest edits are not stored.
   */
  const persist = (dashboards: Record<string, Dashboard>) => {
    const before = get().dashboards
    const changed = Object.keys(dashboards).filter((id) => dashboards[id] !== before[id])
    const removed = Object.keys(before).filter((id) => !(id in dashboards))
    void (async () => {
      try {
        for (const id of changed) { await putDashboard(dashboards[id]); tell({ type: 'dash', id }) }
        for (const id of removed) { await deleteDashboard(id); tell({ type: 'dash', id }) }
        saveWarned = false
      } catch {
        if (saveWarned) return
        saveWarned = true
        const ds = get().active
        const dash = ds ? get().dashboards[ds.id] : undefined
        get().notify('error', 'Your latest dashboard edits could not be saved — browser storage may be full. They are on screen but will be lost on reload.', ds && dash
          ? { label: 'Export dashboard', run: () => downloadText(`${ds.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'dashboard'}.numero.json`, JSON.stringify(exportDashboard(ds, dash), null, 2), 'application/json') }
          : undefined)
      }
    })()
    return dashboards
  }

  const fail = (e: unknown) => {
    set({ progress: null, updating: false })
    // a cancelled read or download is the user's own doing: nothing to report
    if (e instanceof Error && (e.name === 'ImportCancelled' || (e instanceof FetchError && (e.kind === 'cancelled' || e.kind === 'declined')))) return
    get().notify('error', e instanceof Error ? e.message : String(e))
  }

  /** The next file of a multi-file drop, once the current one is imported or dismissed. */
  const nextQueued = () => {
    const [next, ...rest] = get().queue
    if (!next) return
    set({ queue: rest })
    void get().startImport(next)
  }

  const setRefresh = (id: string, ev: Parameters<typeof nextStatus>[1]) => set((s) => ({ refresh: { ...s.refresh, [id]: nextStatus(s.refresh[id], ev) } }))

  channel?.addEventListener('message', (ev: MessageEvent<TabMessage>) => {
    const m = ev.data
    if (!m || m.from === TAB_ID) return
    if (m.type === 'dash') {
      // another tab saved (or removed) this dashboard: show its version here
      void getDashboard(m.id).then((d) => set((s) => {
        const { [m.id]: _, ...rest } = s.dashboards
        return { dashboards: d ? { ...rest, [m.id]: d } : rest }
      })).catch(() => {})
    } else if (m.type === 'metas') {
      void Promise.all([engine('list', {}), engine('listTrash', {})]).then(([metas, trash]) => set((s) => ({
        metas: metas.sort((a, b) => b.createdAt - a.createdAt), trash,
        // a dataset removed in the other tab closes here too
        active: s.active && !metas.some((x) => x.id === s.active!.id) ? null : s.active,
      }))).catch(() => {})
    } else if (m.type === 'open' && get().active?.id === m.id) {
      tell({ type: 'also-open', id: m.id })
      set({ alsoOpen: true })
    } else if (m.type === 'also-open' && get().active?.id === m.id) set({ alsoOpen: true })
  })

  const onProgress = (fraction: number, label: string) => set({ progress: { fraction, label } })

  const applyLoaded = (l: Loaded) => {
    const ds = toDataset(l)
    set((s) => ({
      active: s.active?.id === ds.id ? ds : s.active,
      metas: s.metas.some((m) => m.id === ds.id) ? s.metas.map((m) => (m.id === ds.id ? l.meta : m)) : [l.meta, ...s.metas],
      prep: { headers: l.prepHeaders, reports: l.reports },
    }))
    return ds
  }

  /** A linked file that changed since the last update: offer to load it (a toast; nothing happens without a click). */
  const offerLinkedUpdate = async (ds: Dataset) => {
    const file = await linkedChanged(ds.id, ds.source.lastLoaded ?? ds.createdAt)
    if (!file || get().active?.id !== ds.id || get().pendingUpdate) return
    get().notify('info', `${file.name} changed since the last update`, { label: 'Update now', run: () => { get().openUpdate(); void get().previewUpdate(file) } })
  }

  /** Builds the "What changed" summary, shows it and keeps it with the update in the history. */
  const recordChanges = async (before: Dataset, after: Dataset, fileName: string) => {
    try {
      // the page being looked at first: its KPIs lead the report
      const dash = get().dashboards[after.id]
      const active = currentPage(dash)
      const pages = dash ? [...(active ? [active] : []), ...dash.pages.filter((p) => p !== active)] : []
      const report = whatChanged(before, after, pages, fileName)
      set({ changes: { ...report, datasetId: after.id } })
      const [first, ...rest] = after.source.updates ?? []
      if (!first) return
      const meta = await engine('updateMeta', { id: after.id, patch: { source: { ...after.source, updates: [{ ...first, changes: report }, ...rest] } } })
      set((s) => ({ metas: s.metas.map((m) => (m.id === meta.id ? meta : m)), active: s.active?.id === meta.id ? { ...s.active, source: meta.source } : s.active }))
    } catch {
      // the summary is a nicety: the update itself already succeeded
    }
  }

  const snapshot = (id: string): Snapshot => ({ dash: clone(get().dashboards[id]), model: clone(get().active!.model) })

  /** Records the state before a change; rapid edits with the same label collapse into one undo step. */
  const remember = (label: string) => {
    const id = get().active?.id
    if (!id) return
    const h = get().history[id] ?? { past: [], future: [] }
    const now = Date.now()
    if (h.lastLabel === label && now - (h.lastAt ?? 0) < 1000) {
      set({ history: { ...get().history, [id]: { ...h, lastAt: now } } })
      return
    }
    const past = [...h.past, snapshot(id)].slice(-100)
    set({ history: { ...get().history, [id]: { past, future: [], lastLabel: label, lastAt: now } } })
  }

  /** Records a data update in the undo history (⌘Z restores the version it replaced). */
  const rememberData = (id: string) => {
    const h = get().history[id] ?? { past: [], future: [] }
    set({ history: { ...get().history, [id]: { past: [...h.past, { data: true } as DataStep].slice(-100), future: [] } } })
  }

  const rebuild = async (id: string, model: DatasetModel) => {
    const seq = ++rebuildSeq
    set({ updating: true })
    try {
      const l = await engine('rebuild', { id, model })
      if (seq !== rebuildSeq) return
      applyLoaded(l)
      set({ updating: false })
    } catch (e) {
      if (seq === rebuildSeq) fail(e)
    }
  }

  const restore = (snap: Snapshot) => {
    const ds = get().active
    if (!ds) return
    if (snap.dash) set({ dashboards: persist({ ...get().dashboards, [ds.id]: snap.dash }) })
    if (JSON.stringify(snap.model) !== JSON.stringify(ds.model)) {
      set({ active: { ...ds, model: snap.model } })
      void rebuild(ds.id, snap.model)
    }
  }

  /** Adds a sample's showcase: prep steps, computed columns and measures, then feature pages before "Overview". */
  const applyPreset = async (ds: Dataset, file: string) => {
    const preset = PRESETS[file]
    const patch = preset.model?.({ idOf: (f) => get().metas.find((m) => m.fileName === f && m.id !== ds.id)?.id }) ?? {}
    let cur = ds
    if (Object.keys(patch).length) {
      set({ progress: { fraction: 0.8, label: 'Setting up the showcase' } })
      try {
        const model = { ...ds.model, ...patch }
        cur = applyLoaded(await engine('rebuild', { id: ds.id, model }))
      } catch (e) {
        return fail(e)
      }
    }
    const pages: Page[] = preset.pages(cur).map((pg) => ({ ...pg, id: uid('p') }))
    const overview: Page = { id: uid('p'), name: 'Overview', widgets: suggest(cur).widgets, filters: [] }
    const dash: Dashboard = { datasetId: cur.id, pages: [...pages, overview], activePage: pages[0]?.id ?? overview.id }
    // the showcase is the starting point, not an undoable edit
    const { [cur.id]: _, ...history } = get().history
    set({ dashboards: persist({ ...get().dashboards, [cur.id]: dash }), history, progress: null })
    const extras = [patch.prep?.length && 'prep steps', (patch.computed?.length || patch.measures?.length) && 'formulas'].filter(Boolean)
    get().notify('info', `Showcase ready: ${pages.map((pg) => `“${pg.name}”`).join(', ')} + Overview${extras.length ? ` · see the ${extras.join(' and ')} in Prepare and New column / measure` : ''}`)
  }

  const commitDataset = (ds: Dataset, view?: { tab?: Tab; page?: string }) => {
    let dashboards = get().dashboards[ds.id] ? get().dashboards : persist({ ...get().dashboards, [ds.id]: newDashboard(ds) })
    const d = dashboards[ds.id]
    if (view?.page && d.activePage !== view.page && d.pages.some((p) => p.id === view.page)) dashboards = { ...dashboards, [ds.id]: { ...d, activePage: view.page } }
    ls.set(LAST_KEY, ds.id)
    set({ dashboards, active: ds, tab: view?.tab ?? 'dashboard', editing: null, progress: null, alsoOpen: false })
    tell({ type: 'open', id: ds.id })
  }

  return {
    ready: false,
    metas: [],
    active: null,
    prep: { headers: [], reports: [] },
    tab: 'dashboard',
    dashboards: {},
    editing: null,
    pending: null,
    progress: null,
    updating: false,
    toasts: [],
    trash: [],
    queue: [],
    refresh: {},
    alsoOpen: false,
    safeStart: false,
    booted: false,
    crashTest: typeof location !== 'undefined' && location.hash === '#crash-test',
    formulaEditor: null,
    pendingUpdate: null,
    history: {},
    changes: null,
    fullscreen: null,
    rowsView: null,
    gallery: false,
    palette: false,
    printing: false,
    themePref: (() => {
      try { return (localStorage.getItem('numero:theme') as ThemePref) || 'system' } catch { return 'system' }
    })(),
    patterns: (() => {
      try { return localStorage.getItem('numero:patterns') === '1' } catch { return false }
    })(),

    init: async () => {
      // read before anything can rewrite the address
      const route = typeof location === 'undefined' ? parseRoute('') : parseRoute(location.hash)
      try {
        // dashboards kept by earlier versions in one localStorage value move into the database first
        await migrateLocalDashboards().catch(() => 0)
        const metas = (await engine('list', {})).sort((a, b) => b.createdAt - a.createdAt)
        const [dashboards, trash] = await Promise.all([listDashboards(), engine('listTrash', {})])
        set({ metas, dashboards, trash, ready: true })
        // a dataset named in the address (a bookmark, a reload) wins over "the one open last time"
        const wanted = route.dataset && metas.some((m) => m.id === route.dataset) ? route.dataset : null
        const last = wanted ?? ls.get(LAST_KEY)
        if (!last || !metas.some((m) => m.id === last)) return
        // the previous start never got this dataset on screen (a crash, a tab killed for memory): don't try again unasked
        if (ls.get(OPENING_KEY) === last) {
          forgetLastOpen()
          set({ safeStart: true })
          const name = metas.find((m) => m.id === last)?.name ?? 'the last dataset'
          get().notify('info', `“${name}” was not reopened because it did not finish opening last time. Nothing was deleted.`, { label: 'Open it', run: () => void get().open(last) })
          return
        }
        ls.set(OPENING_KEY, last)
        await get().open(last, wanted ? { tab: route.tab, page: route.page } : undefined)
      } catch (e) {
        set({ ready: true })
        fail(e)
      } finally {
        set({ booted: true })
      }
    },

    startImports: async (files) => {
      if (!files.length) return
      if (files.length === 1) return get().startImport(files[0])
      // files with the same columns (monthly exports) can become one dataset
      const { sameColumns } = await import('./lib/multi')
      if (await sameColumns(files)) {
        const combine = await ask({
          title: `Combine ${files.length} files into one dataset?`,
          body: `${files.map((f) => f.name).join(', ')} have the same columns. Combined, their rows are stacked in one dataset. Otherwise each file is imported by itself, one after another.`,
          confirmLabel: 'Combine', cancelLabel: 'Import separately',
        })
        if (combine) return get().startImport(files[0], { kind: 'file' }, { more: files.slice(1) })
      }
      set({ queue: files.slice(1) })
      get().notify('info', `${files.length} files: importing ${files[0].name} first, then ${files.length === 2 ? files[1].name : `the other ${files.length - 1}`} one after another.`)
      await get().startImport(files[0])
    },

    startImport: async (file, source = { kind: 'file' }, opts = {}) => {
      const seq = ++importSeq
      const options: ImportOptions = {}
      // a very large file: offer a first look at part of it before reading everything
      if (source.kind === 'file' && !opts.skipPreview && file.size > LARGE_FILE_BYTES && !/\.(xlsx?|xlsm|xlsb|ods|json)$/i.test(file.name)) {
        const limited = await ask({
          title: `${file.name} is ${fmtBytes(file.size)}`,
          body: 'Reading all of it takes a while and a lot of memory. You can look at the first 1,000,000 rows first — the rest of the file is not read — and switch to all rows in the preview.',
          confirmLabel: 'First 1,000,000 rows', cancelLabel: 'Read the whole file',
        })
        if (seq !== importSeq) return
        if (limited) options.rowLimit = 1_000_000
      }
      const cancel = () => { importSeq++; set({ progress: null }); void engine('cancel', {}).catch(() => {}); nextQueued() }
      const onReadProgress = (fraction: number, label: string) => { if (seq === importSeq) set({ progress: { fraction, label, cancel } }) }
      set({ progress: { fraction: 0, label: `Reading ${file.name}`, cancel } })
      try {
        const preview = await engine('preview', { file, options, more: opts.more }, onReadProgress)
        // cancelled, or another import started meanwhile: this preview must not appear
        if (seq !== importSeq) return
        // a decimal comma the file is clear about (semicolon-delimited, values like 12,5) is applied without asking
        if (preview.detected.decimal?.preselect) options.decimal = ','
        set({ progress: null, pending: { preview, file, source, options, sample: opts.sample, more: opts.more } })
        if (opts.skipPreview && preview.sheets.length === 1) {
          await get().commitImport({ sheet: preview.sheets[0].name, name: opts.name ?? file.name.replace(/\.[^.]+$/, '') })
        }
      } catch (e) {
        if (seq !== importSeq) return
        fail(e)
        nextQueued()
      }
    },

    reparse: async (options) => {
      const p = get().pending
      if (!p) return
      set({ pending: { ...p, busy: true, options } })
      const seq = importSeq
      try {
        const preview = await engine('preview', { file: p.file, options, more: p.more })
        if (seq !== importSeq || !get().pending) return
        set({ pending: { ...p, preview, options, busy: false } })
      } catch (e) {
        if (seq !== importSeq || !get().pending) return
        set({ pending: { ...p, busy: false } })
        get().notify('error', e instanceof Error ? e.message : String(e))
      }
    },

    commitImport: async ({ sheet, name, overrides, prep }) => {
      const p = get().pending
      // one commit per preview: double-clicks or repeated presses must not start parallel imports
      if (!p || p.busy) return
      set({ pending: { ...p, busy: true } })
      const model: DatasetModel = { ...emptyModel(), options: { ...p.options, sheet }, overrides: overrides ?? {}, prep: prep ?? [] }
      set({ progress: { fraction: 0.5, label: 'Analyzing columns' } })
      try {
        const l = await engine('commit', { token: p.preview.token, sheet, name, source: p.source, model }, onProgress)
        set({ pending: null })
        const ds = applyLoaded(l)
        commitDataset(ds)
        if (p.sample && PRESETS[p.sample]) await applyPreset(ds, p.sample)
        // shown last so it isn't replaced by the showcase message
        const s = p.preview.sheets.find((x) => x.name === sheet)
        if (s?.truncated) get().notify('info', `Imported the first ${ds.rows.length.toLocaleString()} rows (row limit).`)
        tell({ type: 'metas' })
        // the user's own data is now stored here: ask the browser to keep it (asked once, never on first page load)
        if (p.source.kind !== 'sample') void requestPersistenceOnce().catch(() => {})
        nextQueued()
      } catch (e) {
        const cur = get().pending
        if (cur) set({ pending: { ...cur, busy: false } })
        fail(e)
      }
    },

    cancelImport: () => {
      importSeq++
      download?.abort()
      set({ pending: null, progress: null })
      // the parsed rows held for this preview are released, not kept until the next import
      void engine('cancel', {}).catch(() => {})
      nextQueued()
    },

    importUrl: async (url, opts = {}) => {
      const seq = ++importSeq
      download?.abort()
      const ctl = (download = new AbortController())
      const cancel = () => { importSeq++; ctl.abort(); set({ progress: null }) }
      set({ progress: { fraction: 0.02, label: 'Connecting', cancel, indeterminate: true } })
      try {
        const res = await fetchFile(url, {
          signal: ctl.signal,
          onProgress: (received, total) => {
            if (seq !== importSeq) return
            set({ progress: total ? { fraction: received / total, label: `Downloading · ${fmtBytes(received)} of ${fmtBytes(total)}`, cancel } : { fraction: 0.5, label: `Downloading · ${fmtBytes(received)}`, cancel, indeterminate: true } })
          },
          confirmLarge: (bytes) => ask({ title: `This download is ${fmtBytes(bytes)}`, body: 'It will be held in memory while it is read. Continue?', confirmLabel: 'Download', cancelLabel: 'Cancel' }),
        })
        // cancelled while the last bytes arrived: no preview
        if (seq !== importSeq) return
        const name = fileNameFromUrl(url, res.contentType)
        await get().startImport(new File([res.blob], name), { kind: 'url', url, refreshMinutes: opts.refreshMinutes })
      } catch (e) {
        if (seq !== importSeq) return
        fail(e)
      } finally {
        if (download === ctl) download = null
      }
    },

    importText: async (text, name = 'Pasted data') => {
      const looksJson = /^\s*[[{]/.test(text)
      await get().startImport(new File([text], `${name}.${looksJson ? 'json' : text.includes('\t') ? 'tsv' : 'csv'}`), { kind: 'paste' })
    },

    open: async (id, view) => {
      if (!id) { set({ active: null, editing: null, alsoOpen: false }); ls.del(LAST_KEY); return }
      if (get().active?.id === id) {
        const d = get().dashboards[id]
        set({ tab: view?.tab ?? 'dashboard', editing: null, ...(view?.page && d?.pages.some((p) => p.id === view.page) && d.activePage !== view.page ? { dashboards: { ...get().dashboards, [id]: { ...d, activePage: view.page } } } : {}) })
        return
      }
      set({ progress: { fraction: 0.05, label: 'Loading dataset' }, editing: null })
      try {
        const l = await engine('load', { id }, onProgress)
        const ds = toDataset(l)
        set({ prep: { headers: l.prepHeaders, reports: l.reports }, metas: get().metas.map((m) => (m.id === id ? l.meta : m)) })
        commitDataset(ds, view)
        void offerLinkedUpdate(ds)
        // on screen without a crash: the startup guard can stand down (after the first paint, where render errors would show)
        setTimeout(() => { if (ls.get(OPENING_KEY) === id) ls.del(OPENING_KEY) }, 1500)
      } catch (e) {
        ls.del(OPENING_KEY)
        fail(e)
      }
    },

    remove: async (id) => {
      const meta = get().metas.find((m) => m.id === id)
      if (!meta) return
      // work built on the dataset goes with it: say what, and ask
      const dash = get().dashboards[id]
      if (needsConfirm(meta, dash)) {
        const stake = workAtStake(meta, dash)
        const ok = await ask({
          title: `Remove “${meta.name}”?`,
          body: `${stake.length ? `It has ${stake.join(', ')}. ` : ''}You can restore it from “Recently removed” on Home for 7 days; after that it is erased.`,
          confirmLabel: 'Remove', danger: true,
        })
        if (!ok) return
      }
      let trashed: DatasetMeta | null
      try {
        trashed = await engine('delete', { id })
      } catch (e) {
        return fail(e)
      }
      set((s) => ({
        metas: s.metas.filter((m) => m.id !== id),
        trash: trashed ? [trashed, ...s.trash.filter((m) => m.id !== id)] : s.trash,
        active: s.active?.id === id ? null : s.active,
      }))
      if (ls.get(LAST_KEY) === id) ls.del(LAST_KEY)
      tell({ type: 'metas' })
      get().notify('info', `Removed “${meta.name}” — it can be restored from Home for 7 days`, { label: 'Undo', run: () => void get().restoreRemoved(id) })
    },

    restoreRemoved: async (id) => {
      try {
        const m = await engine('undelete', { id })
        if (!m) { get().notify('error', 'That dataset is no longer available to restore.'); set((s) => ({ trash: s.trash.filter((x) => x.id !== id) })); return }
        // the dashboard and saved versions never left storage, so they are back with it
        const dash = get().dashboards[id] ?? await getDashboard(id).catch(() => undefined)
        set((s) => ({
          metas: [m, ...s.metas.filter((x) => x.id !== id)].sort((a, b) => b.createdAt - a.createdAt),
          trash: s.trash.filter((x) => x.id !== id),
          dashboards: dash ? { ...s.dashboards, [id]: dash } : s.dashboards,
        }))
        tell({ type: 'metas' })
        get().notify('info', `Restored “${m.name}”`, { label: 'Open', run: () => void get().open(id) })
      } catch (e) {
        fail(e)
      }
    },

    purgeRemoved: async (id) => {
      try {
        await engine('purge', id ? { id } : {})
        const gone = new Set(id ? [id] : get().trash.map((m) => m.id))
        set((s) => ({ trash: s.trash.filter((m) => !gone.has(m.id)), dashboards: Object.fromEntries(Object.entries(s.dashboards).filter(([k]) => !gone.has(k))) }))
        tell({ type: 'metas' })
      } catch (e) {
        fail(e)
      }
    },

    renameDataset: async (id, name) => {
      if (!name.trim()) return
      const meta = await engine('updateMeta', { id, patch: { name: name.trim() } })
      set((s) => ({ metas: s.metas.map((m) => (m.id === id ? meta : m)), active: s.active?.id === id ? { ...s.active, name: meta.name } : s.active }))
    },

    refreshSource: async (id, opts = {}) => {
      const ds = id ? get().metas.find((m) => m.id === id) : get().active
      if (!ds?.source.url) return
      const scheduled = !!opts.scheduled
      const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false
      // a scheduled tick waits out its back-off, a paused source and a missing connection; a click always tries
      if (scheduled && !dueNow(get().refresh[ds.id], Date.now(), online)) {
        if (!online) setRefresh(ds.id, { type: 'failed', at: Date.now(), kind: 'offline', message: '' })
        return
      }
      // one refresh per dataset at a time: a slow download must not be joined by the next tick
      if (refreshing.has(ds.id)) return
      refreshing.add(ds.id)
      set({ updating: true })
      try {
        const res = await fetchFile(ds.source.url, { cache: 'no-store' })
        const file = new File([res.blob], ds.fileName)
        const l = await engine('replaceSource', { id: ds.id, file, force: opts.force })
        const now = Date.now()
        set({ updating: false })
        if (l.outcome === 'unchanged') {
          set((s) => ({ metas: s.metas.map((m) => (m.id === ds.id ? l.meta : m)), active: s.active?.id === ds.id ? { ...s.active, source: l.meta.source } : s.active }))
          setRefresh(ds.id, { type: 'unchanged', at: now })
          if (!scheduled) get().notify('info', `Checked “${ds.name}” — no change since the last refresh`)
          return
        }
        if (l.outcome === 'blocked') {
          setRefresh(ds.id, { type: 'blocked', at: now, missing: l.check.missing })
          // which of the missing columns charts rely on
          const dash = get().dashboards[ds.id]
          const used = new Set(dash?.pages.flatMap((p) => p.widgets.flatMap(widgetColumns)) ?? [])
          const inUse = l.check.missing.filter((c) => used.has(c))
          if (scheduled) return
          const ok = await ask({
            title: `The source no longer has ${l.check.missing.length === 1 ? `“${l.check.missing[0]}”` : `${l.check.missing.length} columns`}`,
            body: `Missing: ${l.check.missing.join(', ')}.${l.check.added.length ? ` New: ${l.check.added.join(', ')}.` : ''} ${inUse.length ? `Charts use ${inUse.join(', ')} — they will show a missing-column notice until you edit them.` : 'No chart uses them.'} Nothing has been replaced yet.`,
            confirmLabel: 'Replace anyway', cancelLabel: 'Keep current data', danger: inUse.length > 0,
          })
          if (ok) { refreshing.delete(ds.id); await get().refreshSource(ds.id, { force: true }) }
          return
        }
        applyLoaded(l)
        setRefresh(ds.id, { type: 'replaced', at: now })
        if (get().active?.id === ds.id) rememberData(ds.id)
        get().notify('info', `Refreshed “${ds.name}” · ${l.rows.length.toLocaleString()} rows`, { label: 'Undo', run: () => void get().restoreVersion() })
      } catch (e) {
        set({ progress: null, updating: false })
        const kind = e instanceof FetchError ? e.kind : 'error'
        const message = e instanceof Error ? e.message : String(e)
        setRefresh(ds.id, { type: 'failed', at: Date.now(), kind, message, intervalMinutes: ds.source.refreshMinutes })
        // a click gets an answer; a schedule gets the status in the header, not a message per attempt
        if (!scheduled) get().notify(kind === 'offline' ? 'info' : 'error', kind === 'offline' ? 'You are offline — the data on screen is unchanged. Refresh again when the connection is back.' : `Refresh failed. ${message}`)
      } finally {
        refreshing.delete(ds.id)
      }
    },

    setRefresh: async (minutes) => {
      const ds = get().active
      if (!ds) return
      const meta = await engine('updateMeta', { id: ds.id, patch: { source: { ...ds.source, refreshMinutes: minutes } } })
      set((s) => ({ metas: s.metas.map((m) => (m.id === ds.id ? meta : m)), active: s.active ? { ...s.active, source: meta.source } : null }))
    },

    openUpdate: () => set({ pendingUpdate: { open: true } }),
    cancelUpdate: () => {
      const had = get().pendingUpdate
      set({ pendingUpdate: null })
      // release the parsed file held for this update
      if (had?.preview || had?.busy) void engine('cancel', {}).catch(() => {})
    },

    previewUpdate: async (file, sheet) => {
      const ds = get().active
      if (!ds) return
      set({ pendingUpdate: { open: true, busy: true } })
      try {
        // the first date column that comes straight from the file (not a computed one)
        const dateColumn = ds.columns.find((c) => c.type === 'date' && c.formula == null)?.key
        const preview = await engine('updatePreview', { id: ds.id, file, sheet, dateColumn })
        set({ pendingUpdate: { open: true, preview, file } })
      } catch (e) {
        set({ pendingUpdate: { open: true } })
        get().notify('error', e instanceof Error ? e.message : String(e))
      }
    },

    commitUpdate: async ({ mode, mapping, dedupe, sync }) => {
      const ds = get().active
      const pu = get().pendingUpdate
      if (!ds || !pu?.preview || pu.busy) return
      set({ pendingUpdate: { ...pu, busy: true }, progress: { fraction: 0.2, label: mode === 'append' ? 'Appending new rows' : 'Replacing the data' } })
      try {
        const res = await engine('updateCommit', { id: ds.id, token: pu.preview.token, mode, mapping, dedupe, sync }, onProgress)
        const next = applyLoaded(res)
        set({ pendingUpdate: null, progress: null })
        rememberData(ds.id)
        void confirmLink(ds.id, pu.file)
        void recordChanges(ds, next, pu.preview.fileName)
        const extra = [res.updated && `updated ${res.updated.toLocaleString()}`, res.skipped && `skipped ${res.skipped.toLocaleString()} unchanged`, mode === 'append' && res.removed && `removed ${res.removed.toLocaleString()} no longer listed`].filter(Boolean).join(', ')
        const text = mode === 'append'
          ? `Added ${res.added.toLocaleString()} rows${extra ? ` (${extra})` : ''} · ${res.rows.length.toLocaleString()} rows now`
          : `Replaced ${res.removed.toLocaleString()} rows with ${res.added.toLocaleString()} from ${pu.preview.fileName}`
        get().notify('info', text, { label: 'Undo', run: () => void get().restoreVersion() })
      } catch (e) {
        set({ pendingUpdate: { ...pu, busy: false } })
        fail(e)
      }
    },

    restoreVersion: async (key, via) => {
      const ds = get().active
      if (!ds) return
      set({ progress: { fraction: 0.3, label: 'Restoring an earlier version' } })
      try {
        const l = await engine('restoreVersion', { id: ds.id, key }, onProgress)
        applyLoaded(l)
        // the "What changed" card described the data that was just replaced
        set((st) => ({ progress: null, changes: st.changes?.datasetId === ds.id ? null : st.changes }))
        // a restore picked by hand is itself undoable; undo/redo manage their own history entries
        if (!via) rememberData(ds.id)
        const what = l.restored.label.replace(/^Before/, 'from before')
        // the replaced data is now the newest version, so restoring the newest again is a redo
        get().notify('info', `Restored the data ${what} · ${l.rows.length.toLocaleString()} rows`, { label: 'Redo', run: () => void get().restoreVersion() })
      } catch (e) {
        fail(e)
      }
    },

    deleteVersions: async (id, key) => {
      try {
        const meta = key ? await engine('deleteVersion', { id, key }) : await engine('clearVersions', { id })
        set((st) => ({ metas: st.metas.map((x) => (x.id === id ? meta : x)), active: st.active?.id === id ? { ...st.active, source: meta.source } : st.active }))
      } catch (e) {
        fail(e)
      }
    },

    showChanges: (r) => {
      const ds = get().active
      set({ changes: r && ds ? { ...r, datasetId: ds.id } : null })
    },

    setTab: (tab) => set({ tab, editing: null }),
    setTheme: (themePref) => {
      try { localStorage.setItem('numero:theme', themePref) } catch { /* ignore */ }
      set({ themePref })
    },
    setPatterns: (patterns) => {
      try { localStorage.setItem('numero:patterns', patterns ? '1' : '0') } catch { /* ignore */ }
      set({ patterns })
    },
    notify: (kind, text, action) => {
      const id = ++toastSeq
      // the same message again replaces its earlier copy; other messages stay, so an Undo is not pushed off screen
      set((s) => ({ toasts: [...s.toasts.filter((t) => t.text !== text), { id, kind, text, action }].slice(-4) }))
      setTimeout(() => get().dismissToast(id), action ? 12_000 : kind === 'error' ? 8000 : 5000)
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    // ---------- model edits (rebuild in the engine) ----------

    updateModel: async (label, fn) => {
      const ds = get().active
      if (!ds) return
      remember(label)
      const next = fn(clone(ds.model))
      set({ active: { ...ds, model: next } })
      await rebuild(ds.id, next)
    },

    setColumnType: (key, type) => get().updateModel('type', (m) => {
      const overrides = { ...m.overrides }
      if (type) overrides[key] = type
      else delete overrides[key]
      return { ...m, overrides }
    }),

    renameColumn: async (key, name) => {
      const ds = get().active
      const col = ds?.columns.find((c) => c.key === key)
      if (!ds || !col || !name.trim() || name.trim() === col.name) return
      await get().updateModel('rename', (m) => {
        const n = name.trim()
        // formulas refer to columns by [Name], so rewrite them to keep working
        // bare references by key keep working (keys never change), so only names are rewritten
        const computed = renameRefs(m.computed, col.name, n, col.key).map((d) => (d.key === key ? { ...d, name: n } : d))
        const measures = renameRefs(m.measures as ComputedDef[], col.name, n, col.key) as MeasureDef[]
        return { ...m, names: col.formula == null ? { ...m.names, [key]: n } : m.names, computed, measures }
      })
    },

    setColumnFormat: (key, format) => get().updateModel(`format:${key}`, (m) => {
      const formats = { ...m.formats }
      if (format && Object.values(format).some((v) => v !== undefined && v !== '')) formats[key] = format
      else delete formats[key]
      return { ...m, formats }
    }),

    openFormula: (key, mode = 'column') => set({ formulaEditor: { key, mode } }),
    closeFormula: () => set({ formulaEditor: null }),

    saveComputed: async (input) => {
      const ds = get().active
      if (!ds) return
      const name = input.name.trim()
      let key = input.key
      await get().updateModel('computed', (m) => {
        const defs = [...m.computed]
        const i = key ? defs.findIndex((d) => d.key === key) : -1
        if (i >= 0) {
          const old = defs[i]
          defs[i] = { key: old.key, name, formula: input.formula, format: input.format }
          const renamed = old.name !== name ? renameRefs(defs, old.name, name).map((d) => (d.key === old.key ? defs[i] : d)) : defs
          return { ...m, computed: renamed, measures: old.name !== name ? renameRefs(m.measures as ComputedDef[], old.name, name) as MeasureDef[] : m.measures }
        }
        key = uniqueKey(name, new Set(ds.columns.map((c) => c.key)))
        return { ...m, computed: [...defs, { key, name, formula: input.formula, format: input.format }] }
      })
      return key
    },

    deleteComputed: (key) => get().updateModel('computed', (m) => ({ ...m, computed: m.computed.filter((d) => d.key !== key) })),

    saveMeasure: async (input) => {
      const ds = get().active
      if (!ds) return
      let key = input.key
      await get().updateModel('measure', (m) => {
        const defs = [...m.measures]
        const i = key ? defs.findIndex((d) => d.key === key) : -1
        const def = { key: key ?? '', name: input.name.trim(), formula: input.formula, format: input.format }
        if (i >= 0) { defs[i] = def; return { ...m, measures: defs } }
        key = uniqueKey(input.name, new Set(defs.map((d) => d.key))).replace(/^calc_/, 'm_')
        return { ...m, measures: [...defs, { ...def, key }] }
      })
      return key
    },

    deleteMeasure: (key) => get().updateModel('measure', (m) => ({ ...m, measures: m.measures.filter((d) => d.key !== key) })),

    addPrep: (step) => get().updateModel('prep', (m) => ({ ...m, prep: [...m.prep, step] })),
    updatePrep: (id, step) => get().updateModel(`prep:${id}`, (m) => ({ ...m, prep: m.prep.map((s) => (s.id === id ? step : s)) })),
    removePrep: (id) => get().updateModel('prep', (m) => ({ ...m, prep: m.prep.filter((s) => s.id !== id) })),
    movePrep: (id, dir) => get().updateModel('prep', (m) => {
      const prep = [...m.prep]
      const i = prep.findIndex((s) => s.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prep.length) return m
      ;[prep[i], prep[j]] = [prep[j], prep[i]]
      return { ...m, prep }
    }),

    // ---------- dashboards ----------

    edit: (editing) => set({ editing }),
    setFullscreen: (fullscreen) => set({ fullscreen }),
    showRows: (rowsView) => set({ rowsView }),
    setGallery: (gallery) => set({ gallery }),
    setPalette: (palette) => set({ palette }),
    setPrinting: (printing) => set({ printing, editing: null }),

    mutateDash: (label, fn) => {
      const id = get().active?.id
      const dash = id ? get().dashboards[id] : undefined
      if (!id || !dash) return
      remember(label)
      set({ dashboards: persist({ ...get().dashboards, [id]: { ...fn(dash), edited: true } }) })
    },

    mutatePage: (label, fn) => get().mutateDash(label, (d) => {
      const page = currentPage(d)
      return page ? { ...d, pages: d.pages.map((p) => (p.id === page.id ? fn(p) : p)) } : d
    }),

    addWidget: (w) => {
      get().mutatePage('add', (p) => ({ ...p, widgets: [...p.widgets, w] }))
      set({ editing: w.id })
    },
    updateWidget: (id, patch) => get().mutatePage(`edit:${id}:${Object.keys(patch).join(',')}`, (p) => ({ ...p, widgets: p.widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)) })),
    removeWidget: (id) => {
      get().mutatePage('remove', (p) => ({ ...p, widgets: p.widgets.filter((w) => w.id !== id) }))
      if (get().editing === id) set({ editing: null })
    },
    duplicateWidget: (id) => get().mutatePage('duplicate', (p) => {
      const i = p.widgets.findIndex((w) => w.id === id)
      if (i < 0) return p
      const copy = { ...clone(p.widgets[i]), id: uid(), title: `${p.widgets[i].title} (copy)` }
      return { ...p, widgets: [...p.widgets.slice(0, i + 1), copy, ...p.widgets.slice(i + 1)] }
    }),
    moveWidget: (from, to) => get().mutatePage(`move:${from}`, (p) => {
      const ws = [...p.widgets]
      const a = ws.findIndex((w) => w.id === from)
      const b = ws.findIndex((w) => w.id === to)
      if (a < 0 || b < 0 || a === b) return p
      const [item] = ws.splice(a, 1)
      ws.splice(b, 0, item)
      return { ...p, widgets: ws }
    }),
    resetDashboard: () => {
      const ds = get().active
      if (!ds) return
      get().mutatePage('reset', (p) => ({ ...p, widgets: suggest(ds).widgets }))
      set({ editing: null })
    },
    setFilters: (filters) => get().mutatePage('filters', (p) => ({ ...p, filters })),
    // saved views keep copies of the page filters; cross-filter clicks are left out (they belong to the moment)
    saveView: (name) => get().mutatePage('view', (p) => ({ ...p, views: [...(p.views ?? []), { id: uid('v'), name: name.trim() || `View ${(p.views?.length ?? 0) + 1}`, filters: clone(p.filters.filter((f) => !f.fromWidget)) }] })),
    applyView: (id) => get().mutatePage('filters', (p) => {
      const v = p.views?.find((x) => x.id === id)
      return v ? { ...p, filters: v.filters.map((f) => ({ ...clone(f), id: uid('f') })) } : p
    }),
    updateView: (id) => get().mutatePage('view', (p) => ({ ...p, views: p.views?.map((v) => (v.id === id ? { ...v, filters: clone(p.filters.filter((f) => !f.fromWidget)) } : v)) })),
    removeView: (id) => get().mutatePage('view', (p) => ({ ...p, views: p.views?.filter((v) => v.id !== id) })),

    addPage: (name, widgets) => {
      const page: Page = { id: uid('p'), name: name ?? `Page ${(get().dashboards[get().active!.id]?.pages.length ?? 0) + 1}`, widgets: widgets ?? [], filters: [] }
      get().mutateDash('page', (d) => ({ ...d, pages: [...d.pages, page], activePage: page.id }))
      set({ editing: null })
    },
    setPage: (id) => {
      const ds = get().active
      if (!ds) return
      const d = get().dashboards[ds.id]
      set({ dashboards: persist({ ...get().dashboards, [ds.id]: { ...d, activePage: id } }), editing: null })
    },
    renamePage: (id, name) => get().mutateDash('page', (d) => ({ ...d, pages: d.pages.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)) })),
    duplicatePage: (id) => get().mutateDash('page', (d) => {
      const src = d.pages.find((p) => p.id === id)
      if (!src) return d
      const copy: Page = { ...clone(src), id: uid('p'), name: `${src.name} (copy)`, widgets: src.widgets.map((w) => ({ ...clone(w), id: uid() })) }
      const i = d.pages.indexOf(src)
      return { ...d, pages: [...d.pages.slice(0, i + 1), copy, ...d.pages.slice(i + 1)], activePage: copy.id }
    }),
    removePage: (id) => get().mutateDash('page', (d) => {
      if (d.pages.length <= 1) return d
      const pages = d.pages.filter((p) => p.id !== id)
      return { ...d, pages, activePage: d.activePage === id ? pages[0].id : d.activePage }
    }),
    movePage: (id, dir) => get().mutateDash('page', (d) => {
      const pages = [...d.pages]
      const i = pages.findIndex((p) => p.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= pages.length) return d
      ;[pages[i], pages[j]] = [pages[j], pages[i]]
      return { ...d, pages }
    }),
    setDashboard: (d) => get().mutateDash('import', () => d),

    // ---------- undo / redo ----------

    undo: () => {
      const id = get().active?.id
      const h = id ? get().history[id] : undefined
      if (!id || !h?.past.length) return
      const past = [...h.past]
      const step = past.pop()!
      // a data step swaps the data back; its redo is the same swap again
      set({ history: { ...get().history, [id]: { past, future: [...h.future, isData(step) ? step : snapshot(id)] } } })
      if (isData(step)) void get().restoreVersion(undefined, 'undo')
      else restore(step)
    },
    redo: () => {
      const id = get().active?.id
      const h = id ? get().history[id] : undefined
      if (!id || !h?.future.length) return
      const future = [...h.future]
      const step = future.pop()!
      set({ history: { ...get().history, [id]: { past: [...h.past, isData(step) ? step : snapshot(id)], future } } })
      if (isData(step)) void get().restoreVersion(undefined, 'redo')
      else restore(step)
    },
  }
})

function fileNameFromUrl(url: string, contentType: string | null): string {
  let name = 'download'
  try {
    const u = new URL(url)
    name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? u.hostname)
    // Google Sheets: /spreadsheets/d/<id>/export?format=csv
    if (u.searchParams.get('format') === 'csv' || u.searchParams.get('output') === 'csv') name = 'sheet.csv'
  } catch { /* keep default */ }
  if (!/\.(csv|tsv|txt|json|ndjson|jsonl|xlsx|xls|xlsm|xlsb|ods|gz)$/i.test(name)) {
    const ext = contentType?.includes('json') ? 'json' : contentType?.includes('spreadsheetml') ? 'xlsx' : contentType?.includes('ms-excel') ? 'xls' : 'csv'
    name = `${name}.${ext}`
  }
  return name
}

export const useActive = () => useStore((s) => s.active ?? undefined)
export const useDashboardFull = () => useStore((s) => (s.active ? s.dashboards[s.active.id] : undefined))
/** The active page of the active dataset's dashboard. */
export const useDashboard = () => useStore((s) => currentPage(s.active ? s.dashboards[s.active.id] : undefined))
export const useCanUndo = () => useStore((s) => !!(s.active && s.history[s.active.id]?.past.length))
export const useCanRedo = () => useStore((s) => !!(s.active && s.history[s.active.id]?.future.length))

// errors nobody is waiting for (a rejected promise without a handler, a script error) still reach the user and the diagnostics
if (typeof window !== 'undefined') {
  const report = (source: 'promise' | 'error', e: unknown) => {
    const entry = recordError(source, e)
    // a failed download of a lazy chunk or a cancelled request is not worth a message of its own
    if (/ImportCancelled|AbortError|ResizeObserver loop/.test(`${entry.name} ${entry.message}`)) return
    useStore.getState().notify('error', `Something went wrong: ${entry.message || entry.name}. Your data is not affected.`)
  }
  // an ordinary reload or close while a dataset is still opening is not a crash: only a tab that died (no pagehide)
  // or a rendering error leaves the "was opening" marker behind for the next start to find
  window.addEventListener('pagehide', () => { if (!recentErrors().some((e) => e.source === 'render')) ls.del(OPENING_KEY) })
  window.addEventListener('unhandledrejection', (ev) => { ev.preventDefault(); report('promise', ev.reason) })
  window.addEventListener('error', (ev) => { if (ev.error) report('error', ev.error) })
}
