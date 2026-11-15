// Removing a dataset: when to ask first, and how long it can still be brought back.

import type { Dashboard, DatasetMeta } from '../types'
import { TRASH_MS } from './db'

/** Work that would be lost with the dataset. An empty list means nothing was built on it: no need to ask. */
export function workAtStake(meta: DatasetMeta, dash?: Dashboard): string[] {
  const out: string[] = []
  if (dash?.edited) out.push('a dashboard you changed')
  const prep = meta.model.prep.length
  if (prep) out.push(`${prep} preparation step${prep > 1 ? 's' : ''}`)
  const formulas = meta.model.computed.length + meta.model.measures.length
  if (formulas) out.push(`${formulas} formula${formulas > 1 ? 's' : ''}`)
  const versions = meta.source.versions?.length ?? 0
  if (versions) out.push(`${versions} saved version${versions > 1 ? 's' : ''} of the data`)
  return out
}

/** Sample datasets ship with a showcase (prep steps, formulas): that is not the user's work. */
export const needsConfirm = (meta: DatasetMeta, dash?: Dashboard) =>
  meta.source.kind === 'sample' ? !!dash?.edited || !!meta.source.versions?.length : workAtStake(meta, dash).length > 0

/** Time left before a removed dataset is erased, in words. */
export function trashRemaining(meta: Pick<DatasetMeta, 'trashedAt'>, now: number): string {
  const left = (meta.trashedAt ?? now) + TRASH_MS - now
  if (left <= 0) return 'being erased'
  const hours = left / 3_600_000
  if (hours > 24) return `${Math.ceil(hours / 24)} days left`
  if (hours === 24) return '1 day left'
  if (hours >= 1) return `${Math.floor(hours)} hour${Math.floor(hours) > 1 ? 's' : ''} left`
  return 'under an hour left'
}
