import { describe, expect, it } from 'vitest'
import { BACKUP_VERSION, BackupError, buildArchive, decodeRows, encodeRows, estimateBackupBytes, migrateArchive, planRestore, summarize, validateArchive, type BackupInput } from '../../src/lib/backup'
import { emptyModel } from '../../src/lib/model'
import { workAtStake, needsConfirm, trashRemaining } from '../../src/lib/trash'
import { TRASH_MS } from '../../src/lib/db'
import { headersMatch, peekHeaders, sameColumns } from '../../src/lib/multi'
import { provenance, sharedProvenance } from '../../src/lib/provenance'
import type { Dashboard, DatasetMeta } from '../../src/types'

const meta = (id: string, name: string, extra: Partial<DatasetMeta> = {}): DatasetMeta => ({
  id, name, fileName: `${name}.csv`, format: 'csv', createdAt: 1_700_000_000_000, rowCount: 2, columnCount: 2, bytes: 1000,
  source: { kind: 'file', lastLoaded: 1_700_000_000_000 }, model: emptyModel(), ...extra,
})
const dash = (id: string): Dashboard => ({ datasetId: id, activePage: 'p1', pages: [{ id: 'p1', name: 'Overview', filters: [], widgets: [{ id: 'w1', type: 'bar', title: 'Sales by city', size: 'md', dimension: 'city', measures: [{ id: 'm', column: 'sales', agg: 'sum' }] }] }] })
const rows = [{ city: 'Oslo', sales: '10' }, { city: 'Zürich', sales: '12,5' }]
const full = (): BackupInput[] => [
  {
    meta: meta('ds_a', 'Sales', {
      source: { kind: 'url', url: 'https://example.test/s.csv', refreshMinutes: 15, lastLoaded: 5, versions: [{ key: 'ds_a::v1', at: 1, rows: 1, label: 'old' }] },
      model: { ...emptyModel(), names: { city: 'Town' }, formats: { sales: { decimals: 1 } }, computed: [{ key: 'calc_x', name: 'Double', formula: '[sales] * 2' }], measures: [{ key: 'm_r', name: 'Rate', formula: 'SUM([sales]) / COUNT()' }], prep: [{ id: 's1', op: 'trim' }, { id: 's2', op: 'join', datasetId: 'ds_b', leftKey: 'city', rightKey: 'city', how: 'left' }], options: { decimal: ',', delimiter: ';' } },
    }),
    dashboard: dash('ds_a'), source: { headers: ['city', 'sales'], rows },
  },
  { meta: meta('ds_b', 'Cities'), dashboard: dash('ds_b'), source: { headers: ['city', 'when'], rows: [{ city: 'Oslo', when: new Date(Date.UTC(2024, 0, 15)) }, { city: 'Rome', when: null }] } },
]
const archive = async (items = full(), includeData = true) => JSON.parse((await buildArchive(items, { includeData, settings: { theme: 'dark', patterns: true }, now: 0, appVersion: '0.1.0' })).parts.join(''))
const rejects = async (json: unknown) => validateArchive(json).then(() => { throw new Error('accepted') }, (e: Error) => e)

describe('workspace backup', () => {
  it('round trip keeps dashboards, formulas, prep steps, formats and source details', async () => {
    const a = await validateArchive(await archive())
    expect(a).toMatchObject({ app: 'numero', kind: 'workspace', version: BACKUP_VERSION, includesData: true, settings: { theme: 'dark', patterns: true }, createdAt: '1970-01-01T00:00:00.000Z' })
    const plan = planRestore(a, [], 'merge')
    expect(summarize(plan)).toEqual({ added: 2, replaced: 0, settings: 0, skipped: [] })
    const [sales, cities] = plan.items
    const original = full()[0]
    expect(sales.meta!.model).toEqual(original.meta.model)
    expect(sales.meta!.source).toMatchObject({ kind: 'url', url: 'https://example.test/s.csv', refreshMinutes: 15 })
    expect(sales.dashboard).toEqual(original.dashboard)
    expect(decodeRows(sales.data!)).toEqual(rows)
    // spreadsheet dates come back as dates
    expect(decodeRows(cities.data!)[0].when).toEqual(new Date(Date.UTC(2024, 0, 15)))
    // saved versions belong to the browser they were made in
    expect(sales.meta!.source.versions).toBeUndefined()
  })
  it('rows are stored once, as arrays in header order', () => {
    const d = encodeRows(['a', 'b'], [{ a: 1, b: 'x' }, { a: null, b: undefined }])
    expect(d).toEqual({ headers: ['a', 'b'], rows: [[1, 'x'], [null, null]] })
    expect(decodeRows(d)).toEqual([{ a: 1, b: 'x' }, { a: null, b: null }])
  })
  it('a settings-only backup is small and restores onto datasets that are already here', async () => {
    const a = await validateArchive(await archive(full(), false))
    expect(a.includesData).toBe(false)
    expect(a.manifest.every((m) => !m.hasData)).toBe(true)
    const here = [meta('ds_a', 'Sales (renamed here)', { rowCount: 99 })]
    const s = summarize(planRestore(a, here, 'merge'))
    expect(s).toMatchObject({ added: 0, settings: 1 })
    expect(s.skipped).toEqual([{ name: 'Cities', reason: expect.stringMatching(/no rows/) }])
    // rows stay, settings and dashboard come back
    const item = planRestore(a, here, 'merge').items[0]
    expect(item.data).toBeUndefined()
    expect(item.meta).toMatchObject({ rowCount: 99, name: 'Sales' })
    expect(item.meta!.model.computed).toHaveLength(1)
    // nothing to copy from without rows
    expect(summarize(planRestore(a, here, 'copy')).skipped).toHaveLength(2)
  })
  it('estimates the size before the file is made', () => {
    const metas = [{ bytes: 1_000_000 }, { bytes: 3_000_000 }]
    expect(estimateBackupBytes(metas, false)).toBeLessThan(100_000)
    expect(estimateBackupBytes(metas, true)).toBeGreaterThan(4_000_000)
  })
  it('reports datasets whose rows could not be read, and still writes the rest', async () => {
    const items = full()
    delete items[1].source
    const { parts, skipped } = await buildArchive(items, { includeData: true })
    expect(skipped).toEqual([{ name: 'Cities', reason: expect.stringMatching(/could not be read/) }])
    const a = await validateArchive(JSON.parse(parts.join('')))
    expect(a.manifest.map((m) => m.hasData)).toEqual([true, false])
  })

  describe('validated in full before anything is restored', () => {
    it('refuses files that are not workspace backups, saying what they are', async () => {
      expect((await rejects(null)).message).toBe('This file is not a Numero backup.')
      expect((await rejects({ app: 'other' })).message).toBe('This file is not a Numero backup.')
      expect((await rejects({ app: 'numero', version: 1, dashboard: { pages: [] } })).message).toMatch(/single dashboard export/)
    })
    it('refuses a backup from a newer version; reads the current one', async () => {
      const a = await archive()
      expect((await rejects({ ...a, version: BACKUP_VERSION + 1 })).message).toMatch(/newer version of Numero/)
      expect(() => migrateArchive({ ...a, version: 'x' })).toThrow(BackupError)
      expect(migrateArchive(a).version).toBe(1)
    })
    it('a changed byte anywhere in a dataset fails its checksum', async () => {
      const a = await archive()
      a.datasets[1].data.rows[0][0] = 'Tampered'
      const e = await rejects(a)
      expect(e).toBeInstanceOf(BackupError)
      expect(e.message).toBe('“Cities” in this backup is damaged (its checksum does not match). Nothing was restored.')
    })
    it('a cut-off or inconsistent file is refused as a whole', async () => {
      const a = await archive()
      expect((await rejects({ ...a, datasets: a.datasets.slice(0, 1) })).message).toMatch(/lists 2 datasets but holds 1/)
      expect((await rejects({ ...a, datasets: undefined })).message).toMatch(/incomplete/)
      const twice = await archive([full()[0], full()[0]])
      expect((await rejects(twice)).message).toMatch(/twice/)
    })
  })

  describe('conflicts', () => {
    it('merge brings a dataset that is already here back to the backup and keeps its saved versions', async () => {
      const a = await validateArchive(await archive())
      const versions = [{ key: 'k', at: 2, rows: 5, label: 'local' }]
      const plan = planRestore(a, [meta('ds_a', 'Sales', { source: { kind: 'file', versions } }), meta('ds_z', 'Cities')], 'merge')
      expect(plan.conflicts).toEqual({ ids: 1, names: 1 })
      expect(plan.items.map((i) => [i.action, i.name, i.meta!.id])).toEqual([['replace', 'Sales', 'ds_a'], ['add', 'Cities (restored)', 'ds_b']])
      expect(plan.items[0].meta!.source.versions).toEqual(versions)
    })
    it('copy touches nothing here: new ids, new names, joins follow the copies', async () => {
      const a = await validateArchive(await archive())
      const plan = planRestore(a, [meta('ds_a', 'Sales'), meta('ds_b', 'Cities')], 'copy', 123)
      const [sales, cities] = plan.items
      expect(plan.items.every((i) => i.action === 'add')).toBe(true)
      expect([sales.name, cities.name]).toEqual(['Sales (restored)', 'Cities (restored)'])
      expect(new Set([sales.meta!.id, cities.meta!.id, 'ds_a', 'ds_b']).size).toBe(4)
      expect(sales.dashboard!.datasetId).toBe(sales.meta!.id)
      const join = sales.meta!.model.prep.find((s) => s.op === 'join')
      expect(join).toMatchObject({ datasetId: cities.meta!.id })
    })
  })
})

describe('R5 removing a dataset', () => {
  it('asks only when work would be lost, and says what', () => {
    const plain = meta('a', 'Plain')
    expect(needsConfirm(plain, dash('a'))).toBe(false)
    expect(workAtStake(plain, dash('a'))).toEqual([])
    const worked = meta('b', 'Worked', { source: { kind: 'file', versions: [{ key: 'k', at: 1, rows: 1, label: 'x' }, { key: 'k2', at: 2, rows: 1, label: 'y' }] }, model: { ...emptyModel(), prep: [{ id: 's', op: 'trim' }], computed: [{ key: 'c', name: 'C', formula: '1' }], measures: [{ key: 'm', name: 'M', formula: 'COUNT()' }] } })
    expect(workAtStake(worked, { ...dash('b'), edited: true })).toEqual(['a dashboard you changed', '1 preparation step', '2 formulas', '2 saved versions of the data'])
    expect(needsConfirm(worked)).toBe(true)
    expect(needsConfirm(plain, { ...dash('a'), edited: true })).toBe(true)
  })
  it('a sample’s built-in showcase is not the user’s work', () => {
    const sample = meta('s', 'Coffee', { source: { kind: 'sample' }, model: { ...emptyModel(), prep: [{ id: 's', op: 'trim' }], measures: [{ key: 'm', name: 'M', formula: 'COUNT()' }] } })
    expect(needsConfirm(sample, dash('s'))).toBe(false)
    expect(needsConfirm(sample, { ...dash('s'), edited: true })).toBe(true)
  })
  it('says how long a removed dataset can still be restored', () => {
    const now = 1_000_000_000
    expect(trashRemaining({ trashedAt: now }, now)).toBe('7 days left')
    expect(trashRemaining({ trashedAt: now - TRASH_MS + 30 * 3_600_000 }, now)).toBe('2 days left')
    expect(trashRemaining({ trashedAt: now - 60_000 }, now)).toBe('7 days left')
    expect(trashRemaining({ trashedAt: now - TRASH_MS + 5 * 3_600_000 }, now)).toBe('5 hours left')
    expect(trashRemaining({ trashedAt: now - TRASH_MS + 60_000 }, now)).toBe('under an hour left')
    expect(trashRemaining({ trashedAt: now - TRASH_MS - 1 }, now)).toBe('being erased')
  })
})

describe('R3 several files dropped together', () => {
  const f = (text: string, name: string) => new File([text], name)
  it('offers to combine only files with the same columns', async () => {
    expect(await sameColumns([f('day,sales\n1,2\n', 'jan.csv'), f('day,sales\n3,4\n', 'feb.csv')])).toBe(true)
    // order does not matter, names do
    expect(await sameColumns([f('day,sales\n1,2\n', 'jan.csv'), f('sales,day\n4,3\n', 'feb.csv')])).toBe(true)
    expect(await sameColumns([f('day,sales\n1,2\n', 'jan.csv'), f('day,revenue\n3,4\n', 'feb.csv')])).toBe(false)
    expect(await sameColumns([f('day,sales\n1,2\n', 'jan.csv'), f('[{"day":1}]', 'feb.json')])).toBe(false)
    expect(await sameColumns([f('day,sales\n1,2\n', 'jan.csv')])).toBe(false)
  })
  it('reads only the header row', async () => {
    expect(await peekHeaders(f('a;b;c\n1;2;3\n', 'x.csv'))).toEqual(['a', 'b', 'c'])
    expect(await peekHeaders(f('{}', 'x.json'))).toBeNull()
    expect(headersMatch(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(headersMatch(['a', 'a'], ['a', 'a'])).toBe(false)
  })
})

describe('provenance', () => {
  const fmt = (t: number) => `t${t}`
  it('says when and from where the data was loaded, and marks a truncated import', () => {
    const m = meta('u', 'Metrics', { rowCount: 1000, columnCount: 4, source: { kind: 'url', url: 'https://example.test/m.csv?key=1', refreshMinutes: 15, lastLoaded: 10, lastChecked: 5000, truncated: true, rowLimit: 1000, ragged: { long: 2, short: 1 }, updates: [{ at: 10, mode: 'refresh', fileName: 'm.csv', rowsBefore: 900, rowsAfter: 1000, added: 1000, skipped: 0 }] }, model: { ...emptyModel(), prep: [{ id: 'a', op: 'trim' }, { id: 'b', op: 'trim', disabled: true }] } })
    const lines = Object.fromEntries(provenance(m, fmt).map((l) => [l.label, l]))
    expect(lines.Source.value).toBe('Downloaded from a URL · Metrics.csv')
    expect(lines.Imported.value).toBe('t1700000000000')
    expect(lines['Last change'].value).toBe('t10 · refresh from m.csv · 900 → 1,000 rows')
    expect(lines.Refresh.value).toBe('Every 15 minutes while open')
    expect(lines['Last checked'].value).toBe('t5000 · no change since the data was loaded')
    expect(lines['Row limit']).toMatchObject({ tone: 'warn', value: expect.stringMatching(/first 1,000 rows/) })
    expect(lines['Uneven rows'].value).toMatch(/3 rows .* \(2 lost extra cells\)/)
    expect(lines.Preparation.value).toBe('1 step applied before charts')
  })
  it('the shared form carries no full address and no file list', () => {
    const m = meta('u', 'Metrics', { source: { kind: 'url', url: 'https://example.test/private/m.csv?token=secret', lastLoaded: 0, files: ['a.csv', 'b.csv'] } })
    const p = sharedProvenance(m)
    expect(p).toMatchObject({ kind: 'url', host: 'example.test', rows: 2, prepSteps: 0 })
    expect(JSON.stringify(p)).not.toMatch(/secret|private|a\.csv/)
  })
})
