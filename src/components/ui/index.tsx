import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Calendar, CaseSensitive, Hash, ToggleLeft, Tag, X } from 'lucide-react'
import type { ColType } from '../../types'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')
export { cx }

// Escape closes only the topmost popover / dialog
const layers: (() => void)[] = []
let escInstalled = false
export function useEscapeLayer(active: boolean, close: () => void) {
  const ref = useRef(close)
  ref.current = close
  useEffect(() => {
    if (!active) return
    if (!escInstalled) {
      escInstalled = true
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !layers.length) return
        e.stopPropagation()
        layers[layers.length - 1]()
      })
    }
    const fn = () => ref.current()
    layers.push(fn)
    return () => { const i = layers.lastIndexOf(fn); if (i >= 0) layers.splice(i, 1) }
  }, [active])
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({ variant = 'secondary', size = 'md', className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition select-none disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'bg-accent-fill text-white hover:brightness-110 shadow-card',
        variant === 'secondary' && 'border border-line bg-surface text-ink hover:bg-surface-2 shadow-card',
        variant === 'ghost' && 'text-ink-2 hover:bg-surface-3 hover:text-ink',
        variant === 'danger' && 'text-bad hover:bg-surface-3',
        className,
      )}
    >
      {children}
    </button>
  )
}

export function IconButton({ label, className, children, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition hover:bg-surface-3 hover:text-ink',
        active && 'bg-surface-3 text-ink',
        className,
      )}
    >
      {children}
    </button>
  )
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: {
  value: T
  options: { value: T; label: ReactNode; title?: string }[]
  onChange: (v: T) => void
  size?: 'sm' | 'md'
}) {
  return (
    <div className="inline-flex rounded-lg bg-surface-3 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'inline-flex items-center gap-1.5 rounded-md font-medium transition',
            size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-3 text-[13px]',
            value === o.value ? 'bg-surface text-ink shadow-card' : 'text-ink-3 hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1 text-sm text-ink-2">
      {label}
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx('relative h-5 w-9 shrink-0 rounded-full transition', checked ? 'bg-accent' : 'bg-line-strong')}
      >
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
    </label>
  )
}

const TYPE_META: Record<ColType, { icon: typeof Hash; label: string; cls: string }> = {
  number: { icon: Hash, label: 'Number', cls: 'text-[#2a78d6] bg-[#2a78d6]/10' },
  date: { icon: Calendar, label: 'Date', cls: 'text-[#c25a00] bg-[#eb6834]/12 dark:text-[#f0a070]' },
  category: { icon: Tag, label: 'Category', cls: 'text-[#0e8a5f] bg-[#1baf7a]/12 dark:text-[#4fd1a0]' },
  text: { icon: CaseSensitive, label: 'Text', cls: 'text-ink-2 bg-surface-3' },
  boolean: { icon: ToggleLeft, label: 'Boolean', cls: 'text-[#6250d6] bg-[#6250d6]/10 dark:text-[#a99ff0]' },
}

export function TypeIcon({ type, className }: { type: ColType; className?: string }) {
  const m = TYPE_META[type]
  const Icon = m.icon
  return (
    <span title={m.label} className={cx('inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md', m.cls, className)}>
      <Icon size={12} strokeWidth={2.4} />
    </span>
  )
}
export const typeLabel = (t: ColType) => TYPE_META[t].label

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'good' | 'bad' }) {
  return (
    <span className={cx(
      'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium',
      tone === 'neutral' && 'bg-surface-3 text-ink-2',
      tone === 'accent' && 'bg-accent-soft text-accent-ink',
      tone === 'good' && 'bg-good/10 text-good',
      tone === 'bad' && 'bg-bad/10 text-bad',
    )}>{children}</span>
  )
}

/** Click-outside dropdown anchored to its trigger. */
export function Popover({ trigger, children, align = 'left', width = 240, defaultOpen = false, label = 'Options' }: {
  trigger: (open: boolean, toggle: () => void) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  width?: number
  defaultOpen?: boolean
  /** names the popup for screen readers (it's a non-modal dialog) */
  label?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  // Rendered in a portal with fixed positioning so scroll containers never clip it
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = ref.current?.getBoundingClientRect()
      if (!r) return
      const w = Math.min(width, window.innerWidth - 32)
      const left = Math.max(16, Math.min(align === 'right' ? r.right - w : r.left, window.innerWidth - w - 16))
      const below = window.innerHeight - r.bottom - 16
      const top = below < 240 && r.top > below ? Math.max(16, r.top - 6 - Math.min(r.top - 16, 420)) : r.bottom + 6
      setPos({ top, left, maxH: below < 240 && r.top > below ? r.top - 22 : below - 6 })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, width, align])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !pop.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  useEscapeLayer(open, () => setOpen(false))

  return (
    <div ref={ref} className="relative">
      {trigger(open, () => setOpen((o) => !o))}
      {open && pos && createPortal(
        <div
          ref={pop}
          role="dialog"
          aria-label={label}
          style={{ width: Math.min(width, window.innerWidth - 32), top: pos.top, left: pos.left, maxHeight: Math.min(420, pos.maxH) }}
          className="fade-up fixed z-[60] overflow-y-auto rounded-xl border border-line bg-surface p-1 text-left font-normal shadow-pop"
        >
          {children(() => setOpen(false))}
        </div>,
        document.body,
      )}
    </div>
  )
}

export function MenuItem({ icon, children, onClick, danger, active }: { icon?: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition hover:bg-surface-3',
        danger ? 'text-bad' : 'text-ink',
        active && 'bg-accent-soft text-accent-ink',
      )}
    >
      {icon && <span className="text-ink-3">{icon}</span>}
      {children}
    </button>
  )
}

export function Modal({ title, onClose, children, width = 520 }: { title: ReactNode; onClose: () => void; children: ReactNode; width?: number }) {
  useEscapeLayer(true, onClose)
  const box = useRef<HTMLDivElement>(null)
  const titleId = useRef(`dlg_${Math.random().toString(36).slice(2, 8)}`).current
  // move focus into the dialog, keep Tab inside it, and give focus back on close
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const el = box.current
    // only what Tab can actually reach: hidden inputs (e.g. a file picker behind a button) would break the wrap-around
    const focusables = () => [...(el?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])]
      .filter((x) => !x.hasAttribute('disabled') && x.tabIndex !== -1 && x.getClientRects().length > 0)
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>('[autofocus]') ?? focusables()[1] ?? focusables()[0])?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !el) return
      const f = focusables()
      if (!f.length) return
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus() }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus() }
    }
    el?.addEventListener('keydown', onKey)
    return () => { el?.removeEventListener('keydown', onKey); prev?.focus?.() }
  }, [])
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ width }} className="fade-up max-h-[88vh] max-w-full overflow-auto rounded-2xl border border-line bg-surface shadow-pop" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface px-5 py-3.5">
          <h2 id={titleId} className="text-[15px] font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}><X size={16} /></IconButton>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{children}</span>
      {action}
    </div>
  )
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-3 text-ink-3">{icon}</div>
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="max-w-xs text-[13px] text-ink-3">{children}</div>}
    </div>
  )
}

// ---------- confirm dialog (replaces window.confirm) ----------

interface ConfirmReq { title: string; body?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean; resolve: (ok: boolean) => void }
let setConfirm: ((r: ConfirmReq | null) => void) | null = null

/** Promise-based confirmation in the app's own dialog style. */
export function confirmDialog(opts: Omit<ConfirmReq, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    if (!setConfirm) { resolve(window.confirm(opts.title)); return }
    setConfirm({ ...opts, resolve })
  })
}

export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmReq | null>(null)
  useEffect(() => { setConfirm = setReq; return () => { setConfirm = null } }, [])
  if (!req) return null
  const done = (ok: boolean) => { req.resolve(ok); setReq(null) }
  return (
    <Modal title={req.title} onClose={() => done(false)} width={420}>
      {req.body && <div className="text-sm leading-relaxed text-ink-2">{req.body}</div>}
      <div className="mt-5 flex justify-end gap-2">
        <Button size="sm" onClick={() => done(false)}>{req.cancelLabel ?? 'Cancel'}</Button>
        <Button size="sm" variant={req.danger ? 'danger' : 'primary'} className={req.danger ? 'bg-bad text-white hover:bg-bad hover:brightness-110' : ''} autoFocus onClick={() => done(true)}>{req.confirmLabel ?? 'OK'}</Button>
      </div>
    </Modal>
  )
}

/** Click-to-edit text: shows the value, turns into an input on click (replaces window.prompt for renames). */
export function InlineEdit({ value, onSave, label, className, role, selected }: { value: string; onSave: (v: string) => void; label: string; className?: string; role?: 'tab'; selected?: boolean }) {
  const [editing, setEditing] = useState(false)
  if (!editing) {
    return <button role={role} aria-selected={role ? selected : undefined} aria-label={`${value} — rename ${label}`} className={cx('truncate rounded px-1 text-left hover:bg-surface-3', className)} title={`Click to rename this ${label}`} onClick={(e) => { e.stopPropagation(); setEditing(true) }}>{value}</button>
  }
  return (
    <input autoFocus aria-label={`Rename ${label}`} defaultValue={value} className="field h-7 px-2 text-[13px]"
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== value) onSave(v); setEditing(false) }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) } }} />
  )
}
