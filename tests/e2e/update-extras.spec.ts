import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fixture, freshApp, openSample } from './helpers'

test('after an update, "What changed" sums up KPIs, movers and new values, and can be reopened', async ({ page }) => {
  const errors = await freshApp(page)
  await openSample(page, 'Coffee Chain Sales', { showcase: true })
  await page.getByRole('button', { name: 'Update data' }).click()
  const dlg = page.getByRole('dialog', { name: /Update data/ })
  await dlg.getByRole('button', { name: /Try it: July 2025 orders/ }).click()
  await expect(dlg.getByRole('region', { name: 'Data checks' })).toContainText('No problems found')
  await dlg.getByRole('button', { name: 'Append and update dashboard' }).click()

  const card = page.getByRole('region', { name: 'What changed' })
  await expect(card).toContainText('latest period Jul 2025, compared with Jun 2025')
  await expect(card).toContainText(/Revenue\$121K → \$128\.6K/)
  await expect(card).toContainText('Biggest movers · Jul 2025')
  await expect(card).toContainText('Iced coffee')
  await card.getByRole('button', { name: 'Dismiss what changed' }).click()
  await expect(card).toHaveCount(0)

  // kept with the update: reopen it from the history
  await page.getByRole('button', { name: 'Update data' }).click()
  await dlg.getByRole('button', { name: 'What changed' }).click()
  await expect(card).toContainText('Iced coffee')
  expect(errors).toEqual([])
})

test('data checks flag text in number columns, new blanks, negatives and future dates before loading', async ({ page }) => {
  await freshApp(page)
  await openSample(page, 'Seattle Weather')
  await page.getByRole('button', { name: 'Update data' }).click()
  const dlg = page.getByRole('dialog', { name: /Update data/ })
  await dlg.locator('input[type=file]').setInputFiles(fixture('seattle-bad.csv'))
  const checks = dlg.getByRole('region', { name: 'Data checks' })
  await expect(checks).toContainText('1 date in date is in the future (latest Jan 4, 2031)')
  await expect(checks).toContainText('1 negative value in precipitation')
  await expect(checks).toContainText('3 values in temp_max aren’t numbers')
  await expect(checks).toContainText('TBD')
  await expect(checks).toContainText('3 rows have no weather')
})

test('a linked file is re-read in one click (File System Access API)', async ({ page }) => {
  const csv = readFileSync(fixture('seattle-2016-01-02.csv'), 'utf8')
  // a stand-in picker: the real one opens a native dialog
  await page.addInitScript((text) => {
    const handle = {
      kind: 'file', name: 'seattle-latest.csv',
      getFile: async () => new File([text], 'seattle-latest.csv', { type: 'text/csv', lastModified: Date.UTC(2026, 0, 2) }),
      queryPermission: async () => 'granted', requestPermission: async () => 'granted',
    }
    ;(window as unknown as { showOpenFilePicker: () => Promise<unknown[]> }).showOpenFilePicker = async () => [handle]
  }, csv)
  const errors = await freshApp(page)
  await openSample(page, 'Seattle Weather')
  await page.getByRole('button', { name: 'Update data' }).click()
  const dlg = page.getByRole('dialog', { name: /Update data/ })
  await expect(dlg).toContainText('The file you choose is remembered')
  await dlg.getByRole('button', { name: 'Choose file' }).click()
  await expect(dlg).toContainText('seattle-latest.csv · 1 rows')
  await dlg.getByRole('button', { name: 'Append and update dashboard' }).click()
  await expect(page.locator('header').getByText('1,462 rows')).toBeVisible()

  await page.getByRole('button', { name: 'Update data' }).click()
  await expect(dlg).toContainText('Linked file · modified')
  await dlg.getByRole('button', { name: 'Update from seattle-latest.csv' }).click()
  await expect(dlg.getByRole('radio', { name: /Append new rows/ })).toBeVisible()
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Update data' }).click()
  await dlg.getByRole('button', { name: 'Unlink' }).click()
  await expect(dlg.getByRole('button', { name: /Update from/ })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('review fixes: checks follow manual mapping, undo clears "What changed", cancel doesn’t link, extra KPIs fold away', async ({ page }) => {
  // a stand-in picker that hands over the renamed file
  const csv = (await import('node:fs')).readFileSync(fixture('seattle-renamed-bad.csv'), 'utf8')
  await page.addInitScript((text) => {
    const handle = { kind: 'file', name: 'renamed.csv', getFile: async () => new File([text], 'renamed.csv', { type: 'text/csv' }), queryPermission: async () => 'granted', requestPermission: async () => 'granted' }
    ;(window as unknown as { showOpenFilePicker: () => Promise<unknown[]> }).showOpenFilePicker = async () => [handle]
  }, csv)
  const errors = await freshApp(page)
  await openSample(page, 'Seattle Weather')
  const dlg = page.getByRole('dialog', { name: /Update data/ })
  await page.getByRole('button', { name: 'Update data' }).click()
  await dlg.getByRole('button', { name: 'Choose file' }).click()
  const checks = dlg.getByRole('region', { name: 'Data checks' })
  await expect(checks).toContainText('No problems found')
  // R7: once temp_max is mapped to max_temp, its text values are checked too
  await dlg.getByRole('combobox', { name: 'Map temp_max' }).selectOption('max_temp')
  await expect(checks).toContainText('3 values in temp_max aren’t numbers')
  // R8: cancelling doesn't link the picked file
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Update data' }).click()
  await expect(dlg.getByRole('button', { name: /Update from/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // R9 and R1 on the coffee showcase
  await page.getByRole('button', { name: 'Numero home' }).click()
  await openSample(page, 'Coffee Chain Sales', { showcase: true })
  await page.getByRole('button', { name: 'Update data' }).click()
  await dlg.getByRole('button', { name: /Try it: July 2025 orders/ }).click()
  await dlg.getByRole('button', { name: 'Append and update dashboard' }).click()
  const card = page.getByRole('region', { name: 'What changed' })
  await expect(card).toContainText('Mobile share')
  await expect(card).not.toContainText('Sum of Unit Cost')
  await card.getByRole('button', { name: /more from other pages/ }).click()
  await expect(card).toContainText('Sum of Unit Cost')
  await page.getByRole('button', { name: 'Undo' }).last().click()
  await expect(page.locator('header').getByText('18,618 rows')).toBeVisible()
  await expect(card).toHaveCount(0)

  // R10: saved versions count in the Storage manager and can be cleared
  await page.getByRole('button', { name: 'Numero home' }).click()
  await page.getByRole('button', { name: /Storage/ }).first().click()
  const storage = page.getByRole('dialog', { name: 'Browser storage' })
  // N6: the versions are listed with their size and can be deleted one by one
  await storage.getByRole('button', { name: '1 saved version' }).click()
  const list = storage.getByRole('list', { name: /Saved versions of coffee-chain-sales/ })
  await expect(list.getByRole('listitem').first()).toContainText(/KB|MB/)
  await list.getByRole('button', { name: /^Delete version/ }).click()
  await expect(storage.getByRole('button', { name: /saved version/ })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('opening a dataset whose linked file changed offers the update', async ({ page }) => {
  const csv = (await import('node:fs')).readFileSync(fixture('seattle-2016-01-02.csv'), 'utf8')
  // the stand-in file always looks freshly saved
  await page.addInitScript((text) => {
    const handle = { kind: 'file', name: 'seattle-latest.csv', getFile: async () => new File([text], 'seattle-latest.csv', { type: 'text/csv', lastModified: Date.now() + 60_000 }), queryPermission: async () => 'granted', requestPermission: async () => 'granted' }
    ;(window as unknown as { showOpenFilePicker: () => Promise<unknown[]> }).showOpenFilePicker = async () => [handle]
  }, csv)
  const errors = await freshApp(page)
  await openSample(page, 'Seattle Weather')
  await page.getByRole('button', { name: 'Update data' }).click()
  const dlg = page.getByRole('dialog', { name: /Update data/ })
  await dlg.getByRole('button', { name: 'Choose file' }).click()
  await dlg.getByRole('button', { name: 'Append and update dashboard' }).click()
  await expect(page.locator('header').getByText('1,462 rows')).toBeVisible()

  await page.getByRole('button', { name: 'Numero home' }).click()
  await openSample(page, 'Cars')
  await page.getByRole('navigation').getByRole('button', { name: /^seattle-weather/ }).click()
  await expect(page.getByText('seattle-latest.csv changed since the last update')).toBeVisible()
  await page.getByRole('button', { name: 'Update now' }).click()
  await expect(dlg.getByRole('radio', { name: /Append new rows/ })).toBeVisible()
  expect(errors).toEqual([])
})

test('⌘Z undoes a data update and ⇧⌘Z redoes it (N3); sync removes rows a full export no longer lists (N5)', async ({ page }) => {
  const errors = await freshApp(page)
  await openSample(page, 'Coffee Chain Sales', { showcase: true })
  await page.getByRole('button', { name: 'Update data' }).click()
  const dlg = page.getByRole('dialog', { name: /Update data/ })
  await dlg.getByRole('button', { name: /Try it: July 2025 orders/ }).click()
  await dlg.getByRole('button', { name: 'Append and update dashboard' }).click()
  const rows = (n: string) => expect(page.locator('header').getByText(`${n} rows`)).toBeVisible()
  await rows('19,750')
  await page.locator('body').click({ position: { x: 5, y: 400 } })
  await page.keyboard.press('ControlOrMeta+z')
  await rows('18,618')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await rows('19,750')

  // sync: a two-row "full export" keyed by date leaves only its two days
  await page.getByRole('button', { name: 'Numero home' }).click()
  await openSample(page, 'Seattle Weather')
  await page.getByRole('button', { name: 'Update data' }).click()
  await dlg.locator('input[type=file]').setInputFiles(fixture('seattle-correction.csv'))
  await dlg.getByRole('combobox', { name: 'Match rows by' }).selectOption('date')
  await dlg.getByRole('switch', { name: /Remove loaded rows whose date isn’t in this file/ }).click()
  await dlg.getByRole('button', { name: 'Append and update dashboard' }).click()
  await expect(page.getByText(/Added 1 rows \(updated 1, removed 1,460 no longer listed\)/)).toBeVisible()
  await rows('2')
  await page.keyboard.press('ControlOrMeta+z')
  await rows('1,461')
  expect(errors).toEqual([])
})
