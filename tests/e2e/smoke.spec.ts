import { expect, test } from '@playwright/test'
import { freshApp, openSample, tab, typeFormula } from './helpers'

test('sample → dashboard → edit → filter → computed column → reload', async ({ page }) => {
  const errors = await freshApp(page)
  await openSample(page, 'Seattle Weather')

  // suggested dashboard
  await expect(page.getByRole('heading', { name: 'seattle-weather' })).toBeVisible()
  await expect(page.getByText('Total records')).toBeVisible()
  await expect(page.locator('canvas').first()).toBeVisible()

  // edit a widget's chart type
  await page.getByRole('heading', { name: 'Share by Weather' }).click()
  await page.getByRole('button', { name: /^Column/ }).click()
  await page.getByRole('button', { name: 'Done' }).click()

  // dashboard filter
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
  await page.getByRole('button', { name: 'Weather', exact: true }).click()
  await page.getByRole('checkbox', { name: 'rain' }).check()
  await page.keyboard.press('Escape')
  await expect(page.getByText('641', { exact: true }).first()).toBeVisible()

  // computed column
  await page.getByRole('button', { name: 'New column' }).click()
  await page.getByRole('textbox', { name: 'Column name' }).fill('Daily spread')
  await typeFormula(page, '[temp_max] - [temp_min]')
  await expect(page.getByText(/distinct · \d+ blank/)).toBeVisible()
  await page.getByRole('button', { name: 'Add column' }).click()

  // persisted after reload
  await page.reload()
  await page.getByRole('button', { name: /seattle-weather/ }).first().click()
  await tab(page, 'Data')
  await expect(page.getByRole('columnheader', { name: /Daily spread/ })).toBeVisible()
  await tab(page, 'Pivot')
  await expect(page.getByText(/Total/).first()).toBeVisible()
  expect(errors).toEqual([])
})
