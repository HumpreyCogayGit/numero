// Generates public/samples/online-store-events.csv — a synthetic web shop event log (CC0) for funnels and cohorts.
// Each row is one step a customer reached in a session: Visit → Product view → Add to cart → Checkout → Purchase.
// Customers arrive month by month through a channel and come back less often over time, so retention by first
// month is visible in a cohort table. Seeded, so re-running produces the same file.
import { writeFileSync } from 'node:fs'

let seed = 20250101
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = (xs, w) => { let r = rnd() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < xs.length; i++) { r -= w[i]; if (r <= 0) return xs[i] } return xs[xs.length - 1] }

const CHANNELS = ['Search', 'Social', 'Email', 'Direct', 'Referral']
const CHANNEL_W = [5, 3, 2, 2.5, 1]
// how likely a customer from each channel is to come back in a later month
const LOYALTY = { Search: 0.34, Social: 0.22, Email: 0.46, Direct: 0.4, Referral: 0.38 }
const COUNTRIES = ['United States', 'Canada', 'United Kingdom', 'Germany', 'France', 'Australia']
const COUNTRY_W = [6, 1.5, 2, 1.6, 1.2, 1]
const DEVICES = ['Mobile', 'Desktop', 'Tablet']
const DEVICE_W = [5.5, 3.5, 1]
const STAGES = ['1 Visit', '2 Product view', '3 Add to cart', '4 Checkout', '5 Purchase']

const rows = [['Event Date', 'Customer ID', 'Stage', 'Channel', 'Country', 'Device', 'Revenue']]
let next = 10001
const months = 12
for (let m = 0; m < months; m++) {
  const newCustomers = Math.round(260 + m * 22 + rnd() * 40)
  for (let c = 0; c < newCustomers; c++) {
    const id = `C${next++}`
    const channel = pick(CHANNELS, CHANNEL_W)
    const country = pick(COUNTRIES, COUNTRY_W)
    const device = pick(DEVICES, DEVICE_W)
    // retention fades with time since the first visit, then levels off
    for (let k = 0; m + k < months; k++) {
      const p = k === 0 ? 1 : LOYALTY[channel] * (0.55 + 0.45 / k)
      if (rnd() > p) continue
      const sessions = 1 + (rnd() < 0.25 ? 1 : 0)
      for (let s = 0; s < sessions; s++) {
        const days = new Date(Date.UTC(2025, m + k + 1, 0)).getUTCDate()
        const date = new Date(Date.UTC(2025, m + k, 1 + Math.floor(rnd() * days))).toISOString().slice(0, 10)
        // each step is reached with some probability; returning customers convert better
        const keep = [1, 0.72, 0.42 + (k ? 0.08 : 0), 0.68, 0.78 + (k ? 0.06 : 0)]
        for (let i = 0; i < STAGES.length; i++) {
          if (rnd() > keep[i]) break
          const revenue = i === 4 ? (18 + rnd() * 70 + (device === 'Desktop' ? 12 : 0)).toFixed(2) : ''
          rows.push([date, id, STAGES[i], channel, country, device, revenue])
        }
      }
    }
  }
}
// in date order, as an export would be
const head = rows.shift()
rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
writeFileSync(new URL('../public/samples/online-store-events.csv', import.meta.url), [head, ...rows].map((r) => r.join(',')).join('\n') + '\n')
console.log(`online-store-events.csv: ${rows.length} rows, ${next - 10001} customers`)
