// Whether the browser will keep stored datasets, said without storage jargon.
// Persistence is not a backup: it only asks the browser not to clear the data when the device runs low on space.

export type PersistState = 'persistent' | 'best-effort' | 'unsupported' | 'error'
export type PersistRequest = 'granted' | 'denied' | 'unsupported' | 'error'
export type QuotaLevel = 'ok' | 'warn' | 'critical' | 'unknown'

export interface StorageStatus {
  state: PersistState
  usage: number | null
  quota: number | null
  level: QuotaLevel
}

/** The parts of navigator.storage used here; passed in by tests. */
export type StorageApi = Partial<Pick<StorageManager, 'persisted' | 'persist' | 'estimate'>> | undefined

const api = (): StorageApi => (typeof navigator === 'undefined' ? undefined : navigator.storage)

export const WARN_SHARE = 0.8
export const CRITICAL_SHARE = 0.95

export function quotaLevel(usage: number | null, quota: number | null): QuotaLevel {
  if (usage == null || !quota) return 'unknown'
  const share = usage / quota
  return share >= CRITICAL_SHARE ? 'critical' : share >= WARN_SHARE ? 'warn' : 'ok'
}

export async function storageStatus(storage: StorageApi = api()): Promise<StorageStatus> {
  let state: PersistState = 'unsupported'
  if (typeof storage?.persisted === 'function') {
    try { state = (await storage.persisted()) ? 'persistent' : 'best-effort' } catch { state = 'error' }
  }
  let usage: number | null = null, quota: number | null = null
  if (typeof storage?.estimate === 'function') {
    try {
      const e = await storage.estimate()
      usage = e.usage ?? null
      quota = e.quota ?? null
    } catch { /* the estimate is a nicety */ }
  }
  return { state, usage, quota, level: quotaLevel(usage, quota) }
}

/** Asks the browser to keep this site's data. Never throws: every outcome leaves the app usable. */
export async function requestPersistence(storage: StorageApi = api()): Promise<PersistRequest> {
  if (typeof storage?.persist !== 'function') return 'unsupported'
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return 'granted'
    return (await storage.persist()) ? 'granted' : 'denied'
  } catch {
    return 'error'
  }
}

const ASKED_KEY = 'numero:persist-asked'

/**
 * Asks once, and only after the user has imported data of their own: never on first page load.
 * A refusal is remembered so the question (a permission prompt in some browsers) does not come back on every import.
 */
export async function requestPersistenceOnce(storage: StorageApi = api(), memory: Pick<Storage, 'getItem' | 'setItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): Promise<PersistRequest | 'already-asked'> {
  try { if (memory?.getItem(ASKED_KEY)) return 'already-asked' } catch { /* ask anyway */ }
  const result = await requestPersistence(storage)
  try { memory?.setItem(ASKED_KEY, result) } catch { /* ignore */ }
  return result
}

/** What the Storage dialog says, in plain words. */
export function describeStorage(s: StorageStatus): { headline: string; detail: string; tone: 'good' | 'neutral' | 'warn' } {
  const backup = 'Either way this is one copy in one browser — keep your source files, and export dashboards you care about.'
  switch (s.state) {
    case 'persistent': return { tone: 'good', headline: 'Kept until you remove it', detail: `This browser has agreed not to clear Numero’s data on its own. ${backup}` }
    case 'best-effort': return { tone: 'neutral', headline: 'Kept, unless the device runs low on space', detail: `The browser may clear Numero’s data if the device gets very full. ${backup}` }
    case 'unsupported': return { tone: 'neutral', headline: 'Kept by the browser', detail: `This browser does not say how long it keeps a site’s data, and may clear it when space runs low. ${backup}` }
    default: return { tone: 'warn', headline: 'Could not check how the data is kept', detail: `Numero could not ask the browser about its storage. Your data is still here. ${backup}` }
  }
}

export function quotaWarning(s: StorageStatus): string | null {
  if (s.level === 'critical') return 'Storage is almost full. New imports and saved versions may fail — remove datasets or old versions you no longer need.'
  if (s.level === 'warn') return 'Storage is getting full. Consider removing datasets or saved versions you no longer need.'
  return null
}
