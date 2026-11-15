import { describe, expect, it, vi } from 'vitest'
import { describeStorage, quotaLevel, quotaWarning, requestPersistence, requestPersistenceOnce, storageStatus, type StorageApi } from '../../src/lib/durability'

const api = (o: { persisted?: boolean | Error; persist?: boolean | Error; usage?: number; quota?: number; estimateFails?: boolean }): StorageApi => ({
  persisted: async () => { if (o.persisted instanceof Error) throw o.persisted; return !!o.persisted },
  persist: async () => { if (o.persist instanceof Error) throw o.persist; return !!o.persist },
  estimate: async () => { if (o.estimateFails) throw new Error('nope'); return { usage: o.usage, quota: o.quota } },
})
const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } }

describe('local data durability', () => {
  it('reports each state of the persistence API', async () => {
    expect((await storageStatus(api({ persisted: true, usage: 10, quota: 100 }))).state).toBe('persistent')
    expect((await storageStatus(api({ persisted: false }))).state).toBe('best-effort')
    expect((await storageStatus(undefined)).state).toBe('unsupported')
    expect((await storageStatus({})).state).toBe('unsupported')
    expect((await storageStatus(api({ persisted: new Error('SecurityError') }))).state).toBe('error')
  })
  it('a failing estimate still returns a usable status', async () => {
    expect(await storageStatus(api({ persisted: true, estimateFails: true }))).toEqual({ state: 'persistent', usage: null, quota: null, level: 'unknown' })
  })
  it('requesting: granted, denied, unsupported and failing all resolve — nothing throws', async () => {
    expect(await requestPersistence(api({ persist: true }))).toBe('granted')
    expect(await requestPersistence(api({ persist: false }))).toBe('denied')
    expect(await requestPersistence(undefined)).toBe('unsupported')
    expect(await requestPersistence({ estimate: async () => ({}) })).toBe('unsupported')
    expect(await requestPersistence(api({ persist: new Error('boom') }))).toBe('error')
    expect(await requestPersistence(api({ persisted: new Error('boom'), persist: true }))).toBe('error')
  })
  it('does not ask again when storage is already persistent', async () => {
    const a = api({ persisted: true })
    const persist = vi.spyOn(a!, 'persist')
    expect(await requestPersistence(a)).toBe('granted')
    expect(persist).not.toHaveBeenCalled()
  })
  it('asks once: a refusal is remembered and the prompt does not return on the next import', async () => {
    const a = api({ persist: false })
    const persist = vi.spyOn(a!, 'persist')
    const mem = memory()
    expect(await requestPersistenceOnce(a, mem)).toBe('denied')
    expect(await requestPersistenceOnce(a, mem)).toBe('already-asked')
    expect(persist).toHaveBeenCalledTimes(1)
    // storage that throws (private mode) must not break the request
    const broken = { getItem: () => { throw new Error('x') }, setItem: () => { throw new Error('x') } }
    expect(await requestPersistenceOnce(api({ persist: true }), broken)).toBe('granted')
  })
  it('quota levels: ok, warning at 80%, critical at 95%, unknown without numbers', () => {
    expect(quotaLevel(10, 100)).toBe('ok')
    expect(quotaLevel(80, 100)).toBe('warn')
    expect(quotaLevel(94, 100)).toBe('warn')
    expect(quotaLevel(95, 100)).toBe('critical')
    expect(quotaLevel(null, 100)).toBe('unknown')
    expect(quotaLevel(5, 0)).toBe('unknown')
    expect(quotaWarning({ state: 'persistent', usage: 10, quota: 100, level: 'ok' })).toBeNull()
    expect(quotaWarning({ state: 'persistent', usage: 85, quota: 100, level: 'warn' })).toMatch(/getting full/)
    expect(quotaWarning({ state: 'persistent', usage: 99, quota: 100, level: 'critical' })).toMatch(/almost full/)
  })
  it('describes every state without browser-storage terms, and never as a backup', () => {
    for (const state of ['persistent', 'best-effort', 'unsupported', 'error'] as const) {
      const d = describeStorage({ state, usage: null, quota: null, level: 'unknown' })
      expect(`${d.headline} ${d.detail}`).not.toMatch(/IndexedDB|persist|quota|evict|origin|best-effort|StorageManager/i)
      expect(d.detail).toMatch(/keep your source files/)
    }
    expect(describeStorage({ state: 'persistent', usage: 1, quota: 2, level: 'ok' }).headline).toBe('Kept until you remove it')
    expect(describeStorage({ state: 'best-effort', usage: 1, quota: 2, level: 'ok' }).headline).toBe('Kept, unless the device runs low on space')
  })
})
