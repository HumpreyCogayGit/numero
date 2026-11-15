import type { EChartsOption } from 'echarts'
import type { Column, Dataset, DrillLevel, Filter, Widget } from '../types'
import {
  colMap, correlationMatrix, effective, filteredRows, groupExtras, labelOf, measureColumn, nextBucket, OTHER, runBox, runGrouped,
  runHistogram, runScatter, type GroupResult,
} from './aggregate'
import { compact, escapeHtml, fmtAxis, fmtNumber, fmtValue } from './format'
import { inkOn, seriesColor, type ChartTokens } from './palette'
import { mean, movingAverage, quantile } from './stats'
import { anomalies, forecast, seasonLength } from './forecast'
import { resolveRegion } from './geo'
import { defaultAgg } from './suggest'

/** What a click on a mark means: a filter for the clicked category/series, and optionally a drill-down step. */
export interface Interaction {
  filterAt?: (dataIndex: number, seriesIndex: number) => Omit<Filter, 'id'> | null
  drillAt?: (dataIndex: number) => DrillLevel | null
  /** the filters that select the rows behind a mark, with a label for them */
  rowsAt?: (dataIndex: number, seriesIndex: number) => { filters: Omit<Filter, 'id'>[]; label: string } | null
}

export interface BuiltChart {
  option: EChartsOption
  /** rows for the "view as table" toggle and CSV export */
  table: { headers: string[]; rows: (string | number | null)[][] }
  note?: string
  empty?: boolean
  /** screen-reader summary */
  label?: string
  interact?: Interaction
  /** maps need their geometry registered first */
  map?: 'world' | 'usa'
  /** largest value plotted — small multiples share it so panels compare */
  maxValue?: number
}

export interface BuildOpts {
  /** small-multiple panel: no legend, tight grid, shared y-axis max */
  compact?: boolean
  yMax?: number
  /** fullscreen view: zoom slider on time charts */
  fullscreen?: boolean
}

const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif'

// ---------- color follows the entity ----------

const entityCache = new WeakMap<Dataset['rows'], Map<string, Map<string, number>>>()

/** Rank of each category value by frequency in the *unfiltered* dataset, so filters never repaint survivors. */
export function entityIndex(ds: Pick<Dataset, 'rows'>, col: Column): Map<string, number> {
  let byCol = entityCache.get(ds.rows)
  if (!byCol) entityCache.set(ds.rows, (byCol = new Map()))
  const hit = byCol.get(col.key)
  if (hit) return hit
  const counts = new Map<string, number>()
  for (const r of ds.rows) { const l = labelOf(r[col.key], col); counts.set(l, (counts.get(l) ?? 0) + 1) }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
  if (col.type === 'number' || col.type === 'boolean') sorted.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const map = new Map(sorted.map((k, i) => [k, i]))
  byCol.set(col.key, map)
  return map
}

// ---------- shared chrome ----------

function base(t: ChartTokens): EChartsOption {
  return {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: FONT, color: t.textSecondary },
    animationDuration: 450,
    animationEasing: 'cubicOut',
    tooltip: {
      backgroundColor: t.surface,
      borderColor: t.border,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: t.textPrimary, fontSize: 12, fontFamily: FONT },
      extraCssText: 'box-shadow:0 8px 24px rgba(0,0,0,.12);border-radius:10px;',
      confine: true,
    },
  }
}

const axisCommon = (t: ChartTokens) => ({
  axisLine: { lineStyle: { color: t.axis } },
  axisTick: { show: false },
  axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true },
  splitLine: { lineStyle: { color: t.grid, width: 1, type: 'solid' as const } },
  nameTextStyle: { color: t.muted, fontSize: 11 },
})

const legend = (t: ChartTokens, show: boolean, data?: string[]) => ({
  show,
  data,
  type: 'scroll' as const,
  top: 0,
  left: 0,
  icon: 'roundRect',
  itemWidth: 10,
  itemHeight: 10,
  itemGap: 14,
  textStyle: { color: t.textSecondary, fontSize: 12 },
  pageIconColor: t.textSecondary,
  pageTextStyle: { color: t.muted },
})

function tooltipRow(color: string, name: string, value: string) {
  return `<div style="display:flex;align-items:center;gap:8px;margin-top:3px"><span style="width:8px;height:8px;border-radius:2px;background:${color}"></span><span style="flex:1;opacity:.8">${escapeHtml(name)}</span><b style="margin-left:16px;font-variant-numeric:tabular-nums">${escapeHtml(value)}</b></div>`
}

function tooltipHead(s: string) {
  return `<div style="font-weight:600;margin-bottom:2px">${escapeHtml(s)}</div>`
}

const empty = (note?: string): BuiltChart => ({ option: {}, table: { headers: [], rows: [] }, empty: true, note })

// ---------- builders ----------

export function buildChart(ds: Dataset, widget: Widget, filters: Filter[], t: ChartTokens, opts: BuildOpts = {}): BuiltChart {
  const w = effective(widget)
  switch (w.type) {
    case 'scatter': return scatter(ds, w, filters, t, opts)
    case 'histogram': return hist(ds, w, filters, t)
    case 'box': return box(ds, w, filters, t)
    case 'correlation': return corr(ds, w, filters, t)
    case 'heatmap': return heatmap(ds, w, filters, t)
    case 'donut': return donut(ds, w, filters, t)
    case 'treemap': return treemap(ds, w, filters, t)
    case 'map': return choropleth(ds, w, filters, t)
    case 'points': return points(ds, w, filters, t)
    case 'waterfall': return waterfall(ds, widget, filters, t)
    case 'pareto': return pareto(ds, widget, filters, t)
    case 'funnel': return funnel(ds, widget, filters, t)
    default: return cartesian(ds, widget, filters, t, opts)
  }
}

function groupedTable(g: GroupResult) {
  return {
    headers: [g.dimension?.name ?? '', ...g.series.map((s) => s.name)],
    rows: g.categories.map((c, i) => [c, ...g.series.map((s) => s.values[i])]),
  }
}

function colorsFor(ds: Dataset, g: GroupResult, t: ChartTokens): string[] {
  if (g.splitBy) {
    const idx = entityIndex(ds, g.splitBy)
    // an entity keeps its own slot; one ranked past the palette takes a free slot, never the grey reserved for "Other"
    const slots = g.series.map((s) => (s.name === OTHER ? -1 : idx.get(s.name) ?? -1))
    const used = new Set(slots.filter((i) => i >= 0 && i < t.series.length))
    let free = 0
    return g.series.map((s, i) => {
      let slot = slots[i]
      if (s.name !== OTHER && (slot < 0 || slot >= t.series.length)) {
        while (used.has(free) && free < t.series.length) free++
        slot = free < t.series.length ? free : -1
        if (slot >= 0) used.add(slot)
      }
      return seriesColor(t, slot, s.name)
    })
  }
  let i = 0
  return g.series.map((s) => (s.ghost ? t.muted : seriesColor(t, i++)))
}

/** Click → filter on the category (and the series value when split); double-click → drill a level deeper. */
function groupedInteraction(g: GroupResult, w: Widget, ds: Dataset): Interaction {
  const cols = colMap(ds)
  return {
    filterAt: (i, si) => {
      const k = g.categoryKeys[i]
      if (k === OTHER) return null
      const s = g.series[si]
      if (g.splitBy && s?.key != null && s.key !== OTHER && g.seriesFilterFor) return g.seriesFilterFor(s.key)
      return g.filterFor && k != null ? g.filterFor(k) : null
    },
    rowsAt: (i, si) => {
      const k = g.categoryKeys[i]
      const s = g.series[si]
      if (k === OTHER || s?.key === OTHER || s?.ghost) return null
      const filters: Omit<Filter, 'id'>[] = []
      const label: string[] = []
      if (g.dimension && g.filterFor && k != null) { filters.push(g.filterFor(k)); label.push(`${g.dimension.name}: ${g.categories[i]}`) }
      if (g.splitBy && g.seriesFilterFor && s?.key != null) { filters.push(g.seriesFilterFor(s.key)); label.push(`${g.splitBy.name}: ${s.name}`) }
      return { filters, label: label.join(' · ') }
    },
    drillAt: (i) => {
      const k = g.categoryKeys[i]
      if (!g.dimension || !g.filterFor || k === OTHER || k == null) return null
      const f = g.filterFor(k)
      const finer: Record<string, Widget['bucket']> = { year: 'quarter', quarter: 'month', month: 'week', week: 'day', day: 'hour' }
      if (g.isTime && g.bucket && finer[g.bucket]) return { dimension: g.dimension.key, bucket: finer[g.bucket], filter: { ...f, id: `drill_${i}` } }
      if (!g.isTime && w.drillTo && cols.has(w.drillTo) && w.drillTo !== g.dimension.key) {
        return { dimension: w.drillTo, bucket: cols.get(w.drillTo)!.type === 'date' ? 'auto' : undefined, filter: { ...f, id: `drill_${i}` } }
      }
      return null
    },
  }
}

function describe(kind: string, title: string, g: GroupResult, fmt: (v: number) => string): string {
  const s = g.series.find((x) => !x.ghost)
  if (!s || !g.categories.length) return `${kind}: ${title}. No data.`
  let hi = -1
  s.values.forEach((v, i) => { if (v != null && (hi < 0 || v > s.values[hi]!)) hi = i })
  const parts = [`${kind}: ${title}.`, `${g.categories.length} ${g.isTime ? 'periods' : 'categories'}${g.series.length > 1 ? `, ${g.series.length} series` : ''}.`]
  if (hi >= 0) parts.push(`Highest ${s.name}: ${g.categories[hi]} (${fmt(s.values[hi]!)}).`)
  if (g.isTime && s.values.length > 1) {
    const first = s.values.find((v) => v != null), last = [...s.values].reverse().find((v) => v != null)
    if (first != null && last != null) parts.push(`From ${fmt(first)} to ${fmt(last)}.`)
  }
  return parts.join(' ')
}

function cartesian(ds: Dataset, widget: Widget, filters: Filter[], t: ChartTokens, opts: BuildOpts): BuiltChart {
  const w = effective(widget)
  const g = runGrouped(ds, widget, filters)
  const cols = colMap(ds)
  const horizontal = w.type === 'hbar'
  const isLine = w.type === 'line' || w.type === 'area'
  const colors = colorsFor(ds, g, t)
  const fmtCol = w.normalized ? undefined : measureColumn(g.series[0]?.measure ?? { id: '', agg: 'count' }, cols)
  const fmt = (v: number) => (w.normalized ? `${v.toFixed(1)}%` : fmtNumber(v, fmtCol, { format: w.format }))
  const real = g.series.filter((s) => !s.ghost)
  const multi = real.length > 1
  const stacked = !!w.stacked || !!w.normalized
  const many = g.categories.length > 40
  const categories = [...g.categories]
  const interact = groupedInteraction(g, widget, ds)
  // extra tooltip fields, aggregated per category
  const extras = w.tooltipFields?.length && !opts.compact ? groupExtras(ds, widget, filters, w.tooltipFields, defaultAgg) : undefined

  const series: (NonNullable<EChartsOption['series']> & object[])[number][] = g.series.map((s, i) => {
    const color = colors[i]
    const ghost = !!s.ghost
    if (isLine || ghost) {
      return {
        type: 'line' as const, name: s.name, data: [...s.values], color,
        stack: stacked && !ghost ? 'total' : undefined,
        smooth: 0.25, smoothMonotone: 'x' as const,
        showSymbol: !ghost && g.categories.length <= 24,
        symbol: 'circle', symbolSize: 8,
        itemStyle: { color, borderColor: t.surface, borderWidth: 2 },
        lineStyle: ghost ? { width: 1.5, type: [5, 4], opacity: 0.9 } : { width: 2, cap: 'round' as const, join: 'round' as const },
        areaStyle: w.type === 'area' && !ghost ? { opacity: stacked ? 0.22 : 0.1 } : undefined,
        emphasis: { focus: multi ? 'series' as const : 'none' as const, scale: 1.4 },
        connectNulls: true,
        z: ghost ? 1 : 2,
        endLabel: !ghost && !opts.compact && (w.labels || (multi && real.length <= 4)) ? {
          show: true, color: t.textSecondary, fontSize: 11,
          formatter: (p: { value: unknown }) => (typeof p.value === 'number' ? fmt(p.value) : ''),
        } : undefined,
      }
    }
    const last = s === real[real.length - 1]
    return {
      type: 'bar' as const, name: s.name, data: [...s.values], color,
      stack: stacked ? 'total' : undefined,
      barMaxWidth: opts.compact ? 14 : 24,
      barGap: '12%',
      barCategoryGap: many ? '20%' : '35%',
      itemStyle: {
        color,
        borderRadius: stacked && !last ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
        borderColor: stacked ? t.surface : undefined,
        borderWidth: stacked ? 1 : 0,
      },
      emphasis: { focus: multi ? 'series' as const : 'none' as const },
      label: w.labels && (!stacked || last) ? {
        show: true, position: horizontal ? 'right' as const : 'top' as const, color: t.textSecondary, fontSize: 11,
        formatter: (p: { value: unknown }) => (typeof p.value === 'number' ? fmt(p.value) : ''),
      } : undefined,
    }
  })

  const first = series.find((_, i) => !g.series[i].ghost) as Record<string, unknown> | undefined
  const firstValues = real[0]?.values.filter((v): v is number => v != null) ?? []

  // moving-average overlay for a single time series
  if (w.trend && isLine && real.length === 1 && g.categories.length >= 8) {
    const win = Math.max(3, Math.round(g.categories.length / 12))
    series.push({
      type: 'line', name: `${win}-period moving avg`, data: movingAverage(real[0].values, win),
      color: t.textSecondary, showSymbol: false, smooth: 0.4,
      lineStyle: { width: 1.5, type: [4, 4], opacity: 0.8 }, z: 1, emphasis: { disabled: true },
    })
  }

  // forecast with a confidence band (extends the time axis)
  let note: string | undefined
  if (w.forecast && g.isTime && g.bucket && real.length === 1 && !stacked && !w.cumulative && g.bucket !== 'dow' && g.bucket !== 'moy') {
    const f = forecast(real[0].values, w.forecast, seasonLength(g.bucket))
    const last = g.categoryKeys[g.categoryKeys.length - 1]
    if (f && typeof last === 'number') {
      let k = last
      for (let h = 0; h < w.forecast; h++) { k = nextBucket(k, g.bucket as never); categories.push(labelFuture(k, g.bucket)) }
      const n = g.categories.length
      for (const s of series as { data?: unknown[] }[]) s.data?.push(...new Array(w.forecast).fill(null))
      const pad = (xs: number[]) => [...new Array(n - 1).fill(null), real[0].values[n - 1], ...xs]
      const lower = pad(f.lower)
      const width = pad(f.upper).map((u, i) => (u == null || lower[i] == null ? null : (u as number) - (lower[i] as number)))
      series.push(
        { type: 'line', name: '__lo', data: lower, stack: '__band', symbol: 'none', lineStyle: { opacity: 0 }, silent: true, tooltip: { show: false }, emphasis: { disabled: true } },
        { type: 'line', name: '__band', data: width, stack: '__band', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: colors[0], opacity: 0.12 }, silent: true, tooltip: { show: false }, emphasis: { disabled: true } },
        { type: 'line', name: 'Forecast', data: pad(f.forecast), color: colors[0], symbol: 'none', lineStyle: { width: 2, type: [6, 4] }, emphasis: { disabled: true } },
      )
      note = `Forecast: ${f.method === 'holt-winters' ? 'seasonal (Holt-Winters)' : f.method === 'holt' ? 'trend (Holt)' : 'linear trend'}, 95% band`
    }
  }

  // anomalies: points far from the model's fit
  if (w.anomalies && g.isTime && real.length === 1 && first) {
    const idx = anomalies(real[0].values, seasonLength(g.bucket))
    if (idx.length) {
      first.markPoint = {
        symbol: 'circle', symbolSize: 14,
        itemStyle: { color: 'transparent', borderColor: t.critical, borderWidth: 2 },
        label: { show: false },
        data: idx.map((i) => ({ coord: horizontal ? [real[0].values[i], i] : [i, real[0].values[i]], name: 'Anomaly', value: real[0].values[i] })),
      }
      note = [note, `${idx.length} anomal${idx.length === 1 ? 'y' : 'ies'} flagged`].filter(Boolean).join('  ·  ')
    }
  }

  // reference lines, target, notes, bands
  if (first && !opts.compact) {
    const axis = horizontal ? 'xAxis' : 'yAxis'
    const lines: Record<string, unknown>[] = (w.refLines ?? []).flatMap((r) => {
      const v = r.kind === 'avg' ? mean(firstValues) : r.kind === 'median' ? (firstValues.length ? quantile(firstValues, 0.5) : NaN) : r.value
      if (v == null || !Number.isFinite(v)) return []
      const fixed = r.kind === 'value' && !!r.label
      return [{ [axis]: v, fixed, name: r.label || (r.kind === 'avg' ? 'Average' : r.kind === 'median' ? 'Median' : 'Reference') }]
    })
    if (w.target != null) lines.push({ [axis]: w.target, name: 'Target' })
    if (lines.length) {
      first.markLine = {
        symbol: 'none', silent: true, animation: false,
        lineStyle: { color: t.textSecondary, type: [4, 3], width: 1.25 },
        // a fixed value already carries its number in the label; average / median / target show the computed value
        label: { color: t.textSecondary, fontSize: 11, formatter: (p: { name: string; value: number; data?: { fixed?: boolean } }) => (p.data?.fixed ? p.name : `${p.name} ${fmt(p.value)}`), position: horizontal ? 'end' : 'insideEndTop' },
        data: lines,
      }
    }
    const catAxisKey = horizontal ? 'yAxis' : 'xAxis'
    const bands = (w.bands ?? []).filter((b) => categories.includes(b.from) && categories.includes(b.to))
    if (bands.length) {
      first.markArea = {
        silent: true,
        itemStyle: { color: t.grid, opacity: 0.55 },
        label: { color: t.textSecondary, fontSize: 11, position: 'insideTop' },
        data: bands.map((b) => [{ name: b.label ?? '', [catAxisKey]: b.from }, { [catAxisKey]: b.to }]),
      }
    }
    const notes = (w.notes ?? []).filter((n) => categories.includes(n.at))
    if (notes.length) {
      const pts = notes.flatMap((n) => {
        const i = categories.indexOf(n.at)
        const v = real[0].values[i]
        return v == null ? [] : [{
          coord: horizontal ? [v, i] : [i, v], value: n.text, name: n.text,
          symbol: 'pin', symbolSize: 34, itemStyle: { color: t.textSecondary, borderColor: t.textSecondary },
          label: { show: true, formatter: '✎', color: '#fff', fontSize: 11 },
        }]
      })
      const existing = (first.markPoint as { data?: unknown[] } | undefined)
      first.markPoint = {
        symbol: 'circle', symbolSize: 14, itemStyle: { color: 'transparent', borderColor: t.critical, borderWidth: 2 }, label: { show: false },
        ...(existing ?? {}),
        data: [...(existing?.data ?? []), ...pts],
        tooltip: { formatter: (p: { name: string }) => escapeHtml(p.name) },
      }
    }
  }

  const catAxis = {
    type: 'category' as const,
    data: categories,
    ...axisCommon(t),
    splitLine: { show: false },
    axisLabel: { ...axisCommon(t).axisLabel, width: horizontal ? 120 : undefined, overflow: 'truncate' as const },
    boundaryGap: !isLine,
    inverse: horizontal,
    triggerEvent: true,
  }
  const valAxis = {
    type: 'value' as const,
    ...axisCommon(t),
    axisLine: { show: false },
    max: w.normalized ? 100 : opts.yMax,
    // lines show change, so their axis fits the data; bars and areas encode size and keep a zero baseline
    scale: w.type === 'line' && !opts.yMax && !w.normalized,
    axisLabel: { ...axisCommon(t).axisLabel, formatter: (v: number) => (w.normalized ? `${v}%` : fmtAxis(v, fmtCol, w.format)) },
  }
  const visible = series.filter((s) => !String((s as { name?: string }).name ?? '').startsWith('__'))
  const showLegend = visible.length > 1 && !opts.compact
  const values = real.flatMap((s) => s.values.filter((v): v is number => v != null))
  const stackTotals = stacked ? g.categories.map((_, i) => real.reduce((a, s) => a + (s.values[i] ?? 0), 0)) : []
  return {
    option: {
      ...base(t),
      legend: legend(t, showLegend, visible.map((s) => String((s as { name?: string }).name))),
      grid: opts.compact
        ? { left: 2, right: 6, top: 6, bottom: 2, containLabel: true }
        : { left: 4, right: horizontal || (isLine && multi) ? 56 : 12, top: showLegend ? 36 : 12, bottom: opts.fullscreen && g.isTime ? 44 : 4, containLabel: true },
      xAxis: horizontal ? valAxis : catAxis,
      yAxis: horizontal ? catAxis : valAxis,
      dataZoom: g.isTime && (opts.fullscreen || categories.length > 60)
        ? [{ type: 'inside', start: 0, end: 100 }, ...(opts.fullscreen ? [{ type: 'slider' as const, height: 18, bottom: 8, borderColor: t.grid, fillerColor: `${t.series[0]}22`, textStyle: { color: t.muted } }] : [])]
        : undefined,
      tooltip: {
        ...base(t).tooltip,
        trigger: 'axis',
        axisPointer: { type: isLine ? 'line' : 'shadow', lineStyle: { color: t.axis }, shadowStyle: { color: t.grid, opacity: 0.4 } },
        formatter: (ps: unknown) => {
          const arr = (ps as { axisValueLabel: string; seriesName: string; value: unknown; color: string; dataIndex: number }[]).filter((p) => !p.seriesName.startsWith('__'))
          if (!arr.length) return ''
          const more = extras?.get(g.categoryKeys[arr[0].dataIndex]) ?? []
          return tooltipHead(arr[0].axisValueLabel) + arr
            .filter((p) => p.value != null)
            .map((p) => tooltipRow(p.color, p.seriesName, typeof p.value === 'number' ? fmt(p.value) : String(p.value)))
            .join('') + (more.length ? `<div style="margin-top:6px;border-top:1px solid ${t.border};padding-top:4px">${more.map(([k, v]) => tooltipRow('transparent', k, v)).join('')}</div>` : '')
        },
      },
      series: series as EChartsOption['series'],
    },
    table: groupedTable(g),
    empty: !g.categories.length,
    note: g.total === 0 ? 'No rows match the current filters' : note,
    label: describe(isLine ? 'Line chart' : horizontal ? 'Bar chart' : 'Column chart', w.title, g, fmt),
    interact,
    maxValue: Math.max(0, ...values, ...stackTotals),
  }
}

function labelFuture(k: number, bucket: string): string {
  const d = new Date(k)
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
  switch (bucket) {
    case 'year': return `${d.getUTCFullYear()}`
    case 'quarter': return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`
    case 'month': return `${mon} ${d.getUTCFullYear()}`
    case 'week': return `Wk of ${mon} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
    case 'hour': return `${mon} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:00`
    default: return `${mon} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
  }
}

/** Narrow cards put the donut legend underneath instead of beside the ring. */
function responsiveDonut(option: EChartsOption): EChartsOption {
  const narrow = { center: ['50%', '42%'] }
  // media overrides replace the legend wholesale, so carry the explicit item list (hides the "__total" helper)
  const data = (option.legend as { data?: string[] } | undefined)?.data
  return {
    baseOption: option,
    media: [{
      query: { maxWidth: 420 },
      option: {
        legend: { data, type: 'plain', orient: 'horizontal', left: 'center', top: 'bottom', right: 'auto', itemGap: 10 },
        series: [{ ...narrow, radius: ['44%', '64%'] }, { ...narrow, radius: [0, '40%'] }],
      },
    }],
  } as EChartsOption
}

function donut(ds: Dataset, w: Widget, filters: Filter[], t: ChartTokens): BuiltChart {
  const g = runGrouped(ds, { ...w, limit: w.limit ?? 7, sort: w.sort ?? 'value-desc', series: undefined, compare: 'none' }, filters)
  const cols = colMap(ds)
  const s = g.series[0]
  const fmtCol = measureColumn(s.measure, cols)
  const fmt = (v: number) => fmtNumber(v, fmtCol, { format: w.format })
  const idx = g.dimension ? entityIndex(ds, g.dimension) : new Map<string, number>()
  const data = g.categories.map((c, i) => ({
    name: c, value: s.values[i] ?? 0,
    itemStyle: { color: seriesColor(t, c === OTHER ? -1 : idx.get(c) ?? i, c) },
  }))
  const total = data.reduce((a, d) => a + d.value, 0)
  const inter = groupedInteraction(g, w, ds)
  return {
    option: responsiveDonut({
      ...base(t),
      legend: { ...legend(t, true), data: data.map((d) => d.name), orient: 'vertical', top: 'middle', left: '62%', right: 0, formatter: (n: string) => {
        const d = data.find((x) => x.name === n)
        return d && total ? `${n}  ${((d.value / total) * 100).toFixed(0)}%` : n
      } },
      tooltip: {
        ...base(t).tooltip, trigger: 'item',
        formatter: (p: unknown) => {
          const q = p as { name: string; value: number; color: string; percent: number }
          return tooltipHead(q.name) + tooltipRow(q.color, s.name, fmt(q.value)) + tooltipRow('transparent', 'Share', `${q.percent.toFixed(1)}%`)
        },
      },
      series: [{
        type: 'pie', radius: ['50%', '72%'], center: ['32%', '50%'], data,
        itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 4 },
        label: { show: false },
        emphasis: { scale: true, scaleSize: 4 },
      }, {
        // transparent inner disc whose centered label shows the total
        type: 'pie', radius: [0, '46%'], center: ['32%', '50%'], silent: true, tooltip: { show: false },
        data: [{ value: 1, name: '__total', itemStyle: { color: 'transparent' } }],
        label: {
          show: true, position: 'center', formatter: `{v|${fmt(total)}}\n{l|Total}`,
          rich: { v: { fontSize: 20, fontWeight: 600, color: t.textPrimary, lineHeight: 26 }, l: { fontSize: 12, color: t.muted } },
        },
        labelLine: { show: false },
      }],
    }),
    table: groupedTable(g),
    empty: !data.length,
    label: describe('Donut chart', w.title, g, fmt),
    interact: { filterAt: (i, si) => (si === 0 ? inter.filterAt!(i, 0) : null), drillAt: inter.drillAt, rowsAt: (i) => inter.rowsAt!(i, 0) },
  }
}

function treemap(ds: Dataset, w: Widget, filters: Filter[], t: ChartTokens): BuiltChart {
  const g = runGrouped(ds, { ...w, limit: w.limit ?? 30, sort: 'value-desc', series: undefined, compare: 'none' }, filters)
  const cols = colMap(ds)
  const s = g.series[0]
  const fmtCol = measureColumn(s.measure, cols)
  const fmt = (v: number) => fmtNumber(v, fmtCol, { format: w.format })
  // explicit colors by value, so each tile's label can pick white or ink for contrast
  const ramp = t.sequential.slice(2, 7)
  const vals = s.values.map((v) => v ?? 0)
  const lo = Math.min(...vals), hi = Math.max(...vals)
  const data = g.categories.map((c, i) => {
    const color = ramp[hi === lo ? ramp.length - 1 : Math.round(((vals[i] - lo) / (hi - lo)) * (ramp.length - 1))]
    return { name: c, value: vals[i], itemStyle: { color }, label: { color: inkOn(color) } }
  })
  return {
    option: {
      ...base(t),
      tooltip: { ...base(t).tooltip, formatter: (p: unknown) => { const q = p as { name: string; value: number }; return tooltipHead(q.name) + tooltipRow(t.series[0], s.name, fmt(q.value)) } },
      series: [{
        type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false },
        width: '100%', height: '100%', top: 0, left: 0,
        data,
        itemStyle: { borderColor: t.surface, borderWidth: 2, gapWidth: 2, borderRadius: 4 },
        label: { show: true, fontSize: 12, formatter: (p: { name: string; value: unknown }) => `${p.name}\n${fmt(p.value as number)}` },
        upperLabel: { show: false },
      }],
    },
    table: groupedTable(g),
    empty: !g.categories.length,
    label: describe('Treemap', w.title, g, fmt),
    interact: groupedInteraction(g, w, ds),
  }
}

function scatter(ds: Dataset, w: Widget, filters: Filter[], t: ChartTokens, opts: BuildOpts): BuiltChart {
  const r = runScatter(ds, w, filters)
  if (!r.xCol || !r.yCol) return empty()
  const colorCol = w.color ? colMap(ds).get(w.color) : undefined
  const idx = colorCol ? entityIndex(ds, colorCol) : undefined
  const series: Record<string, unknown>[] = r.groups.map((g, i) => ({
    type: 'scatter', name: g.name, data: g.points, symbolSize: opts.compact ? 6 : 8, large: g.points.length > 2000,
    itemStyle: {
      color: seriesColor(t, g.name === OTHER ? -1 : idx?.get(g.name) ?? i, g.name),
      opacity: 0.78, borderColor: t.surface, borderWidth: 1,
    },
    emphasis: { focus: 'series', itemStyle: { opacity: 1, borderWidth: 2 } },
  }))
  let note: string | undefined
  if (w.trend && r.regression) {
    const all = r.groups.flatMap((g) => g.points.map((p) => p[0]))
    const x0 = Math.min(...all), x1 = Math.max(...all)
    const { slope, intercept, r2 } = r.regression
    series.push({
      type: 'line', name: `Linear fit (R² ${r2.toFixed(2)})`, data: [[x0, intercept + slope * x0], [x1, intercept + slope * x1]],
      showSymbol: false, color: t.textSecondary, lineStyle: { width: 1.5, type: [4, 4] }, emphasis: { disabled: true }, z: 5, silent: true,
    })
    note = `y = ${compact(slope)}·x ${intercept >= 0 ? '+' : '−'} ${compact(Math.abs(intercept))}  ·  r = ${r.regression.r.toFixed(2)}`
  }
  if (r.sampled) note = `${note ? note + '  ·  ' : ''}showing a 4,000-point sample`
  const { xCol, yCol } = r
  const showLegend = series.length > 1 && !opts.compact
  return {
    option: {
      ...base(t),
      legend: legend(t, showLegend),
      // containLabel covers tick labels but not the rotated axis name, so leave room for it
      grid: { left: 38, right: 16, top: showLegend ? 36 : 12, bottom: 24, containLabel: true },
      xAxis: { type: 'value', scale: true, name: xCol.name, nameLocation: 'middle', nameGap: 26, ...axisCommon(t), axisLabel: { ...axisCommon(t).axisLabel, formatter: (v: number) => fmtAxis(v, xCol) } },
      yAxis: { type: 'value', scale: true, name: yCol.name, nameLocation: 'middle', nameRotate: 90, nameGap: 34, ...axisCommon(t), axisLine: { show: false }, axisLabel: { ...axisCommon(t).axisLabel, formatter: (v: number) => fmtAxis(v, yCol) } },
      dataZoom: opts.fullscreen ? [{ type: 'inside', xAxisIndex: 0 }, { type: 'inside', yAxisIndex: 0 }] : undefined,
      tooltip: {
        ...base(t).tooltip, trigger: 'item',
        formatter: (p: unknown) => {
          const q = p as { seriesName: string; seriesIndex: number; dataIndex: number; value: [number, number]; color: string }
          const g = r.groups[q.seriesIndex]
          const extra = g?.extra[q.dataIndex] ?? []
          return tooltipHead(q.seriesName) + tooltipRow(q.color, xCol.name, fmtNumber(q.value[0], xCol)) + tooltipRow(q.color, yCol.name, fmtNumber(q.value[1], yCol))
            + r.extraCols.map((c, i) => tooltipRow('transparent', c.name, fmtValue(extra[i] ?? null, c) || '—')).join('')
        },
      },
      series: series as EChartsOption['series'],
    },
    table: { headers: [colorCol?.name ?? 'Group', xCol.name, yCol.name, ...r.extraCols.map((c) => c.name)], rows: r.groups.flatMap((g) => g.points.slice(0, 500).map((p, i) => [g.name, p[0], p[1], ...r.extraCols.map((c, j) => fmtValue(g.extra[i]?.[j] ?? null, c))])) },
    note,
    empty: !r.groups.some((g) => g.points.length),
    label: `Scatter plot of ${yCol.name} against ${xCol.name}${r.regression ? `, correlation r = ${r.regression.r.toFixed(2)}` : ''}.`,
    interact: colorCol ? { filterAt: (_i, si) => (r.groups[si] && r.groups[si].name !== OTHER ? { column: colorCol.key, values: [r.groups[si].name] } : null) } : undefined,
  }
}

function hist(ds: Dataset, w: Widget, filters: Filter[], t: ChartTokens): BuiltChart {
  const r = runHistogram(ds, w, filters)
  if (!r.col) return empty()
  const col = r.col
  const labels = r.bins.map((b) => `${fmtNumber(b.x0, col)}–${fmtNumber(b.x1, col)}`)
  return {
    option: {
      ...base(t),
      grid: { left: 4, right: 12, top: 12, bottom: 4, containLabel: true },
      xAxis: { type: 'category', data: r.bins.map((b) => compact(b.x0)), ...axisCommon(t), splitLine: { show: false } },
      yAxis: { type: 'value', ...axisCommon(t), axisLine: { show: false }, axisLabel: { ...axisCommon(t).axisLabel, formatter: (v: number) => compact(v) } },
      tooltip: {
        ...base(t).tooltip, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.grid, opacity: 0.4 } },
        formatter: (ps: unknown) => {
          const p = (ps as { dataIndex: number; value: number; color: string }[])[0]
          return tooltipHead(labels[p.dataIndex]) + tooltipRow(p.color, 'Rows', p.value.toLocaleString()) + tooltipRow('transparent', 'Share', `${((p.value / (r.n || 1)) * 100).toFixed(1)}%`)
        },
      },
      series: [{
        type: 'bar', data: r.bins.map((b) => b.count), color: t.series[0], barCategoryGap: 2,
        itemStyle: { borderRadius: [4, 4, 0, 0] },
      }],
    },
    table: { headers: ['Bin', 'Rows'], rows: r.bins.map((b, i) => [labels[i], b.count]) },
    note: r.n ? `n = ${r.n.toLocaleString()}  ·  mean ${fmtNumber(r.mean ?? NaN, col)}` : undefined,
    empty: !r.bins.length,
    label: `Histogram of ${col.name}: ${r.n ?? 0} values in ${r.bins.length} bins.`,
    interact: { filterAt: (i) => (r.bins[i] ? { column: col.key, min: r.bins[i].x0, max: r.bins[i].x1 - 1e-9 } : null) },
  }
}

function box(ds: Dataset, w: Widget, filters: Filter[], t: ChartTokens): BuiltChart {
  const r = runBox(ds, w, filters)
  if (!r.col || !r.items.length) return empty()
  const col = r.col
  const items = r.items as (typeof r.items[number] & { whiskerLo: number; q1: number; median: number; q3: number; whiskerHi: number; outliers: number[] })[]
  const color = t.series[0]
  return {
    option: {
      ...base(t),
      grid: { left: 4, right: 12, top: 12, bottom: 4, containLabel: true },
      xAxis: { type: 'category', data: items.map((d) => d.name), ...axisCommon(t), splitLine: { show: false } },
      yAxis: { type: 'value', scale: true, ...axisCommon(t), axisLine: { show: false }, axisLabel: { ...axisCommon(t).axisLabel, formatter: (v: number) => fmtAxis(v, col) } },
      tooltip: {
        ...base(t).tooltip, trigger: 'item',
        formatter: (p: unknown) => {
          const q = p as { dataIndex: number; seriesType: string; value: number[] }
          if (q.seriesType === 'scatter') return tooltipHead('Outlier') + tooltipRow(color, col.name, fmtNumber(q.value[1], col))
          const d = items[q.dataIndex]
          return tooltipHead(d.name) + [['Max (whisker)', d.whiskerHi], ['Q3', d.q3], ['Median', d.median], ['Q1', d.q1], ['Min (whisker)', d.whiskerLo]]
            .map(([k, v]) => tooltipRow('transparent', k as string, fmtNumber(v as number, col))).join('') + tooltipRow('transparent', 'n', d.n.toLocaleString())
        },
      },
      series: [
        {
          type: 'boxplot', data: items.map((d) => [d.whiskerLo, d.q1, d.median, d.q3, d.whiskerHi]), boxWidth: [8, 28],
          itemStyle: { color: color + '26', borderColor: color, borderWidth: 1.5 },
        },
        {
          type: 'scatter', symbolSize: 6, data: items.flatMap((d, i) => d.outliers.slice(0, 200).map((v) => [i, v])),
          itemStyle: { color: t.surface, borderColor: color, borderWidth: 1.5 },
        },
      ],
    },
    table: { headers: [r.dimCol?.name ?? 'Group', 'Min', 'Q1', 'Median', 'Q3', 'Max', 'n'], rows: items.map((d) => [d.name, d.min ?? null, d.q1, d.median, d.q3, d.max ?? null, d.n]) },
    label: `Box plot of ${col.name}${r.dimCol ? ` by ${r.dimCol.name}` : ''}: ${items.length} groups.`,
    interact: r.filterFor ? { filterAt: (i, si) => (si === 0 && items[i] ? r.filterFor!(items[i].key) : null) } : undefined,
  }
}

function heatmap(ds: Dataset, w: Widget, filters: Filter[], t: ChartTokens): BuiltChart {
  const g = runGrouped(ds, { ...w, stacked: false, normalized: false, cumulative: false, compare: 'none' }, filters)
  const cols = colMap(ds)
  const fmtCol = measureColumn(g.series[0]?.measure ?? { id: '', agg: 'count' }, cols)
  const data: [number, number, number | null][] = []
  let min = Infinity, max = -Infinity
  g.series.forEach((s, yi) => s.values.forEach((v, xi) => {
    data.push([xi, yi, v])
    if (v != null) { if (v < min) min = v; if (v > max) max = v }
  }))
  // labels only when cells are wide enough to hold them
  const showLabels = g.categories.length <= 24 && g.categories.length * g.series.length <= 120
  const inter = groupedInteraction(g, w, ds)
  return {
    option: {
      ...base(t),
      grid: { left: 4, right: 12, top: 8, bottom: 40, containLabel: true },
      xAxis: { type: 'category', data: g.categories, ...axisCommon(t), splitLine: { show: false }, axisLine: { show: false } },
      yAxis: { type: 'category', data: g.series.map((s) => s.name), inverse: true, ...axisCommon(t), splitLine: { show: false }, axisLine: { show: false } },
      visualMap: {
        min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 1, calculable: false, orient: 'horizontal', left: 'center', bottom: 0,
        itemWidth: 10, itemHeight: 140, textStyle: { color: t.muted, fontSize: 11 }, inRange: { color: t.sequential },
        text: [compact(Number.isFinite(max) ? max : 1), compact(Number.isFinite(min) ? min : 0)], textGap: 8,
      },
      tooltip: {
        ...base(t).tooltip, trigger: 'item',
        formatter: (p: unknown) => {
          const q = p as { value: [number, number, number | null]; color: string }
          return tooltipHead(`${g.categories[q.value[0]]} · ${g.series[q.value[1]].name}`) + tooltipRow(q.color, g.series[0].measure.agg === 'count' ? 'Rows' : measureColumn(g.series[0].measure, cols)?.name ?? 'Value', q.value[2] == null ? '—' : fmtNumber(q.value[2], fmtCol, { format: w.format }))
        },
      },
      series: [{
        type: 'heatmap',
        data: data.map((d) => {
          const v = d[2]
          const step = v == null || max === min ? 0 : Math.round(((v - min) / (max - min)) * (t.sequential.length - 1))
          return { value: d, label: { color: inkOn(t.sequential[step]) } }
        }),
        itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 3 },
        label: { show: showLabels, fontSize: 10, formatter: (p: { value: unknown }) => { const v = (p.value as number[])[2]; return v == null ? '' : compact(v) } },
        emphasis: { itemStyle: { borderColor: t.textPrimary, borderWidth: 1 } },
      }],
    },
    table: { headers: [g.dimension?.name ?? '', ...g.series.map((s) => s.name)], rows: g.categories.map((c, i) => [c, ...g.series.map((s) => s.values[i])]) },
    empty: !data.length,
    label: `Heatmap of ${g.dimension?.name ?? ''} by ${g.splitBy?.name ?? ''}: ${g.categories.length} × ${g.series.length} cells.`,
    interact: {
      // a heatmap cell's dataIndex walks the data list; recover its x position
      filterAt: (i) => {
        const xi = data[i]?.[0]
        return xi == null ? null : inter.filterAt!(xi, 0)
      },
    },
  }
}

function corr(ds: Dataset, w: Widget, filters: Filter[], t: ChartTokens): BuiltChart {
  const keys = w.measures.map((m) => m.column).filter((k): k is string => !!k)
  if (keys.length < 2) return empty()
  const cm = correlationMatrix(ds, keys, filters)
  const data: { value: [number, number, number]; label: { color: string } }[] = []
  cm.matrix.forEach((row, i) => row.forEach((v, j) => {
    const r = Number.isFinite(v) ? +v.toFixed(2) : 0
    const pole = r < 0 ? t.diverging[0] : t.diverging[2]
    data.push({ value: [j, i, r], label: { color: Math.abs(r) > 0.55 ? inkOn(pole) : t.textPrimary } })
  }))
  return {
    option: {
      ...base(t),
      grid: { left: 4, right: 12, top: 8, bottom: 40, containLabel: true },
      xAxis: { type: 'category', data: cm.names, ...axisCommon(t), splitLine: { show: false }, axisLine: { show: false }, axisLabel: { ...axisCommon(t).axisLabel, rotate: cm.names.length > 4 ? 30 : 0, width: 90, overflow: 'truncate' } },
      yAxis: { type: 'category', data: cm.names, inverse: true, ...axisCommon(t), splitLine: { show: false }, axisLine: { show: false }, axisLabel: { ...axisCommon(t).axisLabel, width: 110, overflow: 'truncate' } },
      visualMap: {
        min: -1, max: 1, orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 10, itemHeight: 140,
        textStyle: { color: t.muted, fontSize: 11 }, inRange: { color: t.diverging }, text: ['+1', '−1'], textGap: 8,
      },
      tooltip: {
        ...base(t).tooltip, trigger: 'item',
        formatter: (p: unknown) => {
          const q = p as { value: [number, number, number] }
          return tooltipHead(`${cm.names[q.value[1]]} × ${cm.names[q.value[0]]}`) + tooltipRow('transparent', 'Pearson r', q.value[2].toFixed(2))
        },
      },
      series: [{
        type: 'heatmap', data,
        itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 3 },
        label: { show: cm.names.length <= 9, fontSize: 10, formatter: (p: { value: unknown }) => (p.value as number[])[2].toFixed(2) },
      }],
    },
    table: { headers: ['', ...cm.names], rows: cm.names.map((n, i) => [n, ...cm.matrix[i].map((v) => (Number.isFinite(v) ? +v.toFixed(3) : null))]) },
    label: `Correlation matrix of ${cm.names.length} numeric columns.`,
  }
}

// ---------- maps ----------

const mapView = (geo: 'world' | 'usa') => (geo === 'usa' ? { center: [-96, 38.5], zoom: 4.2 } : { zoom: 1.15, center: [10, 15] })

function choropleth(ds: Dataset, w: Widget, filters: Filter[], t: ChartTokens): BuiltChart {
  const geo = w.geo ?? 'world'
  const g = runGrouped(ds, { ...w, limit: undefined, series: undefined, compare: 'none', sort: 'value-desc' }, filters)
  if (!g.dimension) return empty('Choose a country or state column')
  const cols = colMap(ds)
  const s = g.series[0]
  const fmtCol = measureColumn(s.measure, cols)
  const fmt = (v: number) => fmtNumber(v, fmtCol, { format: w.format })
  const byRegion = new Map<string, { value: number; label: string; i: number }>()
  const unmatched: string[] = []
  g.categories.forEach((c, i) => {
    const region = resolveRegion(c, geo)
    const v = s.values[i]
    if (!region) { if (c !== OTHER) unmatched.push(c); return }
    if (v == null) return
    const prev = byRegion.get(region)
    byRegion.set(region, { value: (prev?.value ?? 0) + v, label: prev ? `${prev.label}, ${c}` : c, i })
  })
  const data = [...byRegion.entries()].map(([name, d]) => ({ name, value: d.value, label: d.label, i: d.i }))
  const vals = data.map((d) => d.value)
  const min = vals.length ? Math.min(...vals) : 0, max = vals.length ? Math.max(...vals) : 1
  return {
    map: geo,
    option: {
      ...base(t),
      tooltip: {
        ...base(t).tooltip, trigger: 'item',
        formatter: (p: unknown) => {
          const q = p as { name: string; value: number; data?: { label: string } }
          return tooltipHead(q.data?.label ?? q.name) + (q.value == null || Number.isNaN(q.value) ? tooltipRow('transparent', s.name, 'No data') : tooltipRow(t.series[0], s.name, fmt(q.value)))
        },
      },
      visualMap: {
        min, max: max === min ? min + 1 : max, orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 10, itemHeight: 140, calculable: false,
        textStyle: { color: t.muted, fontSize: 11 }, inRange: { color: t.sequential }, text: [compact(max), compact(min)], textGap: 8,
      },
      series: [{
        type: 'map', map: geo, roam: true, scaleLimit: { min: 1, max: 12 }, ...mapView(geo),
        top: 8, bottom: 40,
        itemStyle: { areaColor: t.grid, borderColor: t.surface, borderWidth: 0.8 },
        emphasis: { label: { show: false }, itemStyle: { areaColor: t.series[1] } },
        select: { disabled: true },
        data,
      }],
    } as EChartsOption,
    table: { headers: [g.dimension.name, s.name], rows: data.map((d) => [d.label, d.value]) },
    note: unmatched.length ? `${unmatched.length} value${unmatched.length > 1 ? 's' : ''} not on the map (${unmatched.slice(0, 3).join(', ')}${unmatched.length > 3 ? '…' : ''})` : undefined,
    empty: !data.length,
    label: `Map of ${s.name} by ${g.dimension.name}: ${data.length} regions.`,
    interact: {
      filterAt: (i) => {
        const d = data[i]
        return d && g.filterFor ? g.filterFor(g.categoryKeys[d.i]) : null
      },
    },
  }
}

function points(ds: Dataset, w: Widget, filters: Filter[], t: ChartTokens): BuiltChart {
  const geo = w.geo ?? 'world'
  const cols = colMap(ds)
  const lon = w.x ? cols.get(w.x) : undefined
  const lat = w.y ? cols.get(w.y) : undefined
  if (!lon || !lat) return empty('Choose longitude and latitude columns')
  const rows = filteredRows(ds, [...filters, ...(w.filters ?? [])])
  const sizeCol = w.sizeBy ? cols.get(w.sizeBy) : undefined
  const colorCol = w.color ? cols.get(w.color) : undefined
  const extraCols = (w.tooltipFields ?? []).map((k) => cols.get(k)).filter((c): c is Column => !!c)
  let pts = rows.filter((r) => typeof r[lon.key] === 'number' && typeof r[lat.key] === 'number')
  const sampled = pts.length > 8000
  if (sampled) { const step = pts.length / 8000; pts = Array.from({ length: 8000 }, (_, i) => pts[Math.floor(i * step)]) }
  const sizes = sizeCol ? pts.map((r) => (typeof r[sizeCol.key] === 'number' ? (r[sizeCol.key] as number) : 0)) : []
  const smax = Math.max(1, ...sizes)
  const groups = new Map<string, unknown[][]>()
  const idx = colorCol ? entityIndex(ds, colorCol) : undefined
  const counts = new Map<string, number>()
  if (colorCol) for (const r of pts) { const l = labelOf(r[colorCol.key], colorCol); counts.set(l, (counts.get(l) ?? 0) + 1) }
  // map points overlap like a scatter, so 3 colors + Other
  const keep = new Set([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k))
  pts.forEach((r, i) => {
    const l = colorCol ? labelOf(r[colorCol.key], colorCol) : lat.name
    const name = colorCol && !keep.has(l) ? OTHER : l
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name)!.push([r[lon.key], r[lat.key], sizeCol ? sizes[i] : null, ...extraCols.map((c) => fmtValue(r[c.key], c))])
  })
  const names = [...groups.keys()]
  return {
    map: geo,
    option: {
      ...base(t),
      legend: legend(t, names.length > 1),
      geo: {
        map: geo, roam: true, scaleLimit: { min: 1, max: 40 }, ...mapView(geo),
        top: names.length > 1 ? 30 : 6, bottom: 6,
        itemStyle: { areaColor: t.grid, borderColor: t.surface, borderWidth: 0.8 },
        emphasis: { disabled: true },
        silent: true,
      },
      tooltip: {
        ...base(t).tooltip, trigger: 'item',
        formatter: (p: unknown) => {
          const q = p as { seriesName: string; value: unknown[]; color: string }
          const v = q.value
          return tooltipHead(q.seriesName) + tooltipRow(q.color, 'Lat, lon', `${(v[1] as number).toFixed(3)}, ${(v[0] as number).toFixed(3)}`)
            + (sizeCol ? tooltipRow('transparent', sizeCol.name, fmtNumber(v[2] as number, sizeCol)) : '')
            + extraCols.map((c, i) => tooltipRow('transparent', c.name, String(v[3 + i] ?? '—'))).join('')
        },
      },
      series: names.map((name, i) => ({
        type: 'scatter', coordinateSystem: 'geo', name, data: groups.get(name),
        symbolSize: sizeCol ? (v: unknown[]) => 4 + Math.sqrt(Math.max(0, (v[2] as number) / smax)) * 18 : 5,
        itemStyle: { color: seriesColor(t, name === OTHER ? -1 : idx?.get(name) ?? i, name), opacity: 0.75, borderColor: t.surface, borderWidth: 0.6 },
        large: (groups.get(name)?.length ?? 0) > 3000,
      })),
    } as EChartsOption,
    table: { headers: [lat.name, lon.name, ...(sizeCol ? [sizeCol.name] : []), ...extraCols.map((c) => c.name)], rows: pts.slice(0, 500).map((r) => [r[lat.key] as number, r[lon.key] as number, ...(sizeCol ? [r[sizeCol.key] as number] : []), ...extraCols.map((c) => fmtValue(r[c.key], c))]) },
    note: sampled ? 'showing an 8,000-point sample' : undefined,
    empty: !pts.length,
    label: `Point map of ${pts.length} locations.`,
    interact: colorCol ? { filterAt: (_i, si) => (names[si] && names[si] !== OTHER ? { column: colorCol.key, values: [names[si]] } : null) } : undefined,
  }
}

// ---------- waterfall, pareto, funnel ----------

/** One measure per category, no splits or comparisons: what these three forms need. */
const single = (w: Widget): Widget => ({ ...w, series: undefined, compare: 'none', cumulative: false, normalized: false, stacked: false, measures: w.measures.slice(0, 1) })

/**
 * Waterfall: each bar floats from the running total before it to the one after. Over time, the first bar is the
 * starting level and each later bar the change from the period before; across categories, bars add up to a total.
 */
function waterfall(ds: Dataset, widget: Widget, filters: Filter[], t: ChartTokens): BuiltChart {
  const w = single(effective(widget))
  const g = runGrouped(ds, { ...single(widget) }, filters)
  if (!g.categories.length) return empty(g.total === 0 ? 'No rows match the current filters' : undefined)
  const cols = colMap(ds)
  const fmtCol = measureColumn(g.series[0].measure, cols)
  const fmt = (v: number) => fmtNumber(v, fmtCol, { format: w.format })
  const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v))}`
  const vals = g.series[0].values.map((v) => v ?? 0)
  // steps: [start, end] of each floating bar; totals start at zero
  const steps: { label: string; start: number; end: number; total?: boolean }[] = []
  if (g.isTime) {
    steps.push({ label: g.categories[0], start: 0, end: vals[0], total: true })
    for (let i = 1; i < vals.length; i++) steps.push({ label: g.categories[i], start: vals[i - 1], end: vals[i] })
  } else {
    let run = 0
    for (let i = 0; i < vals.length; i++) { steps.push({ label: g.categories[i], start: run, end: run + vals[i] }); run += vals[i] }
    steps.push({ label: 'Total', start: 0, end: run, total: true })
  }
  // stacked bars stack positives up and negatives down from zero, so a bar crossing zero becomes two parts
  const n = steps.length
  const z = () => new Array<number | null>(n).fill(null)
  const floor = z(), up = z(), upNeg = z(), down = z(), downNeg = z(), total = z(), totalNeg = z()
  steps.forEach((s, i) => {
    const lo = Math.min(s.start, s.end), hi = Math.max(s.start, s.end)
    const [pos, neg] = s.total ? [total, totalNeg] : s.end >= s.start ? [up, upNeg] : [down, downNeg]
    if (lo >= 0) { floor[i] = lo; pos[i] = hi - lo }
    else if (hi <= 0) { floor[i] = hi; neg[i] = lo - hi }
    else { pos[i] = hi; neg[i] = lo }
  })
  const [decColor, , incColor] = t.diverging
  const bar = (name: string, data: (number | null)[], color: string, label = false) => ({
    type: 'bar' as const, name, data, stack: 'wf', color, barMaxWidth: 28, barCategoryGap: '30%',
    itemStyle: { color, borderRadius: 3 },
    label: label && n <= 16 ? {
      show: true, position: 'top' as const, color: t.textSecondary, fontSize: 11,
      formatter: (p: { dataIndex: number }) => { const s = steps[p.dataIndex]; return s.total ? fmt(s.end) : signed(s.end - s.start) },
    } : undefined,
  })
  const series = [
    { type: 'bar' as const, name: '__base', data: floor, stack: 'wf', itemStyle: { color: 'transparent' }, emphasis: { disabled: true }, tooltip: { show: false }, silent: true },
    bar('Increase', up, incColor, true), bar('__upNeg', upNeg, incColor),
    bar('Decrease', down, decColor, true), bar('__downNeg', downNeg, decColor),
    bar(g.isTime ? 'Level' : 'Total', total, t.other, true), bar('__totalNeg', totalNeg, t.other),
  ]
  const inter = groupedInteraction(g, w, ds)
  const inRange = (i: number) => i < g.categories.length
  return {
    option: {
      ...base(t),
      legend: legend(t, true, ['Increase', 'Decrease', g.isTime ? 'Level' : 'Total']),
      grid: { left: 4, right: 12, top: 36, bottom: 4, containLabel: true },
      xAxis: { type: 'category', data: steps.map((s) => s.label), ...axisCommon(t), splitLine: { show: false }, axisLabel: { ...axisCommon(t).axisLabel, overflow: 'truncate', width: 90 } },
      yAxis: { type: 'value', ...axisCommon(t), axisLine: { show: false }, axisLabel: { ...axisCommon(t).axisLabel, formatter: (v: number) => fmtAxis(v, fmtCol, w.format) } },
      tooltip: {
        ...base(t).tooltip, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.grid, opacity: 0.4 } },
        formatter: (ps: unknown) => {
          const i = (ps as { dataIndex: number }[])[0]?.dataIndex
          const s = steps[i]
          if (!s) return ''
          return tooltipHead(s.label) + (s.total
            ? tooltipRow(t.other, g.isTime ? 'Level' : 'Total', fmt(s.end))
            : tooltipRow(s.end >= s.start ? incColor : decColor, 'Change', signed(s.end - s.start)) + tooltipRow(t.muted, 'Running total', fmt(s.end)))
        },
      },
      series: series as EChartsOption['series'],
    },
    table: { headers: [g.dimension?.name ?? '', 'Change', 'Running total'], rows: steps.map((s) => [s.label, s.total ? null : s.end - s.start, s.end]) },
    label: `Waterfall chart: ${w.title}. ${steps.length} steps from ${fmt(steps[0].end)} to ${fmt(steps[n - 1].end)}.`,
    interact: {
      filterAt: (i) => (inRange(i) ? inter.filterAt!(i, 0) : null),
      rowsAt: (i) => (inRange(i) ? inter.rowsAt!(i, 0) : null),
    },
  }
}

/** Pareto: share of the total per category, largest first, with the cumulative share — both on one 0–100% axis. */
function pareto(ds: Dataset, widget: Widget, filters: Filter[], t: ChartTokens): BuiltChart {
  const w = single(effective(widget))
  const g = runGrouped(ds, { ...single(widget), sort: 'value-desc' }, filters)
  // negative values have no share of a total
  const idx = g.categories.map((_, i) => i).filter((i) => (g.series[0].values[i] ?? 0) > 0)
  if (!idx.length) return empty(g.total === 0 ? 'No rows match the current filters' : 'Pareto needs positive values')
  const cols = colMap(ds)
  const fmtCol = measureColumn(g.series[0].measure, cols)
  const fmt = (v: number) => fmtNumber(v, fmtCol, { format: w.format })
  const vals = idx.map((i) => g.series[0].values[i]!)
  const sum = vals.reduce((a, b) => a + b, 0)
  const share = vals.map((v) => (v / sum) * 100)
  let acc = 0
  const cum = share.map((s) => (acc += s))
  const cats = idx.map((i) => g.categories[i])
  const reach80 = cum.findIndex((c) => c >= 80 - 1e-9) + 1
  const [barColor, lineColor] = t.series
  const inter = groupedInteraction(g, w, ds)
  const pct = (v: number) => `${v.toFixed(1)}%`
  return {
    option: {
      ...base(t),
      legend: legend(t, true, ['Share of total', 'Cumulative share']),
      grid: { left: 4, right: 12, top: 36, bottom: 4, containLabel: true },
      xAxis: { type: 'category', data: cats, ...axisCommon(t), splitLine: { show: false }, axisLabel: { ...axisCommon(t).axisLabel, overflow: 'truncate', width: 90 }, triggerEvent: true },
      yAxis: { type: 'value', max: 100, ...axisCommon(t), axisLine: { show: false }, axisLabel: { ...axisCommon(t).axisLabel, formatter: (v: number) => `${v}%` } },
      tooltip: {
        ...base(t).tooltip, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.grid, opacity: 0.4 } },
        formatter: (ps: unknown) => {
          const i = (ps as { dataIndex: number }[])[0]?.dataIndex
          if (i == null) return ''
          return tooltipHead(cats[i]) + tooltipRow(barColor, g.series[0].name, fmt(vals[i])) + tooltipRow(barColor, 'Share of total', pct(share[i])) + tooltipRow(lineColor, 'Cumulative share', pct(cum[i]))
        },
      },
      series: [
        { type: 'bar', name: 'Share of total', data: share, color: barColor, barMaxWidth: 28, itemStyle: { color: barColor, borderRadius: [4, 4, 0, 0] } },
        {
          type: 'line', name: 'Cumulative share', data: cum, color: lineColor, symbol: 'circle', symbolSize: 7, showSymbol: cats.length <= 30,
          itemStyle: { color: lineColor, borderColor: t.surface, borderWidth: 2 }, lineStyle: { width: 2 },
          markLine: { symbol: 'none', silent: true, lineStyle: { color: t.textSecondary, type: [4, 3], width: 1.25 }, label: { color: t.textSecondary, fontSize: 11, formatter: '80%', position: 'insideEndTop' }, data: [{ yAxis: 80 }] },
        },
      ],
    },
    table: { headers: [g.dimension?.name ?? '', g.series[0].name, 'Share %', 'Cumulative %'], rows: cats.map((c, i) => [c, vals[i], +share[i].toFixed(2), +cum[i].toFixed(2)]) },
    note: `${reach80} of ${cats.length} ${reach80 === 1 ? 'category makes' : 'categories make'} up 80% of the total${idx.length < g.categories.length ? ' · negative values left out' : ''}`,
    label: `Pareto chart: ${w.title}. ${reach80} of ${cats.length} categories make up 80% of the total; the largest, ${cats[0]}, is ${pct(share[0])}.`,
    interact: { filterAt: (i) => inter.filterAt!(idx[i], 0), rowsAt: (i) => inter.rowsAt!(idx[i], 0) },
  }
}

/** Funnel: stages in order (largest first unless sorted otherwise), with conversion from the first and previous stage. */
function funnel(ds: Dataset, widget: Widget, filters: Filter[], t: ChartTokens): BuiltChart {
  const w = single(effective(widget))
  const g = runGrouped(ds, { ...single(widget), sort: widget.sort ?? 'value-desc' }, filters)
  if (!g.categories.length) return empty(g.total === 0 ? 'No rows match the current filters' : undefined)
  const cols = colMap(ds)
  const fmtCol = measureColumn(g.series[0].measure, cols)
  const fmt = (v: number) => fmtNumber(v, fmtCol, { format: w.format })
  const vals = g.series[0].values.map((v) => Math.max(0, v ?? 0))
  const first = vals[0] || 1
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`
  const color = t.series[0]
  const inter = groupedInteraction(g, w, ds)
  return {
    option: {
      ...base(t),
      tooltip: {
        ...base(t).tooltip, trigger: 'item',
        formatter: (p: unknown) => {
          const i = (p as { dataIndex: number }).dataIndex
          return tooltipHead(g.categories[i]) + tooltipRow(color, g.series[0].name, fmt(vals[i])) + tooltipRow(color, 'Of first stage', pct(vals[i] / first)) + (i > 0 && vals[i - 1] ? tooltipRow(color, 'From previous stage', pct(vals[i] / vals[i - 1])) : '')
        },
      },
      series: [{
        type: 'funnel', sort: 'none', left: '6%', right: '30%', top: 8, bottom: 8, minSize: '8%', gap: 2,
        // one hue, stages separated by the 2px surface gap
        itemStyle: { color, borderColor: t.surface, borderWidth: 2 },
        emphasis: { itemStyle: { opacity: 0.85 } },
        label: { show: true, position: 'right', color: t.textSecondary, fontSize: 12, formatter: (p: { dataIndex: number; name: string }) => `${p.name}  ${fmt(vals[p.dataIndex])}${p.dataIndex ? ` · ${pct(vals[p.dataIndex] / first)}` : ''}` },
        labelLine: { lineStyle: { color: t.axis } },
        data: g.categories.map((c, i) => ({ name: c, value: vals[i] })),
      }],
    },
    table: { headers: [g.dimension?.name ?? '', g.series[0].name, 'Of first %', 'From previous %'], rows: g.categories.map((c, i) => [c, vals[i], +(vals[i] / first * 100).toFixed(2), i && vals[i - 1] ? +(vals[i] / vals[i - 1] * 100).toFixed(2) : null]) },
    label: `Funnel chart: ${w.title}. ${g.categories.length} stages from ${fmt(vals[0])} to ${fmt(vals[vals.length - 1])} (${pct(vals[vals.length - 1] / first)} of the first).`,
    interact: { filterAt: (i) => inter.filterAt!(i, 0), rowsAt: (i) => inter.rowsAt!(i, 0) },
  }
}
