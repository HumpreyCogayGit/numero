import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AlertCircle, BookOpen, CheckCircle2, Columns3, FunctionSquare, Info, Search, Shapes, Sparkles, Trash2, Wand2 } from 'lucide-react'
import type { Column, ComputedDef, Dataset, NumFormat } from '../types'
import { evaluate, FormulaError, FUNCTIONS, highlight, referencedColumns, tokenize, type Category, type HlKind } from '../lib/formula'
import { typeResults } from '../lib/computed'
import { compileMeasure, evalMeasure } from '../lib/measure'
import { groupKeyFn, widgetColumns } from '../lib/aggregate'
import { fmtNumber, fmtValue } from '../lib/format'
import { quantile } from '../lib/stats'
import { useDashboardFull, useStore } from '../store'
import { Badge, Button, confirmDialog, cx, Modal, Segmented, TypeIcon, typeLabel } from './ui'

const HL: Record<HlKind, string> = {
  fn: 'text-[#2a78d6] dark:text-[#86b6ef] font-medium',
  col: 'text-[#0e8a5f] dark:text-[#4fd1a0]',
  str: 'text-[#c25a00] dark:text-[#f0a070]',
  num: 'text-[#6250d6] dark:text-[#a99ff0]',
  op: 'text-ink-2',
  kw: 'text-[#d55181] font-medium',
  paren: 'text-ink-3',
  bad: 'text-bad underline decoration-wavy decoration-bad/70 underline-offset-4',
  plain: 'text-ink',
}

const CATS: Category[] = ['Logic', 'Math', 'Text', 'Date', 'Aggregate', 'Window', 'Binning']
const CAT_HINT: Record<Category, string> = {
  Logic: 'Conditions and fallbacks',
  Math: 'Row-by-row arithmetic',
  Text: 'Clean, split and combine text',
  Date: 'Extract parts, shift and compare dates',
  Aggregate: 'Whole-column or per-group totals, repeated on every row',
  Window: 'Ranks, running totals and row-to-row changes',
  Binning: 'Group numbers into ranges',
}

const ref = (c: Column) => `[${c.name}]`
const nice = (x: number) => (Math.abs(x) >= 100 ? Math.round(+x.toPrecision(2)) : +x.toPrecision(2))

interface Recipe { group: string; name: string; formula: string; desc: string; format?: NumFormat }

/** Formula templates filled in with this dataset's real columns. */
function recipes(ds: Dataset): Recipe[] {
  // original columns first, so recipes don't build on earlier computed columns
  const nums = ds.columns.filter((c) => c.type === 'number' && !c.isId && !c.discrete).sort((x, y) => Number(x.formula != null) - Number(y.formula != null))
  const [a, b] = nums
  const date = ds.columns.find((c) => c.type === 'date')
  const cat = ds.columns.find((c) => c.type === 'category' && !c.isId && c.distinct >= 2 && c.distinct <= 60)
  const text = ds.columns.find((c) => c.type === 'text' && !c.isId) ?? cat
  const out: Recipe[] = []
  if (a && b) {
    out.push({ group: 'Ratios & shares', name: `${a.name} per ${b.name}`, formula: `DIVIDE(${ref(a)}, ${ref(b)})`, desc: 'Safe ratio — blank instead of an error when dividing by zero' })
    out.push({ group: 'Ratios & shares', name: `${a.name} minus ${b.name}`, formula: `${ref(a)} - ${ref(b)}`, desc: 'Difference between two columns' })
  }
  if (a) {
    out.push({ group: 'Ratios & shares', name: `${a.name} % of total`, formula: `${ref(a)} / SUM(${ref(a)}) * 100`, desc: "Each row's share of the column total", format: 'percent' })
    if (cat) out.push({ group: 'Ratios & shares', name: `${a.name} % of ${cat.name}`, formula: `${ref(a)} / GROUP_SUM(${ref(a)}, ${ref(cat)}) * 100`, desc: `Share within each ${cat.name}`, format: 'percent' })
    const xs = ds.rows.map((r) => r[a.key]).filter((v): v is number => typeof v === 'number')
    if (xs.length) {
      const [p33, p66] = [quantile(xs, 1 / 3), quantile(xs, 2 / 3)].map(nice)
      const [q1, q2, q3] = [0.25, 0.5, 0.75].map((q) => nice(quantile(xs, q)))
      out.push({ group: 'Segments', name: `${a.name} level`, formula: `IFS(${ref(a)} >= ${p66}, "High", ${ref(a)} >= ${p33}, "Medium", "Low")`, desc: 'Three bands split at the 33rd/66th percentiles' })
      if (q1 < q2 && q2 < q3) out.push({ group: 'Segments', name: `${a.name} range`, formula: `BUCKET(${ref(a)}, ${q1}, ${q2}, ${q3})`, desc: 'Labelled ranges at the quartiles' })
    }
    out.push({ group: 'Segments', name: `${a.name} quartile`, formula: `"Q" & NTILE(${ref(a)}, 4)`, desc: 'Equal-count quartiles Q1–Q4' })
    out.push({ group: 'Segments', name: `${a.name} vs median`, formula: `IF(${ref(a)} >= MEDIAN(${ref(a)}), "Above median", "Below median")`, desc: 'Two-way split at the median' })
    out.push({ group: 'Statistics', name: `${a.name} z-score`, formula: `ZSCORE(${ref(a)})`, desc: 'Standard deviations from the mean' })
    out.push({ group: 'Statistics', name: `${a.name} outlier`, formula: `ABS(ZSCORE(${ref(a)})) > 3`, desc: 'True for values more than 3σ from the mean' })
    out.push({ group: 'Statistics', name: `${a.name} rank`, formula: `RANK(${ref(a)})`, desc: '1 = largest value' })
    out.push({ group: 'Statistics', name: `${a.name} percentile`, formula: `PERCENT_RANK(${ref(a)})`, desc: 'Share of rows at or below this value (0–100)' })
    out.push({ group: 'Statistics', name: `${a.name} (log)`, formula: `LN(${ref(a)})`, desc: 'Natural log — tames right-skewed values' })
    if (cat) {
      out.push({ group: 'Groups', name: `${a.name} vs ${cat.name} average`, formula: `${ref(a)} - GROUP_AVG(${ref(a)}, ${ref(cat)})`, desc: `How far each row sits from its ${cat.name} average` })
      out.push({ group: 'Groups', name: `${a.name} rank in ${cat.name}`, formula: `RANK(${ref(a)}, "desc", ${ref(cat)})`, desc: `Rank restarting for each ${cat.name}` })
      out.push({ group: 'Groups', name: `Rows in ${cat.name}`, formula: `GROUP_COUNT(${ref(cat)})`, desc: 'Size of each row’s group' })
    }
  }
  if (date) {
    out.push({ group: 'Dates', name: 'Year', formula: `YEAR(${ref(date)})`, desc: 'Calendar year' })
    out.push({ group: 'Dates', name: 'Year-month', formula: `DATEFORMAT(${ref(date)}, "YYYY-MM")`, desc: 'Sortable month label' })
    out.push({ group: 'Dates', name: 'Quarter', formula: `YEAR(${ref(date)}) & " Q" & QUARTER(${ref(date)})`, desc: 'e.g. 2024 Q3' })
    out.push({ group: 'Dates', name: 'Weekday', formula: `DAYNAME(${ref(date)})`, desc: 'Monday … Sunday' })
    out.push({ group: 'Dates', name: 'Weekend', formula: `WEEKDAY(${ref(date)}) >= 6`, desc: 'True on Saturday and Sunday' })
    out.push({ group: 'Dates', name: 'Days ago', formula: `DATEDIFF(${ref(date)}, TODAY(), "day")`, desc: 'Age of each row in days' })
    if (a) {
      const by = cat ? `, ${ref(cat)}` : ''
      out.push({ group: 'Time series', name: `Running ${a.name}`, formula: `RUNNING_SUM(${ref(a)}, ${ref(date)}${by})`, desc: `Cumulative total in date order${cat ? `, per ${cat.name}` : ''}` })
      out.push({ group: 'Time series', name: `${a.name} change`, formula: `${ref(a)} - LAG(${ref(a)}, 1, ${ref(date)}${by})`, desc: 'Difference from the previous row in date order' })
      out.push({ group: 'Time series', name: `${a.name} % change`, formula: `PCT_CHANGE(${ref(a)}, ${ref(date)}${by})`, desc: 'Percent change from the previous row', format: 'percent' })
      out.push({ group: 'Time series', name: `${a.name} 7-row average`, formula: `MOVING_AVG(${ref(a)}, 7, ${ref(date)}${by})`, desc: 'Smooths day-to-day noise' })
    }
  }
  if (text) {
    out.push({ group: 'Text', name: `${text.name} (clean)`, formula: `PROPER(TRIM(${ref(text)}))`, desc: 'Trim spaces and capitalize words' })
    out.push({ group: 'Text', name: `${text.name} first word`, formula: `SPLIT(${ref(text)}, " ", 1)`, desc: 'Text before the first space' })
    out.push({ group: 'Text', name: `${text.name} length`, formula: `LEN(${ref(text)})`, desc: 'Number of characters' })
  }
  return out
}

/** Calculated-measure templates: aggregate-level formulas evaluated per chart cell. */
function measureRecipes(ds: Dataset): Recipe[] {
  const nums = ds.columns.filter((c) => c.type === 'number' && !c.isId && !c.discrete && c.formula == null)
  const [a, b] = nums
  const cat = ds.columns.find((c) => (c.type === 'category' || c.type === 'text') && c.isId)
  const out: Recipe[] = []
  if (a && b) {
    out.push({ group: 'Ratios', name: `${a.name} per ${b.name}`, formula: `SUM(${ref(a)}) / SUM(${ref(b)})`, desc: 'Ratio of totals — stays correct when grouped or filtered', format: 'decimal' })
    out.push({ group: 'Ratios', name: `${a.name} as % of ${b.name}`, formula: `SUM(${ref(a)}) / SUM(${ref(b)})`, desc: 'Shown as a percentage', format: 'ratio' })
    out.push({ group: 'Averages', name: `${a.name} weighted by ${b.name}`, formula: `SUM(${ref(a)} * ${ref(b)}) / SUM(${ref(b)})`, desc: 'Weighted average' })
  }
  if (a) {
    out.push({ group: 'Shares', name: `Share of ${a.name}`, formula: `SUM(${ref(a)}) / SUM_ALL(${ref(a)})`, desc: 'Each bar’s share of the filtered total — adds up to 100%', format: 'ratio' })
    out.push({ group: 'Averages', name: `${a.name} per row`, formula: `SUM(${ref(a)}) / COUNTROWS()`, desc: 'Total divided by the number of rows' })
    out.push({ group: 'Spread', name: `${a.name} range`, formula: `MAX(${ref(a)}) - MIN(${ref(a)})`, desc: 'Largest minus smallest in each group' })
    out.push({ group: 'Spread', name: `${a.name} 90th percentile`, formula: `PERCENTILE(${ref(a)}, 0.9)`, desc: 'Value 90% of rows fall below' })
    out.push({ group: 'Conditional', name: `Rows with ${a.name} above average`, formula: `SUM(IF(${ref(a)} > AVG_ALL(${ref(a)}), 1, 0))`, desc: 'Count rows meeting a condition' })
    out.push({ group: 'Conditional', name: `% of rows with ${a.name} above average`, formula: `SUM(IF(${ref(a)} > AVG_ALL(${ref(a)}), 1, 0)) / COUNTROWS()`, desc: 'Share of rows meeting a condition', format: 'ratio' })
  }
  if (cat) out.push({ group: 'Counts', name: `Rows per ${cat.name}`, formula: `COUNTROWS() / COUNTD(${ref(cat)})`, desc: 'Average rows per distinct value' })
  return out
}

/** Name of the function whose parentheses contain the caret, plus which argument it's on. */
function enclosingCall(src: string, caret: number): { name: string; arg: number } | null {
  let toks
  try {
    toks = tokenize(src.slice(0, caret))
  } catch (e) {
    // an unfinished [column or "text" at the caret: look at everything before it
    try { toks = tokenize(src.slice(0, (e as FormulaError).start)) } catch { return null }
  }
  const stack: { name: string | null; arg: number }[] = []
  toks.forEach((t, i) => {
    if (t.t === 'lp') stack.push({ name: toks[i - 1]?.t === 'id' ? toks[i - 1].v.toUpperCase() : null, arg: 0 })
    else if (t.t === 'rp') stack.pop()
    else if (t.t === 'comma' && stack.length) stack[stack.length - 1].arg++
  })
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name && FUNCTIONS[stack[i].name!]) return { name: stack[i].name!, arg: stack[i].arg }
  return null
}

/** Autocomplete for the word being typed: [column refs or function / bare column names. */
function suggestionsAt(src: string, caret: number, cols: Column[]) {
  const before = src.slice(0, caret)
  const open = before.lastIndexOf('[')
  if (open > before.lastIndexOf(']')) {
    const q = before.slice(open + 1).toLowerCase()
    return { start: open, items: cols.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8).map((c) => ({ label: c.name, insert: ref(c), kind: 'col' as const, col: c })) }
  }
  const m = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before)
  // no suggestions while typing inside a text literal
  const insideText = (before.match(/"/g)?.length ?? 0) % 2 === 1 || (before.match(/'/g)?.length ?? 0) % 2 === 1
  if (!m || insideText) return null
  const q = m[0].toUpperCase()
  const fns = Object.keys(FUNCTIONS).filter((f) => f.startsWith(q)).slice(0, 6).map((f) => ({ label: f, insert: `${f}(`, kind: 'fn' as const, col: undefined }))
  const cs = cols.filter((c) => c.name.toUpperCase().startsWith(q) || c.key.toUpperCase().startsWith(q)).slice(0, 4).map((c) => ({ label: c.name, insert: ref(c), kind: 'col' as const, col: c }))
  const items = [...fns, ...cs]
  return items.length && !(items.length === 1 && items[0].label === q) ? { start: m.index, items } : null
}

export function FormulaEditor({ ds, mode = 'column' }: { ds: Dataset; mode?: 'column' | 'measure' }) {
  const target = useStore((s) => s.formulaEditor)
  const { closeFormula, saveComputed, deleteComputed, saveMeasure, deleteMeasure, notify } = useStore.getState()
  const dash = useDashboardFull()
  const isMeasure = mode === 'measure'
  const defs = isMeasure ? ds.model.measures : ds.model.computed
  const existing = target?.key ? defs.find((d) => d.key === target.key) : undefined
  const [name, setName] = useState(existing?.name ?? '')
  const [formula, setFormula] = useState(existing?.formula ?? '')
  const [format, setFormat] = useState<ComputedDef['format']>(existing?.format ?? 'auto')
  const [caret, setCaret] = useState(0)
  const [panel, setPanel] = useState<'recipes' | 'functions' | 'columns'>(existing ? 'functions' : 'recipes')
  const [fnQuery, setFnQuery] = useState('')
  const [nameTouched, setNameTouched] = useState(!!existing)
  const area = useRef<HTMLTextAreaElement>(null)
  const pre = useRef<HTMLPreElement>(null)
  const pendingCaret = useRef<number | null>(null)

  // restore the caret in the same commit as a programmatic edit, so fast typing lands in the right place
  useLayoutEffect(() => {
    const p = pendingCaret.current
    if (p == null || !area.current) return
    pendingCaret.current = null
    area.current.focus()
    area.current.setSelectionRange(p, p)
    setCaret(p)
  }, [formula])

  // a computed column may use base columns and computed columns defined before it; a measure may use any column
  const available = useMemo(() => {
    if (isMeasure) return ds.columns
    const idx = existing ? ds.model.computed.findIndex((d) => d.key === existing.key) : Infinity
    const before = new Set(ds.model.computed.slice(0, idx).map((d) => d.key))
    return ds.columns.filter((c) => c.formula == null || before.has(c.key))
  }, [ds, existing, isMeasure])

  // errors about unfinished input ("missing its closing ]") wait until typing pauses
  const [idle, setIdle] = useState(true)
  useEffect(() => {
    setIdle(false)
    const t = setTimeout(() => setIdle(true), 700)
    return () => clearTimeout(t)
  }, [formula])

  const groupDim = useMemo(() => ds.columns.find((c) => c.type === 'category' && !c.isId && c.distinct >= 2 && c.distinct <= 30), [ds])
  const deferred = useDeferredValue(formula)
  const measureResult = useMemo(() => {
    if (!isMeasure || !deferred.trim()) return null
    try {
      const m = compileMeasure(deferred, available)
      const overall = evalMeasure(m, ds.rows, ds.rows)
      let groups: { label: string; value: number | null }[] = []
      if (groupDim) {
        const fn = groupKeyFn(groupDim, ds.rows)
        const g = new Map<string | number, typeof ds.rows>()
        for (const r of ds.rows) { const k = fn.key(r); if (!g.has(k)) g.set(k, []); g.get(k)!.push(r) }
        groups = [...g.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8).map(([k, rows]) => ({ label: fn.label(k), value: evalMeasure(m, rows, ds.rows) }))
      }
      const col: Column = { key: '__m', name: name || 'Measure', type: 'number', detected: 'number', format: format && format !== 'auto' ? format : 'decimal', distinct: 0, missing: 0 }
      return { ok: true as const, overall, groups, col, refs: [...referencedColumns(m.ast)] }
    } catch (e) {
      const err = e as FormulaError
      return { ok: false as const, message: err.message, start: err.start ?? 0, end: err.end ?? 0 }
    }
  }, [isMeasure, deferred, available, ds.rows, format, name, groupDim])

  const result = useMemo(() => {
    if (isMeasure || !deferred.trim()) return null
    try {
      const r = evaluate(deferred, available, ds.rows)
      const typed = typeResults(r.values, format)
      const col: Column = { key: '__preview', name: name || 'Result', type: typed.type, detected: typed.type, format: typed.format, grain: typed.grain, distinct: 0, missing: 0 }
      return { ok: true as const, ...r, typed, col, refs: [...referencedColumns(r.ast)] }
    } catch (e) {
      const err = e as FormulaError
      return { ok: false as const, message: err.message, start: err.start ?? 0, end: err.end ?? 0 }
    }
  }, [isMeasure, deferred, available, ds.rows, format, name])

  const status = isMeasure ? measureResult : result
  const incomplete = status && !status.ok && /missing its closing|ends unexpectedly|is missing its closing/.test(status.message)
  const shownError = status && !status.ok && (!incomplete || idle) ? status : null

  const segments = useMemo(() => highlight(formula, available), [formula, available])
  const call = enclosingCall(formula, caret)
  const sugg = useMemo(() => suggestionsAt(formula, caret, available), [formula, caret, available])
  const allRecipes = useMemo(() => (isMeasure ? measureRecipes(ds) : recipes(ds)), [ds, isMeasure])

  const nameClash = isMeasure
    ? ds.model.measures.some((d) => d.name.toLowerCase() === name.trim().toLowerCase() && d.key !== existing?.key)
    : ds.columns.some((c) => c.name.toLowerCase() === name.trim().toLowerCase() && c.key !== existing?.key)
  const canSave = !!name.trim() && !nameClash && status?.ok === true && deferred === formula

  const insert = (text: string, replaceFrom?: number) => {
    const el = area.current
    const start = replaceFrom ?? el?.selectionStart ?? formula.length
    const end = el?.selectionEnd ?? formula.length
    pendingCaret.current = start + text.length
    setFormula(formula.slice(0, start) + text + formula.slice(end))
  }

  const useRecipe = (r: Recipe) => {
    pendingCaret.current = r.formula.length
    setFormula(r.formula)
    if (!nameTouched || !name.trim()) setName(r.name)
    if (r.format) setFormat(r.format)
  }

  const save = () => {
    if (!canSave) return
    const payload = { key: existing?.key, name: name.trim(), formula, format }
    void (isMeasure ? saveMeasure(payload) : saveComputed(payload))
    notify('info', existing ? `Updated “${name.trim()}”` : isMeasure ? `Added measure “${name.trim()}”` : `Added column “${name.trim()}”`)
    closeFormula()
  }

  const remove = async () => {
    if (!existing) return
    const widgets = (dash?.pages ?? []).flatMap((p) => p.widgets)
    const usedBy = widgets.filter((w) => isMeasure ? w.measures.some((m) => m.calc === existing.key) : widgetColumns(w).includes(existing.key))
    const ok = await confirmDialog({
      title: `Delete “${existing.name}”?`,
      body: usedBy.length ? `${usedBy.length} chart${usedBy.length > 1 ? 's use' : ' uses'} it and will be flagged until edited. You can undo this.` : 'You can undo this.',
      confirmLabel: 'Delete', danger: true,
    })
    if (!ok) return
    void (isMeasure ? deleteMeasure(existing.key) : deleteComputed(existing.key))
    closeFormula()
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); return }
    if (e.key === 'Tab' && sugg) { e.preventDefault(); insert(sugg.items[0].insert, sugg.start) }
  }

  // splice the error range into the highlighted segments
  const marked = useMemo(() => {
    if (!shownError || shownError.end <= shownError.start) return segments.map((s) => ({ ...s, err: false }))
    const out: { text: string; kind: HlKind; err: boolean }[] = []
    let pos = 0
    for (const s of segments) {
      const a = pos, b = pos + s.text.length
      const cuts = [a, Math.max(a, Math.min(b, shownError.start)), Math.max(a, Math.min(b, shownError.end)), b]
      for (let i = 0; i < 3; i++) if (cuts[i + 1] > cuts[i]) out.push({ text: s.text.slice(cuts[i] - a, cuts[i + 1] - a), kind: s.kind, err: i === 1 })
      pos = b
    }
    return out
  }, [segments, shownError])

  const fnList = useMemo(() => {
    const q = fnQuery.trim().toUpperCase()
    return Object.entries(FUNCTIONS).filter(([k, d]) => !q || k.includes(q) || d.desc.toUpperCase().includes(q))
  }, [fnQuery])

  const previewRows = ds.rows.slice(0, 8)
  const refCols = result?.ok ? result.refs.map((k) => available.find((c) => c.key === k)!).filter(Boolean).slice(0, 3) : []
  const Icon = isMeasure ? Shapes : FunctionSquare

  return (
    <Modal title={<span className="flex items-center gap-2"><Icon size={17} className="text-accent" />{isMeasure ? (existing ? 'Edit calculated measure' : 'New calculated measure') : existing ? 'Edit computed column' : 'New computed column'}</span>} onClose={closeFormula} width={1060}>
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-ink-2">{isMeasure ? 'Measure name' : 'Column name'}</span>
               <input aria-label={isMeasure ? 'Measure name' : 'Column name'} className={cx('field', nameClash && 'border-bad')} value={name} placeholder="e.g. Profit margin" onChange={(e) => { setName(e.target.value); setNameTouched(true) }} />
              {nameClash && <span className="mt-1 block text-[11px] text-bad">{isMeasure ? 'A measure' : 'A column'} with this name already exists</span>}
            </label>
            <div>
              <span className="mb-1.5 block text-[12px] font-medium text-ink-2">Number format</span>
              <Segmented<NonNullable<ComputedDef['format']>> size="sm" value={format ?? 'auto'} onChange={setFormat} options={[
                { value: 'auto', label: 'Auto' }, { value: 'integer', label: '123' }, { value: 'decimal', label: '1.23' },
                { value: 'currency', label: '$', title: 'Currency' },
                { value: 'percent', label: '%', title: 'Percent — the value already is a percentage (12 → 12%)' },
                { value: 'ratio', label: '×%', title: 'Ratio as percent — a fraction shown ×100 (0.12 → 12%)' },
              ]} />
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[12px] font-medium text-ink-2">Formula</span>
              <span className="text-[11px] text-ink-3">Tab completes · ⌘/Ctrl + Enter saves</span>
            </div>
            <div className={cx('relative rounded-xl border bg-surface transition focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)]', shownError ? 'border-bad/60' : 'border-line focus-within:border-accent')}>
              <pre ref={pre} aria-hidden className="pointer-events-none m-0 min-h-[112px] overflow-hidden whitespace-pre-wrap break-words p-3.5 font-mono text-[13.5px] leading-[1.65]">
                {marked.map((s, i) => <span key={i} className={cx(HL[s.kind], s.err && 'rounded-sm bg-bad/15 underline decoration-wavy decoration-bad underline-offset-4')}>{s.text}</span>)}
                {'\n'}
              </pre>
              <textarea
                ref={area}
                aria-label="Formula"
                autoFocus
                spellCheck={false}
                value={formula}
                placeholder={isMeasure ? 'SUM([Profit]) / SUM([Revenue])' : 'IF([Revenue] > 0, [Profit] / [Revenue], NULL)'}
                onChange={(e) => { setFormula(e.target.value); setCaret(e.target.selectionStart) }}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                onKeyDown={onKey}
                onScroll={(e) => { if (pre.current) pre.current.scrollTop = e.currentTarget.scrollTop }}
                className="absolute inset-0 h-full w-full resize-none overflow-auto whitespace-pre-wrap break-words bg-transparent p-3.5 font-mono text-[13.5px] leading-[1.65] text-transparent caret-[var(--ink)] outline-none placeholder:text-ink-3/70 selection:bg-accent/25"
              />
            </div>

            {sugg && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {sugg.items.map((s, i) => (
                  <button key={s.kind + s.label} onMouseDown={(e) => { e.preventDefault(); insert(s.insert, sugg.start) }}
                    className={cx('inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[12px] transition hover:border-accent', i === 0 ? 'border-accent/50 bg-accent-soft text-accent-ink' : 'border-line text-ink-2')}>
                    {s.col ? <TypeIcon type={s.col.type} className="h-4 w-4" /> : <FunctionSquare size={12} />}{s.label}
                    {i === 0 && <kbd className="ml-0.5 rounded bg-surface px-1 text-[10px] text-ink-3">Tab</kbd>}
                  </button>
                ))}
              </div>
            )}

            {call && (
              <div className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-[12px]">
                <code className="font-mono text-ink">{highlightArg(FUNCTIONS[call.name].sig, call.arg)}</code>
                <div className="mt-0.5 text-ink-3">{FUNCTIONS[call.name].desc}</div>
              </div>
            )}

            <div className="mt-2 min-h-5 text-[12px]">
              {shownError ? (
                <span className="flex items-start gap-1.5 text-bad"><AlertCircle size={14} className="mt-px shrink-0" />{shownError.message}</span>
              ) : !status || !status.ok ? (
                <span className="text-ink-3">{isMeasure
                  ? 'Wrap columns in aggregates — SUM, AVG, COUNT, COUNTD, MIN, MAX, MEDIAN — and combine them. Use SUM_ALL for totals that ignore the grouping.'
                  : 'Reference columns in [brackets], combine them with + − × ÷, or pick a recipe on the right.'}</span>
              ) : measureResult?.ok ? (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-2">
                  <CheckCircle2 size={14} className="text-good" />
                  <b className="font-medium text-ink">Overall {fmtNumber(measureResult.overall, measureResult.col)}</b>
                  <span className="text-ink-3">· recalculated for every bar, slice and cell, under any filter</span>
                </span>
              ) : result?.ok ? (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-2">
                  <CheckCircle2 size={14} className="text-good" />
                  <TypeIcon type={result.typed.type} className="h-4 w-4" />
                  <b className="font-medium text-ink">{typeLabel(result.typed.type)}</b>
                  {result.typed.format && result.typed.type === 'number' && <Badge>{result.typed.format}</Badge>}
                  <Summary values={result.typed.values} col={result.col} />
                  {result.rowErrors > 0 && <span className="text-bad">· {result.rowErrors.toLocaleString()} rows failed: {result.firstRowError}</span>}
                </span>
              ) : null}
            </div>
            {!isMeasure && /\b(SUM|AVG|MEDIAN|COUNT|COUNTD|MIN|MAX|STDEV|SUM_ALL|GROUP_\w+|RANK|ZSCORE|PERCENT_RANK|NTILE)\s*\(/i.test(formula) && (
              <p className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-surface-2 px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-3">
                <Info size={13} className="mt-px shrink-0" />
                <span>Computed columns are calculated once over all rows, so column totals here ignore dashboard filters. For ratios and shares that follow filters and grouping, <button className="font-medium text-accent-ink hover:underline" onClick={() => useStore.setState({ formulaEditor: { mode: 'measure' } })}>create a calculated measure</button>.</span>
              </p>
            )}
          </div>

          {isMeasure ? (
            <div className="overflow-hidden rounded-xl border border-line">
              <div className="flex items-center justify-between border-b border-line bg-surface-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                Preview <span className="font-normal normal-case tracking-normal">{groupDim ? `by ${groupDim.name}` : 'overall'}</span>
              </div>
              <table className="tabular w-full text-[12.5px]">
                <tbody>
                  {(measureResult?.ok ? measureResult.groups : []).map((g) => (
                    <tr key={g.label} className="border-t border-line/70 first:border-t-0">
                      <td className="px-3 py-1.5 text-ink-2">{g.label}</td>
                      <td className="bg-accent-soft/30 px-3 py-1.5 text-right font-medium text-ink">{measureResult?.ok ? fmtNumber(g.value, measureResult.col) : '—'}</td>
                    </tr>
                  ))}
                  {!(measureResult?.ok && measureResult.groups.length) && <tr><td className="px-3 py-6 text-center text-ink-3">{measureResult?.ok ? `Overall: ${fmtNumber(measureResult.overall, measureResult.col)}` : 'The preview appears once the formula is valid'}</td></tr>}
                </tbody>
              </table>
            </div>
          ) : (
          <div className="overflow-hidden rounded-xl border border-line">
            <div className="flex items-center justify-between border-b border-line bg-surface-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
              Preview <span className="font-normal normal-case tracking-normal">first {previewRows.length} of {ds.rows.length.toLocaleString()} rows</span>
            </div>
            <div className="overflow-x-auto">
              <table className="tabular w-full text-[12.5px]">
                <thead>
                  <tr className="text-ink-3">
                    {refCols.map((c) => <th key={c.key} className="whitespace-nowrap px-3 py-1.5 text-left font-medium">{c.name}</th>)}
                    <th className="whitespace-nowrap bg-accent-soft/60 px-3 py-1.5 text-left font-semibold text-accent-ink">ƒ {name || 'Result'}</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((r, i) => (
                    <tr key={i} className="border-t border-line/70">
                      {refCols.map((c) => <td key={c.key} className="max-w-[200px] truncate px-3 py-1.5 text-ink-2">{fmtValue(r[c.key], c) || <i className="text-ink-3">null</i>}</td>)}
                      <td className="max-w-[260px] truncate bg-accent-soft/30 px-3 py-1.5 font-medium text-ink">
                        {result?.ok ? (result.typed.values[i] == null ? <i className="font-normal text-ink-3">null</i> : fmtValue(result.typed.values[i], result.col)) : <span className="text-ink-3">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          )}
        </div>

        <aside className="flex min-h-0 flex-col rounded-xl border border-line bg-surface-2/50 lg:max-h-[620px]">
          <div className="border-b border-line p-2">
            <Segmented<typeof panel> size="sm" value={panel} onChange={setPanel} options={[
              { value: 'recipes', label: <><Wand2 size={12} />Recipes</> },
              { value: 'functions', label: <><BookOpen size={12} />Functions</> },
              { value: 'columns', label: <><Columns3 size={12} />Columns</> },
            ]} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {panel === 'recipes' && (
              allRecipes.length ? groupBy(allRecipes, (r) => r.group).map(([g, rs]) => (
                <div key={g} className="mb-3">
                  <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-3">{g}</div>
                  {rs.map((r) => (
                    <button key={r.name + r.formula} onClick={() => useRecipe(r)} className="group mb-1 block w-full rounded-lg border border-transparent bg-surface px-2.5 py-2 text-left transition hover:border-accent/50">
                      <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink"><Sparkles size={11} className="text-accent opacity-60 group-hover:opacity-100" />{r.name}</div>
                      <code className="mt-0.5 block truncate font-mono text-[11px] text-ink-3" title={r.formula}>{r.formula}</code>
                      <div className="mt-0.5 text-[11px] text-ink-3">{r.desc}</div>
                    </button>
                  ))}
                </div>
              )) : <p className="p-2 text-[12px] text-ink-3">No recipes for these column types — see Functions.</p>
            )}
            {panel === 'functions' && (
              <>
                <div className="relative mb-2">
                  <Search size={13} className="absolute left-2.5 top-2.5 text-ink-3" />
                  <input value={fnQuery} onChange={(e) => setFnQuery(e.target.value)} placeholder={`Search ${Object.keys(FUNCTIONS).length} functions…`} className="field h-8 pl-8 text-[12.5px]" />
                </div>
                {CATS.map((cat) => {
                  const list = fnList.filter(([, d]) => d.cat === cat)
                  if (!list.length) return null
                  return (
                    <div key={cat} className="mb-3">
                      <div className="px-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-3">{cat}</div>
                      <div className="px-1.5 pb-1 text-[11px] text-ink-3">{CAT_HINT[cat]}</div>
                      {list.map(([k, d]) => (
                        <button key={k} onClick={() => insert(`${k}(`)} title={`Example: ${d.ex}`} className="mb-0.5 block w-full rounded-lg px-2 py-1.5 text-left transition hover:bg-surface">
                          <code className="font-mono text-[12px] text-accent-ink">{d.sig}</code>
                          <div className="text-[11px] leading-snug text-ink-3">{d.desc}</div>
                        </button>
                      ))}
                    </div>
                  )
                })}
              </>
            )}
            {panel === 'columns' && available.map((c) => (
              <button key={c.key} onClick={() => insert(ref(c))} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-surface">
                <TypeIcon type={c.type} />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {c.formula != null && <span className="text-[11px] text-ink-3">ƒ</span>}
              </button>
            ))}
          </div>
        </aside>
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-line pt-4">
        <div>{existing && <Button variant="danger" size="sm" onClick={() => void remove()}><Trash2 size={14} />{isMeasure ? 'Delete measure' : 'Delete column'}</Button>}</div>
        <div className="flex gap-2">
          <Button size="sm" onClick={closeFormula}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!canSave} onClick={save}>{existing ? 'Save changes' : isMeasure ? 'Add measure' : 'Add column'}</Button>
        </div>
      </div>
    </Modal>
  )
}

function Summary({ values, col }: { values: (string | number | boolean | null)[]; col: Column }) {
  const present = values.filter((v) => v != null)
  const blanks = values.length - present.length
  const distinct = new Set(present).size
  let extra = ''
  if (col.type === 'number' && present.length) {
    const xs = present as number[]
    let lo = Infinity, hi = -Infinity, sum = 0
    for (const x of xs) { if (x < lo) lo = x; if (x > hi) hi = x; sum += x }
    extra = ` · range ${fmtNumber(lo, col)} – ${fmtNumber(hi, col)} · mean ${fmtNumber(sum / xs.length, col)}`
  }
  if (col.type === 'date' && present.length) {
    const xs = present as number[]
    extra = ` · ${fmtValue(Math.min(...xs), col)} – ${fmtValue(Math.max(...xs), col)}`
  }
  return <span className="text-ink-3">· {distinct.toLocaleString()} distinct · {blanks.toLocaleString()} blank{extra}</span>
}

function highlightArg(sig: string, arg: number) {
  const open = sig.indexOf('(')
  const parts = sig.slice(open + 1, -1).split(/,\s*/)
  const idx = Math.min(arg, parts.length - 1)
  return (
    <>
      <span className="text-accent-ink">{sig.slice(0, open)}</span>(
      {parts.map((p, i) => <span key={i}>{i > 0 && ', '}<span className={i === idx ? 'rounded bg-accent/15 px-0.5 font-semibold text-ink' : 'text-ink-3'}>{p}</span></span>)}
      )
    </>
  )
}

function groupBy<T>(xs: T[], key: (x: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>()
  for (const x of xs) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k)!.push(x) }
  return [...m.entries()]
}

