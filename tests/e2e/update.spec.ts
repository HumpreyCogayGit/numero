import { expect, test } from '@playwright/test'
import { fixture, freshApp, openSample } from './helpers'

test('append a new month to a designed dashboard, roll a relative filter forward, undo and redo', async ({ page }) => {
  const errors = await freshApp(page)
  await openSample(page, 'Coffee Chain Sales', { showcase: true })
  await expect(page.getByText('18,618 rows').first()).toBeVisible()

  // a page filter that should follow the data
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
  await page.getByRole('button', { name: 'Order Date', exact: true }).click()
  await page.getByRole('button', { name: 'Latest month' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /latest month · Jun 2025/ })).toBeVisible()

  await page.getByRole('button', { name: 'Update data' }).click()
  const dlg = page.getByRole('dialog', { name: /Update data/ })
  await dlg.getByRole('button', { name: /Try it: July 2025 orders/ }).click()
  await expect(dlg.getByRole('radio', { name: /Append new rows/ })).toHaveAttribute('aria-checked', 'true')
  await expect(dlg.getByText(/12 of 12 columns match/)).toBeVisible()
  await expect(dlg.getByText(/Jul 1, 2025 – Jul 31, 2025/)).toBeVisible()
  await expect(dlg.getByRole('combobox', { name: 'Match rows by' })).toHaveValue('Order ID')
  await dlg.getByRole('button', { name: 'Append and update dashboard' }).click()

  await expect(page.getByText(/Added [\d,]+ rows/)).toBeVisible()
  await expect(page.getByRole('button', { name: /latest month · Jul 2025/ })).toBeVisible()
  await expect(page.getByRole('group', { name: /^Revenue\./ })).toContainText('vs Jun 2025')
  const after = await page.locator('header').getByText(/[\d,]+ rows/).first().textContent()
  expect(after).not.toBe('18,618 rows')

  // undo from the toast restores the previous data; restoring again redoes
  await page.getByRole('button', { name: 'Undo' }).last().click()
  await expect(page.locator('header').getByText('18,618 rows')).toBeVisible()
  await expect(page.getByRole('button', { name: /latest month · Jun 2025/ })).toBeVisible()
  await page.getByRole('button', { name: 'Redo' }).last().click()
  await expect(page.locator('header').getByText(after!)).toBeVisible()

  // survives a reload, with history
  await page.reload()
  await page.getByRole('button', { name: /^coffee-chain-sales/ }).first().click()
  await expect(page.locator('header').getByText(after!)).toBeVisible()
  await page.getByRole('button', { name: 'Update data' }).click()
  await expect(page.getByRole('dialog').getByText(/restore/i).first()).toBeVisible()
  await expect(page.getByRole('dialog').getByText(/18,618 → /).first()).toBeVisible()
  expect(errors).toEqual([])
})

test('replace with a file whose columns changed: map renamed columns, blank the dropped ones', async ({ page }) => {
  await freshApp(page)
  await openSample(page, 'Seattle Weather')
  await page.getByRole('button', { name: 'Update data' }).click()
  const dlg = page.getByRole('dialog', { name: /Update data/ })
  await dlg.locator('input[type=file]').setInputFiles(fixture('seattle-2016-renamed.csv'))
  // a 60-row file vs 1,461 looks like a new period, so switch to replace explicitly
  await dlg.getByRole('radio', { name: /Replace all rows/ }).click()
  await expect(dlg.getByText(/Not found in the new file/)).toBeVisible()
  await expect(dlg.getByText(/Used by \d+ chart/).first()).toBeVisible()
  await dlg.getByRole('combobox', { name: 'Map temp_max' }).selectOption('max_temp')
  await dlg.getByRole('button', { name: 'Replace and update dashboard' }).click()
  await expect(page.getByText(/Replaced 1,461 rows with 60/)).toBeVisible()
  await expect(page.locator('header').getByText('60 rows')).toBeVisible()
  await expect(page.getByText(/Missing column/)).toHaveCount(0)
})

test('a row whose key is already loaded is overwritten, and several versions can be restored', async ({ page }) => {
  const errors = await freshApp(page)
  await openSample(page, 'Seattle Weather')
  const append = async (file: string) => {
    await page.getByRole('button', { name: 'Update data' }).click()
    const dlg = page.getByRole('dialog', { name: /Update data/ })
    await dlg.locator('input[type=file]').setInputFiles(fixture(file))
    await dlg.getByRole('combobox', { name: 'Match rows by' }).selectOption('date')
    await expect(dlg.getByText(/already loaded overwrites it/)).toBeVisible()
    await dlg.getByRole('button', { name: 'Append and update dashboard' }).click()
  }
  // 2015-12-31 comes back with a corrected temp_max; 2016-01-01 is new
  await append('seattle-correction.csv')
  // 1,462, not 1,463: the corrected day replaced its row instead of being added
  await expect(page.getByText('Added 1 rows (updated 1) · 1,462 rows now')).toBeVisible()

  await append('seattle-2016-01-02.csv')
  await expect(page.locator('header').getByText('1,463 rows')).toBeVisible()

  // both earlier versions are listed; going back to the original skips a step
  await page.getByRole('button', { name: 'Update data' }).click()
  const versions = page.getByRole('list', { name: 'Saved versions' }).getByRole('listitem')
  await expect(versions).toHaveCount(2)
  await expect(versions.nth(0)).toContainText('Before appending seattle-2016-01-02.csv')
  await expect(versions.nth(1)).toContainText('1,461 rows')
  await versions.nth(1).getByRole('button', { name: /^Restore/ }).click()
  await expect(page.locator('header').getByText('1,461 rows')).toBeVisible()
  await expect(page.getByText(/Restored the data from before appending seattle-correction\.csv/)).toBeVisible()

  // the data it replaced is now a version too, so nothing is lost
  await page.getByRole('button', { name: 'Update data' }).click()
  await expect(versions).toHaveCount(2)
  await expect(versions.nth(0)).toContainText('1,463 rows')
  await versions.nth(0).getByRole('button', { name: /^Restore/ }).click()
  await expect(page.locator('header').getByText('1,463 rows')).toBeVisible()
  expect(errors).toEqual([])
})
