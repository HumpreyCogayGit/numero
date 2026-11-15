import { expect, type Page } from '@playwright/test'

/** Fresh app state: no stored datasets or dashboards, light theme. */
export async function freshApp(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto('/')
  await page.evaluate(async () => {
    localStorage.clear()
    localStorage.setItem('numero:theme', 'light')
    await new Promise<void>((res) => { const r = indexedDB.deleteDatabase('numero'); r.onsuccess = r.onerror = r.onblocked = () => res() })
  })
  await page.reload()
  await expect(page.getByRole('button', { name: /Drop a file here/ })).toBeVisible()
  return errors
}

/** Opens a sample; lands on its suggested "Overview" page unless `showcase` is set (samples open on their showcase page). */
export async function openSample(page: Page, title: string, opts: { showcase?: boolean } = {}) {
  await page.getByRole('button', { name: `Open sample ${title}` }).click()
  await expect(page.getByRole('tab', { name: 'Dashboard' })).toBeVisible({ timeout: 30_000 })
  if (!opts.showcase) {
    const overview = page.getByRole('tab', { name: 'Overview' })
    await expect(overview.or(page.getByRole('tab', { name: /Overview — rename page/ }))).toBeVisible()
    if (await overview.count()) await overview.click()
  }
}

export const fixture = (name: string) => new URL(`../fixtures/${name}`, import.meta.url).pathname

/** Calls a chart's click/drill handlers through the dev-only hook (canvas marks can't be targeted by selector). */
export async function chartAction(page: Page, cardTitle: string, action: 'click' | 'dblclick' | 'contextmenu', dataIndex: number, opts: { series?: number; shift?: boolean } = {}) {
  const card = page.getByRole('group', { name: new RegExp(`^${cardTitle}\\.`) })
  await card.locator('[role="img"]').first().evaluate((el, a) => {
    const hook = (el as HTMLElement & { __numero: { click: (d: number, s?: number, sh?: boolean) => void; dblclick: (d: number) => void; contextmenu: (d: number, s?: number) => void } }).__numero
    if (a.action === 'click') hook.click(a.dataIndex, a.series, a.shift)
    else if (a.action === 'contextmenu') hook.contextmenu(a.dataIndex, a.series)
    else hook.dblclick(a.dataIndex)
  }, { action, dataIndex, series: opts.series ?? 0, shift: !!opts.shift })
}

export async function tab(page: Page, name: string) {
  await page.getByRole('tab', { name }).click()
}

export async function typeFormula(page: Page, text: string) {
  const area = page.getByRole('textbox', { name: 'Formula' })
  await area.fill(text)
}
