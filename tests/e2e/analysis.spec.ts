import { expect, test } from '@playwright/test'
import { chartAction, freshApp, openSample } from './helpers'

test('online store: funnel, Pareto, waterfall and a retention cohort table', async ({ page }) => {
  const errors = await freshApp(page)
  await openSample(page, 'Online Store Events', { showcase: true })
  await expect(page.getByRole('group', { name: /^Text: / })).toContainText(/Shop performance through Dec 2025/)
  await expect(page.getByRole('group', { name: /^Text: / }).locator('p span.font-semibold').first()).toHaveText('4,842')

  await expect(page.getByRole('img', { name: /^Funnel chart: Checkout funnel\. 5 stages/ })).toBeVisible()
  await expect(page.getByRole('img', { name: /^Pareto chart: Revenue by country\./ })).toBeVisible()
  await expect(page.getByRole('img', { name: /^Waterfall chart: Revenue by channel\. 6 steps/ })).toBeVisible()

  const cohort = page.getByRole('table', { name: /^Cohort table/ })
  await expect(cohort.locator('tbody tr')).toHaveCount(13)
  await expect(cohort.locator('tbody tr').first()).toContainText('Jan 2025')
  await expect(cohort.locator('tbody tr').first().locator('td').nth(2)).toHaveText('100%')

  // switch the cohort to counts by quarter
  const card = page.getByRole('group', { name: /^Customers coming back/ })
  await card.hover()
  await card.getByRole('button', { name: 'Edit' }).click()
  await page.getByRole('button', { name: 'Active count', exact: true }).click()
  await page.getByRole('combobox', { name: 'Cohort period' }).selectOption('quarter')
  await expect(cohort.locator('tbody tr')).toHaveCount(5)
  await expect(cohort.locator('thead')).toContainText('Quarter 0')
  await page.getByRole('button', { name: 'Done' }).click()

  // right-click a funnel stage: the sessions behind it
  await chartAction(page, 'Checkout funnel', 'contextmenu', 4)
  await expect(page.getByRole('dialog', { name: /Rows behind/ })).toContainText('Stage: 5 Purchase')
  expect(errors).toEqual([])
})

test('new chart types from the gallery', async ({ page }) => {
  const errors = await freshApp(page)
  await openSample(page, 'Seattle Weather')
  for (const [type, label] of [['Waterfall', /^Waterfall chart/], ['Pareto', /^Pareto chart/], ['Funnel', /^Funnel chart/]] as const) {
    await page.getByRole('button', { name: 'Add chart' }).click()
    await page.getByRole('dialog', { name: 'Add a chart' }).getByRole('button', { name: new RegExp(`^${type}`) }).click()
    await page.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('img', { name: label }).last()).toBeVisible()
  }
  await page.getByRole('button', { name: 'Add chart' }).click()
  await page.getByRole('dialog', { name: 'Add a chart' }).getByRole('button', { name: /^Cohort/ }).click()
  await page.getByRole('combobox', { name: 'Cohort entity' }).selectOption({ label: 'Weather' })
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('table', { name: /^Cohort table/ })).toBeVisible()
  expect(errors).toEqual([])
})

test('review fixes: axes use the measure format; chart data tables can filter and show rows from the keyboard', async ({ page }) => {
  const errors = await freshApp(page)
  await openSample(page, 'Online Store Events', { showcase: true })
  // R2: a ratio measure's axis reads as percentages
  const ticks = await page.getByRole('group', { name: /^Conversion rate by channel\./ }).locator('[role="img"]').evaluate((el) => {
    const opt = (el as HTMLElement & { __numero: { option: () => { xAxis: { axisLabel: { formatter: (v: number) => string } }[] } } }).__numero.option()
    return [0.05, 0.2].map((v) => opt.xAxis[0].axisLabel.formatter(v))
  })
  expect(ticks).toEqual(['5%', '20%'])

  // R13: the data-table view offers the mark actions as buttons
  const card = page.getByRole('group', { name: /^Conversion rate by channel\./ })
  await card.hover()
  await card.getByRole('button', { name: 'Show data table' }).click()
  const filter = card.getByRole('button', { name: 'Filter the dashboard by Email' })
  await filter.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: /Channel/ }).first()).toBeVisible()
  await expect(card).toContainText('Filtering the dashboard')
  await card.getByRole('button', { name: 'Show rows for Email' }).click()
  await expect(page.getByRole('dialog', { name: /Rows behind/ })).toContainText('Channel: Email')
  expect(errors).toEqual([])
})

test('rows behind a cohort cell and a fullscreen chart; rules on percent measures typed in %', async ({ page }) => {
  const errors = await freshApp(page)
  await openSample(page, 'Online Store Events', { showcase: true })
  const rows = page.getByRole('dialog', { name: /Rows behind/ })

  // N7: a cohort cell opens the rows of that cohort's customers in that month
  await page.getByRole('button', { name: /Jan 2025 cohort · Month 2: \d+ of 293 active/ }).click()
  await expect(rows).toContainText('Jan 2025 cohort · Month 2')
  await expect(rows.getByRole('table', { name: 'Rows' })).toContainText('Mar 1, 2025')
  await page.keyboard.press('Escape')

  // N7: right-click in fullscreen
  const funnel = page.getByRole('group', { name: /^Checkout funnel\./ })
  await funnel.hover()
  await funnel.getByRole('button', { name: 'Fullscreen' }).click()
  const full = page.getByRole('dialog', { name: 'Checkout funnel' })
  await full.locator('[role="img"]').evaluate((el) => (el as HTMLElement & { __numero: { contextmenu: (d: number) => void } }).__numero.contextmenu(0))
  await expect(rows).toContainText('Stage: 1 Visit')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  // N8: a rule on a ratio measure takes 20 (%), not 0.2
  const card = page.getByRole('group', { name: /^Conversion rate by channel\./ })
  await card.hover()
  await card.getByRole('button', { name: 'Edit' }).click()
  await page.getByRole('button', { name: /^Table/ }).click()
  await page.getByRole('button', { name: 'Add rule' }).click()
  await page.getByRole('combobox', { name: 'Rule comparison' }).selectOption('gte')
  await page.getByRole('spinbutton', { name: 'Rule value' }).fill('20')
  await page.getByRole('button', { name: 'Good', exact: true }).click()
  const table = page.getByRole('group', { name: /^Conversion rate by channel\./ })
  await expect(table.getByLabel('Good')).toHaveCount(1)
  await expect(table.getByRole('row', { name: /Email/ }).getByLabel('Good')).toBeVisible()
  expect(errors).toEqual([])
})

test('suggestions and the Ask bar offer the newer chart types; tooltip fields on bar charts (N2, N9a)', async ({ page }) => {
  const errors = await freshApp(page)
  await openSample(page, 'Online Store Events')
  // the suggested Overview has a funnel and a cohort table
  await expect(page.getByRole('img', { name: /^Funnel chart: Funnel by Stage/ })).toBeVisible()
  await expect(page.getByRole('table', { name: /^Cohort table: Coming back/ })).toBeVisible()
  const box = page.getByRole('textbox', { name: 'Ask a question about this data' })
  await box.fill('customer retention by quarter')
  await box.press('Enter')
  await expect(page.getByText('Reading this as')).toBeVisible()
  await expect(page.getByText('by first quarter')).toBeVisible()

  await page.getByRole('button', { name: 'Numero home' }).click()
  await openSample(page, 'Coffee Chain Sales')
  await page.getByRole('button', { name: 'Add chart' }).click()
  const gallery = page.getByRole('dialog', { name: 'Add a chart' })
  await expect(gallery.getByRole('button', { name: /Pareto/ }).first()).toBeVisible()
  await page.keyboard.press('Escape')

  // N9a: a bar chart's tooltip lists the extra fields per bar
  const card = page.getByRole('group', { name: /by Store\./ }).first()
  await card.hover()
  await card.getByRole('button', { name: 'Edit' }).click()
  await page.locator('label', { hasText: 'Extra tooltip fields' }).getByRole('checkbox', { name: 'Channel', exact: true }).check()
  await page.getByRole('button', { name: 'Done' }).click()
  const html = await card.locator('[role="img"]').evaluate((el) => {
    const opt = (el as HTMLElement & { __numero: { option: () => { tooltip: { formatter: (p: unknown) => string }[] } } }).__numero.option()
    return opt.tooltip[0].formatter([{ axisValueLabel: 'x', seriesName: 's', value: 1, color: '#000', dataIndex: 0 }])
  })
  expect(html).toMatch(/Channel.*In-store \(\+\d more\)/)
  expect(errors).toEqual([])
})
