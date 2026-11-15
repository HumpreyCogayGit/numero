// Generates public/samples/coffee-chain-sales.csv — a synthetic, deliberately messy sales file (CC0) —
// plus public/samples/updates/coffee-chain-sales-2025-07.csv, the "next month" used to demo Update data.
// Seeded, so re-running produces the same file. Mess on purpose: inconsistent store names, duplicate rows,
// blank channels, test orders and currency strings — the Prepare tab cleans them up.
import { mkdirSync, writeFileSync } from 'node:fs'

let seed = 20240101
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = (xs, w) => { let r = rnd() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < xs.length; i++) { r -= w[i]; if (r <= 0) return xs[i] } return xs[xs.length - 1] }

const STORES = [
  ['Seattle - Pike St', 'WA', 1.3], ['Seattle - Capitol Hill', 'WA', 1.0], ['Portland - Pearl', 'OR', 0.9],
  ['San Francisco - Mission', 'CA', 1.2], ['Los Angeles - Silver Lake', 'CA', 1.0], ['Austin - South Congress', 'TX', 0.8],
  ['Chicago - Loop', 'IL', 1.1], ['New York - Tribeca', 'NY', 1.4], ['Boston - Back Bay', 'MA', 0.9],
]
const PRODUCTS = [
  ['Espresso', 'Hot coffee', 3.0, 0.55, 'hot'], ['Latte', 'Hot coffee', 4.75, 1.05, 'hot'], ['Cappuccino', 'Hot coffee', 4.5, 0.95, 'hot'],
  ['Americano', 'Hot coffee', 3.5, 0.65, 'hot'], ['Cold Brew', 'Iced coffee', 4.95, 0.85, 'iced'], ['Iced Latte', 'Iced coffee', 5.25, 1.15, 'iced'],
  ['Matcha Latte', 'Tea', 5.5, 1.55, 'hot'], ['Chai Latte', 'Tea', 4.95, 1.25, 'hot'], ['Croissant', 'Bakery', 3.75, 1.35, 'food'],
  ['Blueberry Muffin', 'Bakery', 3.5, 1.15, 'food'], ['Breakfast Sandwich', 'Food', 7.5, 3.05, 'food'],
]
const HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
const HOUR_W = [3, 9, 12, 9, 6, 5, 7, 6, 4, 4, 4, 3, 2, 1]
const money = (x) => `$${x.toFixed(2)}`
const messy = (s) => { const r = rnd(); return r < 0.33 ? ` ${s.toLowerCase()}` : r < 0.66 ? `${s.toUpperCase()} ` : `${s}  ` }

const rows = [['Order ID', 'Order Date', 'Store', 'State', 'Product', 'Category', 'Qty', 'Unit Price', 'Unit Cost', 'Channel', 'Promo', 'Rating']]
let id = 0
const start = Date.UTC(2024, 0, 1), end = Date.UTC(2025, 6, 31)
for (let t = start; t <= end; t += 864e5) {
  const d = new Date(t)
  const month = d.getUTCMonth(), dow = d.getUTCDay()
  const monthsIn = (d.getUTCFullYear() - 2024) * 12 + month
  const summer = Math.max(0, Math.cos(((month - 6.5) / 12) * 2 * Math.PI))  // peaks in July
  const promo = d.getUTCFullYear() === 2024 && month === 6                 // "Iced Summer" promotion, July 2024
  for (const [store, state, size] of STORES) {
    const orders = Math.round((2.2 + rnd() * 1.6) * size * (1 + monthsIn * 0.012) * (dow === 0 || dow === 6 ? 1.2 : 1) * (promo ? 1.25 : 1))
    for (let o = 0; o < orders; o++) {
      const icedBoost = 1 + summer * 2.2 + (promo ? 1.2 : 0)
      const p = pick(PRODUCTS, PRODUCTS.map((x) => (x[4] === 'iced' ? icedBoost : x[4] === 'hot' ? 1.6 - summer * 0.6 : 1)))
      const channel = pick(['In-store', 'Mobile', 'Delivery'], [60, 28 + monthsIn * 0.4, 10])
      const hour = pick(HOURS, HOUR_W), minute = Math.floor(rnd() * 60)
      const qty = pick([1, 2, 3, 4], [72, 20, 6, 2])
      const price = p[2] + (channel === 'Delivery' ? 1 : 0) - (promo && p[4] === 'iced' ? 0.75 : 0)
      const rating = rnd() < 0.25 ? String(Math.max(1, Math.min(5, Math.round(4.3 - (channel === 'Delivery' ? 0.8 : 0) + (rnd() - 0.5) * 2)))) : ''
      const row = [
        `C-${String(++id).padStart(6, '0')}`,
        `${d.toISOString().slice(0, 10)} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        rnd() < 0.04 ? messy(store) : store, state, p[0], p[1], String(qty), money(price), money(p[3]),
        rnd() < 0.03 ? '' : channel, promo && p[4] === 'iced' ? 'Yes' : 'No', rating,
      ]
      rows.push(row)
      if (rnd() < 0.012) rows.push([...row])        // accidental duplicate export
    }
  }
  if (rnd() < 0.04) rows.push([`T-${String(id).padStart(6, '0')}`, `${d.toISOString().slice(0, 10)} 05:00`, 'Test Store', 'WA', 'TEST ITEM', 'Test', '1', '$0.00', '$0.00', 'In-store', 'No', ''])
}
const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
const csv = (rs) => rs.map((r) => r.map(esc).join(',')).join('\n') + '\n'
const [header, ...body] = rows
// generated in date order, so the base file is identical whether or not later months are generated
const base = body.filter((r) => r[1] < '2025-07')
const july = body.filter((r) => r[1] >= '2025-07')
writeFileSync(new URL('../public/samples/coffee-chain-sales.csv', import.meta.url), csv([header, ...base]))
mkdirSync(new URL('../public/samples/updates/', import.meta.url), { recursive: true })
writeFileSync(new URL('../public/samples/updates/coffee-chain-sales-2025-07.csv', import.meta.url), csv([header, ...july]))
console.log(`${base.length} rows + ${july.length} rows for July 2025`)
