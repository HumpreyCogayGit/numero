import { expect, test } from '@playwright/test'
import { openSample } from './helpers'

test('web app manifest and icons are served', async ({ page, request }) => {
  await page.goto('/')
  const href = await page.locator('link[rel="manifest"]').getAttribute('href')
  const res = await request.get(href!)
  expect(res.ok()).toBe(true)
  const m = await res.json()
  expect(m).toMatchObject({ short_name: 'Numero', display: 'standalone', start_url: './' })
  for (const icon of m.icons as { src: string; sizes: string }[]) expect((await request.get(`/${icon.src}`)).ok(), icon.src).toBe(true)
  expect(m.icons.some((i: { sizes: string; purpose?: string }) => i.sizes === '512x512' && i.purpose === 'maskable')).toBe(true)
})

// the service worker only exists in production builds: BASE_URL=http://localhost:4173 with `npx vite preview`
test('works offline once loaded (production build)', async ({ page, context }) => {
  test.skip(!process.env.BASE_URL, 'needs the production preview (BASE_URL)')
  await page.goto('/')
  await page.evaluate(async () => {
    localStorage.clear()
    await new Promise<void>((res) => { const r = indexedDB.deleteDatabase('numero'); r.onsuccess = r.onerror = r.onblocked = () => res() })
  })
  await page.reload()
  await page.evaluate(() => navigator.serviceWorker.ready)
  await openSample(page, 'Seattle Weather')
  await expect(page.getByRole('group', { name: /^Total records\./ })).toContainText('1,461')

  // the built page carries a Content-Security-Policy, and nothing was fetched from another site (fonts included)
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  expect(csp).toContain("script-src 'self'")
  expect(csp).toContain("font-src 'self'")
  const foreign = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((u) => new URL(u).origin !== location.origin))
  expect(foreign).toEqual([])

  await context.setOffline(true)
  await expect(page.getByRole('status').filter({ hasText: 'Offline. Your datasets still work.' })).toBeVisible()
  await page.reload()
  // the app shell comes from the cache and the dataset from IndexedDB
  await expect(page.getByRole('group', { name: /^Total records\./ })).toContainText('1,461', { timeout: 20_000 })
  await page.getByRole('button', { name: 'Numero home' }).click()
  await openSample(page, 'Seattle Weather')
  // offline is shown as a state of the app, not as a failed download
  await expect(page.getByRole('status').filter({ hasText: 'Offline. Your datasets still work.' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await context.setOffline(false)
  await expect(page.getByRole('status').filter({ hasText: 'Offline. Your datasets still work.' })).toHaveCount(0)
})
