import { expect, test } from '@playwright/test'
import { chartAction, freshApp, openSample } from './helpers'

test('text widgets: headings with live values that follow filters and new data', async ({ page }) => {
  const errors = await freshApp(page)
  await openSample(page, 'Coffee Chain Sales', { showcase: true })
  // an untitled text widget is named after its first line
  const note = page.getByRole('group', { name: /^Text: (Jun|Jul) 2025 at a glance\./ })
  await expect(note.getByRole('heading', { name: 'Jun 2025 at a glance' })).toBeVisible()
  await expect(note).toContainText(/\$[\d.,]+K? revenue from [\d,]+ orders/)

  // the note rolls forward when July is loaded
  await page.getByRole('button', { name: 'Update data' }).click()
  const dlg = page.getByRole('dialog', { name: /Update data/ })
  await dlg.getByRole('button', { name: /Try it: July 2025 orders/ }).click()
  await dlg.getByRole('button', { name: 'Append and update dashboard' }).click()
  await expect(note.getByRole('heading', { name: 'Jul 2025 at a glance' })).toBeVisible()

  // a new text widget from the gallery, edited with a placeholder chip
  await page.getByRole('button', { name: 'Add chart' }).click()
  await page.getByRole('dialog', { name: 'Add a chart' }).getByRole('button', { name: /^Text/ }).click()
  const text = page.getByRole('textbox', { name: 'Text' })
  await text.fill('# Store report\nWe sold {nonsense} and ')
  await page.getByRole('button', { name: '{rows}', exact: true }).click()
  await page.getByRole('button', { name: 'Done' }).click()
  const card = page.getByRole('group', { name: /^Text: / }).last()
  await expect(card.getByRole('heading', { name: 'Store report' })).toBeVisible()
  await expect(card).toContainText('19,750')
  await expect(card.getByText('{nonsense}')).toHaveAttribute('title', /No column, measure or value/)
  expect(errors).toEqual([])
})

test('underlying rows: right-click a mark or table row, or "Show rows" on any widget', async ({ page }) => {
  const errors = await freshApp(page)
  await openSample(page, 'Coffee Chain Sales', { showcase: true })
  const dlg = page.getByRole('dialog', { name: /Rows behind/ })

  // a bar: rows for that store only
  await chartAction(page, 'Revenue by store', 'contextmenu', 0)
  await expect(dlg).toContainText(/Store: \w/)
  const n = Number((await dlg.locator('b').first().textContent())!.replace(/,/g, ''))
  expect(n).toBeGreaterThan(100)
  expect(n).toBeLessThan(18618)
  await expect(dlg.getByRole('table', { name: 'Rows' }).locator('tbody tr')).toHaveCount(50)
  await dlg.getByRole('button', { name: 'Next page' }).click()
  await expect(dlg).toContainText(`51–100 of ${n.toLocaleString('en-US')}`)
  const download = page.waitForEvent('download')
  await dlg.getByRole('button', { name: 'Download CSV' }).click()
  expect((await download).suggestedFilename()).toMatch(/^revenue-by-store-store-.*\.csv$/)
  await page.keyboard.press('Escape')

  // a table row
  const channels = page.getByRole('group', { name: /^Channels\./ })
  await channels.getByRole('row').nth(1).click({ button: 'right' })
  await expect(dlg).toContainText('Channel:')
  await page.keyboard.press('Escape')

  // a KPI: every row it counts
  const kpi = page.getByRole('group', { name: /^Revenue\./ })
  await kpi.hover()
  await kpi.getByRole('button', { name: 'More' }).click()
  await page.getByRole('button', { name: 'Show rows' }).click()
  await expect(dlg).toContainText('18,618 rows')
  expect(errors).toEqual([])
})

test('conditional formatting: color scale and rules on a table widget', async ({ page }) => {
  const errors = await freshApp(page)
  await openSample(page, 'Coffee Chain Sales', { showcase: true })
  const table = page.getByRole('group', { name: /^Channels\./ })
  // the showcase rule: an average order value of $7 or more is good (Delivery)
  await expect(table.getByRole('row', { name: /Delivery/ }).getByLabel('Good')).toBeVisible()
  await expect(table.getByLabel('Good')).toHaveCount(1)
  const shaded = await table.locator('td[style*="color-mix"]').count()
  expect(shaded).toBe(12)

  // a new rule flags low order counts
  await table.hover()
  await table.getByRole('button', { name: 'Edit' }).click()
  await page.getByRole('button', { name: 'Add rule' }).click()
  await page.getByRole('combobox', { name: 'Rule measure' }).last().selectOption({ label: 'Distinct count of Order ID' })
  await page.getByRole('spinbutton', { name: 'Rule value' }).last().fill('1000')
  await expect(table.getByLabel('Alert')).toHaveCount(1)
  await expect(table.getByRole('row', { name: /Unknown/ }).getByLabel('Alert')).toBeVisible()
  await page.getByRole('switch', { name: 'Color scale (light → dark by value)' }).click()
  await expect(table.locator('td[style*="color-mix"]')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('saved views: name a set of filters and switch between them', async ({ page }) => {
  const errors = await freshApp(page)
  await openSample(page, 'Seattle Weather')
  const total = page.getByRole('group', { name: /^Total records\./ })
  await expect(total).toContainText('1,461')

  // "All days" with no filters, then "Rainy days"
  await page.getByRole('button', { name: 'Views', exact: true }).click()
  await page.getByRole('textbox', { name: 'View name' }).fill('All days')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
  await page.getByRole('button', { name: 'Weather', exact: true }).click()
  await page.getByRole('checkbox', { name: 'rain' }).check()
  await page.keyboard.press('Escape')
  await expect(total).toContainText('641')
  await page.getByRole('button', { name: 'Views', exact: true }).click()
  await page.getByRole('textbox', { name: 'View name' }).fill('Rainy days')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Views: Rainy days' })).toBeVisible()

  // switch back and forth
  await page.getByRole('button', { name: 'Views: Rainy days' }).click()
  await page.getByRole('list', { name: 'Saved views' }).getByRole('button', { name: /^All days/ }).click()
  await expect(total).toContainText('1,461')
  await expect(page.getByRole('button', { name: 'Views: All days' })).toBeVisible()
  await page.getByRole('button', { name: 'Views: All days' }).click()
  await page.getByRole('list', { name: 'Saved views' }).getByRole('button', { name: /^Rainy days/ }).click()
  await expect(total).toContainText('641')

  // kept after a reload, and deletable
  await page.reload()
  await page.getByRole('button', { name: /^seattle-weather/ }).first().click()
  await page.getByRole('button', { name: 'Views: Rainy days' }).click()
  await page.getByRole('button', { name: 'Delete view All days' }).click()
  await expect(page.getByRole('list', { name: 'Saved views' }).getByRole('listitem')).toHaveCount(1)
  expect(errors).toEqual([])
})

test('print report: a cover, then one sheet per dashboard page (N12)', async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { printed: number }).printed = 0; window.print = () => { (window as unknown as { printed: number }).printed++ } })
  const errors = await freshApp(page)
  await openSample(page, 'Coffee Chain Sales', { showcase: true })
  await page.getByRole('button', { name: 'Share' }).click()
  await page.getByRole('button', { name: /Print report/ }).click()
  const report = page.getByRole('region', { name: 'Report' })
  await expect(report.getByRole('heading', { name: 'coffee-chain-sales', level: 1 })).toBeVisible()
  await expect(report).toContainText('Data covers')
  await expect(report).toContainText('Jan 1, 2024 – Jun 30, 2025')
  // a sheet per page, in order, each with its widgets
  const sheets = report.getByRole('region', { name: /^Page \d+:/ })
  await expect(sheets).toHaveCount(3)
  await expect(sheets.nth(0).getByRole('heading', { name: 'Highlights' })).toBeVisible()
  await expect(sheets.nth(0).getByRole('group', { name: /^Revenue by store\./ })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1)
  // closes once printing is done
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
  await expect(report).toHaveCount(0)
  expect(errors).toEqual([])
})
