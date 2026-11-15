import type { Column, Dashboard, Dataset, DatasetModel, Filter, Measure, Page, Widget } from '../types'
import { fmtValue } from './format'
import { emptyModel } from './model'
import { uid } from './suggest'
import { sharedProvenance } from './provenance'

export const SHARE_VERSION = 1

export interface SharedDashboard {
  app: 'numero'
  version: number
  exportedAt: string
  dataset: { name: string; columns: { key: string; name: string; type: Column['type'] }[] }
  model: Omit<DatasetModel, 'options'> & { options?: DatasetModel['options'] }
  dashboard: Dashboard
  /** where the data behind the dashboard came from and how fresh it was (no file paths, no row values) */
  provenance?: ReturnType<typeof sharedProvenance>
}

/** Everything needed to rebuild a dashboard on the same — or a matching — dataset. */
export function exportDashboard(ds: Dataset, dash: Dashboard): SharedDashboard {
  return {
    app: 'numero',
    version: SHARE_VERSION,
    exportedAt: new Date().toISOString(),
    dataset: { name: ds.name, columns: ds.columns.map((c) => ({ key: c.key, name: c.name, type: c.type })) },
    model: ds.model,
    dashboard: dash,
    provenance: sharedProvenance(ds),
  }
}

export interface ImportPlan {
  dashboard: Dashboard
  model: DatasetModel
  /** columns the dashboard used that the target dataset doesn't have */
  unmatched: string[]
}

/** Maps a shared dashboard onto a dataset by column key, then by display name (case-insensitive). */
export function planImport(json: unknown, ds: Dataset): ImportPlan {
  const s = json as SharedDashboard
  if (!s || s.app !== 'numero' || !s.dashboard?.pages) throw new Error('This file is not a Numero dashboard export.')
  if (s.version > SHARE_VERSION) throw new Error('This dashboard was exported by a newer version of Numero.')
  const target = new Map(ds.columns.map((c) => [c.key, c]))
  const byName = new Map(ds.columns.map((c) => [c.name.toLowerCase(), c.key]))
  const computedKeys = new Set(s.model.computed.map((d) => d.key))
  const map = new Map<string, string>()
  const unmatched = new Set<string>()
  for (const c of s.dataset.columns) {
    if (target.has(c.key)) map.set(c.key, c.key)
    else if (byName.has(c.name.toLowerCase())) map.set(c.key, byName.get(c.name.toLowerCase())!)
    else if (!computedKeys.has(c.key)) unmatched.add(c.name)
  }
  for (const k of computedKeys) map.set(k, k)
  const key = (k?: string) => (k == null ? k : map.get(k) ?? k)
  const filter = (f: Filter): Filter => ({ ...f, column: key(f.column)! })
  const measure = (m: Measure): Measure => ({ ...m, column: key(m.column) })
  const widget = (w: Widget): Widget => ({
    ...w,
    id: uid(),
    dimension: key(w.dimension), series: key(w.series), x: key(w.x), y: key(w.y), color: key(w.color), sizeBy: key(w.sizeBy),
    facet: key(w.facet), drillTo: key(w.drillTo), entity: key(w.entity), drill: undefined,
    measures: w.measures.map(measure),
    filters: w.filters?.map(filter),
    tooltipFields: w.tooltipFields?.map((k) => key(k)!),
  })
  const pages: Page[] = s.dashboard.pages.map((p) => ({
    ...p, id: uid('p'), widgets: p.widgets.map(widget), filters: p.filters.map(filter),
    views: p.views?.map((v) => ({ ...v, filters: v.filters.map(filter) })),
  }))
  const remapRecord = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r ?? {}).flatMap(([k, v]) => (map.has(k) ? [[map.get(k)!, v]] : [])))
  const base = emptyModel()
  const model: DatasetModel = {
    ...base,
    ...ds.model,
    // keep the target's own import options and prep; bring over the analysis layer
    overrides: { ...ds.model.overrides, ...remapRecord(s.model.overrides) },
    names: { ...ds.model.names, ...remapRecord(s.model.names) },
    formats: { ...ds.model.formats, ...remapRecord(s.model.formats) },
    computed: mergeBy(ds.model.computed, s.model.computed ?? []),
    measures: mergeBy(ds.model.measures, s.model.measures ?? []),
    prep: ds.model.prep.length ? ds.model.prep : s.model.prep ?? [],
  }
  const activePage = pages[s.dashboard.pages.findIndex((p) => p.id === s.dashboard.activePage)]?.id ?? pages[0].id
  return { dashboard: { datasetId: ds.id, pages, activePage }, model, unmatched: [...unmatched] }
}

function mergeBy<T extends { key: string }>(mine: T[], theirs: T[]): T[] {
  const keys = new Set(mine.map((d) => d.key))
  return [...mine, ...theirs.filter((d) => !keys.has(d.key))]
}

// ---------- data export ----------

/** Rows as displayed (formatted dates, computed columns included) for CSV / XLSX export. */
export function exportRows(ds: Pick<Dataset, 'columns' | 'rows'>, rows = ds.rows, formatted = true): (string | number | boolean | null)[][] {
  return rows.map((r) => ds.columns.map((c) => {
    const v = r[c.key]
    if (v == null) return null
    if (c.type === 'date' && typeof v === 'number') return formatted ? fmtValue(v, c) : new Date(v).toISOString()
    if (c.type === 'number') return v
    return formatted ? fmtValue(v, c) : v
  }))
}

export async function exportXlsx(ds: Pick<Dataset, 'columns' | 'rows' | 'name'>, rows = ds.rows): Promise<Blob> {
  const XLSX = await import('xlsx')
  const aoa = [ds.columns.map((c) => c.name), ...rows.map((r) => ds.columns.map((c) => {
    const v = r[c.key]
    if (v == null) return null
    if (c.type === 'date' && typeof v === 'number') return new Date(v)
    return v
  }))]
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, ds.name.slice(0, 31).replace(/[\\/?*[\]:]/g, ' ') || 'Data')
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}
