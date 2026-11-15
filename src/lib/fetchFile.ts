// Downloading a file the user asked for by URL: cancellable, time-limited, size-checked, with errors told apart.

/** No response headers within this long: give up and say so. Applies again to each stall while the body downloads. */
export const FETCH_TIMEOUT_MS = 30_000
/** A download announced as larger than this asks first. */
export const CONFIRM_BYTES = 100 * 1024 * 1024
/** Never keep more than this in memory, whatever Content-Length says (or doesn't). */
export const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024

export type FetchFailure = 'cancelled' | 'timeout' | 'http' | 'offline' | 'network' | 'too-large' | 'declined'

export class FetchError extends Error {
  kind: FetchFailure
  status?: number
  constructor(kind: FetchFailure, message: string, status?: number) {
    super(message)
    this.name = 'FetchError'
    this.kind = kind
    this.status = status
  }
}

const mb = (n: number) => `${Math.round(n / (1024 * 1024)).toLocaleString()} MB`

const httpAdvice = (status: number) =>
  status === 401 || status === 403 ? 'The address needs a sign-in or does not allow public access — use a public link, or download the file and import it.'
    : status === 404 || status === 410 ? 'Nothing is published at that address — check the link.'
      : status === 429 ? 'The server is limiting requests — wait a little and try again.'
        : status >= 500 ? 'The server had a problem — try again in a moment.'
          : 'Check the link and try again.'

export interface FetchFileOptions {
  /** aborting it cancels the request and the body download */
  signal?: AbortSignal
  timeoutMs?: number
  /** called with bytes received and the announced total (undefined when the server does not say) */
  onProgress?: (received: number, total?: number) => void
  /** asked before a download announced as large; resolve false to stop */
  confirmLarge?: (bytes: number) => Promise<boolean>
  confirmBytes?: number
  maxBytes?: number
  cache?: RequestCache
  fetchImpl?: typeof fetch
  online?: () => boolean
}

/** Downloads a URL into memory. Every way it can fail arrives as a FetchError with a `kind` and a message that says what to do. */
export async function fetchFile(url: string, o: FetchFileOptions = {}): Promise<{ blob: Blob; contentType: string | null; bytes: number }> {
  const doFetch = o.fetchImpl ?? fetch
  const timeoutMs = o.timeoutMs ?? FETCH_TIMEOUT_MS
  const maxBytes = o.maxBytes ?? MAX_DOWNLOAD_BYTES
  const online = o.online ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false))
  if (o.signal?.aborted) throw new FetchError('cancelled', 'Download cancelled.')
  if (!online()) throw new FetchError('offline', 'You are offline. Data already imported keeps working; this download needs a connection — try again when you are back online.')

  const ctl = new AbortController()
  let reason: 'cancelled' | 'timeout' | 'too-large' | 'declined' | null = null
  const onAbort = () => { reason ??= 'cancelled'; ctl.abort() }
  o.signal?.addEventListener('abort', onAbort)
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { reason ??= 'timeout'; ctl.abort() }, timeoutMs) }
  const fail = (e: unknown): FetchError => {
    if (e instanceof FetchError) return e
    if (reason === 'cancelled') return new FetchError('cancelled', 'Download cancelled.')
    if (reason === 'timeout') return new FetchError('timeout', `The server did not answer within ${Math.round(timeoutMs / 1000)} seconds. It may be slow or unreachable — try again, or download the file and import it.`)
    if (reason === 'too-large') return new FetchError('too-large', `The download passed ${mb(maxBytes)} and was stopped — that is more than can be held in the browser. Download the file and import it with a row limit.`)
    if (reason === 'declined') return new FetchError('declined', 'Download cancelled.')
    if (!online()) return new FetchError('offline', 'The connection dropped during the download. Try again when you are back online.')
    return new FetchError('network', 'Could not download that URL. The server may not allow browser access (CORS), or the address is wrong. If the link opens in a browser tab, download the file and import it instead.')
  }

  try {
    arm()
    const res = await doFetch(url, { signal: ctl.signal, cache: o.cache })
    if (!res.ok) throw new FetchError('http', `The server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}. ${httpAdvice(res.status)}`, res.status)
    const announced = Number(res.headers.get('content-length'))
    const total = Number.isFinite(announced) && announced > 0 ? announced : undefined
    if (total != null && total > maxBytes) { reason = 'too-large'; ctl.abort(); throw fail(null) }
    if (total != null && total > (o.confirmBytes ?? CONFIRM_BYTES) && o.confirmLarge) {
      clearTimeout(timer)
      if (!(await o.confirmLarge(total))) { reason = 'declined'; ctl.abort(); throw fail(null) }
    }
    const contentType = res.headers.get('content-type')
    if (!res.body) {
      arm()
      const blob = await res.blob()
      if (blob.size > maxBytes) { reason = 'too-large'; throw fail(null) }
      o.onProgress?.(blob.size, total)
      return { blob, contentType, bytes: blob.size }
    }
    // read the body ourselves: byte progress, a stall timeout, and a hard cap that an absent or wrong Content-Length cannot get past
    const reader = res.body.getReader()
    const parts: Uint8Array[] = []
    let received = 0
    for (;;) {
      arm()
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) { reason = 'too-large'; ctl.abort(); void reader.cancel().catch(() => {}); throw fail(null) }
      parts.push(value)
      o.onProgress?.(received, total)
    }
    return { blob: new Blob(parts as BlobPart[], contentType ? { type: contentType } : undefined), contentType, bytes: received }
  } catch (e) {
    throw fail(e)
  } finally {
    clearTimeout(timer)
    o.signal?.removeEventListener('abort', onAbort)
  }
}
