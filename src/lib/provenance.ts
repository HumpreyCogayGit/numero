// Where a dataset came from and how fresh it is, as short labelled lines: for the header, print and shared files.
// Never includes a local file path (browsers don't expose one) or any row values.

import type { DatasetMeta } from '../types'

export interface ProvenanceLine { label: string; value: string; tone?: 'warn' }

const KIND: Record<DatasetMeta['source']['kind'], string> = { file: 'File on this device', url: 'Downloaded from a URL', paste: 'Pasted text', sample: 'Bundled sample' }

export function provenance(meta: DatasetMeta, fmt: (t: number) => string = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })): ProvenanceLine[] {
  const s = meta.source
  const out: ProvenanceLine[] = []
  out.push({ label: 'Source', value: `${KIND[s.kind]} · ${s.files?.length ? `${s.files.length} files combined (${s.files.join(', ')})` : meta.fileName}${meta.sheet ? ` · sheet “${meta.sheet}”` : ''}` })
  if (s.kind === 'url' && s.url) out.push({ label: 'Address', value: s.url })
  out.push({ label: 'Imported', value: fmt(meta.createdAt) })
  const last = s.updates?.[0]
  if (last) out.push({ label: 'Last change', value: `${fmt(last.at)} · ${last.mode} from ${last.fileName} · ${last.rowsBefore.toLocaleString()} → ${last.rowsAfter.toLocaleString()} rows` })
  if (s.kind === 'url') {
    out.push({ label: 'Refresh', value: s.refreshMinutes ? `Every ${s.refreshMinutes} minutes while open` : 'By hand' })
    if (s.lastChecked) out.push({ label: 'Last checked', value: `${fmt(s.lastChecked)}${s.lastLoaded && s.lastChecked > s.lastLoaded + 1000 ? ' · no change since the data was loaded' : ''}` })
  }
  out.push({ label: 'Rows', value: `${meta.rowCount.toLocaleString()} × ${meta.columnCount} columns` })
  if (s.truncated) out.push({ label: 'Row limit', value: `Only the first ${(s.rowLimit ?? meta.rowCount).toLocaleString()} rows of the file were imported — totals and trends cover that part only`, tone: 'warn' })
  if (s.ragged && s.ragged.long + s.ragged.short > 0) {
    out.push({ label: 'Uneven rows', value: `${(s.ragged.long + s.ragged.short).toLocaleString()} rows had more or fewer cells than the header${s.ragged.long ? ` (${s.ragged.long.toLocaleString()} lost extra cells)` : ''}`, tone: 'warn' })
  }
  const prep = meta.model.prep.filter((p) => !p.disabled).length
  if (prep) out.push({ label: 'Preparation', value: `${prep} step${prep > 1 ? 's' : ''} applied before charts` })
  return out
}

/** The part that travels in a shared dashboard file: no address beyond the host, no file list. */
export function sharedProvenance(meta: DatasetMeta) {
  const s = meta.source
  let host: string | undefined
  try { host = s.url ? new URL(s.url).host : undefined } catch { /* leave out */ }
  return {
    kind: s.kind,
    fileName: meta.fileName,
    ...(host ? { host } : {}),
    importedAt: new Date(meta.createdAt).toISOString(),
    ...(s.lastLoaded ? { lastLoadedAt: new Date(s.lastLoaded).toISOString() } : {}),
    rows: meta.rowCount,
    ...(s.truncated ? { truncated: true, rowLimit: s.rowLimit } : {}),
    prepSteps: meta.model.prep.filter((p) => !p.disabled).length,
  }
}
