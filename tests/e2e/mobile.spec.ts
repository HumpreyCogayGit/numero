import { expect, test } from '@playwright/test'
import { freshApp, openSample } from './helpers'

test('phone layout: no horizontal scroll, menu, dashboard and editor work', async ({ page }) => {
  const errors = await freshApp(page)
  const overflow = () => page.evaluate(() => { const m = document.querySelector('main')!; return m.scrollWidth - m.clientWidth })
  expect(await overflow()).toBeLessThanOrEqual(0)
  await openSample(page, 'Seattle Weather')
  await expect(page.getByRole('group', { name: /^Total records\./ })).toBeVisible()
  expect(await overflow()).toBeLessThanOrEqual(0)
  // R5: toasts use the width of the screen (16px gutters) instead of shrinking to half of it
  const toast = page.getByRole('status').filter({ hasText: /Showcase ready/ })
  await expect(toast).toBeVisible()
  const box = (await toast.boundingBox())!
  expect(box.width).toBeGreaterThan(page.viewportSize()!.width - 40)
  // open and close the sidebar
  await page.getByRole('button', { name: 'Open menu' }).click()
  await expect(page.getByRole('complementary', { name: 'Datasets' })).toBeInViewport()
  await page.getByRole('button', { name: 'Close menu' }).click()
  // widget editor takes the full width and closes
  await page.getByRole('group', { name: /^Share by Weather\./ }).getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByRole('button', { name: 'Done' })).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  expect(errors).toEqual([])
})
