import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { chartAction, freshApp, openSample } from './helpers'

/** WCAG 2.1 A/AA checks; moderate, serious and critical problems fail the test, with a readable list. */
async function audit(page: Page, view: string) {
  await page.waitForTimeout(400) // let fade-in animations settle so colors are final
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze()
  const bad = r.violations.filter((v) => v.impact === 'moderate' || v.impact === 'serious' || v.impact === 'critical')
  const report = bad.map((v) => `${v.id} (${v.impact}, ${v.nodes.length}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)
  expect(report, `${view}\n${report.join('\n')}`).toEqual([])
}

for (const theme of ['light', 'dark'] as const) {
  test(`accessibility audit · ${theme}`, async ({ page }) => {
    test.setTimeout(120_000)
    // animations off, so colors are measured at their final values (the app honours this setting)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await freshApp(page)
    if (theme === 'dark') { await page.evaluate(() => localStorage.setItem('numero:theme', 'dark')); await page.reload() }
    await audit(page, 'home')

    await openSample(page, 'Coffee Chain Sales', { showcase: true })
    await audit(page, 'dashboard')
    for (const tab of ['Insights', 'Pivot', 'Columns', 'Data', 'Prepare']) {
      await page.getByRole('tab', { name: tab }).click()
      await audit(page, tab)
    }
    await page.getByRole('tab', { name: 'Dashboard' }).click()

    const card = page.getByRole('group', { name: /^Revenue by store\./ })
    await card.hover()
    await card.getByRole('button', { name: 'Edit' }).click()
    await audit(page, 'widget editor')
    await page.getByRole('button', { name: 'Done' }).click()

    await chartAction(page, 'Revenue by store', 'contextmenu', 0)
    await audit(page, 'rows view')
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Views', exact: true }).click()
    await audit(page, 'views menu')
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Update data' }).click()
    await page.getByRole('dialog').getByRole('button', { name: /Try it/ }).click()
    await expect(page.getByRole('dialog').getByText(/columns match/)).toBeVisible()
    await audit(page, 'update review')
    await page.getByRole('button', { name: 'Append and update dashboard' }).click()
    await expect(page.getByRole('region', { name: 'What changed' })).toBeVisible()
    await audit(page, 'what changed')

    await page.evaluate(() => { window.print = () => {} })
    await page.getByRole('button', { name: 'Share' }).click()
    await page.getByRole('button', { name: /Print report/ }).click()
    await expect(page.getByRole('region', { name: 'Report' })).toBeVisible()
    await audit(page, 'print report')
    await page.getByRole('region', { name: 'Report' }).getByRole('button', { name: 'Close' }).click()

    await page.keyboard.press('ControlOrMeta+k')
    await page.getByRole('combobox', { name: /Search commands/ }).fill('rev')
    await audit(page, 'command palette')
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Numero home' }).click()
    await openSample(page, 'Online Store Events', { showcase: true })
    await audit(page, 'funnel, cohort and text widgets')
  })
}

test('dialogs: focus moves in, Tab stays inside, Escape returns focus to the trigger', async ({ page }) => {
  await freshApp(page)
  await openSample(page, 'Seattle Weather')
  for (const [trigger, dialog] of [['Update data', /Update data/], ['Add chart', /Add a chart/]] as const) {
    const button = page.getByRole('button', { name: trigger, exact: true })
    await button.focus()
    await page.keyboard.press('Enter')
    const dlg = page.getByRole('dialog', { name: dialog })
    await expect(dlg).toBeVisible()
    expect(await dlg.evaluate((d) => d.contains(document.activeElement)), `${trigger}: focus moves in`).toBe(true)
    // Tab past the end and Shift+Tab past the start both stay inside
    for (let i = 0; i < 40; i++) await page.keyboard.press('Tab')
    expect(await dlg.evaluate((d) => d.contains(document.activeElement)), `${trigger}: Tab stays inside`).toBe(true)
    for (let i = 0; i < 40; i++) await page.keyboard.press('Shift+Tab')
    expect(await dlg.evaluate((d) => d.contains(document.activeElement)), `${trigger}: Shift+Tab stays inside`).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dlg).toHaveCount(0)
    await expect(button, `${trigger}: focus returns`).toBeFocused()
  }
  // the command palette starts in its search box and gives focus back too
  const search = page.getByRole('button', { name: /Search & commands/ })
  await search.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('combobox', { name: /Search commands/ })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(search).toBeFocused()
})
