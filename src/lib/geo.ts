import type { Column, Row } from '../types'

// Region names as they appear in public/geo/*.json (Natural Earth via world-atlas / us-atlas).

const COUNTRY_ALIASES: Record<string, string> = {
  'united states': 'United States of America', usa: 'United States of America', us: 'United States of America', 'u.s.': 'United States of America', 'u.s.a.': 'United States of America', america: 'United States of America',
  uk: 'United Kingdom', 'u.k.': 'United Kingdom', gb: 'United Kingdom', gbr: 'United Kingdom', 'great britain': 'United Kingdom', britain: 'United Kingdom', england: 'United Kingdom',
  'russian federation': 'Russia', rus: 'Russia',
  'korea, rep.': 'South Korea', 'republic of korea': 'South Korea', 'korea, south': 'South Korea', korea: 'South Korea', kor: 'South Korea',
  'korea, dem. rep.': 'North Korea', 'korea, north': 'North Korea', "democratic people's republic of korea": 'North Korea',
  'czech republic': 'Czechia', 'czech rep.': 'Czechia',
  'democratic republic of the congo': 'Dem. Rep. Congo', 'congo, dem. rep.': 'Dem. Rep. Congo', 'dr congo': 'Dem. Rep. Congo', drc: 'Dem. Rep. Congo',
  'republic of the congo': 'Congo', 'congo, rep.': 'Congo',
  'central african republic': 'Central African Rep.', 'bosnia and herzegovina': 'Bosnia and Herz.', 'dominican republic': 'Dominican Rep.',
  'south sudan': 'S. Sudan', 'ivory coast': "Côte d'Ivoire", "cote d'ivoire": "Côte d'Ivoire",
  eswatini: 'eSwatini', swaziland: 'eSwatini', 'north macedonia': 'Macedonia', 'equatorial guinea': 'Eq. Guinea',
  'solomon islands': 'Solomon Is.', 'falkland islands': 'Falkland Is.', 'western sahara': 'W. Sahara', burma: 'Myanmar',
  'iran, islamic rep.': 'Iran', 'syrian arab republic': 'Syria', 'lao pdr': 'Laos', 'viet nam': 'Vietnam',
  'egypt, arab rep.': 'Egypt', 'venezuela, rb': 'Venezuela', 'yemen, rep.': 'Yemen', 'slovak republic': 'Slovakia',
  'kyrgyz republic': 'Kyrgyzstan', 'turkiye': 'Turkey', 'türkiye': 'Turkey', 'east timor': 'Timor-Leste', 'timor leste': 'Timor-Leste',
  uae: 'United Arab Emirates', 'the netherlands': 'Netherlands', holland: 'Netherlands', 'the bahamas': 'Bahamas', 'bahamas, the': 'Bahamas',
  'gambia, the': 'Gambia', 'the gambia': 'Gambia', 'tanzania, united republic of': 'Tanzania', 'bolivia (plurinational state of)': 'Bolivia',
  'brunei darussalam': 'Brunei', 'cabo verde': 'Cape Verde', 'trinidad & tobago': 'Trinidad and Tobago', 'papua new guinea': 'Papua New Guinea',
  deu: 'Germany', de: 'Germany', fra: 'France', fr: 'France', ita: 'Italy', esp: 'Spain', es: 'Spain', jpn: 'Japan', jp: 'Japan', chn: 'China', cn: 'China',
  ind: 'India', bra: 'Brazil', br: 'Brazil', can: 'Canada', ca: 'Canada', aus: 'Australia', au: 'Australia', mex: 'Mexico', mx: 'Mexico', nld: 'Netherlands', nl: 'Netherlands',
}

export const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico', GU: 'Guam', VI: 'United States Virgin Islands', AS: 'American Samoa', MP: 'Commonwealth of the Northern Mariana Islands',
}
const STATE_NAMES = new Set(Object.values(US_STATES).map((s) => s.toLowerCase()))

// world-atlas country names (110m), used to validate matches without fetching the map
const WORLD = new Set(["Fiji","Tanzania","W. Sahara","Canada","United States of America","Kazakhstan","Uzbekistan","Papua New Guinea","Indonesia","Argentina","Chile","Dem. Rep. Congo","Somalia","Kenya","Sudan","Chad","Haiti","Dominican Rep.","Russia","Bahamas","Falkland Is.","Norway","Greenland","Fr. S. Antarctic Lands","Timor-Leste","South Africa","Lesotho","Mexico","Uruguay","Brazil","Bolivia","Peru","Colombia","Panama","Costa Rica","Nicaragua","Honduras","El Salvador","Guatemala","Belize","Venezuela","Guyana","Suriname","France","Ecuador","Puerto Rico","Jamaica","Cuba","Zimbabwe","Botswana","Namibia","Senegal","Mali","Mauritania","Benin","Niger","Nigeria","Cameroon","Togo","Ghana","Côte d'Ivoire","Guinea","Guinea-Bissau","Liberia","Sierra Leone","Burkina Faso","Central African Rep.","Congo","Gabon","Eq. Guinea","Zambia","Malawi","Mozambique","eSwatini","Angola","Burundi","Israel","Lebanon","Madagascar","Palestine","Gambia","Tunisia","Algeria","Jordan","United Arab Emirates","Qatar","Kuwait","Iraq","Oman","Vanuatu","Cambodia","Thailand","Laos","Myanmar","Vietnam","North Korea","South Korea","Mongolia","India","Bangladesh","Bhutan","Nepal","Pakistan","Afghanistan","Tajikistan","Kyrgyzstan","Turkmenistan","Iran","Syria","Armenia","Sweden","Belarus","Ukraine","Poland","Austria","Hungary","Moldova","Romania","Lithuania","Latvia","Estonia","Germany","Bulgaria","Greece","Turkey","Albania","Croatia","Switzerland","Luxembourg","Belgium","Netherlands","Portugal","Spain","Ireland","New Caledonia","Solomon Is.","New Zealand","Australia","Sri Lanka","China","Taiwan","Italy","Denmark","United Kingdom","Iceland","Azerbaijan","Georgia","Philippines","Malaysia","Brunei","Slovenia","Finland","Slovakia","Czechia","Eritrea","Japan","Paraguay","Yemen","Saudi Arabia","N. Cyprus","Cyprus","Morocco","Egypt","Libya","Ethiopia","Djibouti","Somaliland","Uganda","Rwanda","Bosnia and Herz.","Macedonia","Serbia","Montenegro","Kosovo","Trinidad and Tobago","S. Sudan"])
const WORLD_LOWER = new Map([...WORLD].map((n) => [n.toLowerCase(), n]))

export function resolveRegion(value: unknown, geo: 'world' | 'usa'): string | null {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  const lo = raw.toLowerCase()
  if (geo === 'usa') {
    const abbr = US_STATES[raw.toUpperCase()]
    if (abbr) return abbr
    return STATE_NAMES.has(lo) ? Object.values(US_STATES).find((s) => s.toLowerCase() === lo)! : null
  }
  return WORLD_LOWER.get(lo) ?? COUNTRY_ALIASES[lo] ?? null
}

/** Decides whether a column holds countries or US states (by name, then by how many values resolve). */
export function detectGeo(col: Column, rows: Row[]): 'world' | 'usa' | null {
  if (col.type !== 'category' && col.type !== 'text') return null
  const distinct = [...new Set(rows.slice(0, 20_000).map((r) => r[col.key]).filter((v) => v != null))].slice(0, 400)
  if (distinct.length < 2) return null
  const share = (geo: 'world' | 'usa') => distinct.filter((v) => resolveRegion(v, geo)).length / distinct.length
  const named = /(country|nation)/i.test(col.key) ? 'world' : /(^|_|\b)(state|province)(\b|_|$)/i.test(col.key) ? 'usa' : null
  const w = share('world'), u = share('usa')
  if (named === 'world' && w > 0.5) return 'world'
  if (named === 'usa' && u > 0.5) return 'usa'
  if (u >= 0.8 && distinct.length >= 5) return 'usa'
  if (w >= 0.8 && distinct.length >= 5) return 'world'
  return null
}

export function detectLatLon(cols: Column[], rows: Row[]): { lat: string; lon: string } | null {
  const nums = cols.filter((c) => c.type === 'number')
  const inRange = (c: Column, lim: number) => rows.slice(0, 2000).every((r) => r[c.key] == null || Math.abs(r[c.key] as number) <= lim)
  const lat = nums.find((c) => /^(lat|latitude|lat_deg|y_lat)$/i.test(c.key) || /latitude/i.test(c.key)) ?? nums.find((c) => /lat/i.test(c.key))
  const lon = nums.find((c) => /^(lon|lng|long|longitude)$/i.test(c.key) || /longitude/i.test(c.key)) ?? nums.find((c) => /(lon|lng)/i.test(c.key))
  return lat && lon && inRange(lat, 90) && inRange(lon, 180) ? { lat: lat.key, lon: lon.key } : null
}
