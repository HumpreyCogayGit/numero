// Numero service worker (generated at build time from pwa/sw.template.js).
// The app shell is precached, so Numero opens offline; data never leaves the device anyway.
const VERSION = '__VERSION__'
const SHELL = __SHELL__
const APP = `numero-app-${VERSION}`
// samples outlive app versions
const DATA = 'numero-data'
const INDEX = new URL('./', self.location).href
// module scripts are requested with an Origin header and servers often answer "Vary: Origin"; the precached copy is the same file
const match = (req) => caches.match(req, { ignoreVary: true })

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('numero-app-') && k !== APP).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

const put = (cache, req, res) => { if (res.ok || res.type === 'opaque') caches.open(cache).then((c) => c.put(req, res)) }

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // pages: the network first (fresh deploys), the cached shell when offline
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => { put(APP, INDEX, res.clone()); return res }).catch(() => match(INDEX)))
    return
  }
  const same = url.origin === self.location.origin
  // hashed build files never change: cache first
  if (same && url.pathname.includes('/assets/')) {
    e.respondWith(match(req).then((hit) => hit ?? fetch(req).then((res) => { put(APP, req, res.clone()); return res })))
    return
  }
  // samples, maps and icons: serve what's cached, refresh in the background.
  // Requests to other sites (URL imports the user asked for) are never touched or cached here.
  if (same) {
    if (req.cache === 'no-store') return
    e.respondWith(match(req).then((hit) => {
      const net = fetch(req).then((res) => { put(DATA, req, res.clone()); return res }).catch(() => hit)
      return hit ?? net
    }))
  }
})
