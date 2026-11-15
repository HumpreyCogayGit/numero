import type { Dataset } from '../types'
import { provenance } from '../lib/provenance'

/** Where the data came from and how fresh it is; opened from the dataset header. */
export function SourceInfo({ ds }: { ds: Dataset }) {
  const lines = provenance(ds)
  return (
    <div className="p-3 text-[12.5px]">
      <dl className="space-y-1.5">
        {lines.map((l) => (
          <div key={l.label} className="grid grid-cols-[88px_1fr] gap-2">
            <dt className="text-ink-3">{l.label}</dt>
            <dd className={l.tone === 'warn' ? 'break-words text-[#a86f00] dark:text-[#f0c060]' : 'break-words text-ink'}>{l.value}</dd>
          </div>
        ))}
      </dl>
      {!!ds.review?.checks.length && (
        <div className="mt-3 border-t border-line pt-2.5">
          <div className="text-[11.5px] font-medium text-ink-2">Noted when this file was imported</div>
          <ul className="mt-1 space-y-1 text-ink-2">
            {ds.review.checks.slice(0, 6).map((c, i) => <li key={i}>· {c.message}</li>)}
          </ul>
          {ds.review.checks.length > 6 && <div className="mt-1 text-ink-3">and {ds.review.checks.length - 6} more</div>}
        </div>
      )}
    </div>
  )
}
