// Keeps the address bar and the browser history in step with the view: Back goes to the previous view (or closes an
// open dialog first), and a reload or bookmark returns to the same dataset, tab and page.

import { formatRoute, parseRoute, sameRoute, sameView, type Route } from './lib/route'
import { useStore } from './store'

const current = (): Route => {
  const s = useStore.getState()
  const ds = s.active
  if (!ds) return { dataset: null, tab: 'dashboard' }
  return { dataset: ds.id, tab: s.tab, ...(s.tab === 'dashboard' ? { page: s.dashboards[ds.id]?.activePage } : {}) }
}

/** Closes the topmost dialog or editor. Returns false when nothing was open. */
function closeOverlay(): boolean {
  const s = useStore.getState()
  if (s.palette) { s.setPalette(false); return true }
  if (s.pending) { s.cancelImport(); return true }
  if (s.pendingUpdate) { s.cancelUpdate(); return true }
  if (s.formulaEditor) { s.closeFormula(); return true }
  if (s.rowsView) { s.showRows(null); return true }
  if (s.fullscreen) { s.setFullscreen(null); return true }
  if (s.gallery) { s.setGallery(false); return true }
  if (s.editing) { s.edit(null); return true }
  if (s.printing) { s.setPrinting(false); return true }
  return false
}

export function startRouteSync(): () => void {
  let applying = false
  let last = parseRoute(location.hash)

  const write = (r: Route, push: boolean) => {
    const url = `${location.pathname}${location.search}${formatRoute(r)}`
    if (push) history.pushState(null, '', url)
    else history.replaceState(null, '', url)
    last = r
  }

  // the store moved (a click in the app): a new history entry for a new view, none for edits
  const unsub = useStore.subscribe(() => {
    const s = useStore.getState()
    // while a dataset loads the view is in between: wait for it to land
    if (applying || !s.booted || s.progress) return
    const now = current()
    if (sameRoute(now, last)) return
    // the page id becoming known (first open) fills in the same entry
    write(now, !sameView(now, last))
  })

  const onPop = () => {
    // Back with a dialog or editor open closes it and stays on the view
    if (closeOverlay()) { write(last, true); return }
    const want = parseRoute(location.hash)
    const s = useStore.getState()
    const exists = want.dataset && s.metas.some((m) => m.id === want.dataset)
    applying = true
    last = exists ? want : { dataset: null, tab: 'dashboard' }
    void s.open(exists ? want.dataset : null, { tab: want.tab, page: want.page }).finally(() => {
      applying = false
      const now = current()
      if (!sameRoute(now, last)) write(now, false)
    })
  }
  window.addEventListener('popstate', onPop)
  return () => { unsub(); window.removeEventListener('popstate', onPop) }
}
