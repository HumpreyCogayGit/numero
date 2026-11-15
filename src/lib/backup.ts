// Workspace backup: every dataset's settings, formulas, preparation steps and dashboard in one file — and, when asked,
// the source rows too. The file is plain JSON so it can be inspected; each dataset carries a checksum so damage is
// noticed before anything is restored. Pure functions: storage is the caller's business (see the worker).
//
// Format history
//   1  first version: manifest + datasets, per-dataset SHA-256, rows as arrays with dates tagged {"$d": ms}

import type { Dashboard, DatasetMeta, PrepStep, RawRow, RawValue } from '../types'
import { normalizeModel } from './model'
import { migrateDashboard } from './db'

export const BACKUP_VERSION = 1
export const BACKUP_EXT = '.numero-backup.json'

export interface BackupData { headers: string[]; rows: unknown[][] }
export interface BackupDataset { meta: DatasetMeta; dashboard?: Dashboard; data?: BackupData }
export interface ManifestEntry { id: string; name: string; rows: number; columns: number; hasData: boolean; checksum: string }

export interface BackupArchive {
  app: 'numero'
  kind: 'workspace'
  version: number
  createdAt: string
  appVersion?: string
  /** whether source rows are inside; without them a dataset can only be restored onto data that is already here */
  includesData: boolean
  settings: { theme?: string; patterns?: boolean }
  manifest: ManifestEntry[]
  datasets: BackupDataset[]
}

export class BackupError extends Error {
  constructor(message: string) { super(message); this.name = 'BackupError' }
}

// ---------- rows ----------

const encodeValue = (v: RawValue): unknown => (v instanceof Date ? { $d: +v } : v === undefined ? null : v)
const decodeValue = (v: unknown): RawValue => (v && typeof v === 'object' && '$d' in (v as object) ? new Date((v as { $d: number }).$d) : (v as RawValue))

/** Rows as arrays in header order (no repeated keys); dates from spreadsheets keep their type. */
export const encodeRows = (headers: string[], rows: RawRow[]): BackupData => ({ headers, rows: rows.map((r) => headers.map((h) => encodeValue(r[h]))) })
export const decodeRows = (d: BackupData): RawRow[] => d.rows.map((arr) => {
  const o: RawRow = {}
  for (let i = 0; i < d.headers.length; i++) o[d.headers[i]] = decodeValue(arr[i])
  return o
})

// ---------- writing ----------

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** What is kept of a dataset's meta: saved versions and the removed-marker belong to this browser, not to a backup. */
export function backupMeta(meta: DatasetMeta): DatasetMeta {
  const { trashedAt: _t, ...rest } = meta
  const { versions: _v, ...source } = rest.source
  return { ...rest, source }
}

/** Approximate size of the file before it is made: the stored size of the rows, plus a little per dataset for settings. */
export function estimateBackupBytes(metas: Pick<DatasetMeta, 'bytes'>[], includeData: boolean): number {
  return metas.reduce((a, m) => a + 20_000 + (includeData ? Math.round((m.bytes ?? 0) * 1.15) : 0), 2000)
}

export interface BackupInput { meta: DatasetMeta; dashboard?: Dashboard; source?: { headers: string[]; rows: RawRow[] } }

/**
 * The archive as text pieces (one per dataset, so a large workspace is never one giant string).
 * Datasets whose rows could not be read are written without them and listed in `skipped`.
 */
export async function buildArchive(items: BackupInput[], o: { includeData: boolean; settings?: BackupArchive['settings']; now?: number; appVersion?: string }): Promise<{ parts: string[]; skipped: { name: string; reason: string }[] }> {
  const manifest: ManifestEntry[] = []
  const bodies: string[] = []
  const skipped: { name: string; reason: string }[] = []
  for (const it of items) {
    const entry: BackupDataset = { meta: backupMeta(it.meta), ...(it.dashboard ? { dashboard: it.dashboard } : {}) }
    if (o.includeData) {
      if (it.source) entry.data = encodeRows(it.source.headers, it.source.rows)
      else skipped.push({ name: it.meta.name, reason: 'its rows could not be read from browser storage — saved without them' })
    }
    const body = JSON.stringify(entry)
    bodies.push(body)
    manifest.push({ id: it.meta.id, name: it.meta.name, rows: it.meta.rowCount, columns: it.meta.columnCount, hasData: !!entry.data, checksum: await sha256(body) })
  }
  const head = JSON.stringify({
    app: 'numero', kind: 'workspace', version: BACKUP_VERSION, createdAt: new Date(o.now ?? Date.now()).toISOString(),
    ...(o.appVersion ? { appVersion: o.appVersion } : {}), includesData: o.includeData, settings: o.settings ?? {}, manifest,
  })
  // {"app":…,"manifest":[…],"datasets":[ body, body ]}
  const parts = [`${head.slice(0, -1)},"datasets":[`]
  bodies.forEach((b, i) => parts.push(i ? `,${b}` : b))
  parts.push(']}')
  return { parts, skipped }
}

// ---------- reading ----------

/** Brings an archive written by an older version up to the current format. Each step is one version. */
export function migrateArchive(raw: Record<string, unknown>): BackupArchive {
  const version = Number(raw.version)
  if (!Number.isInteger(version) || version < 1) throw new BackupError('This backup has no readable version number.')
  if (version > BACKUP_VERSION) throw new BackupError('This backup was made by a newer version of Numero. Update Numero, then restore it.')
  // (no older formats yet: version 1 is current. A future version 2 adds its step here: if (version < 2) raw = v1to2(raw))
  return raw as unknown as BackupArchive
}

/**
 * Checks the whole file before anything is restored: it is a Numero workspace backup, of a version this build reads,
 * every dataset is complete, and every checksum matches. Throws a BackupError that says what is wrong.
 */
export async function validateArchive(json: unknown): Promise<BackupArchive> {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new BackupError('This file is not a Numero backup.')
  const raw = json as Record<string, unknown>
  if (raw.app !== 'numero') throw new BackupError('This file is not a Numero backup.')
  if (raw.kind !== 'workspace') throw new BackupError(raw.dashboard ? 'This is a single dashboard export, not a workspace backup — open a dataset and use Share → Import dashboard.' : 'This file is not a Numero workspace backup.')
  const a = migrateArchive(raw)
  if (!Array.isArray(a.manifest) || !Array.isArray(a.datasets)) throw new BackupError('This backup is incomplete: its list of datasets is missing.')
  if (a.manifest.length !== a.datasets.length) throw new BackupError(`This backup is incomplete: it lists ${a.manifest.length} datasets but holds ${a.datasets.length}. The file may be cut off.`)
  const seen = new Set<string>()
  for (let i = 0; i < a.datasets.length; i++) {
    const d = a.datasets[i], m = a.manifest[i]
    const name = m?.name ?? d?.meta?.name ?? `dataset ${i + 1}`
    if (!d || typeof d !== 'object' || !d.meta || typeof d.meta.id !== 'string' || typeof d.meta.name !== 'string' || !d.meta.source) throw new BackupError(`“${name}” in this backup is damaged: its description is missing.`)
    if (m.id !== d.meta.id) throw new BackupError(`“${name}” in this backup does not match its entry in the list of contents.`)
    if (seen.has(d.meta.id)) throw new BackupError(`This backup lists “${name}” twice.`)
    seen.add(d.meta.id)
    if ((await sha256(JSON.stringify(d))) !== m.checksum) throw new BackupError(`“${name}” in this backup is damaged (its checksum does not match). Nothing was restored.`)
    if (d.data) {
      if (!Array.isArray(d.data.headers) || !Array.isArray(d.data.rows)) throw new BackupError(`“${name}” in this backup is damaged: its rows cannot be read.`)
      const w = d.data.headers.length
      if (d.data.rows.some((r) => !Array.isArray(r) || r.length !== w)) throw new BackupError(`“${name}” in this backup is damaged: some rows do not match its columns.`)
    }
    if (d.dashboard && !Array.isArray((d.dashboard as Dashboard).pages) && !Array.isArray((d.dashboard as unknown as { widgets?: unknown }).widgets)) throw new BackupError(`The dashboard of “${name}” in this backup is damaged.`)
  }
  return a
}

// ---------- restoring ----------

export type RestoreMode = 'merge' | 'copy'

export interface RestoreItem {
  /** id in the backup */
  from: string
  name: string
  /** add: a dataset not here yet · replace: same dataset here, rows and settings from the backup · settings: same dataset here, backup has no rows — settings and dashboard only · skip: cannot be restored */
  action: 'add' | 'replace' | 'settings' | 'skip'
  reason?: string
  /** what gets written (absent for skip) */
  meta?: DatasetMeta
  dashboard?: Dashboard
  data?: BackupData
}

export interface RestorePlan { mode: RestoreMode; items: RestoreItem[]; conflicts: { ids: number; names: number } }

const newId = (i: number, now: number) => `ds_${now.toString(36)}_r${i.toString(36)}${Math.random().toString(36).slice(2, 5)}`

function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name
  let n = `${name} (restored)`
  for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${name} (restored ${i})`
  return n
}

/**
 * Decides, without touching storage, what restoring would do.
 * merge: a dataset already here (same id) is brought back to the backup's state; others are added.
 * copy:  nothing here is touched — every dataset in the backup that has rows arrives as a new one.
 */
export function planRestore(a: BackupArchive, existing: DatasetMeta[], mode: RestoreMode, now = Date.now()): RestorePlan {
  const byId = new Map(existing.map((m) => [m.id, m]))
  const names = new Set(existing.map((m) => m.name.toLowerCase()))
  const conflicts = { ids: a.datasets.filter((d) => byId.has(d.meta.id)).length, names: a.datasets.filter((d) => !byId.has(d.meta.id) && names.has(d.meta.name.toLowerCase())).length }
  // copies get fresh ids; joins between restored datasets follow them
  const idMap = new Map<string, string>()
  if (mode === 'copy') a.datasets.forEach((d, i) => { if (d.data) idMap.set(d.meta.id, newId(i, now)) })
  const remap = (steps: PrepStep[]): PrepStep[] => steps.map((s) => ((s.op === 'join' || s.op === 'append') && idMap.has(s.datasetId) ? { ...s, datasetId: idMap.get(s.datasetId)! } : s))

  const items: RestoreItem[] = a.datasets.map((d): RestoreItem => {
    const here = byId.get(d.meta.id)
    const model = normalizeModel(d.meta.model)
    const dash = d.dashboard ? migrateDashboard(d.dashboard) : undefined
    if (mode === 'copy') {
      if (!d.data) return { from: d.meta.id, name: d.meta.name, action: 'skip', reason: 'the backup has no rows for it, so there is nothing to make a copy from' }
      const id = idMap.get(d.meta.id)!
      const name = uniqueName(d.meta.name, names)
      names.add(name.toLowerCase())
      return { from: d.meta.id, name, action: 'add', data: d.data, meta: { ...d.meta, id, name, model: { ...model, prep: remap(model.prep) } }, dashboard: dash ? { ...dash, datasetId: id } : undefined }
    }
    if (here) {
      if (d.data) return { from: d.meta.id, name: d.meta.name, action: 'replace', data: d.data, meta: { ...d.meta, model, source: { ...d.meta.source, versions: here.source.versions } }, dashboard: dash }
      // no rows in the backup: the rows here stay, the settings and dashboard go back to the backup's
      return { from: d.meta.id, name: d.meta.name, action: 'settings', meta: { ...here, name: d.meta.name, model }, dashboard: dash }
    }
    if (!d.data) return { from: d.meta.id, name: d.meta.name, action: 'skip', reason: 'the backup has no rows for it — import its source file, then restore again to get its dashboard back' }
    const name = uniqueName(d.meta.name, names)
    names.add(name.toLowerCase())
    return { from: d.meta.id, name, action: 'add', data: d.data, meta: { ...d.meta, name, model }, dashboard: dash }
  })
  return { mode, items, conflicts }
}

export interface RestoreSummary { added: number; replaced: number; settings: number; skipped: { name: string; reason: string }[] }

export const summarize = (plan: RestorePlan): RestoreSummary => ({
  added: plan.items.filter((i) => i.action === 'add').length,
  replaced: plan.items.filter((i) => i.action === 'replace').length,
  settings: plan.items.filter((i) => i.action === 'settings').length,
  skipped: plan.items.filter((i) => i.action === 'skip').map((i) => ({ name: i.name, reason: i.reason ?? '' })),
})
