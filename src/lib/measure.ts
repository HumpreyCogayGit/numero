// Calculated measures: aggregate-level formulas evaluated once per chart cell, on that cell's rows.
//   SUM([Profit]) / SUM([Revenue])          profit margin that stays right under any grouping or filter
//   SUM([Sales]) / SUM_ALL([Sales]) * 100   share of the filtered total
//   SUM(IF([Returned], [Revenue], 0))       row logic inside an aggregate

import type { Column, Row } from '../types'
import { binaryOp, colAggs, evaluateAst, FormulaError, num, parse, truthy, unaryOp, type FValue, type Node } from './formula'
import { quantileSorted } from './stats'

const GROUP_AGGS = new Set(['SUM', 'AVG', 'MIN', 'MAX', 'MEDIAN', 'COUNT', 'COUNTD', 'STDEV', 'PERCENTILE', 'COUNTROWS'])
const ALL_AGGS: Record<string, string> = { SUM_ALL: 'SUM', AVG_ALL: 'AVG', COUNT_ALL: 'COUNT' }

export interface CompiledMeasure { ast: Node; src: string }

/** Parses and validates: columns must sit inside an aggregate; row-window functions aren't allowed. */
export function compileMeasure(src: string, cols: Column[]): CompiledMeasure {
  const ast = parse(src, cols)
  const check = (node: Node, inAgg: boolean) => {
    switch (node.k) {
      case 'col':
        if (!inAgg) throw new FormulaError(`Wrap [${node.col.name}] in an aggregate such as SUM([${node.col.name}]) — a measure summarizes many rows`, node.s, node.e)
        return
      case 'un': check(node.a, inAgg); return
      case 'bin': check(node.a, inAgg); check(node.b, inAgg); return
      case 'call': {
        const isAgg = GROUP_AGGS.has(node.name) || node.name in ALL_AGGS
        if (isAgg && inAgg) throw new FormulaError(`${node.name}() can't be nested inside another aggregate`, node.s, node.e)
        if (isAgg && (node.name === 'MIN' || node.name === 'MAX') && node.args.length > 1) {
          // MIN(a, b) of two aggregates is a scalar pick, not a column aggregate
          node.args.forEach((a) => check(a, inAgg))
          return
        }
        if (!isAgg && node.def.win) throw new FormulaError(`${node.name}() works row by row — use it in a computed column instead`, node.s, node.e)
        node.args.forEach((a, i) => check(a, inAgg || (isAgg && !(node.name === 'PERCENTILE' && i === 1))))
      }
    }
  }
  check(ast, false)
  return { ast, src }
}

/** Evaluates a measure for one group of rows; `all` is every row in view (for *_ALL). */
export function evalMeasure(m: CompiledMeasure, group: Row[], all: Row[]): number | null {
  const ev = (node: Node): FValue => {
    switch (node.k) {
      case 'lit': return node.v
      case 'col': return null
      case 'un': return unaryOp(node.op, ev(node.a))
      case 'bin':
        if (node.op === 'AND') return truthy(ev(node.a)) ? truthy(ev(node.b)) : false
        if (node.op === 'OR') return truthy(ev(node.a)) ? true : truthy(ev(node.b))
        return binaryOp(node.op, ev(node.a), ev(node.b))
      case 'call': {
        const name = node.name
        const scalarPick = (name === 'MIN' || name === 'MAX') && node.args.length > 1
        if (!scalarPick && (GROUP_AGGS.has(name) || name in ALL_AGGS)) {
          const rows = name in ALL_AGGS ? all : group
          if (name === 'COUNTROWS') return rows.length
          const xs = evaluateAst(node.args[0], rows).values
          if (name === 'PERCENTILE') {
            const sorted = xs.map(num).filter((x): x is number => x != null).sort((a, b) => a - b)
            const p = num(ev(node.args[1])) ?? 0.5
            return sorted.length ? quantileSorted(sorted, p > 1 ? p / 100 : p) : null
          }
          return colAggs[ALL_AGGS[name] ?? name](xs)
        }
        if (node.def.lazy) return node.def.lazy(node.args, ev)
        return node.def.fn!(...node.args.map(ev))
      }
    }
  }
  const v = num(ev(m.ast))
  return v == null || !Number.isFinite(v) ? null : v
}

const cache = new Map<string, CompiledMeasure | Error>()

/** Compiles with a small cache keyed by formula + column set; returns the error instead of throwing. */
export function getMeasure(src: string, cols: Column[]): CompiledMeasure | Error {
  const key = src + '\u0000' + cols.map((c) => `${c.key}:${c.name}:${c.type}`).join('|')
  let hit = cache.get(key)
  if (!hit) {
    try { hit = compileMeasure(src, cols) } catch (e) { hit = e as Error }
    if (cache.size > 200) cache.clear()
    cache.set(key, hit)
  }
  return hit
}
