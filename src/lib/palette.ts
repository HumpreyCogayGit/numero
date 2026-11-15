// Validated reference palette (dataviz skill, references/palette.md).
// Categorical order is the CVD-safety mechanism — never reorder or cycle.

export type Theme = 'light' | 'dark'

export interface ChartTokens {
  surface: string
  textPrimary: string
  textSecondary: string
  muted: string
  grid: string
  axis: string
  border: string
  series: string[]
  other: string
  sequential: string[]
  diverging: [string, string, string]
  good: string
  critical: string
}

export const TOKENS: Record<Theme, ChartTokens> = {
  light: {
    surface: '#fcfcfb',
    textPrimary: '#0b0b0b',
    textSecondary: '#52514e',
    muted: '#898781',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
    border: 'rgba(11,11,11,0.10)',
    series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
    other: '#b5b3ab',
    sequential: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
    diverging: ['#d03b3b', '#f0efec', '#2a78d6'],
    good: '#006300',
    critical: '#d03b3b',
  },
  dark: {
    surface: '#1a1a19',
    textPrimary: '#f0efec',
    textSecondary: '#c3c2b7',
    muted: '#898781',
    grid: '#2c2c2a',
    axis: '#383835',
    border: 'rgba(255,255,255,0.10)',
    series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    other: '#5d5c57',
    sequential: ['#1a2c44', '#184f95', '#1c5cab', '#2670cc', '#5598e7', '#86b6ef', '#cde2fb'],
    diverging: ['#e66767', '#383835', '#3987e5'],
    good: '#0ca30c',
    critical: '#e66767',
  },
}

/** Fixed-order categorical color; index past 7 never generates a new hue. */
export function seriesColor(t: ChartTokens, index: number, name?: string): string {
  if (name === 'Other' || index < 0 || index >= t.series.length) return t.other
  return t.series[index]
}

/** Readable label color inside a filled cell of the sequential/diverging ramp: whichever ink contrasts more. */
export function inkOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
  // contrast against near-black (#0b0b0b, luminance ≈ 0.0034) vs white
  return (l + 0.05) / 0.0534 >= 1.05 / (l + 0.05) ? '#0b0b0b' : '#ffffff'
}
