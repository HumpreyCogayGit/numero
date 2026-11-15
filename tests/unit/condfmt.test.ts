import { describe, expect, it } from 'vitest'
import { cellLook, describeRule, matches } from '../../src/lib/condfmt'
import type { CondRule } from '../../src/types'

const rule = (p: Partial<CondRule>): CondRule => ({ id: 'r', cmp: 'gt', value: 0, tone: 'good', ...p })

describe('conditional formatting', () => {
  it('compares values', () => {
    expect(matches(5, rule({ cmp: 'gt', value: 4 }))).toBe(true)
    expect(matches(4, rule({ cmp: 'gt', value: 4 }))).toBe(false)
    expect(matches(4, rule({ cmp: 'gte', value: 4 }))).toBe(true)
    expect(matches(3, rule({ cmp: 'between', value: 5, value2: 1 }))).toBe(true)
    expect(describeRule(rule({ cmp: 'between', value: 1, value2: 5 }))).toBe('between 1 and 5')
    expect(describeRule(rule({ cmp: 'lt', value: 0.25 }), (n) => `${n * 100}%`)).toBe('below 25%')
  })
  it('bars by default, scale when asked, the first matching rule for that measure', () => {
    const range = { min: 10, max: 50 }
    expect(cellLook(25, 'a', range, undefined)).toEqual({ bar: 50, rule: undefined })
    expect(cellLook(30, 'a', range, { bars: false, scale: true })).toEqual({ scale: 0.5, rule: undefined })
    const rules = [rule({ id: 'x', measure: 'b', cmp: 'gt', value: 0 }), rule({ id: 'y', cmp: 'lt', value: 20, tone: 'bad' }), rule({ id: 'z', cmp: 'lt', value: 30 })]
    expect(cellLook(15, 'a', range, { rules }).rule?.id).toBe('y')
    expect(cellLook(25, 'a', range, { rules }).rule?.id).toBe('z')
    expect(cellLook(25, 'b', range, { rules }).rule?.id).toBe('x')
    expect(cellLook(null, 'a', range, { rules })).toEqual({})
  })
})
