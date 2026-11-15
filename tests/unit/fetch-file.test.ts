import { describe, expect, it, vi } from 'vitest'
import { FetchError, fetchFile } from '../../src/lib/fetchFile'
import { backoffMs, describeStatus, dueNow, MAX_BACKOFF_MS, nextStatus, type RefreshStatus } from '../../src/lib/refresh'

const enc = new TextEncoder()
/** A streamed response; `delay` waits between pieces and honours the abort signal like a real fetch. */
function fakeFetch(o: { status?: number; statusText?: string; pieces?: string[]; length?: number | null; delay?: number; hang?: boolean; fail?: Error; type?: string }): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal
    const aborted = () => new DOMException('Aborted', 'AbortError')
    if (o.fail) throw o.fail
    if (o.hang) await new Promise((_, rej) => signal?.addEventListener('abort', () => rej(aborted())))
    const pieces = o.pieces ?? ['a,b\n1,2\n']
    let i = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (signal?.aborted) { c.error(aborted()); return }
        if (o.delay) await new Promise<void>((res, rej) => { const t = setTimeout(res, o.delay); signal?.addEventListener('abort', () => { clearTimeout(t); rej(aborted()) }) }).catch((e) => { c.error(e); throw e })
        if (i < pieces.length) c.enqueue(enc.encode(pieces[i++]))
        else c.close()
      },
    })
    const headers = new Headers({ 'content-type': o.type ?? 'text/csv' })
    const total = o.length === undefined ? pieces.join('').length : o.length
    if (total != null) headers.set('content-length', String(total))
    return new Response(body, { status: o.status ?? 200, statusText: o.statusText ?? '', headers })
  }) as typeof fetch
}
const failure = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure') }, (e: unknown) => e as FetchError)

describe('abortable, bounded URL downloads', () => {
  it('downloads with byte progress when the size is announced', async () => {
    const seen: [number, number | undefined][] = []
    const r = await fetchFile('https://x.test/a.csv', { fetchImpl: fakeFetch({ pieces: ['a,b\n', '1,2\n', '3,4\n'] }), onProgress: (n, t) => seen.push([n, t]) })
    expect(await r.blob.text()).toBe('a,b\n1,2\n3,4\n')
    expect(r).toMatchObject({ bytes: 12, contentType: 'text/csv' })
    expect(seen).toEqual([[4, 12], [8, 12], [12, 12]])
  })
  it('reports progress without a total when the server does not say (indeterminate)', async () => {
    const seen: (number | undefined)[] = []
    await fetchFile('https://x.test/a.csv', { fetchImpl: fakeFetch({ length: null }), onProgress: (_, t) => seen.push(t) })
    expect(seen).toEqual([undefined])
  })
  it('cancel stops the request: nothing arrives afterwards', async () => {
    const ctl = new AbortController()
    const onProgress = vi.fn()
    const p = fetchFile('https://x.test/slow.csv', { fetchImpl: fakeFetch({ pieces: ['a', 'b', 'c', 'd'], delay: 30 }), signal: ctl.signal, onProgress })
    setTimeout(() => ctl.abort(), 45)
    const e = await failure(p)
    expect(e).toBeInstanceOf(FetchError)
    expect(e.kind).toBe('cancelled')
    const calls = onProgress.mock.calls.length
    await new Promise((r) => setTimeout(r, 120))
    expect(onProgress.mock.calls.length).toBe(calls)
    // already cancelled before it starts
    const pre = new AbortController()
    pre.abort()
    expect((await failure(fetchFile('https://x.test/a.csv', { fetchImpl: fakeFetch({}), signal: pre.signal }))).kind).toBe('cancelled')
  })
  it('times out a server that never answers, and one that stalls mid-download, with advice to retry', async () => {
    const e = await failure(fetchFile('https://x.test/hang.csv', { fetchImpl: fakeFetch({ hang: true }), timeoutMs: 40 }))
    expect(e.kind).toBe('timeout')
    expect(e.message).toMatch(/did not answer within .* try again/)
    const stall = await failure(fetchFile('https://x.test/stall.csv', { fetchImpl: fakeFetch({ pieces: ['a', 'b'], delay: 200 }), timeoutMs: 40 }))
    expect(stall.kind).toBe('timeout')
  })
  it('HTTP failures carry the status and guidance that differs from a timeout', async () => {
    const e404 = await failure(fetchFile('https://x.test/missing.csv', { fetchImpl: fakeFetch({ status: 404, statusText: 'Not Found' }) }))
    expect(e404).toMatchObject({ kind: 'http', status: 404 })
    expect(e404.message).toBe('The server answered 404 Not Found. Nothing is published at that address — check the link.')
    const e403 = await failure(fetchFile('https://x.test/private.csv', { fetchImpl: fakeFetch({ status: 403 }) }))
    expect(e403.message).toMatch(/sign-in|public access/)
    const e503 = await failure(fetchFile('https://x.test/down.csv', { fetchImpl: fakeFetch({ status: 503 }) }))
    expect(e503.message).toMatch(/server had a problem/)
    expect(e404.message).not.toMatch(/did not answer/)
  })
  it('tells offline apart from a blocked or wrong address (likely CORS)', async () => {
    const offline = await failure(fetchFile('https://x.test/a.csv', { fetchImpl: fakeFetch({}), online: () => false }))
    expect(offline.kind).toBe('offline')
    expect(offline.message).toMatch(/offline/i)
    const cors = await failure(fetchFile('https://x.test/a.csv', { fetchImpl: fakeFetch({ fail: new TypeError('Failed to fetch') }), online: () => true }))
    expect(cors.kind).toBe('network')
    expect(cors.message).toMatch(/Could not download that URL.*CORS/)
    // the connection dropping part-way is offline, not CORS
    let up = true
    const dropped = await failure(fetchFile('https://x.test/a.csv', { fetchImpl: (async () => { up = false; throw new TypeError('network error') }) as unknown as typeof fetch, online: () => up }))
    expect(dropped.kind).toBe('offline')
  })
  it('asks before a download announced as large, and stops when the answer is no', async () => {
    const confirmLarge = vi.fn(async () => false)
    const e = await failure(fetchFile('https://x.test/big.csv', { fetchImpl: fakeFetch({ length: 5000 }), confirmBytes: 1000, confirmLarge }))
    expect(confirmLarge).toHaveBeenCalledWith(5000)
    expect(e.kind).toBe('declined')
    const yes = await fetchFile('https://x.test/big.csv', { fetchImpl: fakeFetch({ length: 5000 }), confirmBytes: 1000, confirmLarge: async () => true })
    expect(yes.bytes).toBe(8)
    // small or unannounced downloads are not asked about
    const quiet = vi.fn(async () => true)
    await fetchFile('https://x.test/small.csv', { fetchImpl: fakeFetch({}), confirmBytes: 1000, confirmLarge: quiet })
    expect(quiet).not.toHaveBeenCalled()
  })
  it('a missing or dishonest Content-Length does not get past the hard cap', async () => {
    const pieces = Array.from({ length: 50 }, () => 'x'.repeat(100))
    const none = await failure(fetchFile('https://x.test/big.csv', { fetchImpl: fakeFetch({ pieces, length: null }), maxBytes: 1000 }))
    expect(none.kind).toBe('too-large')
    const lying = await failure(fetchFile('https://x.test/big.csv', { fetchImpl: fakeFetch({ pieces, length: 10 }), maxBytes: 1000 }))
    expect(lying.kind).toBe('too-large')
    expect(lying.message).toMatch(/row limit/)
    const honest = await failure(fetchFile('https://x.test/big.csv', { fetchImpl: fakeFetch({ pieces, length: 5000 }), maxBytes: 1000 }))
    expect(honest.kind).toBe('too-large')
  })
  it('a retry after a failure succeeds', async () => {
    let n = 0
    const flaky = (async (...a: Parameters<typeof fetch>) => (n++ === 0 ? Promise.reject(new TypeError('Failed to fetch')) : fakeFetch({})(...a))) as typeof fetch
    expect((await failure(fetchFile('https://x.test/a.csv', { fetchImpl: flaky }))).kind).toBe('network')
    expect((await fetchFile('https://x.test/a.csv', { fetchImpl: flaky })).bytes).toBe(8)
  })
})

describe('R7 scheduled refresh: one status, back-off after failures', () => {
  const at = 1_000_000
  it('backs off by doubling the interval, capped', () => {
    expect(backoffMs(0)).toBe(0)
    expect(backoffMs(1, 5)).toBe(10 * 60_000)
    expect(backoffMs(2, 5)).toBe(20 * 60_000)
    expect(backoffMs(3, 5)).toBe(40 * 60_000)
    expect(backoffMs(30, 60)).toBe(MAX_BACKOFF_MS)
  })
  it('repeated failures count up and postpone the next scheduled attempt; a success clears them', () => {
    let s: RefreshStatus | undefined
    s = nextStatus(s, { type: 'failed', at, kind: 'http', message: 'The server answered 500.', intervalMinutes: 5 })
    expect(s).toMatchObject({ state: 'failing', failures: 1, nextAt: at + 10 * 60_000 })
    expect(dueNow(s, at + 5 * 60_000, true)).toBe(false)
    expect(dueNow(s, at + 10 * 60_000, true)).toBe(true)
    s = nextStatus(s, { type: 'failed', at, kind: 'network', message: 'x', intervalMinutes: 5 })
    expect(s).toMatchObject({ failures: 2, nextAt: at + 20 * 60_000 })
    expect(describeStatus(s, () => '11:15')).toBe('Refresh failing (2×) · next try 11:15')
    s = nextStatus(s, { type: 'unchanged', at: at + 1 })
    expect(s).toEqual({ state: 'ok', failures: 0, checkedAt: at + 1, changed: false })
    expect(dueNow(s, at + 2, true)).toBe(true)
  })
  it('says "checked, no change" apart from a refresh that brought new data', () => {
    expect(describeStatus(nextStatus(undefined, { type: 'unchanged', at }), () => '10:42')).toBe('Checked 10:42 · no change')
    expect(describeStatus(nextStatus(undefined, { type: 'replaced', at }), () => '10:42')).toBe('Refreshed 10:42')
  })
  it('offline is a postponement, not a failure: no back-off, and nothing runs until the connection returns', () => {
    const s = nextStatus({ state: 'ok', failures: 0, checkedAt: 5 }, { type: 'failed', at, kind: 'offline', message: 'offline' })
    expect(s).toMatchObject({ state: 'offline', failures: 0, checkedAt: 5 })
    expect(s.nextAt).toBeUndefined()
    expect(describeStatus(s, String)).toBe('Offline · refresh waiting')
    expect(dueNow(s, at, false)).toBe(false)
    expect(dueNow(s, at, true)).toBe(true)
  })
  it('a source that dropped columns pauses the schedule until the user decides', () => {
    const s = nextStatus(undefined, { type: 'blocked', at, missing: ['wind', 'weather'] })
    expect(s).toMatchObject({ state: 'paused', missing: ['wind', 'weather'], message: 'Refresh paused: the source no longer has “wind”, “weather”.' })
    expect(dueNow(s, at + MAX_BACKOFF_MS * 2, true)).toBe(false)
  })
  it('a cancelled download changes nothing', () => {
    const prev: RefreshStatus = { state: 'ok', failures: 0, checkedAt: 1 }
    expect(nextStatus(prev, { type: 'failed', at, kind: 'cancelled', message: '' })).toBe(prev)
  })
})
