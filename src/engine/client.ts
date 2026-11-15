import type { FromWorker, RequestType, Requests, ToWorker } from './protocol'

export type OnProgress = (fraction: number, label: string) => void

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: OnProgress }>()

function get(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (ev: MessageEvent<FromWorker>) => {
    const m = ev.data
    const p = pending.get(m.id)
    if (!p) return
    if (m.kind === 'progress') { p.onProgress?.(m.fraction, m.label); return }
    pending.delete(m.id)
    if (m.kind === 'result') p.resolve(m.result)
    else {
      const err = new Error(m.message)
      err.name = m.name ?? 'Error'
      p.reject(err)
    }
  }
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'The data engine crashed.'))
    pending.clear()
    worker = null
  }
  return worker
}

/** Calls the data engine worker; resolves with its result, reporting progress along the way. */
export function engine<K extends RequestType>(type: K, payload: Requests[K]['req'], onProgress?: OnProgress): Promise<Requests[K]['res']> {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress })
    get().postMessage({ id, type, payload } satisfies ToWorker)
  })
}
