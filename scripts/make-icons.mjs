// Renders the app icons (PNG) from the favicon's design, for the web app manifest and iOS home screens.
import { chromium } from '@playwright/test'

const glyph = (inset) => `<rect x="${8 + inset}" y="16" width="4" height="9" rx="1.5" fill="#fff"/><rect x="14" y="11" width="4" height="14" rx="1.5" fill="#fff"/><rect x="${20 - inset}" y="7" width="4" height="18" rx="1.5" fill="#fff" opacity=".75"/>`
// "any": rounded tile like the favicon; "maskable": full-bleed, glyph scaled into the 80% safe zone
const svg = (maskable) => maskable
  ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#2a78d6"/><g transform="translate(16 16) scale(.72) translate(-16 -16)">${glyph(0)}</g></svg>`
  : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2a78d6"/>${glyph(0)}</svg>`

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage()
for (const [name, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['maskable-512.png', 512, true], ['apple-touch-icon.png', 180, true]]) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml,${encodeURIComponent(svg(maskable))}" width="${size}" height="${size}">`)
  await page.locator('img').screenshot({ path: new URL(`../public/icons/${name}`, import.meta.url).pathname, omitBackground: !maskable })
}
await browser.close()
console.log('icons written to public/icons')
