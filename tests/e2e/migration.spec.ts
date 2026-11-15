import { expect, test } from '@playwright/test'

test('datasets and dashboards saved by the first version are migrated', async ({ page }) => {
  // seed v1 storage from a same-origin page that doesn't run the app
  await page.goto('/favicon.svg')
  await page.evaluate(async () => {
    await new Promise<void>((res) => { const r = indexedDB.deleteDatabase('numero'); r.onsuccess = r.onerror = r.onblocked = () => res() })
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('numero', 1)
      r.onupgradeneeded = () => r.result.createObjectStore('datasets', { keyPath: 'id' })
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const raw = Array.from({ length: 30 }, (_, i) => ({ city: ['Oslo', 'Rome', 'Lima'][i % 3], sales: String(100 + i), day: `2024-01-${String((i % 28) + 1).padStart(2, '0')}` }))
    await new Promise<void>((res) => {
      const tx = db.transaction('datasets', 'readwrite')
      tx.objectStore('datasets').put({
        id: 'ds_legacy', name: 'Legacy sales', fileName: 'legacy.csv', format: 'csv', createdAt: 1,
        columns: [
          { key: 'city', name: 'Town', type: 'category', detected: 'category' },
          { key: 'sales', name: 'Sales', type: 'number', detected: 'number' },
          { key: 'day', name: 'Day', type: 'text', detected: 'date' },
          { key: 'calc_double', name: 'Double', type: 'number', detected: 'number', formula: '[Sales] * 2' },
        ],
        raw,
        computed: [{ key: 'calc_double', name: 'Double', formula: '[Sales] * 2' }],
        rows: [],
      })
      tx.oncomplete = () => res()
    })
    db.close()
    localStorage.setItem('numero:dashboards', JSON.stringify({ ds_legacy: { datasetId: 'ds_legacy', filters: [], widgets: [{ id: 'w1', type: 'bar', title: 'Old chart', size: 'md', dimension: 'city', measures: [{ id: 'm', column: 'calc_double', agg: 'sum' }] }] } }))
    localStorage.setItem('numero:theme', 'light')
  })
  await page.goto('/')
  await page.getByRole('button', { name: /Legacy sales/ }).first().click()
  // the old single-page dashboard became the "Overview" page with its widget intact
  await expect(page.getByRole('group', { name: /^Old chart\./ })).toBeVisible()
  await expect(page.getByRole('tab', { name: /Overview/ })).toBeVisible()
  // renamed column, type override (text instead of detected date) and computed column all survived
  await page.getByRole('tab', { name: 'Data' }).click()
  await expect(page.getByRole('columnheader', { name: /Town/ })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: /Day/ }).locator('[title="Text"]')).toBeVisible()
  await expect(page.getByRole('cell', { name: '200', exact: true })).toBeVisible()
})
