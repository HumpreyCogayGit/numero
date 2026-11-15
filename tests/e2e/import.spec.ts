import { expect, test } from '@playwright/test'
import { fixture, freshApp, tab } from './helpers'

test('import preview: encoding, delimiter, title rows, decimal comma, day-first dates, type override', async ({ page }) => {
  const errors = await freshApp(page)
  await page.locator('input[type=file]').first().setInputFiles(fixture('eu-sales.csv'))
  const dlg = page.getByRole('dialog', { name: /Import eu-sales\.csv/ })
  await expect(dlg).toBeVisible()
  // detection: Windows-1252 decoded, title row read as the header until we skip it
  await expect(dlg.getByText('Detected: windows-1252')).toBeVisible()
  await dlg.getByRole('spinbutton', { name: 'Rows to skip' }).fill('1')
  await expect(dlg.getByRole('columnheader', { name: /Stadt/ })).toBeVisible()
  await expect(dlg.getByText('München').first()).toBeVisible()
  await dlg.getByRole('combobox', { name: 'Date order' }).selectOption('dmy')
  await dlg.getByRole('combobox', { name: 'Decimal separator' }).selectOption(',')
  await expect(dlg.getByRole('combobox', { name: 'Type of Umsatz' })).toHaveValue('number')
  await dlg.getByRole('combobox', { name: 'Type of Menge' }).selectOption('category')
  await dlg.getByRole('button', { name: /Import 6 rows/ }).click()

  await expect(page.getByRole('heading', { name: 'eu-sales' })).toBeVisible()
  await tab(page, 'Data')
  // 03/04/2024 read day-first → 3 April; 1.234,50 → 1,234.5
  await expect(page.getByRole('cell', { name: 'Apr 3, 2024' })).toBeVisible()
  await expect(page.getByRole('cell', { name: '1,234.5' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: /Menge/ }).locator('[title="Category"]')).toBeVisible()
  expect(errors).toEqual([])
})

test('workbook sheet picker and row limit', async ({ page }) => {
  await freshApp(page)
  await page.getByRole('button', { name: 'Open sample US Unemployment by Industry' }).click()
  const dlg = page.getByRole('dialog', { name: /Import us-unemployment/ })
  await expect(dlg.getByRole('combobox', { name: 'Sheet' })).toHaveValue('Unemployment')
  await dlg.getByRole('combobox', { name: 'Row limit' }).selectOption('1000')
  await expect(dlg.getByRole('button', { name: 'Import 1,000 rows' })).toBeVisible()
  await dlg.getByRole('button', { name: 'Import 1,000 rows' }).click()
  await expect(page.getByText(/Imported the first 1,000 rows/)).toBeVisible()
  await expect(page.getByText('1,000 rows', { exact: true }).first()).toBeVisible()
})

test('paste data and import from a URL', async ({ page }) => {
  await freshApp(page)
  await page.getByRole('button', { name: 'Paste data' }).click()
  await page.getByRole('textbox', { name: 'Pasted data' }).fill('Region\tSales\nNorth\t1200\nSouth\t950\nEast\t700\n')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('dialog', { name: /Import/ }).getByRole('button', { name: /Import 3 rows/ }).click()
  await expect(page.getByRole('heading', { name: 'Pasted data' })).toBeVisible()

  await page.route('https://data.example.test/metrics.csv', (r) => r.fulfill({ status: 200, contentType: 'text/csv', headers: { 'access-control-allow-origin': '*' }, body: 'day,visits\n2024-01-01,10\n2024-01-02,14\n2024-01-03,9\n2024-01-04,20\n' }))
  await page.getByRole('button', { name: 'Numero home' }).click()
  await page.getByRole('button', { name: 'From a URL' }).click()
  await page.getByRole('textbox', { name: 'URL' }).fill('https://data.example.test/metrics.csv')
  await page.getByRole('combobox', { name: 'Refresh interval' }).selectOption('15')
  await page.getByRole('dialog', { name: 'Import from a URL' }).getByRole('button', { name: 'Import' }).click()
  await page.getByRole('dialog', { name: /Import metrics\.csv/ }).getByRole('button', { name: /Import 4 rows/ }).click()
  await expect(page.getByRole('heading', { name: 'metrics' })).toBeVisible()
  // URL sources can be refreshed
  await page.route('https://data.example.test/metrics.csv', (r) => r.fulfill({ status: 200, contentType: 'text/csv', headers: { 'access-control-allow-origin': '*' }, body: 'day,visits\n2024-01-01,10\n2024-01-02,14\n2024-01-03,9\n2024-01-04,20\n2024-01-05,25\n' }))
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByText(/Refreshed “metrics” · 5 rows/)).toBeVisible()
})

test('an unreadable URL shows a helpful error', async ({ page }) => {
  await freshApp(page)
  await page.route('https://blocked.example.test/x.csv', (r) => r.abort())
  await page.getByRole('button', { name: 'From a URL' }).click()
  await page.getByRole('textbox', { name: 'URL' }).fill('https://blocked.example.test/x.csv')
  await page.getByRole('dialog', { name: 'Import from a URL' }).getByRole('button', { name: 'Import' }).click()
  await expect(page.getByRole('alert')).toContainText('Could not download that URL')
})
