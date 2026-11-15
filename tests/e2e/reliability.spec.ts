import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { freshApp, openSample, tab } from './helpers'

// the production build's service worker would answer intercepted requests from its cache
test.use({ serviceWorkers: 'block' })

const csvFile = (name: string, text: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) })
const picker = (page: Page) => page.locator('input[type=file]').first()
const importDialog = (page: Page, name: RegExp | string = /Import/) => page.getByRole('dialog', { name })
const assumed = (page: Page) => page.getByRole('region', { name: 'What Numero assumed' })

const days = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('\n') + '\n'
const SALES = 'day,region,sales\n' + days(40, (i) => `2024-01-${String((i % 28) + 1).padStart(2, '0')},${['North', 'South', 'East'][i % 3]},${100 + i * 3}`)

async function importCsv(page: Page, name: string, text: string) {
  await picker(page).setInputFiles(csvFile(name, text))
  const dlg = importDialog(page)
  await dlg.getByRole('button', { name: /^Import [\d,]+ rows$/ }).click()
  await expect(page.getByRole('tab', { name: 'Dashboard' })).toBeVisible()
}

async function audit(page: Page, view: string) {
  // animations off, so colors are measured at their final values (as in a11y.spec.ts)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForTimeout(400)
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze()
  const bad = r.violations.filter((v) => v.impact === 'moderate' || v.impact === 'serious' || v.impact === 'critical')
  expect(bad.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => `${n.target.join(' ')} — ${n.failureSummary?.split('\n')[1]?.trim() ?? ''}`).join(' | ')}`), view).toEqual([])
}

test.describe('files that cannot be read (R3)', () => {
  test('a PDF is refused with the supported formats named, and never reaches the preview', async ({ page }) => {
    await freshApp(page)
    await picker(page).setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n') })
    await expect(page.getByRole('alert')).toContainText('report.pdf is a PDF, not a table. Numero reads CSV or TSV text, JSON, and Excel')
    await expect(importDialog(page)).toHaveCount(0)
    // the same bytes under a .csv name are still recognised
    await picker(page).setInputFiles({ name: 'renamed.csv', mimeType: 'text/csv', buffer: Buffer.from('%PDF-1.7\n1 0 obj\n') })
    await expect(page.getByRole('alert').filter({ hasText: 'renamed.csv looks like a PDF' })).toBeVisible()
    await expect(importDialog(page)).toHaveCount(0)
  })

  test('malformed JSON and NDJSON say which line is wrong', async ({ page }) => {
    await freshApp(page)
    await picker(page).setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('[\n  {"a": 1},\n  {"a": 2 "b": 3}\n]') })
    await expect(page.getByRole('alert')).toContainText(/bad\.json can’t be read as JSON — line 3, column \d+: a comma or a closing } is missing/)
    await picker(page).setInputFiles({ name: 'events.ndjson', mimeType: 'application/x-ndjson', buffer: Buffer.from('{"a":1}\n{"a":2}\n{"a":3,}\n') })
    await expect(page.getByRole('alert').filter({ hasText: 'line 3 is not valid JSON' })).toBeVisible()
  })

  test('ragged rows are counted with examples, and the rows imported do not change', async ({ page }) => {
    await freshApp(page)
    await picker(page).setInputFiles(csvFile('ragged.csv', 'a,b\n1,2,3,4\n5,6\n7\n8,9\n'))
    const dlg = importDialog(page, /Import ragged\.csv/)
    await expect(assumed(page)).toContainText('2 rows have a different number of cells than the header (2)')
    await expect(assumed(page)).toContainText('1 with extra cells: the extra cells are not imported')
    await assumed(page).getByRole('button', { name: 'Show rows' }).first().click()
    await expect(assumed(page)).toContainText('line 2 · 4 cells · 1,2,3,4')
    await dlg.getByRole('button', { name: 'Import 4 rows' }).click()
    await expect(page.getByText('4 rows', { exact: true }).first()).toBeVisible()
    // the count stays with the dataset
    await page.getByRole('button', { name: 'Source and freshness' }).click()
    await expect(page.getByRole('dialog', { name: 'Source and freshness' })).toContainText('2 rows had more or fewer cells than the header')
  })

  test('several files: the same columns can be combined; otherwise they queue, and the user is told', async ({ page }) => {
    await freshApp(page)
    const jan = csvFile('jan.csv', 'day,sales\n2024-01-01,10\n2024-01-02,12\n')
    const feb = csvFile('feb.csv', 'day,sales\n2024-02-01,20\n2024-02-02,22\n2024-02-03,24\n')
    await picker(page).setInputFiles([jan, feb])
    const ask = page.getByRole('dialog', { name: 'Combine 2 files into one dataset?' })
    await expect(ask).toContainText('jan.csv, feb.csv have the same columns')
    await ask.getByRole('button', { name: 'Combine' }).click()
    await expect(assumed(page)).toContainText('Combined 2 files with the same columns: jan.csv, feb.csv')
    await importDialog(page).getByRole('button', { name: 'Import 5 rows' }).click()
    await expect(page.getByText('5 rows', { exact: true }).first()).toBeVisible()

    // different columns: one after another, announced
    await page.getByRole('button', { name: 'Numero home' }).click()
    await picker(page).setInputFiles([csvFile('one.csv', 'x,y\n1,2\n3,4\n'), csvFile('two.csv', 'p,q,r\n1,2,3\n')])
    await expect(page.getByText('2 files: importing one.csv first, then two.csv one after another.')).toBeVisible()
    await importDialog(page, /Import one\.csv/).getByRole('button', { name: 'Import 2 rows' }).click()
    await importDialog(page, /Import two\.csv/).getByRole('button', { name: 'Import 1 rows' }).click()
    await expect(page.getByRole('heading', { name: 'two' })).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Datasets' }).getByRole('button', { name: /^one / })).toBeVisible()
  })
})

test.describe('type detection in the preview (R1)', () => {
  test('a semicolon file with decimal commas is read as numbers without touching a setting', async ({ page }) => {
    await freshApp(page)
    await picker(page).setInputFiles(csvFile('preise.csv', 'stadt;preis;menge\nBerlin;12,5;3\nParis;7,25;1\nRom;1.234,50;2\nWien;3,10;4\n'))
    const dlg = importDialog(page, /Import preise\.csv/)
    await expect(dlg.getByRole('combobox', { name: 'Decimal separator' })).toHaveValue(',')
    await expect(dlg.getByText('Detected: comma (semicolon-delimited file)')).toBeVisible()
    await expect(dlg.getByRole('combobox', { name: 'Type of preis' })).toHaveValue('number')
    await dlg.getByRole('button', { name: 'Import 4 rows' }).click()
    await tab(page, 'Data')
    await expect(page.getByRole('cell', { name: '1,234.5', exact: true })).toBeVisible()
  })

  test('decimal comma in a comma-delimited file is proposed; NA stays a value in a category; ZIP codes keep their zero', async ({ page }) => {
    await freshApp(page)
    const rows = days(12, (i) => `"${i},5",${['NA', 'EU', 'APAC'][i % 3]},0${2134 + i},${i % 4 === 0 ? '-' : i * 2}`)
    await picker(page).setInputFiles(csvFile('mixed.csv', 'price,region,zip,units\n' + rows))
    const dlg = importDialog(page, /Import mixed\.csv/)
    await expect(assumed(page)).toContainText('“price” reads as numbers only with a decimal comma')
    await expect(dlg.getByRole('combobox', { name: 'Type of price' })).not.toHaveValue('number')
    await assumed(page).getByRole('button', { name: 'Use decimal comma' }).click()
    await expect(dlg.getByRole('combobox', { name: 'Type of price' })).toHaveValue('number')
    await expect(dlg.getByRole('combobox', { name: 'Type of zip' })).not.toHaveValue('number')
    // NA under a number is blank and said so; under the category it is a value
    await expect(assumed(page)).toContainText('In “units”, - (3) is read as blank')
    await expect(assumed(page)).toContainText('In “region”, NA (4) is kept as a value')
    await dlg.getByRole('button', { name: 'Import 12 rows' }).click()
    await tab(page, 'Data')
    await expect(page.getByRole('cell', { name: '02134', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'NA', exact: true }).first()).toBeVisible()
  })
})

test.describe('data-quality checks on first import', () => {
  test('a clean file says so', async ({ page }) => {
    await freshApp(page)
    await picker(page).setInputFiles(csvFile('clean.csv', SALES))
    await expect(assumed(page)).toContainText('Nothing unusual: every column read cleanly.')
    await expect(assumed(page)).toContainText('Checked all 40 rows')
  })

  test('warnings: inspect rows, leave them out with a preparation step, or change a type', async ({ page }) => {
    await freshApp(page)
    const text = 'released,title,gross\n' + days(40, (i) => `${i === 7 || i === 30 ? '2046-03-10' : `2023-0${(i % 9) + 1}-15`},Film ${i},${i % 10 === 0 ? 'pending' : 1000 + i}`)
    await picker(page).setInputFiles(csvFile('films.csv', text))
    const dlg = importDialog(page, /Import films\.csv/)
    const future = assumed(page).getByRole('listitem').filter({ hasText: '2 dates in released are in the future' })
    await expect(future).toHaveAttribute('data-severity', 'warning')
    await future.getByRole('button', { name: 'Show rows' }).click()
    await expect(future).toContainText('Data rows: 8, 31')
    // mixed column: read as text until the user decides
    const mixed = assumed(page).getByRole('listitem').filter({ hasText: 'gross is read as text: 4 values of 40 aren’t numbers' })
    await mixed.getByRole('button', { name: /Read as number/ }).click()
    await expect(dlg.getByRole('combobox', { name: 'Type of gross' })).toHaveValue('number')
    await expect(assumed(page).getByRole('listitem').filter({ hasText: '4 values in gross aren’t numbers — they will be blank' })).toBeVisible()
    // leave the future rows out
    await future.getByRole('button', { name: 'Leave those rows out' }).click()
    await expect(future.getByRole('button', { name: 'Will be left out' })).toHaveAttribute('aria-pressed', 'true')
    await audit(page, 'import preview with warnings')
    await dlg.getByRole('button', { name: 'Import 40 rows' }).click()
    await expect(page.getByText('38 rows', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('1 prep steps')).toBeVisible()
    // the step is an ordinary, removable preparation step: the source rows were not altered
    await tab(page, 'Prepare')
    await expect(page.getByText(/remove rows where released is greater than/i).first()).toBeVisible()
  })

  test('import anyway: the notes stay with the dataset and are not raised again on reopening', async ({ page }) => {
    await freshApp(page)
    const text = 'released,gross\n' + days(30, (i) => `${i === 3 ? '2046-03-10' : '2023-05-15'},${1000 + i}`)
    await picker(page).setInputFiles(csvFile('anyway.csv', text))
    await expect(assumed(page)).toContainText('1 date in released is in the future')
    await importDialog(page).getByRole('button', { name: 'Import 30 rows' }).click()
    await expect(page.getByText('30 rows', { exact: true }).first()).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: 'anyway' })).toBeVisible()
    // no dialog, no alert on reopening — the note is on file under Source
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.getByRole('button', { name: 'Source and freshness' }).click()
    const src = page.getByRole('dialog', { name: 'Source and freshness' })
    await expect(src).toContainText('Noted when this file was imported')
    await expect(src).toContainText('1 date in released is in the future')
  })
})

test.describe('removing datasets (R5)', () => {
  test('restore from “Recently removed” — after a reload, with saved versions and the dashboard', async ({ page }) => {
    await freshApp(page)
    await importCsv(page, 'sales.csv', SALES)
    // an update creates a saved version
    await page.getByRole('button', { name: 'Update data' }).click()
    await page.getByRole('dialog', { name: /Update/ }).locator('input[type=file]').setInputFiles(csvFile('more.csv', 'day,region,sales\n2024-03-01,West,999\n'))
    await page.getByRole('dialog', { name: /Update/ }).getByRole('button', { name: /^(Add|Append|Update)/ }).last().click()
    await expect(page.getByText(/Added 1 rows/)).toBeVisible()
    await page.getByRole('button', { name: 'Numero home' }).click()

    await page.getByRole('button', { name: 'Remove sales' }).first().click()
    // it has a saved version: ask first, and say what is at stake
    const ask = page.getByRole('dialog', { name: 'Remove “sales”?' })
    await expect(ask).toContainText('1 saved version of the data')
    await ask.getByRole('button', { name: 'Remove' }).click()
    const removed = page.getByRole('region', { name: 'Recently removed' })
    await expect(removed).toContainText('sales')
    await expect(removed).toContainText('1 saved version')
    await expect(removed).toContainText('7 days left')

    // later messages do not push the Undo away
    await picker(page).setInputFiles({ name: 'x.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n') })
    await expect(page.getByRole('alert')).toContainText('x.pdf')
    await expect(page.getByRole('status').filter({ hasText: 'Removed “sales”' }).getByRole('button', { name: 'Undo' })).toBeVisible()

    // still restorable after a reload — the old 60-second in-memory undo was lost here
    await page.reload()
    await expect(page.getByRole('region', { name: 'Recently removed' })).toContainText('sales')
    await page.getByRole('button', { name: 'Restore sales' }).click()
    await expect(page.getByRole('region', { name: 'Recently removed' })).toHaveCount(0)
    await page.getByRole('complementary', { name: 'Datasets' }).getByRole('button', { name: /^sales/ }).click()
    await expect(page.getByText('41 rows', { exact: true }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Numero home' }).click()
    await page.getByRole('button', { name: 'Storage' }).click()
    await expect(page.getByRole('dialog', { name: 'Browser storage' }).getByRole('button', { name: '1 saved version' })).toBeVisible()
  })

  test('a plain dataset is removed without a question; erasing is final; no orphaned dashboards remain', async ({ page }) => {
    await freshApp(page)
    await importCsv(page, 'plain.csv', SALES)
    await page.getByRole('button', { name: 'Numero home' }).click()
    await page.getByRole('button', { name: 'Remove plain' }).first().click()
    await expect(page.getByRole('dialog', { name: /Remove/ })).toHaveCount(0)
    await expect(page.getByText(/Removed “plain”/)).toBeVisible()
    const stored = () => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open('numero'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      const count = (s: string) => new Promise<number>((res) => { const r = db.transaction(s).objectStore(s).count(); r.onsuccess = () => res(r.result) })
      const out = { meta: await count('meta'), dashboards: await count('dashboards'), sources: await count('sources') }
      db.close()
      return out
    })
    expect(await stored()).toEqual({ meta: 1, dashboards: 1, sources: 1 })
    await page.getByRole('button', { name: 'Erase plain now' }).click()
    await page.getByRole('dialog', { name: 'Erase “plain” now?' }).getByRole('button', { name: 'Erase' }).click()
    await expect(page.getByRole('region', { name: 'Recently removed' })).toHaveCount(0)
    await expect.poll(stored).toEqual({ meta: 0, dashboards: 0, sources: 0 })

    // a dashboard left behind without its dataset (older versions could do this) is cleared at startup
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res) => { const r = indexedDB.open('numero'); r.onsuccess = () => res(r.result) })
      await new Promise<void>((res) => { const tx = db.transaction('dashboards', 'readwrite'); tx.objectStore('dashboards').put({ datasetId: 'ds_gone', pages: [], activePage: 'x' }); tx.oncomplete = () => res() })
      db.close()
    })
    await page.reload()
    await expect(page.getByRole('button', { name: /Drop a file here/ })).toBeVisible()
    await expect.poll(stored).toEqual({ meta: 0, dashboards: 0, sources: 0 })
  })
})

test.describe('crash recovery and safe startup', () => {
  test('a throwing component shows recovery, not a blank page; returning home keeps the data', async ({ page }) => {
    await freshApp(page)
    await importCsv(page, 'keep.csv', SALES)
    await page.goto('/#crash-test')
    await page.reload()
    const panel = page.getByRole('alert')
    await expect(panel.getByRole('heading', { name: 'Something went wrong on this page' })).toBeVisible()
    await expect(panel).toContainText('Your stored datasets and dashboards have not been deleted')
    await expect(panel).toContainText('Crash test: a child component threw while rendering')
    await audit(page, 'recovery page')
    // diagnostics carry counts, not names or values
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await panel.getByRole('button', { name: 'Copy diagnostics' }).click()
    await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible()
    const text = await page.evaluate(() => navigator.clipboard.readText())
    expect(text).toContain('Numero diagnostics')
    expect(text).toContain('Datasets stored: 1')
    expect(text).not.toMatch(/North|keep/)
    const download = page.waitForEvent('download')
    await panel.getByRole('button', { name: 'Download diagnostics' }).click()
    expect((await download).suggestedFilename()).toBe('numero-diagnostics.txt')

    await panel.getByRole('button', { name: 'Return home without reopening' }).click()
    await expect(page.getByRole('button', { name: /Drop a file here/ })).toBeVisible()
    // only the pointer was cleared: the dataset is still listed and opens
    await page.getByRole('complementary', { name: 'Datasets' }).getByRole('button', { name: /^keep/ }).click()
    await expect(page.getByText('40 rows', { exact: true }).first()).toBeVisible()
  })

  test('a dataset that did not finish opening last time is not reopened automatically', async ({ page }) => {
    await freshApp(page)
    await importCsv(page, 'heavy.csv', SALES)
    // as if the previous start died while opening it (a killed tab runs no unload handlers): set from a page that isn't the app
    await page.goto('/favicon.svg')
    await page.evaluate(() => localStorage.setItem('numero:opening', localStorage.getItem('numero:last')!))
    await page.goto('/')
    await expect(page.getByRole('button', { name: /Drop a file here/ })).toBeVisible()
    await expect(page.getByText('“heavy” was not reopened because it did not finish opening last time. Nothing was deleted.')).toBeVisible()
    await page.getByRole('button', { name: 'Open it' }).click()
    await expect(page.getByRole('heading', { name: 'heavy' })).toBeVisible()
    // a quick, ordinary reload is not a crash: it reopens
    await page.reload()
    await expect(page.getByRole('heading', { name: 'heavy' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: 'heavy' })).toBeVisible()
  })

  test('a map that cannot load says so in its own card; the rest of the dashboard works', async ({ page }) => {
    await freshApp(page)
    await page.route('**/geo/usa.json', (r) => r.abort())
    await openSample(page, 'Coffee Chain Sales', { showcase: true })
    await page.getByRole('tab', { name: 'Overview' }).click()
    const failed = page.getByText('The map outline could not be loaded').first()
    await failed.scrollIntoViewIfNeeded()
    await expect(failed).toBeVisible()
    await expect(page.getByRole('group', { name: /^Total records\./ })).toContainText('18.')
    // no error boundary, no global error message
    await expect(page.getByRole('heading', { name: 'Something went wrong on this page' })).toHaveCount(0)
    await page.unroute('**/geo/usa.json')
    await page.getByRole('button', { name: 'Try again' }).first().click()
    await expect(page.getByText('The map outline could not be loaded')).toHaveCount(0)
  })
})

test.describe('URL imports: cancel, failures, refresh (R7)', () => {
  const URL_ = 'https://data.example.test/metrics.csv'
  const BODY = 'day,visits,source\n2024-01-01,10,web\n2024-01-02,14,web\n2024-01-03,9,app\n2024-01-04,20,app\n'
  const fromUrl = async (page: Page, url = URL_) => {
    await page.getByRole('button', { name: 'From a URL' }).click()
    await page.getByRole('textbox', { name: 'URL' }).fill(url)
    await page.getByRole('dialog', { name: 'Import from a URL' }).getByRole('button', { name: 'Import' }).click()
  }
  const serve = (page: Page, body: string, status = 200) => page.route(URL_, (r) => r.fulfill({ status, contentType: 'text/csv', headers: { 'access-control-allow-origin': '*' }, body }))

  test('Cancel stops a slow download and no late preview appears', async ({ page }) => {
    await freshApp(page)
    let release: () => void = () => {}
    const held = new Promise<void>((res) => { release = res })
    await page.route(URL_, async (r) => { await held; await r.fulfill({ status: 200, contentType: 'text/csv', headers: { 'access-control-allow-origin': '*' }, body: BODY }).catch(() => {}) })
    await fromUrl(page)
    const overlay = page.getByRole('status').filter({ hasText: /Connecting|Downloading/ })
    await expect(overlay).toBeVisible()
    await overlay.getByRole('button', { name: 'Cancel' }).click()
    await expect(overlay).toHaveCount(0)
    release()
    await page.waitForTimeout(500)
    await expect(importDialog(page)).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
    // and trying again works
    await page.unroute(URL_)
    await serve(page, BODY)
    await fromUrl(page)
    await importDialog(page, /Import metrics\.csv/).getByRole('button', { name: 'Import 4 rows' }).click()
    await expect(page.getByRole('heading', { name: 'metrics' })).toBeVisible()
  })

  test('an HTTP error and an unreachable address give different guidance', async ({ page }) => {
    await freshApp(page)
    await serve(page, 'nope', 404)
    await fromUrl(page)
    await expect(page.getByRole('alert')).toContainText('The server answered 404')
    await expect(page.getByRole('alert')).toContainText('Nothing is published at that address')
    await page.getByRole('button', { name: 'Dismiss message' }).click()
    await page.unroute(URL_)
    await page.route(URL_, (r) => r.abort())
    await fromUrl(page)
    await expect(page.getByRole('alert')).toContainText('Could not download that URL')
  })

  test('an unchanged source creates no version and no undo step; a dropped column asks first', async ({ page }) => {
    await freshApp(page)
    await serve(page, BODY)
    await fromUrl(page)
    await importDialog(page, /Import metrics\.csv/).getByRole('button', { name: 'Import 4 rows' }).click()
    await expect(page.getByRole('heading', { name: 'metrics' })).toBeVisible()

    await page.getByRole('button', { name: 'Refresh' }).click()
    await expect(page.getByText('Checked “metrics” — no change since the last refresh')).toBeVisible()
    await expect(page.locator('[data-refresh-state="ok"]')).toContainText(/Checked .* · no change/)
    await expect(page.getByRole('button', { name: 'Undo (⌘Z)' })).toBeDisabled()
    const versions = () => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res) => { const r = indexedDB.open('numero'); r.onsuccess = () => res(r.result) })
      const all = await new Promise<{ source: { versions?: unknown[] } }[]>((res) => { const r = db.transaction('meta').objectStore('meta').getAll(); r.onsuccess = () => res(r.result) })
      db.close()
      return all[0].source.versions?.length ?? 0
    })
    expect(await versions()).toBe(0)

    // the source drops a column a chart uses: nothing is replaced until the user says so
    await page.unroute(URL_)
    await serve(page, 'day,source\n2024-01-01,web\n2024-01-02,web\n')
    await page.getByRole('button', { name: 'Refresh' }).click()
    const ask = page.getByRole('dialog', { name: 'The source no longer has “visits”' })
    await expect(ask).toContainText('Charts use visits')
    await expect(ask).toContainText('Nothing has been replaced yet')
    await ask.getByRole('button', { name: 'Keep current data' }).click()
    await expect(page.getByText('4 rows', { exact: true }).first()).toBeVisible()
    await expect(page.locator('[data-refresh-state="paused"]')).toContainText('Refresh paused')
    expect(await versions()).toBe(0)

    // a real change still refreshes, saves a version and can be undone
    await page.unroute(URL_)
    await serve(page, BODY + '2024-01-05,25,web\n')
    await page.getByRole('button', { name: 'Refresh' }).click()
    await expect(page.getByText(/Refreshed “metrics” · 5 rows/)).toBeVisible()
    expect(await versions()).toBe(1)
    await expect(page.getByRole('button', { name: 'Undo (⌘Z)' })).toBeEnabled()
  })

  test('a failing source shows one status in the header; offline is not reported as a failed address', async ({ page, context }) => {
    await freshApp(page)
    await serve(page, BODY)
    await fromUrl(page)
    await importDialog(page, /Import metrics\.csv/).getByRole('button', { name: 'Import 4 rows' }).click()
    await expect(page.getByRole('heading', { name: 'metrics' })).toBeVisible()
    await page.unroute(URL_)
    await serve(page, 'down', 503)
    await page.getByRole('button', { name: 'Refresh' }).click()
    await expect(page.locator('[data-refresh-state="failing"]')).toContainText('Refresh failing')
    await expect(page.locator('[data-refresh-state="failing"]')).toContainText('The server answered 503')
    await page.getByRole('button', { name: 'Refresh' }).click()
    await expect(page.locator('[data-refresh-state="failing"]')).toContainText('Refresh failing (2×)')
    await expect(page.locator('[data-refresh-state]')).toHaveCount(1)

    await context.setOffline(true)
    await expect(page.getByRole('status').filter({ hasText: 'Offline. Your datasets still work.' })).toBeVisible()
    await page.getByRole('button', { name: 'Refresh' }).click()
    await expect(page.locator('[data-refresh-state="offline"]')).toContainText('Offline · refresh waiting')
    await expect(page.getByText('You are offline — the data on screen is unchanged.')).toBeVisible()
    await expect(page.getByText(/CORS/)).toHaveCount(0)
    // local data keeps working
    await tab(page, 'Data')
    await expect(page.getByRole('cell', { name: 'web' }).first()).toBeVisible()
    await context.setOffline(false)
    await expect(page.getByRole('status').filter({ hasText: 'Offline. Your datasets still work.' })).toHaveCount(0)
  })
})

test.describe('local durability', () => {
  test('persistence is not requested on page load, only after the user imports data; the status is in plain words', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __persistCalls: number }
      w.__persistCalls = 0
      let kept = false
      navigator.storage.persist = async () => { w.__persistCalls++; kept = true; return true }
      navigator.storage.persisted = async () => kept
    })
    await freshApp(page)
    const calls = () => page.evaluate(() => (window as unknown as { __persistCalls: number }).__persistCalls)
    expect(await calls()).toBe(0)
    // a bundled sample is not the user's data
    await openSample(page, 'Seattle Weather')
    expect(await calls()).toBe(0)
    await page.getByRole('button', { name: 'Numero home' }).click()
    await page.getByRole('button', { name: 'Storage' }).click()
    const dlg = page.getByRole('dialog', { name: 'Browser storage' })
    await expect(dlg.getByRole('status', { name: 'How your data is kept' })).toContainText('Kept, unless the device runs low on space')
    await expect(dlg).toContainText('keep your source files')
    await dlg.getByRole('button', { name: 'Close' }).click()

    await importCsv(page, 'mine.csv', SALES)
    await expect.poll(calls).toBe(1)
    await page.getByRole('button', { name: 'Numero home' }).click()
    await page.getByRole('button', { name: 'Storage' }).click()
    await expect(dlg.getByRole('status', { name: 'How your data is kept' })).toContainText('Kept until you remove it')
    await expect(dlg).toContainText(/used/)
    await audit(page, 'storage dialog')
  })

  test('denied, unsupported and failing persistence all leave the app usable; a nearly full disk warns', async ({ page }) => {
    for (const mode of ['denied', 'unsupported', 'throws'] as const) {
      await page.addInitScript((m) => {
        const s = navigator.storage as unknown as Record<string, unknown>
        if (m === 'denied') { s.persist = async () => false; s.persisted = async () => false }
        if (m === 'unsupported') { s.persist = undefined; s.persisted = undefined }
        if (m === 'throws') { s.persist = async () => { throw new Error('SecurityError') }; s.persisted = async () => { throw new Error('SecurityError') } }
        s.estimate = async () => ({ usage: 96, quota: 100 })
      }, mode)
      const errors = await freshApp(page)
      await importCsv(page, `${mode}.csv`, SALES)
      await expect(page.getByText('40 rows', { exact: true }).first()).toBeVisible()
      await page.getByRole('button', { name: 'Numero home' }).click()
      await page.getByRole('button', { name: 'Storage' }).click()
      const dlg = page.getByRole('dialog', { name: 'Browser storage' })
      await expect(dlg.getByRole('status', { name: 'How your data is kept' })).toHaveAttribute('data-persist', mode === 'denied' ? 'best-effort' : mode === 'unsupported' ? 'unsupported' : 'error')
      await expect(dlg.getByRole('alert')).toContainText('Storage is almost full')
      expect(errors, mode).toEqual([])
    }
  })
})

test.describe('two open tabs (R6)', () => {
  test('edits to different datasets in two tabs are both kept, and each tab sees the other’s saves', async ({ context }) => {
    const a = await context.newPage()
    await freshApp(a)
    await importCsv(a, 'alpha.csv', SALES)
    await a.getByRole('button', { name: 'Numero home' }).click()
    await importCsv(a, 'beta.csv', SALES)

    const b = await context.newPage()
    await b.goto('/')
    await expect(b.getByRole('heading', { name: 'beta' })).toBeVisible()
    await b.getByRole('complementary', { name: 'Datasets' }).getByRole('button', { name: /^alpha/ }).click()
    await expect(b.getByRole('heading', { name: 'alpha' })).toBeVisible()

    // tab A edits beta, tab B edits alpha — each adds a page
    await a.getByRole('button', { name: 'Add page' }).click()
    await b.getByRole('button', { name: 'Add page' }).click()
    await b.getByRole('button', { name: 'Add page' }).click()
    await expect(b.getByRole('tab', { name: /Page 3/ })).toBeVisible()
    await a.waitForTimeout(400)

    // with the old single shared value, the second save overwrote the first tab's dashboard
    const c = await context.newPage()
    await c.goto('/')
    await c.getByRole('complementary', { name: 'Datasets' }).getByRole('button', { name: /^beta/ }).click()
    await expect(c.getByRole('tab', { name: /Page 2/ })).toBeVisible()
    await c.getByRole('complementary', { name: 'Datasets' }).getByRole('button', { name: /^alpha/ }).click()
    await expect(c.getByRole('tab', { name: /Page 3/ })).toBeVisible()

    // the same dataset in two tabs: a save in one shows in the other, with a warning
    await a.getByRole('complementary', { name: 'Datasets' }).getByRole('button', { name: /^alpha/ }).click()
    await expect(a.getByRole('tab', { name: /Page 3/ })).toBeVisible()
    await expect(a.getByText('This dataset is also open in another tab.')).toBeVisible()
    await expect(b.getByText('This dataset is also open in another tab.')).toBeVisible()
    await b.getByRole('button', { name: 'Add page' }).click()
    await expect(a.getByRole('tab', { name: /Page 4/ })).toBeVisible()

    // a dataset imported in one tab appears in the other's list
    await b.getByRole('button', { name: 'Numero home' }).click()
    await importCsv(b, 'gamma.csv', SALES)
    await expect(a.getByRole('complementary', { name: 'Datasets' }).getByRole('button', { name: /^gamma/ })).toBeVisible()
  })

  test('dashboards saved by the previous storage layout move into the database (migration)', async ({ page }) => {
    await freshApp(page)
    await importCsv(page, 'legacy.csv', SALES)
    await page.getByRole('button', { name: 'Add page' }).click()
    await page.waitForTimeout(300)
    // put the dashboards back where the previous version kept them
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res) => { const r = indexedDB.open('numero'); r.onsuccess = () => res(r.result) })
      const all = await new Promise<{ datasetId: string }[]>((res) => { const r = db.transaction('dashboards').objectStore('dashboards').getAll(); r.onsuccess = () => res(r.result) })
      await new Promise<void>((res) => { const tx = db.transaction('dashboards', 'readwrite'); tx.objectStore('dashboards').clear(); tx.oncomplete = () => res() })
      db.close()
      localStorage.setItem('numero:dashboards', JSON.stringify(Object.fromEntries(all.map((d) => [d.datasetId, d]))))
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'legacy' })).toBeVisible()
    await expect(page.getByRole('tab', { name: /Page 2/ })).toBeVisible()
    const state = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res) => { const r = indexedDB.open('numero'); r.onsuccess = () => res(r.result) })
      const n = await new Promise<number>((res) => { const r = db.transaction('dashboards').objectStore('dashboards').count(); r.onsuccess = () => res(r.result) })
      db.close()
      return { inDb: n, old: localStorage.getItem('numero:dashboards') }
    })
    expect(state).toEqual({ inDb: 1, old: null })
  })
})

test.describe('browser history (R10)', () => {
  test('Back returns Home; reload keeps dataset, tab and page; Back closes a dialog first', async ({ page }) => {
    await freshApp(page)
    await importCsv(page, 'nav.csv', SALES)
    await expect(page).toHaveURL(/#\/d\/ds_[^/]+(\/dashboard\/[^/]+)?$/)
    await page.getByRole('button', { name: 'Add page' }).click()
    await expect(page.getByRole('tab', { name: /Page 2/ })).toBeVisible()
    await tab(page, 'Data')
    await expect(page).toHaveURL(/#\/d\/ds_[^/]+\/data$/)

    // reload: same dataset and tab
    await page.reload()
    await expect(page.getByRole('heading', { name: 'nav' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Data' })).toHaveAttribute('aria-selected', 'true')

    // Back: the dashboard, on the page that was open
    await page.goBack()
    await expect(page.getByRole('tab', { name: 'Dashboard' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: /Page 2/ })).toHaveAttribute('aria-selected', 'true')
    await page.reload()
    await expect(page.getByRole('tab', { name: /Page 2/ })).toHaveAttribute('aria-selected', 'true')

    // Back with a dialog open closes the dialog and stays
    await page.getByRole('button', { name: 'New column' }).click()
    await expect(page.getByRole('dialog').first()).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'nav' })).toBeVisible()

    // Back through the views ends at Home, inside the app; Forward returns
    for (let i = 0; i < 4 && !(await page.getByRole('button', { name: /Drop a file here/ }).isVisible()); i++) await page.goBack()
    await expect(page.getByRole('button', { name: /Drop a file here/ })).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/')
    await page.goForward()
    await expect(page.getByRole('heading', { name: 'nav' })).toBeVisible()
  })
})

test.describe('exports and backup', () => {
  test('CSV exports start with a byte-order mark and neutralise formula cells (R9)', async ({ page }) => {
    await freshApp(page)
    await importCsv(page, 'notes.csv', 'city,note,n\n' + days(8, (i) => `${['München', 'Zürich', '東京'][i % 3]},${i === 0 ? '=1+1' : i === 1 ? '@SUM(A1)' : `ok ${i}`},${i - 3}`))
    await tab(page, 'Data')
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: /Export|CSV/ }).first().click()
    const csvItem = page.getByRole('button', { name: /CSV/ }).last()
    if (await csvItem.isVisible().catch(() => false)) await csvItem.click().catch(() => {})
    const file = await download
    const bytes = await (await import('node:fs/promises')).readFile((await file.path())!)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = bytes.toString('utf8')
    expect(text).toContain('München')
    expect(text).toContain('東京')
    expect(text).toContain("'=1+1")
    expect(text).toContain("'@SUM(A1)")
    // real negative numbers are untouched
    expect(text).toMatch(/,-3(\n|$)/)
  })

  test('workspace backup round trip; a damaged file changes nothing', async ({ page }) => {
    await freshApp(page)
    await importCsv(page, 'books.csv', SALES)
    await page.getByRole('button', { name: 'Add page' }).click()
    await page.getByRole('button', { name: 'Numero home' }).click()
    await page.getByRole('button', { name: 'Backup' }).click()
    const dlg = page.getByRole('dialog', { name: 'Back up and restore' })
    await dlg.getByRole('radio', { name: /Include the data rows/ }).check()
    await audit(page, 'backup dialog')
    const download = page.waitForEvent('download')
    await dlg.getByRole('button', { name: 'Create backup' }).click()
    const file = await download
    expect(file.suggestedFilename()).toMatch(/^numero-\d{4}-\d{2}-\d{2}\.numero-backup\.json$/)
    await expect(dlg.getByRole('status')).toContainText('Backup saved: 1 dataset')
    const fs = await import('node:fs/promises')
    const text = await fs.readFile((await file.path())!, 'utf8')
    const json = JSON.parse(text)
    expect(json).toMatchObject({ app: 'numero', kind: 'workspace', version: 1, includesData: true })

    // a damaged copy: refused as a whole
    const damaged = JSON.parse(text)
    damaged.datasets[0].data.rows[0][2] = '999999'
    await dlg.getByLabel('Backup file').setInputFiles({ name: 'damaged.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(damaged)) })
    await expect(dlg.getByRole('alert')).toContainText('“books” in this backup is damaged (its checksum does not match)')
    await dlg.getByLabel('Backup file').setInputFiles({ name: 'cut.json', mimeType: 'application/json', buffer: Buffer.from(text.slice(0, text.length / 2)) })
    await expect(dlg.getByRole('alert')).toContainText('not a readable Numero backup')

    // wipe everything, then restore from the good file
    await dlg.getByRole('button', { name: 'Close' }).click()
    await page.evaluate(async () => { localStorage.clear(); localStorage.setItem('numero:theme', 'light'); await new Promise<void>((res) => { const r = indexedDB.deleteDatabase('numero'); r.onsuccess = r.onerror = r.onblocked = () => res() }) })
    await page.reload()
    await expect(page.getByRole('complementary', { name: 'Datasets' })).toContainText('Nothing imported yet.')
    // Backup lives beside Storage, which only shows once something is stored: restore is also reachable from the palette-free path below
    await picker(page).setInputFiles(csvFile('seed.csv', 'a,b\n1,2\n'))
    await importDialog(page).getByRole('button', { name: 'Import 1 rows' }).click()
    await page.getByRole('button', { name: 'Numero home' }).click()
    await page.getByRole('button', { name: 'Backup' }).click()
    await dlg.getByLabel('Backup file').setInputFiles({ name: 'good.numero-backup.json', mimeType: 'application/json', buffer: Buffer.from(text) })
    await expect(dlg).toContainText('1 dataset · with data rows')
    await expect(dlg.locator('[data-plan="copy"]')).toContainText('Result: 1 added')
    await dlg.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect(dlg.getByRole('status')).toContainText('Restored: 1 added')
    await dlg.getByRole('button', { name: 'Close' }).click()
    await page.getByRole('complementary', { name: 'Datasets' }).getByRole('button', { name: /^books/ }).click()
    await expect(page.getByText('40 rows', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('tab', { name: /Page 2/ })).toBeVisible()
  })
})

test.describe('privacy and insights', () => {
  test('no request leaves for a third-party origin on load or while using a sample', async ({ page }) => {
    const foreign: string[] = []
    page.on('request', (r) => { const u = new URL(r.url()); if (!['localhost', '127.0.0.1'].includes(u.hostname) && u.protocol.startsWith('http')) foreign.push(r.url()) })
    await freshApp(page)
    await openSample(page, 'Seattle Weather')
    await tab(page, 'Insights')
    expect(foreign).toEqual([])
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).not.toMatch(/Inter/)
  })

  test('the suggested dashboard carries the top insights, named like the Insights tab', async ({ page }) => {
    await freshApp(page)
    await openSample(page, 'Seattle Weather')
    const heading = page.getByRole('heading', { name: 'What stands out' })
    await heading.scrollIntoViewIfNeeded()
    const card = page.locator('div', { has: heading }).last()
    const first = (await card.getByRole('listitem').first().innerText()).split(' — ')[0]
    expect(first.length).toBeGreaterThan(5)
    await card.getByRole('button', { name: /See all insights/ }).click()
    await expect(page.getByRole('tab', { name: 'Insights' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText(first, { exact: true }).first()).toBeVisible()
    // each finding says what it rests on
    await page.getByText(/what this rests on/).first().click()
    await expect(page.getByText(/1,461 rows/).first()).toBeVisible()
  })
})
