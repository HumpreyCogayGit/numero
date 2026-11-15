// Scheduled refresh of URL sources: one status per dataset in place of a toast per attempt, with back-off after failures.

import type { FetchFailure } from './fetchFile'

export interface RefreshStatus {
  /** ok: last attempt worked; failing: retrying with back-off; offline: waiting for a connection; paused: needs a decision */
  state: 'ok' | 'failing' | 'offline' | 'paused'
  /** consecutive failures */
  failures: number
  /** what to tell the user */
  message?: string
  /** when the source was last reached, and whether that brought new data */
  checkedAt?: number
  changed?: boolean
  /** scheduled attempts wait until this time */
  nextAt?: number
  /** paused: columns the download no longer has */
  missing?: string[]
}

export type RefreshEvent =
  | { type: 'replaced' | 'unchanged'; at: number }
  | { type: 'failed'; at: number; kind: FetchFailure | 'error'; message: string; intervalMinutes?: number }
  | { type: 'blocked'; at: number; missing: string[] }

export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000

/** Wait before the next scheduled attempt: the interval doubled per consecutive failure, capped at six hours. */
export function backoffMs(failures: number, intervalMinutes = 15): number {
  if (failures <= 0) return 0
  return Math.min(MAX_BACKOFF_MS, intervalMinutes * 60_000 * 2 ** Math.min(failures, 10))
}

export function nextStatus(prev: RefreshStatus | undefined, ev: RefreshEvent): RefreshStatus {
  switch (ev.type) {
    case 'replaced': return { state: 'ok', failures: 0, checkedAt: ev.at, changed: true }
    case 'unchanged': return { state: 'ok', failures: 0, checkedAt: ev.at, changed: false }
    case 'blocked': return { state: 'paused', failures: 0, checkedAt: ev.at, missing: ev.missing, message: `Refresh paused: the source no longer has ${list(ev.missing)}.` }
    case 'failed': {
      // being offline is not the source's fault: wait for the connection, keep the failure count
      if (ev.kind === 'offline') return { ...prev, state: 'offline', failures: prev?.failures ?? 0, message: 'Offline — the refresh will run when the connection is back.' }
      if (ev.kind === 'cancelled' || ev.kind === 'declined') return prev ?? { state: 'ok', failures: 0 }
      const failures = (prev?.failures ?? 0) + 1
      return { ...prev, state: 'failing', failures, message: ev.message, nextAt: ev.at + backoffMs(failures, ev.intervalMinutes) }
    }
  }
}

/** Whether a scheduled tick should run now. Manual refreshes always run. */
export function dueNow(status: RefreshStatus | undefined, now: number, online: boolean): boolean {
  if (!online) return false
  if (!status) return true
  if (status.state === 'paused') return false
  return status.nextAt == null || now >= status.nextAt
}

const list = (xs: string[]) => (xs.length <= 3 ? xs.map((x) => `“${x}”`).join(', ') : `${xs.slice(0, 3).map((x) => `“${x}”`).join(', ')} and ${xs.length - 3} more`)

/** One line for the header: "Checked 10:42 · no change", "Refresh failing (3×) · next try 11:15"… */
export function describeStatus(s: RefreshStatus | undefined, fmtTime: (t: number) => string): string | null {
  if (!s) return null
  if (s.state === 'offline') return 'Offline · refresh waiting'
  if (s.state === 'paused') return 'Refresh paused · columns changed'
  if (s.state === 'failing') return `Refresh failing${s.failures > 1 ? ` (${s.failures}×)` : ''}${s.nextAt ? ` · next try ${fmtTime(s.nextAt)}` : ''}`
  if (s.checkedAt == null) return null
  return s.changed ? `Refreshed ${fmtTime(s.checkedAt)}` : `Checked ${fmtTime(s.checkedAt)} · no change`
}
