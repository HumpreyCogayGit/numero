import { useState } from 'react'
import { Bookmark, BookmarkCheck, Check, RefreshCw, X } from 'lucide-react'
import type { Page } from '../types'
import { sameFilters } from '../lib/aggregate'
import { useStore } from '../store'
import { Button, cx, Popover } from './ui'

/** Saved views: named sets of this page's filters, one click to switch. */
export function ViewsMenu({ page }: { page: Page }) {
  const { saveView, applyView, updateView, removeView } = useStore.getState()
  const [name, setName] = useState('')
  const views = page.views ?? []
  const current = views.find((v) => sameFilters(v.filters, page.filters))
  return (
    <Popover width={280} label="Saved views" trigger={(_, toggle) => (
      <Button size="sm" variant="ghost" onClick={toggle} aria-label={current ? `Views: ${current.name}` : 'Views'}>
        {current ? <BookmarkCheck size={14} className="text-accent" /> : <Bookmark size={14} />}{current ? current.name : 'Views'}
      </Button>
    )}>
      {(close) => (
        <div className="p-1">
          {views.length > 0 ? (
            <ul aria-label="Saved views" className="mb-1">
              {views.map((v) => {
                const on = v === current
                return (
                  <li key={v.id} className="group flex items-center gap-1 rounded-lg hover:bg-surface-3">
                    <button className={cx('flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[13px]', on && 'font-medium text-accent-ink')} onClick={() => { applyView(v.id); close() }}>
                      <Check size={13} className={on ? 'shrink-0' : 'shrink-0 opacity-0'} />
                      <span className="truncate">{v.name}</span>
                      <span className="ml-auto shrink-0 text-[11px] font-normal text-ink-3">{v.filters.length ? `${v.filters.length} filter${v.filters.length > 1 ? 's' : ''}` : 'no filters'}</span>
                    </button>
                    {!on && <button aria-label={`Update ${v.name} with the current filters`} title="Save the current filters into this view" className="rounded p-1 text-ink-3 opacity-0 hover:text-ink group-hover:opacity-100 focus:opacity-100" onClick={() => updateView(v.id)}><RefreshCw size={12} /></button>}
                    <button aria-label={`Delete view ${v.name}`} className="mr-1 rounded p-1 text-ink-3 opacity-0 hover:text-bad group-hover:opacity-100 focus:opacity-100" onClick={() => removeView(v.id)}><X size={13} /></button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="px-2 pb-2 pt-1 text-[12px] text-ink-3">Save this page’s filters under a name, then switch between views in one click.</p>
          )}
          <form className="flex gap-1.5 border-t border-line px-1 pt-2" onSubmit={(e) => { e.preventDefault(); saveView(name); setName('') }}>
            <input aria-label="View name" className="field h-8" placeholder={`e.g. ${page.filters.length ? 'West, last quarter' : 'All data'}`} value={name} onChange={(e) => setName(e.target.value)} />
            <Button size="sm" type="submit" variant="primary">Save</Button>
          </form>
        </div>
      )}
    </Popover>
  )
}
