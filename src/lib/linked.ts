// Linked source files: in Chromium browsers a dataset can remember the file it was updated from
// (File System Access API), so the next update re-reads it in one click. Elsewhere this is a no-op.

import { deleteHandle, getHandle, putHandle } from './db'

/** The parts of FileSystemFileHandle used here (the picker isn't in TypeScript's DOM types yet). */
export interface FileHandle {
  kind: 'file'
  name: string
  getFile(): Promise<File>
  queryPermission?(o: { mode: 'read' }): Promise<PermissionState>
  requestPermission?(o: { mode: 'read' }): Promise<PermissionState>
}
type Picker = (o: { multiple?: boolean; types?: { description: string; accept: Record<string, string[]> }[]; excludeAcceptAllOption?: boolean }) => Promise<FileHandle[]>

const picker = () => (typeof window !== 'undefined' ? (window as unknown as { showOpenFilePicker?: Picker }).showOpenFilePicker : undefined)
export const canLink = () => !!picker()

// handles that can't be stored (e.g. in a private window) still work for this session
const memory = new Map<string, FileHandle>()
// a picked file becomes the dataset's linked file only once its update is committed
const pending = new Map<string, { handle: FileHandle; file: File }>()

const TYPES = [{
  description: 'Data files',
  accept: {
    'text/csv': ['.csv', '.tsv', '.txt'],
    'application/json': ['.json', '.ndjson'],
    'application/vnd.ms-excel': ['.xls'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx', '.xlsm'],
  },
}]

/** Opens the file picker and returns the chosen file (null when cancelled); `confirmLink` links it after the update. */
export async function pickLinked(id: string): Promise<File | null> {
  const pick = picker()
  if (!pick) return null
  let handle: FileHandle
  try {
    [handle] = await pick({ multiple: false, types: TYPES })
  } catch {
    return null // the user closed the picker
  }
  const file = await handle.getFile()
  pending.set(id, { handle, file })
  return file
}

/** Links the picked file when the committed update used it (not a file dropped or chosen another way). */
export async function confirmLink(id: string, committed?: File) {
  const p = pending.get(id)
  pending.delete(id)
  if (!p || p.file !== committed) return
  const { handle } = p
  memory.set(id, handle)
  try { await putHandle(id, handle) } catch { /* kept in memory only */ }
}

export async function linkedHandle(id: string): Promise<FileHandle | undefined> {
  if (memory.has(id)) return memory.get(id)
  try {
    const h = (await getHandle(id)) as FileHandle | undefined
    if (h) memory.set(id, h)
    return h
  } catch {
    return undefined
  }
}

/** Re-reads the linked file, asking for permission again when the browser needs it (it does after a restart). */
export async function readLinked(id: string): Promise<File> {
  const h = await linkedHandle(id)
  if (!h) throw new Error('No file is linked to this dataset.')
  if (h.queryPermission && (await h.queryPermission({ mode: 'read' })) !== 'granted') {
    if (!h.requestPermission || (await h.requestPermission({ mode: 'read' })) !== 'granted') throw new Error(`Numero needs permission to read ${h.name}.`)
  }
  try {
    return await h.getFile()
  } catch {
    throw new Error(`${h.name} can’t be read any more — it may have been moved or deleted. Choose it again.`)
  }
}

/** Last-modified time when readable without prompting, so the dialog can say whether the file changed. */
export async function linkedModified(h: FileHandle): Promise<number | undefined> {
  try {
    if (h.queryPermission && (await h.queryPermission({ mode: 'read' })) !== 'granted') return undefined
    return (await h.getFile()).lastModified
  } catch {
    return undefined
  }
}

export async function unlink(id: string) {
  memory.delete(id)
  pending.delete(id)
  try { await deleteHandle(id) } catch { /* nothing stored */ }
}

/**
 * The linked file, when it changed after `since` and can be read without asking (browsers only prompt on a click).
 * Used when a dataset opens, to offer the update.
 */
export async function linkedChanged(id: string, since: number | undefined): Promise<File | null> {
  const h = await linkedHandle(id)
  if (!h || since == null) return null
  try {
    if (h.queryPermission && (await h.queryPermission({ mode: 'read' })) !== 'granted') return null
    const f = await h.getFile()
    return f.lastModified > since ? f : null
  } catch {
    return null
  }
}
