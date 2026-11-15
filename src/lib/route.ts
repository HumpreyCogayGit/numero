// The open dataset, tab and page, written into the URL hash so Back, Forward, reload and bookmarks work.
//   #/d/<datasetId>            the dashboard tab, the dashboard's own active page
//   #/d/<datasetId>/<tab>      another tab
//   #/d/<datasetId>/dashboard/<pageId>

export const TAB_IDS = ['dashboard', 'insights', 'pivot', 'profile', 'data', 'prepare'] as const
export type RouteTab = (typeof TAB_IDS)[number]

export interface Route { dataset: string | null; tab: RouteTab; page?: string }

export const HOME: Route = { dataset: null, tab: 'dashboard' }

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p) } catch { return p } })
  if (parts[0] !== 'd' || !parts[1]) return HOME
  const tab = (TAB_IDS as readonly string[]).includes(parts[2]) ? (parts[2] as RouteTab) : 'dashboard'
  return { dataset: parts[1], tab, ...(tab === 'dashboard' && parts[3] ? { page: parts[3] } : {}) }
}

export function formatRoute(r: Route): string {
  if (!r.dataset) return '#/'
  const base = `#/d/${encodeURIComponent(r.dataset)}`
  if (r.tab === 'dashboard') return r.page ? `${base}/dashboard/${encodeURIComponent(r.page)}` : base
  return `${base}/${r.tab}`
}

export const sameRoute = (a: Route, b: Route) => a.dataset === b.dataset && a.tab === b.tab && (a.page ?? '') === (b.page ?? '')

/** Same view apart from the page being filled in (the dashboard's active page becoming known): not a navigation. */
export const sameView = (a: Route, b: Route) => a.dataset === b.dataset && a.tab === b.tab && (!a.page || !b.page || a.page === b.page)
