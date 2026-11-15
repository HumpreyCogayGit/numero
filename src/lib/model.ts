import type { Column, DatasetModel, Row } from '../types'
import { buildTable } from './infer'
import { applyComputed } from './computed'
import { applyPrep, type SourceResolver, type StepReport, type Table } from './prep'

export const emptyModel = (): DatasetModel => ({ overrides: {}, names: {}, formats: {}, computed: [], measures: [], prep: [], options: {} })

/** Older stored models may miss newer fields. */
export const normalizeModel = (m: Partial<DatasetModel> | undefined): DatasetModel => ({ ...emptyModel(), ...(m ?? {}) })

export interface Built {
  columns: Column[]
  rows: Row[]
  /** columns as they look after prep, before typing — prep step editors pick from these */
  prepHeaders: string[]
  reports: StepReport[]
}

/** The single rebuild path: raw source → prep steps → typing (with overrides) → names/formats → computed columns. */
export function buildDataset(source: Table, model: DatasetModel, resolve?: SourceResolver): Built {
  const decimal = model.options.decimal ?? '.'
  const prepped = model.prep.length ? applyPrep(source, model.prep, resolve, decimal) : { ...source, reports: [] }
  const typed = buildTable(prepped.headers, prepped.rows, model.overrides, undefined, { decimal, dateOrder: model.options.dateOrder, softBlanks: model.options.softBlanks })
  const base = typed.columns.map((c) => ({
    ...c,
    name: model.names[c.key] ?? c.name,
    display: model.formats[c.key],
  }))
  const { columns, rows } = applyComputed(base, typed.rows, model.computed)
  for (const c of columns) if (c.formula != null && model.formats[c.key]) c.display = model.formats[c.key]
  return { columns, rows, prepHeaders: prepped.headers, reports: prepped.reports }
}
