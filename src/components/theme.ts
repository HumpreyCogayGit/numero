import { createContext, useContext } from 'react'
import type { Theme } from '../lib/palette'

// kept apart from Chart.tsx so screens without charts don't pull in ECharts
export const ThemeContext = createContext<Theme>('light')
export const useTheme = () => useContext(ThemeContext)
/** Pattern fills (decals) on chart marks — for color-blind readers, grayscale print and forced colors. */
export const PatternContext = createContext(false)
export const usePatterns = () => useContext(PatternContext)
