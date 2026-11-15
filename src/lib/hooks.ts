import { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { Theme } from './palette'

/** Resolves the theme preference against the OS and stamps <html data-theme>. */
export function useResolvedTheme(): Theme {
  const pref = useStore((s) => s.themePref)
  const [system, setSystem] = useState<Theme>(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const on = () => setSystem(mq.matches ? 'dark' : 'light')
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  useEffect(() => {
    if (pref === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = pref
  }, [pref])
  return pref === 'system' ? system : pref
}

/** Whether the browser reports a network connection; follows the online / offline events. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine !== false)
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  return online
}

export { downloadBlob, downloadText, downloadUrl } from './download'
export { toCsv } from './csv'

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export'
