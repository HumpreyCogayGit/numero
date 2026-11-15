import type { Dashboard, DatasetMeta, Filter, Page, RawRow, Widget } from '../types'
import type { Table } from './prep'
import { emptyModel } from './model'

// IndexedDB layout (v3):
//   meta     DatasetMeta (small: name, counts, model)
//   sources  { id, headers, chunks, rowCount } — the raw rows are stored once; typed rows are rebuilt from them
//   chunks   { id, i, rows } — rows as arrays (no repeated keys), 100k per record: Chromium caps one value at ~127 MB
// (v2 stored { id, headers, rows } in `sources` directly; those records still load.)
// v4 adds:
//   dashboards  Dashboard, one record per dataset (keyed by datasetId). They used to be one localStorage value shared
//               by every dataset and rewritten in full on each edit, so two open tabs overwrote each other's work.
// A deleted dataset stays in place with `trashedAt` set on its meta until the retention window ends (see TRASH_MS).

const DB = 'numero'
const VERSION = 4
/** How long a removed dataset (with its saved versions and dashboard) can still be restored. */
export const TRASH_MS = 7 * 24 * 60 * 60 * 1000
const CHUNK_ROWS = 100_000

export interface StoredSource extends Table { id: string }

export class StorageFullError extends Error {
  constructor() {
    super('Browser storage is full. Remove datasets you no longer need (Home → Storage) and try again.')
  }
}

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = (ev) => {
      const db = req.result
      const tx = req.transaction!
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['id', 'i'] })
      if (!db.objectStoreNames.contains('dashboards')) db.createObjectStore('dashboards', { keyPath: 'datasetId' })
      // v1 kept whole datasets (raw + typed rows) in one store: split into meta + source, keeping user edits
      if (ev.oldVersion === 1 && db.objectStoreNames.contains('datasets')) {
        const old = tx.objectStore('datasets')
        old.openCursor().onsuccess = (e) => {
          const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result
          if (!cur) { db.deleteObjectStore('datasets'); return }
          const v = cur.value as {
            id: string; name: string; fileName: string; format: DatasetMeta['format']; sheet?: string; createdAt: number
            columns: { key: string; name: string; type: string; detected: string; formula?: string }[]
            raw: RawRow[]; computed?: DatasetMeta['model']['computed']
          }
          const base = v.columns.filter((c) => c.formula == null)
          const model = emptyModel()
          for (const c of base) {
            if (c.type !== c.detected) model.overrides[c.key] = c.type as never
            model.names[c.key] = c.name
          }
          model.computed = v.computed ?? []
          const meta: DatasetMeta = {
            id: v.id, name: v.name, fileName: v.fileName, format: v.format, sheet: v.sheet, createdAt: v.createdAt,
            rowCount: v.raw.length, columnCount: v.columns.length, source: { kind: 'file' }, model,
          }
          tx.objectStore('meta').put(meta)
          tx.objectStore('sources').put({ id: v.id, headers: base.map((c) => c.key), rows: v.raw })
          cur.continue()
        }
      }
    }
    req.onsuccess = () => {
      // another tab upgrading the database must not be blocked by this connection
      req.result.onversionchange = () => { req.result.close(); dbPromise = null }
      resolve(req.result)
    }
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

type StoreName = 'meta' | 'sources' | 'chunks' | 'dashboards'

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode)
    let result: T
    const req = fn(tx.objectStore(store))
    if (req) req.onsuccess = () => (result = req.result)
    tx.oncomplete = () => resolve(result)
    tx.onerror = tx.onabort = () => {
      const err = tx.error ?? (req ? req.error : null)
      reject(err?.name === 'QuotaExceededError' ? new StorageFullError() : err)
    }
  }))
}

export const listMeta = () => run<DatasetMeta[]>('meta', 'readonly', (s) => s.getAll())
export const getMeta = (id: string) => run<DatasetMeta | undefined>('meta', 'readonly', (s) => s.get(id))
export const putMeta = (m: DatasetMeta) => run('meta', 'readwrite', (s) => { s.put(m) })
const chunkRange = (id: string) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])

export async function getSource(id: string): Promise<StoredSource | undefined> {
  const head = await run<{ id: string; headers: string[]; chunks?: number; rows?: RawRow[] } | undefined>('sources', 'readonly', (s) => s.get(id))
  if (!head) return undefined
  if (head.rows) return { id, headers: head.headers, rows: head.rows }
  const chunks = await run<{ i: number; rows: RawValueRow[] }[]>('chunks', 'readonly', (s) => s.getAll(chunkRange(id)))
  chunks.sort((a, b) => a.i - b.i)
  const rows: RawRow[] = []
  for (const c of chunks) {
    for (const arr of c.rows) {
      const o: RawRow = {}
      for (let j = 0; j < head.headers.length; j++) o[head.headers[j]] = arr[j]
      rows.push(o)
    }
  }
  return { id, headers: head.headers, rows }
}

type RawValueRow = RawRow[string][]

/** Writes the header and every chunk in one transaction, replacing any previous version. */
export async function putSource(src: StoredSource) {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['sources', 'chunks'], 'readwrite')
    const chunks = tx.objectStore('chunks')
    chunks.delete(chunkRange(src.id))
    const n = Math.max(1, Math.ceil(src.rows.length / CHUNK_ROWS))
    for (let i = 0; i < n; i++) {
      const part = src.rows.slice(i * CHUNK_ROWS, (i + 1) * CHUNK_ROWS).map((r) => src.headers.map((h) => r[h]))
      chunks.put({ id: src.id, i, rows: part })
    }
    tx.objectStore('sources').put({ id: src.id, headers: src.headers, chunks: n, rowCount: src.rows.length })
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error?.name === 'QuotaExceededError' ? new StorageFullError() : tx.error)
  })
}

/** Earlier versions of a dataset's rows, kept by updates and refreshes so they can be restored. */
export const versionId = (id: string, stamp: number) => `${id}::v${stamp.toString(36)}`
/** the single backup kept before versions existed */
export const legacyBackupId = (id: string) => `${id}::prev`

export const hasSource = async (id: string) => !!(await run<IDBValidKey | undefined>('sources', 'readonly', (s) => s.getKey(id)))

export async function deleteSource(id: string) {
  await run('sources', 'readwrite', (s) => { s.delete(id) })
  await run('chunks', 'readwrite', (s) => { s.delete(chunkRange(id)) })
}

/** A linked file handle (File System Access API), kept beside the dataset's versions so a delete removes it too. */
const handleKey = (id: string) => `${id}::handle`
export const putHandle = (id: string, handle: unknown) => run('sources', 'readwrite', (s) => { s.put({ id: handleKey(id), handle }) })
export const getHandle = async (id: string) => (await run<{ handle: unknown } | undefined>('sources', 'readonly', (s) => s.get(handleKey(id))))?.handle
export const deleteHandle = (id: string) => run('sources', 'readwrite', (s) => { s.delete(handleKey(id)) })

/** Removes every saved version (`id::…`) of a dataset. */
export async function deleteVersions(id: string) {
  await run('sources', 'readwrite', (s) => { s.delete(IDBKeyRange.bound(`${id}::`, `${id}::\uffff`)) })
  await run('chunks', 'readwrite', (s) => { s.delete(IDBKeyRange.bound([`${id}::`], [`${id}::\uffff`])) })
}

export async function deleteStored(id: string) {
  await run('meta', 'readwrite', (s) => { s.delete(id) })
  await deleteSource(id)
  await deleteVersions(id)
  await deleteDashboard(id)
}

/**
 * Writes several datasets (description, rows, dashboard) in ONE transaction: either all of it is stored or none of it.
 * `rows` are arrays in header order; absent when only the description and dashboard are written.
 */
export async function writeAll(items: { meta: DatasetMeta; dashboard?: Dashboard; data?: { headers: string[]; rows: unknown[][] } }[]): Promise<void> {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['meta', 'sources', 'chunks', 'dashboards'], 'readwrite')
    try {
      for (const it of items) {
        tx.objectStore('meta').put(it.meta)
        if (it.dashboard) tx.objectStore('dashboards').put({ ...it.dashboard, datasetId: it.meta.id })
        if (it.data) {
          const chunks = tx.objectStore('chunks')
          chunks.delete(chunkRange(it.meta.id))
          const n = Math.max(1, Math.ceil(it.data.rows.length / CHUNK_ROWS))
          for (let i = 0; i < n; i++) chunks.put({ id: it.meta.id, i, rows: it.data.rows.slice(i * CHUNK_ROWS, (i + 1) * CHUNK_ROWS) })
          tx.objectStore('sources').put({ id: it.meta.id, headers: it.data.headers, chunks: n, rowCount: it.data.rows.length })
        }
      }
    } catch (e) {
      // a value that cannot be stored: undo everything written so far
      try { tx.abort() } catch { /* already aborting */ }
      reject(e)
      return
    }
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error?.name === 'QuotaExceededError' ? new StorageFullError() : tx.error ?? new Error('The restore was interrupted; nothing was changed.'))
  })
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.()
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null
  } catch {
    return null
  }
}

// ---------- dashboards ----------

const DASH_KEY = 'numero:dashboards'

type LegacyDashboard = { datasetId: string; widgets: Widget[]; filters: Filter[] }

/** v1 dashboards were a single widget list; they become the first page. */
export function migrateDashboard(d: Dashboard | LegacyDashboard): Dashboard {
  if ('pages' in d && Array.isArray(d.pages)) return d
  const legacy = d as LegacyDashboard
  const page: Page = { id: 'p_main', name: 'Overview', widgets: legacy.widgets ?? [], filters: legacy.filters ?? [] }
  return { datasetId: legacy.datasetId, pages: [page], activePage: page.id }
}

export async function listDashboards(): Promise<Record<string, Dashboard>> {
  const all = await run<Dashboard[]>('dashboards', 'readonly', (s) => s.getAll())
  return Object.fromEntries(all.map((d) => [d.datasetId, migrateDashboard(d)]))
}
export const getDashboard = async (id: string) => {
  const d = await run<Dashboard | undefined>('dashboards', 'readonly', (s) => s.get(id))
  return d ? migrateDashboard(d) : undefined
}
/** One record per dataset: saving one dashboard never touches another's. */
export const putDashboard = (d: Dashboard) => run('dashboards', 'readwrite', (s) => { s.put(d) })
export const deleteDashboard = (id: string) => run('dashboards', 'readwrite', (s) => { s.delete(id) })

/**
 * Moves dashboards from the old single localStorage value into IndexedDB. Runs on the page (workers have no
 * localStorage). A dashboard already in IndexedDB wins; the old value is removed only once everything is written.
 */
export async function migrateLocalDashboards(storage: Pick<Storage, 'getItem' | 'removeItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): Promise<number> {
  let raw: string | null = null
  try { raw = storage?.getItem(DASH_KEY) ?? null } catch { return 0 }
  if (!raw) return 0
  let parsed: Record<string, Dashboard | LegacyDashboard>
  try { parsed = JSON.parse(raw) as Record<string, Dashboard | LegacyDashboard> } catch { return 0 }
  if (!parsed || typeof parsed !== 'object') return 0
  const have = await listDashboards()
  let moved = 0
  for (const [id, d] of Object.entries(parsed)) {
    if (have[id] || !d || typeof d !== 'object') continue
    await putDashboard({ ...migrateDashboard(d), datasetId: id })
    moved++
  }
  try { storage?.removeItem(DASH_KEY) } catch { /* the copy in IndexedDB is the one used from now on */ }
  return moved
}
