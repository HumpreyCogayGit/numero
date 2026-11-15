import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, BoxplotChart, FunnelChart, HeatmapChart, LineChart, MapChart, PieChart, ScatterChart, TreemapChart } from 'echarts/charts'
import {
  AriaComponent, DataZoomComponent, GeoComponent, GraphicComponent, GridComponent, LegendComponent, MarkAreaComponent,
  MarkLineComponent, MarkPointComponent, TimelineComponent, TooltipComponent, VisualMapComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { LegacyGridContainLabel } from 'echarts/features'
import type { EChartsOption } from 'echarts'
import { usePatterns } from './theme'
import { recordError } from '../lib/diagnostics'

export { ThemeContext, useTheme, PatternContext, usePatterns } from './theme'

echarts.use([
  BarChart, LineChart, PieChart, ScatterChart, HeatmapChart, BoxplotChart, TreemapChart, MapChart, FunnelChart,
  GridComponent, TooltipComponent, LegendComponent, VisualMapComponent, DataZoomComponent, GraphicComponent, GeoComponent,
  MarkLineComponent, MarkPointComponent, MarkAreaComponent, AriaComponent,
  // media queries (responsive donut legend) go through the timeline option preprocessor
  TimelineComponent,
  // ECharts 6 moved grid.containLabel behind this feature; the chart layouts rely on it
  LegacyGridContainLabel,
  CanvasRenderer,
])


export interface ChartHandle {
  toPng: (background: string) => string | undefined
}

export interface ChartEvent { dataIndex: number; seriesIndex: number; name: string; seriesName?: string; value: unknown; componentType: string; event?: { event?: MouseEvent } }

// ---------- maps ----------

const mapLoads = new Map<string, Promise<void>>()
export function ensureMap(name: 'world' | 'usa'): Promise<void> {
  let p = mapLoads.get(name)
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}geo/${name}.json`)
      .then((r) => { if (!r.ok) throw new Error(`Map ${name} failed to load`); return r.json() })
      .then((geo) => echarts.registerMap(name, geo))
    mapLoads.set(name, p)
    // a failed load is not remembered: the next map chart (or a retry) asks again
    p.catch(() => { if (mapLoads.get(name) === p) mapLoads.delete(name) })
  }
  return p
}

export const Chart = forwardRef<ChartHandle, {
  option: EChartsOption
  className?: string
  label?: string
  map?: 'world' | 'usa'
  onClick?: (e: ChartEvent) => void
  onDblClick?: (e: ChartEvent) => void
  /** right-click on a mark (shows the rows behind it) */
  onContextMenu?: (e: ChartEvent) => void
}>(function Chart({ option, className, label, map, onClick, onDblClick, onContextMenu }, ref) {
  const el = useRef<HTMLDivElement>(null)
  const inst = useRef<echarts.ECharts | null>(null)
  const handlers = useRef({ onClick, onDblClick, onContextMenu })
  handlers.current = { onClick, onDblClick, onContextMenu }
  const patterns = usePatterns()
  const [mapReady, setMapReady] = useState(!map)
  const [mapFailed, setMapFailed] = useState(false)
  const [mapTry, setMapTry] = useState(0)

  useEffect(() => {
    if (!map) return
    let live = true
    setMapFailed(false)
    // the outline file can fail to load (offline before it was cached, a blocked request): say so in this chart only
    ensureMap(map).then(() => live && setMapReady(true), (e) => { recordError('resource', e); if (live) setMapFailed(true) })
    return () => { live = false }
  }, [map, mapTry])

  useEffect(() => {
    if (!el.current) return
    const chart = echarts.init(el.current, undefined, { renderer: 'canvas' })
    inst.current = chart
    const ro = new ResizeObserver(() => chart.resize({ animation: { duration: 0 } }))
    ro.observe(el.current)
    // single clicks wait briefly so a double-click (drill-down) doesn't also cross-filter
    let timer: ReturnType<typeof setTimeout> | null = null
    chart.on('click', (p) => {
      if (!handlers.current.onClick) return
      if (timer) clearTimeout(timer)
      const e = p as unknown as ChartEvent
      timer = setTimeout(() => { timer = null; handlers.current.onClick?.(e) }, handlers.current.onDblClick ? 230 : 0)
    })
    chart.on('dblclick', (p) => {
      if (timer) { clearTimeout(timer); timer = null }
      handlers.current.onDblClick?.(p as unknown as ChartEvent)
    })
    chart.on('contextmenu', (p) => {
      if (!handlers.current.onContextMenu) return
      const e = p as unknown as ChartEvent
      e.event?.event?.preventDefault()
      handlers.current.onContextMenu(e)
    })
    // dev-only hook so browser tests can exercise click / drill handlers without pixel hunting on a canvas
    if (import.meta.env.DEV) {
      (el.current as HTMLDivElement & { __numero?: unknown }).__numero = {
        click: (dataIndex: number, seriesIndex = 0, shiftKey = false) => handlers.current.onClick?.({ dataIndex, seriesIndex, componentType: 'series', name: '', value: null, event: { event: { shiftKey } as MouseEvent } }),
        dblclick: (dataIndex: number) => handlers.current.onDblClick?.({ dataIndex, seriesIndex: 0, componentType: 'series', name: '', value: null }),
        contextmenu: (dataIndex: number, seriesIndex = 0) => handlers.current.onContextMenu?.({ dataIndex, seriesIndex, componentType: 'series', name: '', value: null }),
        option: () => chart.getOption(),
      }
    }
    return () => { ro.disconnect(); chart.dispose(); inst.current = null; if (timer) clearTimeout(timer) }
  }, [])

  useEffect(() => {
    if (!mapReady) return
    const withAria: EChartsOption = {
      ...option,
      aria: { enabled: true, label: { enabled: true, description: label }, decal: { show: patterns } },
    }
    inst.current?.setOption(withAria, { notMerge: true, lazyUpdate: true })
  }, [option, patterns, label, mapReady])

  useImperativeHandle(ref, () => ({
    toPng: (background) => inst.current?.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: background }),
  }))

  const chart = <div ref={el} role="img" aria-label={label} className={map ? 'h-full w-full' : className ?? 'h-full w-full'} style={{ cursor: onClick ? 'pointer' : undefined }} />
  if (!map) return chart
  // a map needs its outline file: when that fails, this chart says so and the rest of the dashboard carries on
  return (
    <div className={className ?? 'h-full w-full'} style={{ position: 'relative' }}>
      {chart}
      {mapFailed && (
        <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface px-4 text-center">
          <div className="text-[13px] font-medium text-ink">The map outline could not be loaded</div>
          <div className="max-w-xs text-[12px] text-ink-3">This {map === 'usa' ? 'US' : 'world'} map needs a file that did not arrive — you may be offline. The data and the other charts are unaffected.</div>
          <button className="rounded-lg border border-line px-3 py-1 text-[12.5px] font-medium hover:border-line-strong" onClick={() => setMapTry((n) => n + 1)}>Try again</button>
        </div>
      )}
    </div>
  )
})
