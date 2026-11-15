import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  BarChart3, Command, Database, FilePlus2, FunctionSquare, Home as HomeIcon, LayoutDashboard, Moon, Monitor, Palette, Pencil, Plus,
  Printer, Redo2, RefreshCcw, Search, Shapes, Sun, Undo2,
} from 'lucide-react'
import { currentPage, useStore, type Tab } from '../store'
import { cx, useEscapeLayer } from './ui'

interface Item {
  id: string
  group: string
  label: string
  hint?: string
  /** extra words to match on */
  keywords?: string
  icon: ReactNode
  run: () => void
}

const TABS: [Tab, string][] = [['dashboard', 'Dashboard'], ['insights', 'Insights'], ['pivot', 'Pivot'], ['profile', 'Columns'], ['data', 'Data'], ['prepare', 'Prepare']]

/** Every word of the query must appear; matches at the start of the label rank first. */
function score(item: Item, q: string): number {
  if (!q) return 1
  const label = item.label.toLowerCase()
  const hay = `${label} ${item.group.toLowerCase()} ${item.keywords?.toLowerCase() ?? ''}`
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.every((w) => hay.includes(w))) return 0
  return (label.startsWith(words[0]) ? 3 : label.includes(words[0]) ? 2 : 1) - label.length / 1000
}

/** ⌘K / Ctrl+K: jump to datasets, tabs, pages and charts, or run common actions, from the keyboard. */
export function CommandPalette() {
  const s = useStore()
  const { setPalette } = s
  const close = () => setPalette(false)
  useEscapeLayer(true, close)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  // give focus back to whatever opened the palette (unless a command moved it on purpose);
  // read during the first render, before the search box takes focus
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(() => () => { if (!document.activeElement || document.activeElement === document.body) opener?.focus?.() }, [opener])

  const items = useMemo<Item[]>(() => {
    const ds = s.active
    const dash = ds ? s.dashboards[ds.id] : undefined
    const page = currentPage(dash)
    const go = (fn: () => void) => () => { close(); fn() }
    const out: Item[] = [
      { id: 'import', group: 'Actions', label: 'Import data…', keywords: 'open file upload csv excel json', icon: <FilePlus2 size={15} />, run: go(() => document.getElementById('import-file')?.click()) },
    ]
    if (ds) {
      out.push(
        { id: 'update', group: 'Actions', label: ds.source.kind === 'url' ? 'Refresh data' : 'Update data…', keywords: 'new month append replace reload', icon: <RefreshCcw size={15} />, run: go(() => (ds.source.kind === 'url' ? void s.refreshSource() : s.openUpdate())) },
        { id: 'chart', group: 'Actions', label: 'Add chart…', keywords: 'widget new visualization', icon: <Plus size={15} />, run: go(() => { s.setTab('dashboard'); s.setGallery(true) }) },
        { id: 'column', group: 'Actions', label: 'New computed column…', keywords: 'formula calculated field', icon: <FunctionSquare size={15} />, run: go(() => s.openFormula()) },
        { id: 'measure', group: 'Actions', label: 'New calculated measure…', keywords: 'formula ratio kpi', icon: <Shapes size={15} />, run: go(() => s.openFormula(undefined, 'measure')) },
        { id: 'page', group: 'Actions', label: 'Add page', keywords: 'dashboard tab', icon: <LayoutDashboard size={15} />, run: go(() => { s.setTab('dashboard'); s.addPage() }) },
        { id: 'report', group: 'Actions', label: 'Print report (all pages)…', keywords: 'pdf export print save report', icon: <Printer size={15} />, run: go(() => { s.setTab('dashboard'); s.setPrinting(true) }) },
        { id: 'undo', group: 'Actions', label: 'Undo', hint: '⌘Z', icon: <Undo2 size={15} />, run: go(s.undo) },
        { id: 'redo', group: 'Actions', label: 'Redo', hint: '⇧⌘Z', icon: <Redo2 size={15} />, run: go(s.redo) },
        ...TABS.map(([t, name]): Item => ({ id: `tab:${t}`, group: 'Go to', label: name, keywords: 'tab view', icon: <BarChart3 size={15} />, run: go(() => s.setTab(t)) })),
        ...(dash?.pages ?? []).map((p): Item => ({ id: `page:${p.id}`, group: 'Pages', label: p.name, hint: `${p.widgets.length} widget${p.widgets.length === 1 ? '' : 's'}`, keywords: 'page dashboard', icon: <LayoutDashboard size={15} />, run: go(() => { s.setTab('dashboard'); s.setPage(p.id) }) })),
        ...(page?.widgets ?? []).filter((w) => w.title).map((w): Item => ({
          id: `widget:${w.id}`, group: `Charts on “${page!.name}”`, label: w.title, keywords: `${w.type} widget chart edit`, icon: <Pencil size={14} />,
          // scroll to it and open the editor
          run: go(() => {
            s.setTab('dashboard')
            s.edit(w.id)
            requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-widget="${w.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
          }),
        })),
      )
    }
    out.push(
      { id: 'home', group: 'Go to', label: 'Home', keywords: 'samples start', icon: <HomeIcon size={15} />, run: go(() => void s.open(null)) },
      ...s.metas.filter((m) => m.id !== ds?.id).map((m): Item => ({ id: `ds:${m.id}`, group: 'Datasets', label: m.name, hint: `${m.rowCount.toLocaleString()} rows`, keywords: `dataset open ${m.fileName}`, icon: <Database size={15} />, run: go(() => void s.open(m.id)) })),
      { id: 'theme:light', group: 'Settings', label: 'Light theme', keywords: 'appearance', icon: <Sun size={15} />, run: go(() => s.setTheme('light')) },
      { id: 'theme:dark', group: 'Settings', label: 'Dark theme', keywords: 'appearance night', icon: <Moon size={15} />, run: go(() => s.setTheme('dark')) },
      { id: 'theme:system', group: 'Settings', label: 'System theme', keywords: 'appearance auto', icon: <Monitor size={15} />, run: go(() => s.setTheme('system')) },
      { id: 'patterns', group: 'Settings', label: s.patterns ? 'Turn pattern fills off' : 'Turn pattern fills on', keywords: 'color blind accessibility texture print', icon: <Palette size={15} />, run: go(() => s.setPatterns(!s.patterns)) },
    )
    return out
  }, [s.active, s.dashboards, s.metas, s.patterns])

  const results = useMemo(() => items.map((it) => ({ it, sc: score(it, q.trim()) })).filter((x) => x.sc > 0).sort((a, b) => (q.trim() ? b.sc - a.sc : 0)).map((x) => x.it).slice(0, 60), [items, q])
  const cur = Math.min(sel, Math.max(0, results.length - 1))
  const move = (d: number) => {
    const next = (cur + d + results.length) % Math.max(1, results.length)
    setSel(next)
    list.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  let lastGroup = ''
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/30 p-4 pt-[12vh] backdrop-blur-[2px]" onMouseDown={close}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="fade-up w-[600px] max-w-full overflow-hidden rounded-2xl border border-line bg-surface shadow-pop" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search size={16} className="shrink-0 text-ink-3" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[cur] ? `palette-${results[cur].id}` : undefined}
            aria-label="Search commands, pages, charts and datasets"
            placeholder="Search commands, pages, charts, datasets…"
            className="h-12 w-full bg-transparent text-[14px] outline-none placeholder:text-ink-3"
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
              else if (e.key === 'Enter') { e.preventDefault(); results[cur]?.run() }
            }}
          />
          <kbd className="shrink-0 rounded border border-line px-1.5 text-[11px] text-ink-3">Esc</kbd>
        </div>
        <ul id="palette-list" ref={list} role="listbox" aria-label="Results" className="max-h-[52vh] overflow-auto p-1.5">
          {results.map((it, i) => {
            const head = it.group !== lastGroup ? (lastGroup = it.group) : null
            return (
              <li key={it.id} role="presentation">
                {head && <div role="presentation" className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">{head}</div>}
                <div
                  id={`palette-${it.id}`}
                  role="option"
                  aria-selected={i === cur}
                  data-index={i}
                  onMouseMove={() => { if (i !== cur) setSel(i) }}
                  onClick={it.run}
                  className={cx('flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px]', i === cur ? 'bg-accent-soft text-accent-ink' : 'text-ink')}
                >
                  <span className={i === cur ? 'text-accent-ink' : 'text-ink-3'}>{it.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.hint && <span className="shrink-0 text-[12px] text-ink-3">{it.hint}</span>}
                </div>
              </li>
            )
          })}
          {!results.length && <li className="px-3 py-6 text-center text-[13px] text-ink-3">Nothing matches “{q}”.</li>}
        </ul>
        <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11.5px] text-ink-3">
          <span className="inline-flex items-center gap-1"><Command size={11} />K opens this anywhere</span>
          <span>↑↓ to move · Enter to run</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
