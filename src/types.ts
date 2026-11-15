export type ColType = 'number' | 'date' | 'category' | 'text' | 'boolean'
/** percent: the value already is a percentage (12 → 12%); ratio: a fraction shown ×100 (0.12 → 12%) */
export type NumFormat = 'integer' | 'decimal' | 'currency' | 'percent' | 'ratio'
export type DateGrain = 'year' | 'month' | 'day' | 'datetime'

/** Cell values after coercion. Dates are stored as epoch milliseconds (UTC). */
export type Value = string | number | boolean | null
export type Row = Record<string, Value>
export type RawValue = string | number | boolean | Date | null | undefined
export type RawRow = Record<string, RawValue>

export interface Column {
  key: string
  name: string
  type: ColType
  /** type the inference picked; lets the UI show "reset to detected" */
  detected: ColType
  format?: NumFormat
  currency?: string
  grain?: DateGrain
  /** integer-like numbers with few distinct values (e.g. cylinders, rating 1–5) */
  discrete?: boolean
  isId?: boolean
  /** a unit every value carried in the file ("5 kg"): read as a number, the unit kept here */
  unit?: string
  /** smallest and largest value of a number column */
  range?: [number, number]
  distinct: number
  missing: number
  /** user display settings (decimals, prefix, date pattern…) */
  display?: ColumnFormat
  /** set on computed columns */
  formula?: string
  formulaError?: string
}

export interface ColumnFormat {
  num?: NumFormat
  decimals?: number
  prefix?: string
  suffix?: string
  /** false shows full numbers (1,234,567) instead of 1.2M */
  compact?: boolean
  currency?: string
  /** DATEFORMAT-style pattern, e.g. "MMM D, YYYY" */
  datePattern?: string
}

export interface ComputedDef {
  key: string
  name: string
  formula: string
  /** 'auto' picks integer/decimal from the results */
  format?: NumFormat | 'auto'
}

/** Aggregate-level formula evaluated per chart cell, e.g. SUM([Profit]) / SUM([Revenue]). */
export interface MeasureDef {
  key: string
  name: string
  formula: string
  format?: NumFormat | 'auto'
}

export interface ImportOptions {
  /** '' = detect */
  delimiter?: string
  /** '' = detect (BOM, then UTF-8, falling back to Windows-1252) */
  encoding?: string
  /** rows to skip before the header row */
  skipRows?: number
  /** false = the file has no header row */
  header?: boolean
  dateOrder?: 'auto' | 'mdy' | 'dmy' | 'ymd'
  decimal?: '.' | ','
  rowLimit?: number
  sheet?: string
  /**
   * NA, None and - : 'auto' (default) reads them as blank in number and date columns and keeps them as values
   * in categories, unless the file uses the same marker under a number; 'always' / 'never' apply to every column.
   */
  softBlanks?: 'auto' | 'always' | 'never'
}

export type PrepStep = { id: string; disabled?: boolean } & (
  | { op: 'dedupe'; columns?: string[] }
  | { op: 'dropBlank'; column?: string }
  | { op: 'fill'; column: string; method: 'value' | 'previous' | 'next' | 'mean' | 'median' | 'zero'; value?: string }
  | { op: 'trim'; columns?: string[] }
  | { op: 'case'; column: string; mode: 'upper' | 'lower' | 'proper' }
  | { op: 'replace'; column?: string; find: string; replace: string; matchCase?: boolean; wholeCell?: boolean }
  | { op: 'split'; column: string; separator: string; parts: number; keepOriginal?: boolean }
  | { op: 'remove'; columns: string[] }
  | { op: 'reorder'; columns: string[] }
  | { op: 'filter'; column: string; cmp: FilterCmp; value?: string; keep: boolean }
  | { op: 'unpivot'; columns: string[]; nameColumn: string; valueColumn: string }
  | { op: 'join'; datasetId: string; leftKey: string; rightKey: string; how: 'left' | 'inner'; columns?: string[]; prefix?: string }
  | { op: 'append'; datasetId: string }
)
export type PrepOp = PrepStep['op']
export type FilterCmp = 'eq' | 'neq' | 'contains' | 'notContains' | 'gt' | 'lt' | 'gte' | 'lte' | 'blank' | 'notBlank'

export interface DatasetModel {
  overrides: Record<string, ColType>
  names: Record<string, string>
  formats: Record<string, ColumnFormat>
  computed: ComputedDef[]
  measures: MeasureDef[]
  prep: PrepStep[]
  options: ImportOptions
}

export interface DataSource {
  kind: 'file' | 'url' | 'paste' | 'sample'
  url?: string
  /** auto-refresh interval while the dataset is open (url sources) */
  refreshMinutes?: number
  lastLoaded?: number
  /** recent data updates, newest first */
  updates?: DataUpdate[]
  /** earlier versions of the data that can be restored, newest first */
  versions?: DataVersion[]
  /** the import stopped at a row limit: the file has more rows than were loaded */
  truncated?: boolean
  rowLimit?: number
  /** rows whose cell count differed from the header's when the file was read */
  ragged?: { long: number; short: number }
  /** several files with the same columns, combined at import */
  files?: string[]
  /** url sources: fingerprint of the bytes last loaded, so an unchanged download is not stored again */
  hash?: string
  /** url sources: when the address was last checked, whether or not anything had changed */
  lastChecked?: number
}

export interface DataVersion {
  /** storage key of the saved rows */
  key: string
  /** when it was replaced */
  at: number
  /** rows as the dashboard showed them */
  rows: number
  /** approximate stored size (the dataset's size when it was saved) */
  bytes?: number
  /** what replaced it, e.g. "Before appending orders-2025-07.csv" */
  label: string
}

export interface DataUpdate {
  at: number
  mode: 'append' | 'replace' | 'refresh' | 'restore'
  fileName: string
  rowsBefore: number
  rowsAfter: number
  added: number
  /** rows already loaded that were overwritten with new values */
  updated?: number
  /** rows removed because a full export (sync) no longer listed them */
  removed?: number
  skipped: number
  /** the "What changed" summary shown after the update */
  changes?: ChangeReport
}

/** What an update changed: KPI moves, the biggest movers in the latest period, new category values, outliers. */
export interface ChangeReport {
  at: number
  fileName: string
  rowsBefore: number
  rowsAfter: number
  /** the latest period in the new data and the one it's compared with */
  period?: { label: string; previous: string; partial?: boolean }
  /** KPIs of the first page passed (the active one) come first; `other` marks those from other pages */
  kpis: { title: string; before: string; after: string; change?: number; upIsGood?: boolean; target?: string; crossed?: 'reached' | 'fell below'; other?: boolean; key?: string }[]
  movers: { dimension: string; value: string; measure: string; current: string; previous: string; change: number; pct?: number }[]
  newValues: { column: string; values: string[]; more: number }[]
  outliers: { column: string; count: number; highest: string; usual: string }[]
}

export type FileFormat = 'csv' | 'tsv' | 'json' | 'xlsx' | 'xls'

/** Everything about a dataset except its rows — small, always in memory. */
export interface DatasetMeta {
  id: string
  name: string
  fileName: string
  format: FileFormat
  sheet?: string
  createdAt: number
  rowCount: number
  columnCount: number
  /** approximate stored size */
  bytes?: number
  source: DataSource
  model: DatasetModel
  /** set when the dataset was removed: it can be restored until the retention window ends */
  trashedAt?: number
  /** data-quality notes shown (and accepted) when the file was imported */
  review?: { at: number; checks: { column: string; kind: string; severity: 'warning' | 'info'; count: number; message: string }[] }
}

/** A loaded dataset: typed rows ready to query. */
export interface Dataset extends DatasetMeta {
  columns: Column[]
  rows: Row[]
}

export type Agg = 'count' | 'sum' | 'avg' | 'median' | 'min' | 'max' | 'distinct' | 'std' | 'p90' | 'p10' | 'calc'
export type DateBucket = 'auto' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year' | 'dow' | 'moy'

export type ChartType =
  | 'kpi' | 'bar' | 'hbar' | 'line' | 'area' | 'donut' | 'scatter'
  | 'histogram' | 'heatmap' | 'table' | 'box' | 'treemap' | 'correlation'
  | 'map' | 'points' | 'text' | 'waterfall' | 'pareto' | 'funnel' | 'cohort'

export interface Measure {
  id: string
  column?: string
  agg: Agg
  /** MeasureDef key when agg = 'calc' */
  calc?: string
}

export interface Filter {
  id: string
  column: string
  /** category / boolean / text: keep only these values */
  values?: string[]
  /** number & date: inclusive range */
  min?: number
  max?: number
  /** text: substring match */
  text?: string
  exclude?: boolean
  /** set when created by clicking a chart (cross-filter) */
  fromWidget?: string
  /** date filters that roll forward with the data: the last N units up to the latest date in the dataset */
  relative?: { last: number; unit: 'day' | 'week' | 'month' | 'quarter' | 'year'; /** whole calendar periods (e.g. last 3 complete months) instead of a rolling window */ calendar?: boolean }
}

export type SortMode = 'value-desc' | 'value-asc' | 'label-asc' | 'label-desc' | 'natural'
/** grid spans out of 12: xs=3, sm=4, md=6, lg=8, full=12 */
export type WidgetSize = 'xs' | 'sm' | 'md' | 'lg' | 'full'

export interface RefLine {
  id: string
  kind: 'avg' | 'median' | 'value'
  value?: number
  label?: string
}
export interface Note { id: string; at: string; text: string }
export interface Band { id: string; from: string; to: string; label?: string }
export interface DrillLevel { dimension: string; bucket?: DateBucket; filter: Filter }

export interface Widget {
  id: string
  title: string
  subtitle?: string
  type: ChartType
  size: WidgetSize
  dimension?: string
  bucket?: DateBucket
  series?: string
  measures: Measure[]
  /** scatter / points */
  x?: string
  y?: string
  color?: string
  sizeBy?: string
  bins?: number
  sort?: SortMode
  limit?: number
  stacked?: boolean
  normalized?: boolean
  cumulative?: boolean
  trend?: boolean
  labels?: boolean
  filters?: Filter[]
  /** KPI: total over all rows, or only the latest period (for snapshot measures like population) */
  kpiMode?: 'total' | 'latest'
  /** KPI & time charts: comparison period */
  compare?: 'previous' | 'yoy' | 'none'
  /** colors the change: true = up is good, false = up is bad, undefined = neutral */
  upIsGood?: boolean
  target?: number
  refLines?: RefLine[]
  notes?: Note[]
  bands?: Band[]
  /** small multiples: one mini chart per value of this column */
  facet?: string
  /** drill-down stack; the last level is current */
  drill?: DrillLevel[]
  /** next dimension when drilling into a category */
  drillTo?: string
  /** forecast this many periods ahead (time charts) */
  forecast?: number
  anomalies?: boolean
  /** extra columns shown in tooltips */
  tooltipFields?: string[]
  /** value formatting override for this widget */
  format?: ColumnFormat
  /** map widgets */
  geo?: 'world' | 'usa'
  /** cohort tables: the entity tracked (customer, user…) and whether cells show retention % or counts */
  entity?: string
  cohortMode?: 'percent' | 'count'
  /** table widgets: data bars, color scale and rules */
  tableFormat?: TableFormat
  /** text widgets: markdown-lite with {placeholders} */
  text?: string
  /** generated by the suggestion engine (used for "suggested charts") */
  reason?: string
}

/** Conditional formatting for table widgets. */
export interface TableFormat {
  /** in-cell data bars (on unless set to false) */
  bars?: boolean
  /** shade cells light → dark by value, per measure */
  scale?: boolean
  /** the first matching rule colors the value and adds a status icon */
  rules?: CondRule[]
}
export interface CondRule {
  id: string
  /** measure id; empty = every measure */
  measure?: string
  cmp: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'between'
  value: number
  value2?: number
  tone: 'good' | 'warning' | 'bad'
}

export interface Page {
  id: string
  name: string
  widgets: Widget[]
  filters: Filter[]
  /** named sets of page filters to switch between */
  views?: SavedView[]
}

export interface SavedView {
  id: string
  name: string
  filters: Filter[]
}

export interface Dashboard {
  datasetId: string
  pages: Page[]
  activePage: string
  /** the user has changed it (as opposed to the suggested layout or a sample's showcase): removing the dataset asks first */
  edited?: boolean
}
