import type { Column, DataSource, DataVersion, DatasetMeta, DatasetModel, FileFormat, ImportOptions, RawRow, Row } from '../types'
import type { DataCheck, HeaderCheck, UpdateMode } from '../lib/update'
import type { StepReport } from '../lib/prep'
import type { RaggedReport } from '../lib/parse'
import type { ImportReview } from '../lib/quality'
import type { ColType } from '../types'
import type { RestoreMode, RestoreSummary } from '../lib/backup'

export interface SheetPreview {
  name: string
  headers: string[]
  sample: RawRow[]
  rowCount: number
  truncated: boolean
  /** rows with more or fewer cells than the header (CSV / TSV) */
  ragged?: RaggedReport
}

export interface PreviewResult {
  token: string
  fileName: string
  format: FileFormat
  bytes: number
  detected: {
    delimiter?: string
    encoding?: string
    /** decimal separator the values point to; `preselect` when the file is clear enough to apply it without asking */
    decimal?: { decimal: '.' | ','; columns: string[]; preselect: boolean }
  }
  sheets: SheetPreview[]
  /** bytes read from the file: less than `bytes` when a row limit ended the read early */
  bytesRead?: number
  /** names of the files combined into this preview, when more than one */
  files?: string[]
}

/** Outcome of re-downloading a URL source. */
export type RefreshResult =
  | (Loaded & { outcome: 'replaced' })
  /** the download is byte-for-byte what is already loaded: nothing stored, no version saved */
  | { outcome: 'unchanged'; meta: DatasetMeta }
  /** columns the dataset has are missing from the download: nothing was replaced, the user decides */
  | { outcome: 'blocked'; check: HeaderCheck; checks: DataCheck[] }

export interface BackupInspection {
  createdAt: string
  includesData: boolean
  datasets: { name: string; rows: number; hasData: boolean }[]
  conflicts: { ids: number; names: number }
  merge: RestoreSummary
  copy: RestoreSummary
}

export interface Loaded {
  meta: DatasetMeta
  columns: Column[]
  rows: Row[]
  prepHeaders: string[]
  reports: StepReport[]
}

export interface UpdatePreview {
  token: string
  fileName: string
  bytes: number
  sheets: string[]
  sheet: string
  incomingHeaders: string[]
  sample: RawRow[]
  rowCount: number
  existingHeaders: string[]
  existingRows: number
  check: HeaderCheck
  /** ID-like column present in both files, suggested for skipping rows already loaded */
  suggestedKey?: string
  /** date coverage of the main date column, existing vs incoming, and how many incoming rows fall on or before the existing last date */
  dates?: { column: string; existing: [number, number]; incoming: [number, number]; overlapping: number }
  /** values in the new file that look wrong compared with the loaded data */
  checks: DataCheck[]
}

export interface UpdateCommit {
  id: string
  token: string
  mode: UpdateMode
  mapping: Record<string, string | undefined>
  dedupe: { enabled: boolean; keys: string[] }
  /** remove loaded rows whose key isn't in the new file */
  sync?: boolean
}

export interface Requests {
  list: { req: Record<string, never>; res: DatasetMeta[] }
  /** `more`: further files with the same columns, combined into one dataset */
  preview: { req: { file: File; options: ImportOptions; more?: File[] }; res: PreviewResult }
  /** data-quality review of the parsed file, with the type choices made in the preview */
  importReview: { req: { token: string; sheet: string; options: Pick<ImportOptions, 'decimal' | 'dateOrder' | 'softBlanks'>; overrides: Record<string, ColType> }; res: ImportReview | null }
  commit: { req: { token: string; sheet: string; name: string; source: DataSource; model: DatasetModel }; res: Loaded }
  /** stops a read in progress and releases parsed rows held for a preview or an update */
  cancel: { req: Record<string, never>; res: null }
  load: { req: { id: string }; res: Loaded }
  rebuild: { req: { id: string; model: DatasetModel }; res: Loaded }
  /** `force` replaces even when columns in use are missing from the download */
  replaceSource: { req: { id: string; file: File; force?: boolean }; res: RefreshResult }
  updateMeta: { req: { id: string; patch: Partial<Pick<DatasetMeta, 'name' | 'source'>> }; res: DatasetMeta }
  /** moves a dataset to "recently removed": its rows, versions and dashboard stay until the retention window ends */
  delete: { req: { id: string }; res: DatasetMeta | null }
  undelete: { req: { id: string }; res: DatasetMeta | null }
  /** removed datasets that can still be restored, newest first */
  listTrash: { req: Record<string, never>; res: DatasetMeta[] }
  /** deletes a removed dataset for good, freeing its storage (all of them when no id is given) */
  purge: { req: { id?: string }; res: null }
  updatePreview: { req: { id: string; file: File; sheet?: string; dateColumn?: string }; res: UpdatePreview }
  /** data checks again, after columns were mapped by hand */
  updateChecks: { req: { id: string; token: string; mapping: Record<string, string | undefined> }; res: DataCheck[] }
  updateCommit: { req: UpdateCommit; res: Loaded & { added: number; updated: number; skipped: number; removed: number } }
  /** puts back the data from before the last update (or refresh) */
  /** restores a saved version (the newest when no key is given); the data it replaces becomes a version itself */
  restoreVersion: { req: { id: string; key?: string }; res: Loaded & { restored: DataVersion } }
  listVersions: { req: { id: string }; res: DataVersion[] }
  /** deletes one saved version */
  deleteVersion: { req: { id: string; key: string }; res: DatasetMeta }
  /** deletes every saved version of a dataset, freeing their storage */
  clearVersions: { req: { id: string }; res: DatasetMeta }
  /** a workspace backup as a file; `includeData` adds the source rows */
  backupExport: { req: { includeData: boolean; settings: { theme?: string; patterns?: boolean }; appVersion?: string }; res: { blob: Blob; datasets: number; skipped: { name: string; reason: string }[] } }
  /** reads and fully checks a backup, and says what restoring it would do in each mode — nothing is written */
  backupInspect: { req: { file: File }; res: BackupInspection }
  /** restores a backup: checked in full first, then written in one transaction (all or nothing) */
  backupRestore: { req: { file: File; mode: RestoreMode }; res: RestoreSummary & { prefs: { theme?: string; patterns?: boolean } } }
  /** raw source rows (for data export of the original file) */
  source: { req: { id: string }; res: { headers: string[]; rows: RawRow[] } | null }
}

export type RequestType = keyof Requests

export type ToWorker = { id: number; type: RequestType; payload: unknown }
export type FromWorker =
  | { id: number; kind: 'result'; result: unknown }
  | { id: number; kind: 'error'; message: string; name?: string }
  | { id: number; kind: 'progress'; fraction: number; label: string }
