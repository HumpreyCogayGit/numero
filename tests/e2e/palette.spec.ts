import { expect, test } from '@playwright/test'
import { freshApp, openSample } from './helpers'

test('command palette: jump to tabs, pages, charts and datasets; run actions', async ({ page }) => {
  const errors = await freshApp(page)
  await openSample(page, 'Seattle Weather')
  await page.getByRole('button', { name: 'Numero home' }).click()
  await openSample(page, 'Coffee Chain Sales', { showcase: true })
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('combobox')

  // a tab, by keyboard
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette).toBeVisible()
  await search.fill('insig')
  await expect(palette.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(palette).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Insights' })).toHaveAttribute('aria-selected', 'true')

  // a page
  await page.keyboard.press('ControlOrMeta+k')
  await search.fill('seasons')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tab', { name: /Seasons & channels — rename page/ })).toBeVisible()

  // a chart on the current page opens its editor; arrow keys pick among matches
  await page.keyboard.press('ControlOrMeta+k')
  await search.fill('orders by channel')
  await expect(palette.getByRole('option', { name: /Orders by channel/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator('aside input.field').first()).toHaveValue('Orders by channel')
  await page.getByRole('button', { name: 'Done' }).click()

  // another dataset, from the sidebar button
  await page.getByRole('button', { name: /Search & commands/ }).click()
  await search.fill('seattle')
  await palette.getByRole('option', { name: /seattle-weather/ }).click()
  await expect(page.getByRole('heading', { name: 'seattle-weather' })).toBeVisible()

  // an action and a setting; Escape closes
  await page.keyboard.press('ControlOrMeta+k')
  await search.fill('dark theme')
  await page.keyboard.press('Enter')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.keyboard.press('ControlOrMeta+k')
  await search.fill('zzzz nothing')
  await expect(palette).toContainText('Nothing matches')
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+k')
  await search.fill('add chart')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Add a chart' })).toBeVisible()
  expect(errors).toEqual([])
})
