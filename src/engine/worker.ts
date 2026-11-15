// Data engine: parsing, type inference, prep, computed columns and storage run here so the page never freezes.

import { ImportCancelled, parseFile, type ParsedFile, type Progress } from '../lib/parse'
import { buildDataset, normalizeModel } from '../lib/model'
import { applyPrep, type Table } from '../lib/prep'
import { writeAll, deleteDashboard, deleteSource, deleteStored, deleteVersions, getHandle, getMeta, getSource, hasSource, legacyBackupId, listDashboards, listMeta, putHandle, putMeta, putSource, StorageFullError, TRASH_MS, versionId, type StoredSource } from '../lib/db'
import { checkIncoming, compareHeaders, guessKey, mergeRows } from '../lib/update'
import { coerce, detectDecimal } from '../lib/infer'
import { acknowledge, reviewImport } from '../lib/quality'
import { BackupError, buildArchive, planRestore, summarize, validateArchive, type BackupArchive, type BackupInput } from '../lib/backup'
import type { DataUpdate, DataVersion, DatasetMeta, DatasetModel, RawRow } from '../types'
import type { FromWorker, Loaded, PreviewResult, RefreshResult, Requests, ToWorker, UpdatePreview } from './protocol'

// typed locally: the DOM and WebWorker libs can't both be loaded in one tsconfig
const ctx = self as unknown as { postMessage(m: FromWorker): void; onmessage: ((ev: MessageEvent<ToWorker>) => void) | null }

const SAMPLE_ROWS = 100
let pendingPreview: { token: string; parsed: ParsedFile; file: File; files?: string[] } | null = null
/** bumped by `cancel`: a read that started under an older number stops at its next piece and its result is dropped */
let epoch = 0

/** SHA-256 of a file's bytes as hex; undefined where the browser offers no crypto (insecure origins). */
async function fingerprint(file: Blob): Promise<string | undefined> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return undefined
  }
}

async function readBackup(file: File): Promise<BackupArchive> {
  let json: unknown
  try {
    json = JSON.parse(await file.text())
  } catch {
    throw new BackupError('This file is not a readable Numero backup — it may be cut off or a different kind of file. Nothing was changed.')
  }
  return validateArchive(json)
}

/** Datasets as stored, minus those in the trash. Expired trash and dashboards without a dataset are cleared on the way. */
async function sweep(): Promise<{ live: DatasetMeta[]; trashed: DatasetMeta[] }> {
  const all = await listMeta()
  const now = Date.now()
  const live: DatasetMeta[] = [], trashed: DatasetMeta[] = []
  for (const m of all) {
    if (m.trashedAt == null) live.push(m)
    else if (now - m.trashedAt > TRASH_MS) { await deleteStored(m.id); cache.delete(m.id) }
    else trashed.push(m)
  }
  // a dashboard whose dataset is gone (a delete interrupted by a reload, in earlier versions) has nothing to show
  const known = new Set([...live, ...trashed].map((m) => m.id))
  for (const id of Object.keys(await listDashboards())) if (!known.has(id)) await deleteDashboard(id)
  return { live, trashed: trashed.sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0)) }
}

// recently used sources, so rebuilds after an edit don't re-read IndexedDB
const cache = new Map<string, StoredSource>()
function remember(src: StoredSource) {
  cache.delete(src.id)
  cache.set(src.id, src)
  while (cache.size > 3) cache.delete(cache.keys().next().value!)
}
async function source(id: string): Promise<StoredSource> {
  const hit = cache.get(id)
  if (hit) return hit
  const src = await getSource(id)
  if (!src) throw new Error('This dataset’s data is missing from browser storage.')
  remember(src)
  return src
}

let pendingUpdate: { token: string; id: string; fileName: string; bytes: number; headers: string[]; rows: RawRow[] } | null = null

const MAX_VERSIONS = 5
/** versions are full copies: very large datasets keep fewer */
const maxVersions = (bytes = 0) => (bytes > 200e6 ? 2 : bytes > 50e6 ? 3 : MAX_VERSIONS)

/** Saved versions, newest first. Datasets updated before versions existed have one `::prev` backup. */
async function versionsOf(meta: DatasetMeta): Promise<DataVersion[]> {
  if (meta.source.versions) return meta.source.versions
  if (!(await hasSource(legacyBackupId(meta.id)))) return []
  const last = meta.source.updates?.[0]
  return [{ key: legacyBackupId(meta.id), at: last?.at ?? meta.source.lastLoaded ?? meta.createdAt, rows: last?.rowsBefore ?? 0, label: 'Previous version' }]
}

const versionLabel = (e: Omit<DataUpdate, 'at' | 'rowsBefore' | 'rowsAfter'>) =>
  e.mode === 'append' ? `Before appending ${e.fileName}`
    : e.mode === 'replace' ? `Before replacing with ${e.fileName}`
      : e.mode === 'refresh' ? `Before refreshing from ${e.fileName}`
        : 'Before restoring an earlier version'

/**
 * Saves the current rows as a version, then writes the new ones and records the update.
 * `consumed` is the version being restored: it becomes the current data, so it leaves the list.
 */
async function swapIn(meta: DatasetMeta, current: StoredSource, next: StoredSource, entry: Omit<DataUpdate, 'at' | 'rowsBefore' | 'rowsAfter'>, bytes: number | undefined, progress: Progress, consumed?: string): Promise<Loaded> {
  const at = Date.now()
  const saved: DataVersion = { key: versionId(meta.id, at), at, rows: meta.rowCount, bytes: meta.bytes, label: versionLabel(entry) }
  let versions = (await versionsOf(meta)).filter((v) => v.key !== consumed)
  // versions are full copies: when storage is full, give up the oldest ones before failing the update
  for (;;) {
    try { await putSource({ ...current, id: saved.key }); break } catch (e) {
      if (!(e instanceof StorageFullError) || !versions.length) throw e
      await deleteSource(versions.pop()!.key)
    }
  }
  const keep = maxVersions(meta.bytes)
  const dropped = versions.slice(keep - 1)
  versions = [saved, ...versions.slice(0, keep - 1)]
  const built = await build({ ...meta, bytes }, next, progress)
  // counts as the dashboard shows them (after prep steps), not raw file rows
  const update: DataUpdate = { ...entry, at, rowsBefore: meta.rowCount, rowsAfter: built.rows.length }
  const loaded: Loaded = { ...built, meta: { ...built.meta, source: { ...meta.source, lastLoaded: at, updates: [update, ...(meta.source.updates ?? [])].slice(0, 12), versions } } }
  progress(0.97, 'Saving')
  await putSource(next)
  await putMeta(loaded.meta)
  remember(next)
  for (const key of [...dropped.map((v) => v.key), ...(consumed ? [consumed] : [])]) await deleteSource(key)
  return loaded
}

/** Loads other datasets referenced by join/append steps (with their own non-join prep applied). */
async function resolverFor(model: DatasetModel, selfId?: string) {
  const ids = [...new Set(model.prep.flatMap((s) => (s.op === 'join' || s.op === 'append') && s.datasetId !== selfId ? [s.datasetId] : []))]
  const tables = new Map<string, Table & { name: string }>()
  for (const id of ids) {
    const [meta, src] = await Promise.all([getMeta(id), source(id).catch(() => undefined)])
    if (!meta || !src) continue
    const m = normalizeModel(meta.model)
    const own = m.prep.filter((s) => s.op !== 'join' && s.op !== 'append')
    const t = own.length ? applyPrep(src, own, undefined, m.options.decimal) : src
    tables.set(id, { headers: t.headers, rows: t.rows, name: meta.name })
  }
  return (id: string) => tables.get(id)
}

async function build(meta: DatasetMeta, src: StoredSource, progress: Progress): Promise<Loaded> {
  progress(0.6, `Analyzing ${src.rows.length.toLocaleString()} rows`)
  const model = normalizeModel(meta.model)
  const built = buildDataset(src, model, await resolverFor(model, meta.id))
  progress(0.95, 'Rendering')
  return { meta: { ...meta, model, rowCount: built.rows.length, columnCount: built.columns.length }, ...built }
}

const handlers: { [K in keyof Requests]: (req: Requests[K]['req'], progress: Progress) => Promise<Requests[K]['res']> } = {
  list: async () => (await sweep()).live.map((m) => ({ ...m, model: normalizeModel(m.model) })),

  preview: async ({ file, options, more }, progress) => {
    const mine = ++epoch
    const cancelled = () => mine !== epoch
    pendingPreview = null
    progress(0.05, `Reading ${file.name}`)
    const files = [file, ...(more ?? [])]
    let parsed = await parseFile(file, options, (f, l) => progress(0.05 + (f * 0.9) / files.length, l), { cancelled })
    for (let i = 1; i < files.length; i++) {
      const next = await parseFile(files[i], options, (f, l) => progress(0.05 + ((i + f) * 0.9) / files.length, l), { cancelled })
      const a = parsed.sheets[0], b = next.sheets[0]
      const same = a.headers.length === b.headers.length && b.headers.every((h) => a.headers.includes(h))
      if (!same) throw new Error(`${files[i].name} does not have the same columns as ${file.name}, so they can’t be combined. Import them one at a time.`)
      const rows = a.rows.concat(b.rows)
      const ragged = a.ragged || b.ragged ? { expected: a.headers.length, long: (a.ragged?.long ?? 0) + (b.ragged?.long ?? 0), short: (a.ragged?.short ?? 0) + (b.ragged?.short ?? 0), examples: [...(a.ragged?.examples ?? []), ...(b.ragged?.examples ?? [])].slice(0, 5) } : undefined
      parsed = { ...parsed, sheets: [{ ...a, rows, truncated: a.truncated || b.truncated, ragged }], bytesRead: (parsed.bytesRead ?? 0) + (next.bytesRead ?? 0) }
    }
    if (files.length > 1 && options.rowLimit && parsed.sheets[0].rows.length > options.rowLimit) {
      parsed.sheets[0] = { ...parsed.sheets[0], rows: parsed.sheets[0].rows.slice(0, options.rowLimit), truncated: true }
    }
    // cancelled while a one-piece format (JSON, workbook) was being read: drop the result
    if (cancelled()) throw new ImportCancelled()
    const token = Math.random().toString(36).slice(2)
    const names = files.length > 1 ? files.map((f) => f.name) : undefined
    pendingPreview = { token, parsed, file, files: names }
    const first = parsed.sheets[0]
    const delimited = parsed.format === 'csv' || parsed.format === 'tsv'
    const res: PreviewResult = {
      token, fileName: file.name, format: parsed.format, bytes: files.reduce((a, f) => a + f.size, 0), bytesRead: parsed.bytesRead, files: names,
      detected: { ...parsed.detected, ...(delimited && !options.decimal ? { decimal: detectDecimal(first.headers, first.rows, parsed.detected.delimiter) } : {}) },
      sheets: parsed.sheets.map((s) => ({ name: s.name, headers: s.headers, sample: s.rows.slice(0, SAMPLE_ROWS), rowCount: s.rows.length, truncated: !!s.truncated, ragged: s.ragged })),
    }
    return res
  },

  importReview: async ({ token, sheet, options, overrides }) => {
    if (!pendingPreview || pendingPreview.token !== token) return null
    const s = pendingPreview.parsed.sheets.find((x) => x.name === sheet) ?? pendingPreview.parsed.sheets[0]
    return reviewImport(s.headers, s.rows, { ...options, overrides, now: Date.now() })
  },

  cancel: async () => {
    epoch++
    pendingPreview = null
    pendingUpdate = null
    return null
  },

  commit: async ({ token, sheet, name, source: dataSource, model }, progress) => {
    if (!pendingPreview || pendingPreview.token !== token) throw new Error('The import expired — please choose the file again.')
    const { parsed, file, files } = pendingPreview
    const s = parsed.sheets.find((x) => x.name === sheet) ?? parsed.sheets[0]
    const id = `ds_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const src: StoredSource = { id, headers: s.headers, rows: s.rows }
    const m = normalizeModel(model)
    const now = Date.now()
    // what the preview showed and the user accepted is kept with the dataset, so it is not presented as news later
    const review = acknowledge(reviewImport(s.headers, s.rows, { decimal: m.options.decimal, dateOrder: m.options.dateOrder, softBlanks: m.options.softBlanks, overrides: m.overrides, now }), now)
    const meta: DatasetMeta = {
      id, name, fileName: file.name, format: parsed.format, sheet: parsed.sheets.length > 1 ? s.name : undefined,
      createdAt: now, rowCount: s.rows.length, columnCount: s.headers.length, bytes: files ? undefined : file.size,
      source: {
        ...dataSource, lastLoaded: now,
        ...(s.truncated ? { truncated: true, rowLimit: m.options.rowLimit } : {}),
        ...(s.ragged ? { ragged: { long: s.ragged.long, short: s.ragged.short } } : {}),
        ...(files ? { files } : {}),
        ...(dataSource.kind === 'url' ? { hash: await fingerprint(file), lastChecked: now } : {}),
      },
      model: m,
      ...(review.checks.length ? { review } : {}),
    }
    const loaded = await build(meta, src, progress)
    progress(0.97, 'Saving')
    await putSource(src)
    await putMeta(loaded.meta)
    remember(src)
    pendingPreview = null
    return loaded
  },

  load: async ({ id }, progress) => {
    progress(0.1, 'Loading from browser storage')
    const meta = await getMeta(id)
    if (!meta) throw new Error('Dataset not found.')
    return build(meta, await source(id), progress)
  },

  rebuild: async ({ id, model }, progress) => {
    const meta = await getMeta(id)
    if (!meta) throw new Error('Dataset not found.')
    const loaded = await build({ ...meta, model }, await source(id), progress)
    await putMeta(loaded.meta)
    return loaded
  },

  replaceSource: async ({ id, file, force }, progress): Promise<RefreshResult> => {
    const meta = await getMeta(id)
    if (!meta) throw new Error('Dataset not found.')
    const model = normalizeModel(meta.model)
    const now = Date.now()
    // the same bytes as last time: nothing to store, no version, no undo step
    const hash = await fingerprint(file)
    if (hash && hash === meta.source.hash) {
      const next = { ...meta, source: { ...meta.source, lastChecked: now } }
      await putMeta(next)
      return { outcome: 'unchanged', meta: next }
    }
    const parsed = await parseFile(file, model.options, (f, l) => progress(f * 0.5, l))
    const s = parsed.sheets.find((x) => x.name === meta.sheet) ?? parsed.sheets[0]
    const current = await source(id)
    // the same comparison Update data makes: a renamed or dropped column is asked about before anything is replaced
    const check = compareHeaders(current.headers, s.headers)
    if (check.missing.length && !force) {
      const checks = checkIncoming(current.headers, current.rows, s.rows, Object.fromEntries(check.matched.map((m) => [m.old, m.incoming])),
        { now, overrides: model.overrides, dateOrder: model.options.dateOrder, decimal: model.options.decimal, softBlanks: model.options.softBlanks })
      return { outcome: 'blocked', check, checks }
    }
    // columns matched under another spelling keep the dataset's own names, so widgets keep working
    const rename = check.matched.filter((m) => m.old !== m.incoming)
    const rows = rename.length ? s.rows.map((r) => { const o = { ...r }; for (const m of rename) { o[m.old] = r[m.incoming]; delete o[m.incoming] } return o }) : s.rows
    const headers = s.headers.map((h) => rename.find((m) => m.incoming === h)?.old ?? h)
    const next: StoredSource = { id, headers, rows }
    const loaded = await swapIn({ ...meta, source: { ...meta.source, hash, lastChecked: now } }, current, next, { mode: 'refresh', fileName: file.name, added: s.rows.length, skipped: 0 }, file.size, progress)
    return { ...loaded, outcome: 'replaced' }
  },

  updatePreview: async ({ id, file, sheet, dateColumn }, progress) => {
    const meta = await getMeta(id)
    if (!meta) throw new Error('Dataset not found.')
    const model = normalizeModel(meta.model)
    progress(0.1, `Reading ${file.name}`)
    // the new file is read with the same settings as the original (delimiter, encoding, header row…)
    const mine = ++epoch
    const parsed = await parseFile(file, { ...model.options, sheet: sheet ?? model.options.sheet ?? meta.sheet, rowLimit: undefined }, (f, l) => progress(0.1 + f * 0.8, l), { cancelled: () => mine !== epoch })
    if (mine !== epoch) throw new ImportCancelled()
    const s = (sheet && parsed.sheets.find((x) => x.name === sheet)) || parsed.sheets.find((x) => x.name === (model.options.sheet ?? meta.sheet)) || parsed.sheets[0]
    const current = await source(id)
    const token = Math.random().toString(36).slice(2)
    pendingUpdate = { token, id, fileName: file.name, bytes: file.size, headers: s.headers, rows: s.rows }
    const check = compareHeaders(current.headers, s.headers)
    const key = guessKey(check.matched.map((m) => m.old), current.rows)
    let dates: UpdatePreview['dates']
    const incomingDate = dateColumn ? check.matched.find((x) => x.old === dateColumn)?.incoming : undefined
    if (dateColumn && incomingDate) {
      const dayFirst = model.options.dateOrder === 'dmy'
      const range = (rows: RawRow[], h: string): [number, number] => {
        let lo = Infinity, hi = -Infinity
        for (const r of rows) { const t = coerce(r[h], { type: 'date' }, dayFirst); if (typeof t === 'number') { if (t < lo) lo = t; if (t > hi) hi = t } }
        return [lo, hi]
      }
      const existing = range(current.rows, dateColumn)
      const incoming = range(s.rows, incomingDate)
      let overlapping = 0
      for (const r of s.rows) { const t = coerce(r[incomingDate], { type: 'date' }, dayFirst); if (typeof t === 'number' && t <= existing[1]) overlapping++ }
      if (Number.isFinite(existing[0]) && Number.isFinite(incoming[0])) dates = { column: dateColumn, existing, incoming, overlapping }
    }
    const res: UpdatePreview = {
      token, fileName: file.name, bytes: file.size, sheets: parsed.sheets.map((x) => x.name), sheet: s.name,
      incomingHeaders: s.headers, sample: s.rows.slice(0, 50), rowCount: s.rows.length,
      existingHeaders: current.headers, existingRows: current.rows.length, check, suggestedKey: key, dates,
      checks: checkIncoming(current.headers, current.rows, s.rows, Object.fromEntries(check.matched.map((m) => [m.old, m.incoming])),
        { now: Date.now(), overrides: model.overrides, dateOrder: model.options.dateOrder, decimal: model.options.decimal, softBlanks: model.options.softBlanks }),
    }
    return res
  },

  updateChecks: async ({ id, token, mapping }) => {
    if (!pendingUpdate || pendingUpdate.token !== token || pendingUpdate.id !== id) return []
    const meta = await getMeta(id)
    if (!meta) return []
    const model = normalizeModel(meta.model)
    const current = await source(id)
    return checkIncoming(current.headers, current.rows, pendingUpdate.rows, mapping,
      { now: Date.now(), overrides: model.overrides, dateOrder: model.options.dateOrder, decimal: model.options.decimal, softBlanks: model.options.softBlanks })
  },

  updateCommit: async ({ id, token, mode, mapping, dedupe, sync }, progress) => {
    if (!pendingUpdate || pendingUpdate.token !== token || pendingUpdate.id !== id) throw new Error('The update expired — please choose the file again.')
    const meta = await getMeta(id)
    if (!meta) throw new Error('Dataset not found.')
    const current = await source(id)
    progress(0.3, mode === 'append' ? 'Appending rows' : 'Replacing rows')
    const merged = mergeRows(current.headers, current.rows, pendingUpdate.headers, pendingUpdate.rows, { mode, mapping, dedupe, sync })
    const next: StoredSource = { id, headers: merged.headers, rows: merged.rows }
    const bytes = mode === 'append' ? (meta.bytes ?? 0) + pendingUpdate.bytes : pendingUpdate.bytes
    const loaded = await swapIn(meta, current, next, { mode, fileName: pendingUpdate.fileName, added: merged.added, updated: merged.updated, skipped: merged.skipped, removed: merged.removed || undefined }, bytes, progress)
    pendingUpdate = null
    return { ...loaded, added: merged.added, updated: merged.updated, skipped: merged.skipped, removed: merged.removed }
  },

  restoreVersion: async ({ id, key }, progress) => {
    const meta = await getMeta(id)
    if (!meta) throw new Error('Dataset not found.')
    const versions = await versionsOf(meta)
    const v = key ? versions.find((x) => x.key === key) : versions[0]
    const saved = v && await getSource(v.key)
    if (!v || !saved) throw new Error('There is no earlier version of this data to restore.')
    const current = await source(id)
    const when = new Date(v.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    const loaded = await swapIn(meta, current, { ...saved, id }, { mode: 'restore', fileName: `version from ${when}`, added: 0, skipped: 0 }, meta.bytes, progress, v.key)
    return { ...loaded, restored: v }
  },

  listVersions: async ({ id }) => {
    const meta = await getMeta(id)
    return meta ? versionsOf(meta) : []
  },

  deleteVersion: async ({ id, key }) => {
    const meta = await getMeta(id)
    if (!meta) throw new Error('Dataset not found.')
    const versions = (await versionsOf(meta)).filter((v) => v.key !== key)
    await deleteSource(key)
    const next = { ...meta, source: { ...meta.source, versions } }
    await putMeta(next)
    return next
  },

  clearVersions: async ({ id }) => {
    const meta = await getMeta(id)
    if (!meta) throw new Error('Dataset not found.')
    // versions share the dataset's key prefix with its linked file handle: keep that one
    const handle = await getHandle(id).catch(() => undefined)
    await deleteVersions(id)
    if (handle) await putHandle(id, handle).catch(() => {})
    const next = { ...meta, source: { ...meta.source, versions: [] } }
    await putMeta(next)
    return next
  },

  updateMeta: async ({ id, patch }) => {
    const meta = await getMeta(id)
    if (!meta) throw new Error('Dataset not found.')
    const next = { ...meta, ...patch }
    await putMeta(next)
    return next
  },

  delete: async ({ id }) => {
    const meta = await getMeta(id)
    if (!meta) return null
    // nothing is erased yet: rows, saved versions and the dashboard stay until the retention window ends
    const next = { ...meta, trashedAt: Date.now() }
    await putMeta(next)
    cache.delete(id)
    return next
  },

  undelete: async ({ id }) => {
    const meta = await getMeta(id)
    if (!meta) return null
    const { trashedAt: _, ...rest } = meta
    await putMeta(rest)
    return { ...rest, model: normalizeModel(rest.model) }
  },

  listTrash: async () => (await sweep()).trashed,

  purge: async ({ id }) => {
    const { trashed } = await sweep()
    for (const m of trashed) if (!id || m.id === id) { await deleteStored(m.id); cache.delete(m.id) }
    return null
  },

  backupExport: async ({ includeData, settings, appVersion }, progress) => {
    const { live } = await sweep()
    const dashboards = await listDashboards()
    const items: BackupInput[] = []
    for (let i = 0; i < live.length; i++) {
      progress(0.05 + (0.8 * i) / Math.max(1, live.length), `Backing up ${live[i].name}`)
      const src = includeData ? await getSource(live[i].id).catch(() => undefined) : undefined
      items.push({ meta: live[i], dashboard: dashboards[live[i].id], source: src })
    }
    const { parts, skipped } = await buildArchive(items, { includeData, settings, appVersion })
    return { blob: new Blob(parts, { type: 'application/json' }), datasets: live.length, skipped }
  },

  backupInspect: async ({ file }) => {
    const a = await readBackup(file)
    const { live } = await sweep()
    const merge = planRestore(a, live, 'merge')
    return {
      createdAt: a.createdAt, includesData: a.includesData,
      datasets: a.manifest.map((m) => ({ name: m.name, rows: m.rows, hasData: m.hasData })),
      conflicts: merge.conflicts, merge: summarize(merge), copy: summarize(planRestore(a, live, 'copy')),
    }
  },

  backupRestore: async ({ file, mode }, progress) => {
    // everything is read and checked before the first write; the write itself is one transaction
    progress(0.1, 'Checking the backup')
    const a = await readBackup(file)
    const { live } = await sweep()
    const plan = planRestore(a, live, mode)
    progress(0.5, 'Restoring')
    await writeAll(plan.items.filter((i) => i.action !== 'skip' && i.meta).map((i) => ({ meta: i.meta!, dashboard: i.dashboard, data: i.data })))
    for (const i of plan.items) if (i.meta) cache.delete(i.meta.id)
    return { ...summarize(plan), prefs: a.settings ?? {} }
  },

  source: async ({ id }) => {
    const src = await source(id).catch(() => null)
    return src ? { headers: src.headers, rows: src.rows } : null
  },
}

ctx.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const { id, type, payload } = ev.data
  const post = (m: FromWorker) => ctx.postMessage(m)
  let last = 0
  const progress: Progress = (fraction, label) => {
    const now = performance.now()
    if (now - last < 80 && fraction < 1) return
    last = now
    post({ id, kind: 'progress', fraction, label })
  }
  try {
    const result = await (handlers[type] as (r: unknown, p: Progress) => Promise<unknown>)(payload, progress)
    post({ id, kind: 'result', result })
  } catch (e) {
    const err = e as Error
    post({ id, kind: 'error', message: err?.message ?? String(e), name: err?.name })
  }
}
