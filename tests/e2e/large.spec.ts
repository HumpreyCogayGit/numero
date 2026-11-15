import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { freshApp } from './helpers'

const ROWS = Number(process.env.LARGE_ROWS ?? 1_000_000)

function bigCsv(path: string) {
  if (existsSync(path)) return
  const regions = ['North', 'South', 'East', 'West', 'Central'], prods = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta']
  const out: string[] = ['order_date,region,product,customer_id,units,unit_price,revenue,returned']
  for (let i = 0; i < ROWS; i++) {
    const d = new Date(Date.UTC(2019, 0, 1) + (i % 2190) * 864e5).toISOString().slice(0, 10)
    const u = 1 + ((i * 7) % 23), p = 5 + ((i * 13) % 200) / 4
    out.push(`${d},${regions[i % 5]},${prods[(i * 3) % 8]},C${100000 + (i % 50000)},${u},${p.toFixed(2)},${(u * p).toFixed(2)},${i % 17 === 0}`)
  }
  writeFileSync(path, out.join('\n'))
}

test('a million-row CSV imports without freezing the page, and filters respond quickly', async ({ page }, info) => {
  test.setTimeout(240_000)
  // outside test-results/, which Playwright empties on every run
  const dir = `${tmpdir()}/numero-e2e`
  mkdirSync(dir, { recursive: true })
  const file = `${dir}/sales-${ROWS}.csv`
  bigCsv(file)
  await freshApp(page)

  // R4: a read in progress can be cancelled; the interface returns to where it was and nothing appears later
  await page.locator('input[type=file]').first().setInputFiles(file)
  const reading = page.getByRole('status').filter({ hasText: /Reading sales|Parsed/ })
  await reading.getByRole('button', { name: 'Cancel' }).click()
  await expect(reading).toHaveCount(0)
  await page.waitForTimeout(1500)
  await expect(page.getByRole('dialog', { name: /Import sales/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Drop a file here/ })).toBeVisible()

  // R4: the first 1,000 rows of this file are read without reading the rest
  await page.locator('input[type=file]').first().setInputFiles(file)
  const first = page.getByRole('dialog', { name: /Import sales/ })
  await expect(first).toBeVisible({ timeout: 120_000 })
  const tLimit = Date.now()
  await first.getByRole('combobox', { name: 'Row limit' }).selectOption('1000')
  await expect(first.getByRole('button', { name: 'Import 1,000 rows' })).toBeVisible({ timeout: 30_000 })
  const limitMs = Date.now() - tLimit
  await expect(first).toContainText(/read 4(\.0)? MB of the file/)
  // cancelling the preview releases the parsed rows (the next import starts clean)
  await first.getByRole('button', { name: 'Cancel' }).click()
  await expect(first).toHaveCount(0)
  console.log(`[perf] first-1000-rows preview=${limitMs}ms`)

  await page.locator('input[type=file]').first().setInputFiles(file)

  // while the worker parses, the main thread keeps answering
  const lags: number[] = []
  const dialog = page.getByRole('dialog', { name: /Import sales/ })
  while (!(await dialog.isVisible())) {
    const t = Date.now()
    await page.evaluate(() => 1)
    lags.push(Date.now() - t)
    await page.waitForTimeout(100)
  }
  await dialog.getByRole('button', { name: /Import 1,000,000 rows|Import [\d,]+ rows/ }).click()
  const t0 = Date.now()
  while (!(await page.getByRole('tab', { name: 'Dashboard' }).isVisible())) {
    const t = Date.now()
    await page.evaluate(() => 1)
    lags.push(Date.now() - t)
    await page.waitForTimeout(100)
  }
  const importMs = Date.now() - t0
  await expect(page.getByText(`${ROWS.toLocaleString('en-US')} rows`).first()).toBeVisible({ timeout: 60_000 })
  const worstLag = Math.max(...lags)

  // R8: the Insights tab at this size (distribution findings use an even sample)
  const tIns = Date.now()
  await page.getByRole('tab', { name: 'Insights' }).click()
  await expect(page.getByText('Automatic findings')).toBeVisible({ timeout: 60_000 })
  const insightsMs = Date.now() - tIns
  console.log(`[perf] insights tab=${insightsMs}ms`)
  info.annotations.push({ type: 'perf', description: `insights tab ${insightsMs} ms` })
  await page.getByRole('tab', { name: 'Dashboard' }).click()

  // filter round-trip: click a summary-table row, wait for the KPI to change
  const kpi = page.getByRole('group', { name: /^Total records\./ })
  const full = ROWS >= 1e6 ? `${ROWS / 1e6}M` : ROWS.toLocaleString('en-US')
  await expect(kpi).toContainText(full, { timeout: 60_000 })
  const summary = page.getByRole('group', { name: /^Summary by /i })
  await expect(summary).toBeVisible({ timeout: 60_000 })
  const t1 = Date.now()
  await summary.getByRole('row').nth(1).click()
  await expect(kpi).not.toContainText(full)
  const filterMs = Date.now() - t1
  // clicking always answers right away (the chip appears before widgets finish)
  const t2 = Date.now()
  await page.getByRole('button', { name: /Remove .* filter/ }).first().click()
  const clickMs = Date.now() - t2

  info.annotations.push({ type: 'perf', description: `import commit ${importMs} ms · worst main-thread lag while parsing ${worstLag} ms · filter round-trip ${filterMs} ms · click response ${clickMs} ms` })
  console.log(`[perf] rows=${ROWS} commit=${importMs}ms worstLag=${worstLag}ms filter=${filterMs}ms click=${clickMs}ms`)
  expect(worstLag).toBeLessThan(1500)
  expect(filterMs).toBeLessThan(3000)
})
