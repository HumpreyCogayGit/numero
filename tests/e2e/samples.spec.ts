import { expect, test } from '@playwright/test'
import { SAMPLES } from '../../src/lib/samples'
import { PRESETS } from '../../src/lib/presets'
import { freshApp } from './helpers'

// opening every sample twice-over would be slow, so each test opens a few in one session
const groups = [SAMPLES.slice(0, 4), SAMPLES.slice(4, 8), SAMPLES.slice(8)]

for (const [i, group] of groups.entries()) {
  test(`sample showcases open cleanly (group ${i + 1}: ${group.map((s) => s.title).join(', ')})`, async ({ page }) => {
    test.setTimeout(120_000)
    const errors = await freshApp(page)
    for (const s of group) {
      await page.getByRole('button', { name: 'Numero home' }).click()
      await page.getByRole('button', { name: `Open sample ${s.title}` }).click()
      // the Excel sample has two sheets and asks which one
      const dlg = page.getByRole('dialog', { name: /^Import / })
      if (s.format === 'XLSX') await dlg.getByRole('button', { name: /Import [\d,]+ rows/ }).click()
      const first = PRESETS[s.file].pages({} as never)[0]?.name
      // messages stack now: the newest is this sample's
      await expect(page.getByText(/Showcase ready/).last(), s.title).toBeVisible({ timeout: 30_000 })
      if (first) await expect(page.getByRole('tab', { name: new RegExp(`${first} — rename page`) }), s.title).toBeVisible()
      await expect(page.getByRole('tab', { name: 'Overview' }), s.title).toBeVisible()
      // every widget on the showcase page renders: no missing-column or empty states
      await expect(page.locator('main [role="group"]').first()).toBeVisible()
      await page.waitForTimeout(300)
      await expect(page.getByText(/Missing column/), s.title).toHaveCount(0)
      await expect(page.getByText('Nothing to show'), s.title).toHaveCount(0)
    }
    expect(errors).toEqual([])
  })
}

test('US Flights imports US Airports first and joins them', async ({ page }) => {
  await freshApp(page)
  await page.getByRole('button', { name: 'Open sample US Flights' }).click()
  await expect(page.getByText(/Showcase ready/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('navigation').getByRole('button', { name: /^us-airports/ })).toBeVisible()
  await expect(page.getByRole('group', { name: /^On-time rate by origin state\./ })).toBeVisible()
  await page.getByRole('tab', { name: 'Prepare' }).click()
  await expect(page.getByText('Join another dataset')).toBeVisible()
  await expect(page.getByText(/Matched 10,000 rows of 10,000/)).toBeVisible()
  // opening the same sample again reopens it instead of importing a copy
  await page.getByRole('button', { name: 'Numero home' }).click()
  await page.getByRole('button', { name: 'Open sample US Flights' }).click()
  await expect(page.getByRole('heading', { name: 'us-flights-2001' })).toBeVisible()
  await expect(page.getByRole('navigation').getByRole('button', { name: /^us-flights-2001/ })).toHaveCount(1)
})
