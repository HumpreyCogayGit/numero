// What went wrong, in a form that can be copied into a bug report.
// Never includes imported values: no rows, no cell contents, no column or dataset names — only counts and types.

export interface ErrorEntry { at: number; source: 'render' | 'promise' | 'error' | 'resource'; name: string; message: string; stack?: string }

export interface DiagnosticState {
  datasets: number
  active?: { rows: number; columns: number; types: Record<string, number>; format: string; sourceKind: string; prepSteps: number; computed: number; measures: number; pages: number; widgets: Record<string, number> }
  tab?: string
}

const MAX = 20
const log: ErrorEntry[] = []

export function recordError(source: ErrorEntry['source'], e: unknown): ErrorEntry {
  const err = e instanceof Error ? e : new Error(typeof e === 'string' ? e : (() => { try { return JSON.stringify(e) } catch { return String(e) } })())
  const entry: ErrorEntry = { at: Date.now(), source, name: err.name, message: err.message, stack: err.stack }
  log.push(entry)
  if (log.length > MAX) log.shift()
  return entry
}

export const recentErrors = (): ErrorEntry[] => [...log]
export const clearErrors = () => { log.length = 0 }

/** Text between quotes can be a value from the user's data (a category in a message): cut it out. */
export const redact = (s: string) => s.replace(/“[^”]*”|"[^"]*"|'[^']{2,}'/g, '“…”')

export function buildDiagnostics(state: DiagnosticState, extra: { error?: ErrorEntry; componentStack?: string; version?: string; userAgent?: string; url?: string; now?: number } = {}): string {
  const lines: string[] = []
  lines.push('Numero diagnostics')
  lines.push(`Time: ${new Date(extra.now ?? Date.now()).toISOString()}`)
  if (extra.version) lines.push(`Version: ${extra.version}`)
  if (extra.userAgent) lines.push(`Browser: ${extra.userAgent}`)
  // the path only: a hash or query could carry a dataset id
  if (extra.url) lines.push(`Page: ${extra.url.split(/[?#]/)[0]}`)
  lines.push('')
  lines.push(`Datasets stored: ${state.datasets}`)
  if (state.active) {
    const a = state.active
    const kv = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'
    lines.push(`Open dataset: ${a.rows.toLocaleString('en-US')} rows × ${a.columns} columns (${kv(a.types)}), ${a.format} from ${a.sourceKind}`)
    lines.push(`Prep steps: ${a.prepSteps}, computed columns: ${a.computed}, measures: ${a.measures}`)
    lines.push(`Dashboard: ${a.pages} page(s); widgets: ${kv(a.widgets)}`)
  } else lines.push('Open dataset: none')
  if (state.tab) lines.push(`View: ${state.tab}`)
  const errors = [...(extra.error ? [extra.error] : []), ...log.filter((e) => e !== extra.error)].slice(0, 5)
  lines.push('')
  lines.push(errors.length ? 'Errors (newest first):' : 'Errors: none recorded')
  for (const e of errors) {
    lines.push(`- [${e.source}] ${e.name}: ${redact(e.message)}`)
    if (e.stack) lines.push(...e.stack.split('\n').slice(1, 9).map((l) => `    ${redact(l.trim())}`))
  }
  if (extra.componentStack) {
    lines.push('')
    lines.push('Component stack:')
    lines.push(...extra.componentStack.trim().split('\n').slice(0, 12).map((l) => `    ${l.trim()}`))
  }
  lines.push('')
  lines.push('No imported values, column names or dataset names are included.')
  return lines.join('\n')
}
