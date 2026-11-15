// Showcase setups for the sample datasets: opening a sample also adds prep steps, computed columns,
// calculated measures and extra dashboard pages that demonstrate what Numero can do with that data.

import type { Agg, Dataset, DatasetModel, Filter, Measure, Page, Widget } from '../types'
import { uid } from './suggest'

export interface Preset {
  /** samples that must be imported first (e.g. the other side of a join) */
  requires?: string[]
  /** additions to the dataset model; `idOf` resolves a required sample's dataset id */
  model?: (ctx: { idOf: (file: string) => string | undefined }) => Partial<Pick<DatasetModel, 'computed' | 'measures' | 'prep' | 'formats'>>
  /** pages added before the suggested "Overview" page; the first one opens */
  pages: (ds: Dataset) => Omit<Page, 'id'>[]
}

// ---------- builders ----------

const W = (w: Partial<Widget> & Pick<Widget, 'type' | 'title'>): Widget => ({ id: uid(), size: 'md', measures: [], ...w })
const M = (column?: string, agg: Agg = 'sum'): Measure => (column ? { id: uid('m'), column, agg } : { id: uid('m'), agg: 'count' })
const C = (calc: string): Measure => ({ id: uid('m'), agg: 'calc', calc })
const year = (column: string, y: number): Filter => ({ id: uid('f'), column, min: Date.UTC(y, 0, 1), max: Date.UTC(y, 11, 31, 23, 59, 59) })
const month = (column: string, y: number, m: number): Filter => ({ id: uid('f'), column, min: Date.UTC(y, m - 1, 1), max: Date.UTC(y, m, 1) - 1 })
const isValue = (column: string, ...values: string[]): Filter => ({ id: uid('f'), column, values })
const page = (name: string, widgets: Widget[], filters: Filter[] = []): Omit<Page, 'id'> => ({ name, widgets, filters })
const step = <T extends object>(s: T) => ({ id: uid('s'), ...s })

// ---------- presets ----------

export const PRESETS: Record<string, Preset> = {
  'coffee-chain-sales.csv': {
    model: () => ({
      prep: [
        step({ op: 'trim' as const, columns: ['Store'] }),
        step({ op: 'case' as const, column: 'Store', mode: 'proper' as const }),
        step({ op: 'dedupe' as const }),
        step({ op: 'filter' as const, column: 'Product', cmp: 'eq' as const, value: 'TEST ITEM', keep: false }),
        step({ op: 'fill' as const, column: 'Channel', method: 'value' as const, value: 'Unknown' }),
      ],
      computed: [
        { key: 'calc_revenue', name: 'Revenue', formula: '[Qty] * [Unit Price]', format: 'currency' },
        { key: 'calc_cost', name: 'Cost', formula: '[Qty] * [Unit Cost]', format: 'currency' },
        { key: 'calc_hour', name: 'Hour', formula: 'DATEFORMAT([Order Date], "HH") & ":00"' },
        { key: 'calc_weekday', name: 'Weekday', formula: 'WEEKDAY([Order Date]) & " " & DAYNAME([Order Date], TRUE)' },
      ],
      measures: [
        { key: 'm_margin', name: 'Gross margin', formula: '(SUM([Revenue]) - SUM([Cost])) / SUM([Revenue])', format: 'ratio' },
        { key: 'm_aov', name: 'Average order value', formula: 'SUM([Revenue]) / COUNTD([Order ID])', format: 'currency' },
        { key: 'm_mobile', name: 'Mobile share', formula: 'SUM(IF([Channel] = "Mobile", 1, 0)) / COUNTROWS()', format: 'ratio' },
      ],
    }),
    pages: () => [
      page('Highlights', [
        W({
          type: 'text', size: 'full', title: '',
          text: '## {latest month} at a glance\n**{Revenue}** revenue from **{count distinct Order ID}** orders · gross margin **{Gross margin}** · average order **{Average order value}**. This note is filtered to the latest month, so it moves forward when new data is loaded.',
          filters: [{ id: uid('f'), column: 'Order Date', relative: { last: 1, unit: 'month', calendar: true } }],
        }),
        W({ type: 'kpi', size: 'xs', title: 'Revenue', measures: [M('calc_revenue')], dimension: 'Order Date', bucket: 'month', upIsGood: true }),
        W({ type: 'kpi', size: 'xs', title: 'Gross margin', measures: [C('m_margin')], dimension: 'Order Date', bucket: 'month', upIsGood: true, target: 0.76 }),
        W({ type: 'kpi', size: 'xs', title: 'Average order value', measures: [C('m_aov')], dimension: 'Order Date', bucket: 'month', upIsGood: true }),
        W({ type: 'kpi', size: 'xs', title: 'Mobile share', measures: [C('m_mobile')], dimension: 'Order Date', bucket: 'month', compare: 'yoy', upIsGood: true, target: 0.35 }),
        W({
          type: 'line', size: 'lg', title: 'Monthly revenue', subtitle: 'with a 6-month forecast', dimension: 'Order Date', bucket: 'month', measures: [M('calc_revenue')],
          forecast: 6, bands: [{ id: uid('b'), from: 'Jun 2024', to: 'Aug 2024', label: 'Iced Summer promo' }],
          notes: [{ id: uid('n'), at: 'Jul 2024', text: 'Iced drinks $0.75 off all July' }],
        }),
        W({ type: 'donut', size: 'sm', title: 'Revenue by category', dimension: 'Category', measures: [M('calc_revenue')] }),
        W({ type: 'hbar', title: 'Revenue by store', subtitle: 'double-click a store to see its products', dimension: 'Store', drillTo: 'Product', measures: [M('calc_revenue')], labels: true }),
        W({ type: 'hbar', title: 'Gross margin by product', dimension: 'Product', measures: [C('m_margin')], sort: 'value-desc', refLines: [{ id: uid('r'), kind: 'avg', label: 'Average' }] }),
        W({ type: 'heatmap', size: 'full', title: 'Revenue by hour and weekday', subtitle: 'computed columns Hour and Weekday', dimension: 'calc_hour', series: 'calc_weekday', measures: [M('calc_revenue')], sort: 'label-asc' }),
        W({ type: 'map', geo: 'usa', title: 'Revenue by state', dimension: 'State', measures: [M('calc_revenue')] }),
        ((aov) => W({
          type: 'table', title: 'Channels', subtitle: 'color scale, and a rule on order value', dimension: 'Channel', measures: [M('Order ID', 'distinct'), M('calc_revenue'), aov],
          tableFormat: { scale: true, bars: false, rules: [{ id: uid('c'), measure: aov.id, cmp: 'gte', value: 7, tone: 'good' }] },
        }))(C('m_aov')),
      ]),
      page('Seasons & channels', [
        W({ type: 'area', size: 'full', title: 'Revenue by category over time', dimension: 'Order Date', bucket: 'month', series: 'Category', stacked: true, measures: [M('calc_revenue')] }),
        W({ type: 'line', size: 'full', title: 'Orders by channel', subtitle: 'small multiples share one axis', dimension: 'Order Date', bucket: 'month', facet: 'Channel', measures: [M('Order ID', 'distinct')] }),
        W({ type: 'bar', title: 'Category mix by month of year', subtitle: 'iced coffee peaks in summer', dimension: 'Order Date', bucket: 'moy', sort: 'natural', measures: [M()], series: 'Category', normalized: true, stacked: true }),
        W({ type: 'box', title: 'Rating spread by channel', dimension: 'Channel', y: 'Rating' }),
        W({ type: 'waterfall', title: 'Revenue change month by month', subtitle: 'waterfall: each bar is the change from the month before', dimension: 'Order Date', bucket: 'month', measures: [M('calc_revenue')] }),
        W({ type: 'pareto', title: 'Products by revenue', subtitle: 'Pareto: the few products that make most of it', dimension: 'Product', measures: [M('calc_revenue')] }),
      ]),
    ],
  },

  'online-store-events.csv': {
    model: () => ({
      measures: [
        { key: 'm_conversion', name: 'Conversion rate', formula: 'SUM(IF([Stage] = "5 Purchase", 1, 0)) / SUM(IF([Stage] = "1 Visit", 1, 0))', format: 'ratio' },
        { key: 'm_customers', name: 'Customers', formula: 'COUNTD([Customer ID])', format: 'integer' },
      ],
    }),
    pages: () => [
      page('Funnel & retention', [
        W({ type: 'text', size: 'full', title: '', text: '## Shop performance through {latest month}\n**{Customers}** customers made **{count Revenue}** purchases worth **{sum Revenue}** · {Conversion rate} of visits end in a purchase.' }),
        W({ type: 'kpi', size: 'xs', title: 'Customers', measures: [C('m_customers')], dimension: 'Event Date', bucket: 'month', upIsGood: true }),
        W({ type: 'kpi', size: 'xs', title: 'Revenue', measures: [M('Revenue')], dimension: 'Event Date', bucket: 'month', upIsGood: true }),
        W({ type: 'kpi', size: 'xs', title: 'Conversion rate', measures: [C('m_conversion')], dimension: 'Event Date', bucket: 'month', upIsGood: true, target: 0.2 }),
        W({ type: 'kpi', size: 'xs', title: 'Average order', measures: [M('Revenue', 'avg')], dimension: 'Event Date', bucket: 'month', upIsGood: true }),
        W({ type: 'funnel', title: 'Checkout funnel', subtitle: 'sessions reaching each step', dimension: 'Stage', sort: 'label-asc', measures: [M()] }),
        W({ type: 'hbar', title: 'Conversion rate by channel', dimension: 'Channel', measures: [C('m_conversion')], labels: true }),
        W({ type: 'cohort', size: 'full', title: 'Customers coming back, by first month', subtitle: 'cohort: share of each month’s new customers active again', dimension: 'Event Date', bucket: 'month', entity: 'Customer ID' }),
        W({ type: 'pareto', title: 'Revenue by country', dimension: 'Country', measures: [M('Revenue')] }),
        W({ type: 'waterfall', title: 'Revenue by channel', subtitle: 'how each channel adds up to the total', dimension: 'Channel', measures: [M('Revenue')] }),
      ]),
    ],
  },

  'seattle-weather.csv': {
    model: () => ({
      computed: [{ key: 'calc_temp_range', name: 'Temp range', formula: '[temp_max] - [temp_min]' }],
      measures: [{ key: 'm_rain_share', name: 'Rainy-day share', formula: 'SUM(IF([weather] = "rain", 1, 0)) / COUNTROWS()', format: 'ratio' }],
    }),
    pages: () => [
      page('Seasons', [
        W({ type: 'kpi', size: 'xs', title: 'Rainy-day share', measures: [C('m_rain_share')], dimension: 'date', bucket: 'month', compare: 'yoy', upIsGood: false }),
        W({ type: 'kpi', size: 'xs', title: 'Average high', measures: [M('temp_max', 'avg')], dimension: 'date', bucket: 'month', compare: 'yoy' }),
        W({ type: 'kpi', size: 'xs', title: 'Precipitation this month', measures: [M('precipitation')], dimension: 'date', bucket: 'month', kpiMode: 'latest', compare: 'yoy' }),
        W({ type: 'kpi', size: 'xs', title: 'Average daily temperature swing', measures: [M('calc_temp_range', 'avg')], dimension: 'date', bucket: 'month' }),
        W({ type: 'line', size: 'lg', title: 'Average high, with forecast and anomalies', dimension: 'date', bucket: 'month', measures: [M('temp_max', 'avg')], forecast: 12, anomalies: true }),
        W({ type: 'bar', size: 'sm', title: 'Rainy-day share by month of year', dimension: 'date', bucket: 'moy', sort: 'natural', measures: [C('m_rain_share')] }),
        W({ type: 'line', title: 'Precipitation vs the year before', dimension: 'date', bucket: 'month', measures: [M('precipitation')], compare: 'yoy' }),
        W({ type: 'heatmap', title: 'Weather by month of year', dimension: 'date', bucket: 'moy', series: 'weather', measures: [M()] }),
      ]),
    ],
  },

  'us-flights-2001.json': {
    requires: ['us-airports.csv'],
    model: ({ idOf }) => ({
      prep: idOf('us-airports.csv') ? [step({ op: 'join' as const, datasetId: idOf('us-airports.csv')!, leftKey: 'origin', rightKey: 'iata', how: 'left' as const, columns: ['name', 'city', 'state', 'latitude', 'longitude'] })] : [],
      computed: [
        { key: 'calc_late', name: 'Late (15+ min)', formula: '[delay] > 15' },
        { key: 'calc_hour', name: 'Departure hour', formula: 'DATEFORMAT([date], "HH") & ":00"' },
        { key: 'calc_weekday', name: 'Weekday', formula: 'WEEKDAY([date]) & " " & DAYNAME([date], TRUE)' },
      ],
      measures: [{ key: 'm_ontime', name: 'On-time rate', formula: 'SUM(IF([delay] <= 15, 1, 0)) / COUNTROWS()', format: 'ratio' }],
    }),
    pages: () => [
      page('Delays', [
        W({ type: 'kpi', size: 'xs', title: 'Flights', measures: [M()], dimension: 'date', bucket: 'month' }),
        W({ type: 'kpi', size: 'xs', title: 'On-time rate', measures: [C('m_ontime')], dimension: 'date', bucket: 'month', upIsGood: true, target: 0.8 }),
        W({ type: 'kpi', size: 'xs', title: 'Average delay (min)', measures: [M('delay', 'avg')], dimension: 'date', bucket: 'month', upIsGood: false }),
        W({ type: 'kpi', size: 'xs', title: 'Average distance (mi)', measures: [M('distance', 'avg')] }),
        W({ type: 'map', geo: 'usa', title: 'On-time rate by origin state', subtitle: 'state comes from joining the US Airports sample', dimension: 'state', measures: [C('m_ontime')] }),
        W({ type: 'hbar', title: 'Busiest origin airports', subtitle: 'double-click to see destinations', dimension: 'name', drillTo: 'destination', measures: [M()], limit: 12, labels: true }),
        W({ type: 'heatmap', size: 'full', title: 'Average delay by departure hour and weekday', dimension: 'calc_hour', series: 'calc_weekday', measures: [M('delay', 'avg')], sort: 'label-asc' }),
        W({ type: 'line', title: 'Daily average delay', dimension: 'date', bucket: 'day', measures: [M('delay', 'avg')], anomalies: true, refLines: [{ id: uid('r'), kind: 'avg', label: 'Quarter average' }] }),
        W({ type: 'donut', title: 'Late flights', dimension: 'calc_late', measures: [M()] }),
      ]),
    ],
  },

  'co2-mauna-loa.csv': {
    model: () => ({
      computed: [
        { key: 'calc_swing', name: 'Seasonal swing', formula: '[CO2] - [adjusted CO2]' },
        { key: 'calc_yoy', name: 'Increase vs a year earlier', formula: '[CO2] - LAG([CO2], 12, [Date])' },
      ],
    }),
    pages: () => [
      page('Climate', [
        W({ type: 'kpi', size: 'xs', title: 'CO₂ this year (ppm)', measures: [M('CO2', 'avg')], dimension: 'Date', bucket: 'year', kpiMode: 'latest', upIsGood: false }),
        W({ type: 'kpi', size: 'xs', title: 'Yearly increase (ppm)', measures: [M('calc_yoy', 'avg')], dimension: 'Date', bucket: 'year', kpiMode: 'latest', upIsGood: false }),
        W({ type: 'kpi', size: 'xs', title: 'Record high (ppm)', measures: [M('CO2', 'max')] }),
        W({ type: 'kpi', size: 'xs', title: 'First reading (ppm)', measures: [M('CO2', 'min')] }),
        W({ type: 'line', size: 'full', title: 'Monthly CO₂ at Mauna Loa', subtitle: 'two-year seasonal forecast', dimension: 'Date', bucket: 'month', measures: [M('CO2', 'avg')], forecast: 24, refLines: [{ id: uid('r'), kind: 'value', value: 350, label: '350 ppm' }, { id: uid('r'), kind: 'value', value: 400, label: '400 ppm' }] }),
        W({ type: 'bar', title: 'The yearly breathing cycle', subtitle: 'average seasonal swing by month', dimension: 'Date', bucket: 'moy', sort: 'natural', measures: [M('calc_swing', 'avg')] }),
        W({ type: 'line', title: 'Increase vs a year earlier', dimension: 'Date', bucket: 'year', measures: [M('calc_yoy', 'avg')], trend: true }),
      ]),
    ],
  },

  'us-employment-by-sector.csv': {
    model: () => ({
      prep: [
        step({ op: 'remove' as const, columns: ['nonfarm', 'private', 'goods_producing', 'service_providing', 'private_service_providing', 'durable_goods', 'nondurable_goods', 'trade_transportation_utilties', 'nonfarm_change'] }),
        step({ op: 'unpivot' as const, columns: ['mining_and_logging', 'construction', 'manufacturing', 'wholesale_trade', 'retail_trade', 'transportation_and_warehousing', 'utilities', 'information', 'financial_activities', 'professional_and_business_services', 'education_and_health_services', 'leisure_and_hospitality', 'other_services', 'government'], nameColumn: 'Sector', valueColumn: 'Jobs (thousands)' }),
        step({ op: 'replace' as const, column: 'Sector', find: '_', replace: ' ' }),
        step({ op: 'case' as const, column: 'Sector', mode: 'proper' as const }),
      ],
    }),
    pages: () => [
      page('Jobs', [
        W({ type: 'kpi', size: 'sm', title: 'Jobs (thousands)', measures: [M('Jobs (thousands)')], dimension: 'month', bucket: 'month', kpiMode: 'latest', compare: 'yoy', upIsGood: true }),
        W({ type: 'kpi', size: 'sm', title: 'Health & education jobs', measures: [M('Jobs (thousands)')], dimension: 'month', bucket: 'month', kpiMode: 'latest', compare: 'yoy', upIsGood: true, filters: [isValue('Sector', 'Education And Health Services')] }),
        W({ type: 'kpi', size: 'sm', title: 'Manufacturing jobs', measures: [M('Jobs (thousands)')], dimension: 'month', bucket: 'month', kpiMode: 'latest', compare: 'yoy', upIsGood: true, filters: [isValue('Sector', 'Manufacturing')] }),
        W({
          type: 'area', size: 'full', title: 'Jobs by sector', subtitle: 'the file had one column per sector — unpivoted in Prepare', dimension: 'month', bucket: 'month', series: 'Sector', stacked: true, measures: [M('Jobs (thousands)')],
          bands: [{ id: uid('b'), from: 'Dec 2007', to: 'Jun 2009', label: 'Great Recession' }],
        }),
        W({ type: 'line', size: 'full', title: 'Each sector on its own panel', dimension: 'month', bucket: 'year', facet: 'Sector', measures: [M('Jobs (thousands)', 'avg')] }),
        W({ type: 'hbar', title: 'Jobs by sector, December 2015', dimension: 'Sector', measures: [M('Jobs (thousands)')], filters: [month('month', 2015, 12)], labels: true }),
        W({ type: 'treemap', title: 'Share of jobs, December 2015', dimension: 'Sector', measures: [M('Jobs (thousands)')], filters: [month('month', 2015, 12)] }),
      ]),
    ],
  },

  'seattle-vs-new-york-weather.csv': {
    pages: () => [
      page('Two cities', [
        W({ type: 'line', title: 'Average high by month', dimension: 'date', bucket: 'month', series: 'location', measures: [M('temp_max', 'avg')] }),
        W({ type: 'bar', title: 'Weather types', subtitle: 'click a bar to filter the dashboard', dimension: 'weather', series: 'location', measures: [M()] }),
        W({ type: 'bar', size: 'full', title: 'Monthly precipitation, side by side', dimension: 'date', bucket: 'month', facet: 'location', measures: [M('precipitation')] }),
        W({ type: 'box', title: 'Daily high spread', dimension: 'location', y: 'temp_max' }),
        W({ type: 'scatter', title: 'Wind vs precipitation', x: 'wind', y: 'precipitation', color: 'location', trend: true }),
      ]),
    ],
  },

  'gapminder.json': {
    pages: () => [
      page('World', [
        W({ type: 'kpi', size: 'xs', title: 'Population (latest year)', measures: [M('pop')], dimension: 'year', kpiMode: 'latest', upIsGood: true }),
        W({ type: 'kpi', size: 'xs', title: 'Life expectancy (latest)', measures: [M('life_expect', 'avg')], dimension: 'year', kpiMode: 'latest', upIsGood: true }),
        W({ type: 'kpi', size: 'xs', title: 'Fertility (latest)', measures: [M('fertility', 'avg')], dimension: 'year', kpiMode: 'latest' }),
        W({ type: 'kpi', size: 'xs', title: 'Countries', measures: [M('country', 'distinct')] }),
        W({ type: 'map', size: 'lg', geo: 'world', title: 'Life expectancy in 2005', dimension: 'country', measures: [M('life_expect', 'avg')], filters: [year('year', 2005)] }),
        W({ type: 'bar', size: 'sm', title: 'Fertility by cluster, 2005', dimension: 'cluster', measures: [M('fertility', 'avg')], filters: [year('year', 2005)], sort: 'value-desc' }),
        W({ type: 'line', title: 'Life expectancy by cluster', dimension: 'year', series: 'cluster', measures: [M('life_expect', 'avg')] }),
        W({ type: 'scatter', title: 'Fertility vs life expectancy, 2005', x: 'life_expect', y: 'fertility', trend: true, tooltipFields: ['country'], filters: [year('year', 2005)] }),
      ]),
    ],
  },

  'us-airports.csv': {
    pages: () => [
      page('Map', [
        W({ type: 'points', size: 'full', geo: 'usa', title: 'Every airport', x: 'longitude', y: 'latitude', tooltipFields: ['name', 'city', 'iata'] }),
        W({ type: 'map', geo: 'usa', title: 'Airports per state', dimension: 'state', measures: [M()] }),
        W({ type: 'hbar', title: 'States with the most airports', subtitle: 'double-click a state to see its cities', dimension: 'state', drillTo: 'city', measures: [M()], limit: 15, labels: true }),
      ]),
    ],
  },

  'movies.json': {
    model: () => ({
      // a few release dates in the source were parsed into the future (up to 2046): drop them
      prep: [step({ op: 'filter' as const, column: 'Release Date', cmp: 'lte' as const, value: '2010-12-31', keep: true })],
      computed: [{ key: 'calc_profit', name: 'Profit', formula: '[Worldwide Gross] - [Production Budget]', format: 'currency' }],
      measures: [{ key: 'm_roi', name: 'Return on budget (×)', formula: 'SUM([Worldwide Gross]) / SUM([Production Budget])', format: 'decimal' }],
    }),
    pages: () => [
      page('Box office', [
        W({ type: 'kpi', size: 'xs', title: 'Films', measures: [M()] }),
        W({ type: 'kpi', size: 'xs', title: 'Worldwide gross', measures: [M('Worldwide Gross')], format: { num: 'currency' } }),
        W({ type: 'kpi', size: 'xs', title: 'Return on budget (×)', measures: [C('m_roi')], upIsGood: true }),
        W({ type: 'kpi', size: 'xs', title: 'Median IMDB rating', measures: [M('IMDB Rating', 'median')] }),
        W({ type: 'hbar', title: 'Return on budget by genre', subtitle: 'double-click a genre to see its distributors', dimension: 'Major Genre', drillTo: 'Distributor', measures: [C('m_roi')], refLines: [{ id: uid('r'), kind: 'avg', label: 'Average' }] }),
        W({ type: 'line', title: 'Worldwide gross by release year', dimension: 'Release Date', bucket: 'year', measures: [M('Worldwide Gross')], format: { num: 'currency' } }),
        W({ type: 'scatter', title: 'Critics vs audiences', x: 'Rotten Tomatoes Rating', y: 'IMDB Rating', trend: true, tooltipFields: ['Title', 'Major Genre'] }),
        W({ type: 'donut', title: 'Films by genre', dimension: 'Major Genre', measures: [M()] }),
        W({ type: 'table', size: 'full', title: 'Top 15 films by profit', dimension: 'Title', measures: [M('calc_profit'), M('Worldwide Gross'), M('Production Budget')], limit: 15, sort: 'value-desc' }),
      ]),
    ],
  },

  'cars.json': {
    model: () => ({
      computed: [{ key: 'calc_ptw', name: 'Horsepower per 1,000 lb', formula: 'ROUND([Horsepower] / [Weight_in_lbs] * 1000, 1)' }],
    }),
    pages: () => [
      page('Efficiency', [
        W({ type: 'scatter', title: 'Miles per gallon vs weight', x: 'Weight_in_lbs', y: 'Miles_per_Gallon', color: 'Origin', trend: true, tooltipFields: ['Name', 'Year'] }),
        W({ type: 'line', title: 'Fuel economy by origin', dimension: 'Year', facet: 'Origin', measures: [M('Miles_per_Gallon', 'avg')] }),
        W({ type: 'bar', title: 'Power-to-weight by cylinders', dimension: 'Cylinders', measures: [M('calc_ptw', 'avg')], sort: 'label-asc' }),
        W({ type: 'box', title: 'Miles per gallon spread by origin', dimension: 'Origin', y: 'Miles_per_Gallon' }),
      ]),
    ],
  },

  'penguins.csv': {
    model: () => ({
      computed: [
        { key: 'calc_bill_ratio', name: 'Bill length ÷ depth', formula: 'ROUND([bill_length_mm] / [bill_depth_mm], 2)' },
        { key: 'calc_size', name: 'Body mass band', formula: 'BUCKET([body_mass_g], 3500, 4500, 5500)' },
      ],
    }),
    pages: () => [
      page('Species', [
        W({ type: 'scatter', size: 'full', title: 'Flipper length vs body mass, by island', x: 'flipper_length_mm', y: 'body_mass_g', color: 'species', facet: 'island' }),
        W({ type: 'box', title: 'Bill shape by species', dimension: 'species', y: 'calc_bill_ratio' }),
        W({ type: 'bar', title: 'Body mass bands', dimension: 'calc_size', series: 'species', stacked: true, measures: [M()], sort: 'label-asc' }),
      ]),
    ],
  },

  'us-unemployment-by-industry.xlsx': {
    pages: () => [
      page('Recession', [
        W({
          type: 'line', size: 'lg', title: 'Unemployment rate, all industries', dimension: 'Date', bucket: 'month', measures: [M('Unemployment Rate (%)', 'avg')], forecast: 12,
          bands: [{ id: uid('b'), from: 'Dec 2007', to: 'Jun 2009', label: 'Great Recession' }],
          notes: [{ id: uid('n'), at: 'Jan 2010', text: 'Highest average rate in the data' }],
        }),
        W({ type: 'kpi', size: 'sm', title: 'Unemployed (thousands, latest month)', measures: [M('Unemployed (thousands)')], dimension: 'Date', bucket: 'month', kpiMode: 'latest', compare: 'yoy', upIsGood: false }),
        W({ type: 'line', size: 'full', title: 'Rate by industry', dimension: 'Date', bucket: 'quarter', facet: 'Industry', measures: [M('Unemployment Rate (%)', 'avg')] }),
      ]),
    ],
  },

  'tech-stock-prices.xls': {
    model: () => ({
      computed: [
        { key: 'calc_change', name: 'Monthly change %', formula: 'ROUND(PCT_CHANGE([Price], [Date], [Symbol]), 2)', format: 'percent' },
        { key: 'calc_vs_avg', name: 'Price vs own average %', formula: 'ROUND([Price] / GROUP_AVG([Price], [Symbol]) * 100, 1)', format: 'percent' },
      ],
    }),
    pages: () => [
      page('Returns', [
        W({ type: 'line', title: 'Price by symbol', dimension: 'Date', bucket: 'month', series: 'Symbol', measures: [M('Price', 'avg')] }),
        W({ type: 'line', title: 'Average monthly change, with anomalies', dimension: 'Date', bucket: 'month', measures: [M('calc_change', 'avg')], anomalies: true, refLines: [{ id: uid('r'), kind: 'value', value: 0, label: 'No change' }] }),
        W({ type: 'line', size: 'full', title: 'Each stock vs its own average', subtitle: 'computed with GROUP_AVG, one panel per symbol', dimension: 'Date', bucket: 'quarter', facet: 'Symbol', measures: [M('calc_vs_avg', 'avg')] }),
        W({ type: 'box', title: 'Monthly change spread', dimension: 'Symbol', y: 'calc_change' }),
        W({ type: 'bar', title: 'Average monthly change by symbol', dimension: 'Symbol', measures: [M('calc_change', 'avg')], labels: true }),
      ]),
    ],
  },
}
