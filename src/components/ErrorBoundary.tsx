import { Component, type ErrorInfo, type ReactNode } from 'react'
import { buildDiagnostics, recordError, type DiagnosticState, type ErrorEntry } from '../lib/diagnostics'
import { downloadText } from '../lib/download'
import { forgetLastOpen, useStore } from '../store'

/** Counts and types only — never names or values (see diagnostics.ts). */
export function diagnosticState(): DiagnosticState {
  try {
    const s = useStore.getState()
    const ds = s.active
    if (!ds) return { datasets: s.metas.length, tab: s.tab }
    const count = (xs: string[]) => xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {})
    const dash = s.dashboards[ds.id]
    return {
      datasets: s.metas.length, tab: s.tab,
      active: {
        rows: ds.rows.length, columns: ds.columns.length, types: count(ds.columns.map((c) => c.type)), format: ds.format, sourceKind: ds.source.kind,
        prepSteps: ds.model.prep.length, computed: ds.model.computed.length, measures: ds.model.measures.length,
        pages: dash?.pages.length ?? 0, widgets: count(dash?.pages.flatMap((p) => p.widgets.map((w) => w.type)) ?? []),
      },
    }
  } catch {
    return { datasets: 0 }
  }
}

export const diagnosticsText = (error?: ErrorEntry, componentStack?: string) =>
  buildDiagnostics(diagnosticState(), { error, componentStack, version: __APP_VERSION__, userAgent: navigator.userAgent, url: location.href })

interface Props { children: ReactNode }
interface State { entry: ErrorEntry | null; stack?: string; copied?: boolean }

/** Catches rendering errors anywhere below it and offers a way back, in place of a blank page. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { entry: null }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { entry: recordError('render', error) }
  }

  componentDidCatch(_: unknown, info: ErrorInfo) {
    this.setState({ stack: info.componentStack ?? undefined })
  }

  render() {
    const { entry, stack, copied } = this.state
    if (!entry) return this.props.children
    const text = () => diagnosticsText(entry, stack)
    const home = () => {
      // only the "reopen this dataset" pointer goes; everything stored stays
      forgetLastOpen()
      location.hash = ''
      location.reload()
    }
    const copy = async () => {
      try { await navigator.clipboard.writeText(text()); this.setState({ copied: true }) } catch { downloadText('numero-diagnostics.txt', text(), 'text/plain') }
    }
    return (
      <main className="flex min-h-full items-center justify-center bg-page p-6 text-ink">
        <div role="alert" className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6 shadow-pop">
          <h1 className="text-[18px] font-semibold tracking-tight">Something went wrong on this page</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
            Numero hit an error it could not recover from while drawing this view. <strong>Your stored datasets and dashboards have not been deleted</strong> — they are still in this browser.
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
            Reloading usually fixes it. If the same dataset fails again, return home without reopening it: it stays in your list.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button className="h-9 rounded-lg bg-accent-fill px-3.5 text-sm font-medium text-white hover:brightness-110" onClick={() => location.reload()}>Reload</button>
            <button className="h-9 rounded-lg border border-line px-3.5 text-sm font-medium hover:border-line-strong" onClick={home}>Return home without reopening</button>
          </div>
          <div className="mt-5 border-t border-line pt-4">
            <div className="text-[12px] font-medium text-ink-2">Details for a bug report</div>
            <p className="mt-1 break-words font-mono text-[12px] text-ink-3">{entry.name}: {entry.message}</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button className="h-8 rounded-lg border border-line px-3 text-[13px] hover:border-line-strong" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy diagnostics'}</button>
              <button className="h-8 rounded-lg border border-line px-3 text-[13px] hover:border-line-strong" onClick={() => downloadText('numero-diagnostics.txt', text(), 'text/plain')}>Download diagnostics</button>
            </div>
            <p className="mt-2 text-[11.5px] text-ink-3">Diagnostics list counts and types only — no values, column names or dataset names from your data.</p>
          </div>
        </div>
      </main>
    )
  }
}

/** Throws while rendering when the page was opened with #crash-test (used by the recovery tests). */
export function CrashProbe(): null {
  // after startup, so the recovery page is exercised with real state behind it
  const crash = useStore((s) => s.crashTest && s.booted)
  if (crash) throw new Error('Crash test: a child component threw while rendering')
  return null
}
