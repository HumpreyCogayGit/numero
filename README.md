# Numero

Drop in a CSV, JSON or Excel file and get an analytics dashboard. Everything runs in the browser; imported data stays on the device. The only network requests are the ones you ask for (importing or refreshing a URL), and the production build enforces that with a Content-Security-Policy.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
```

## Features

- **Import** CSV/TSV, JSON (nested, wrapped, column-oriented, NDJSON), XLSX/XLS/XLSB/ODS, and gzipped CSV or JSON. Files that are not tables (PDFs, images, archives, other binary data) are refused with a message naming what is supported. Several files can be dropped at once: files with the same columns can be combined into one dataset, others are imported one after another. An import preview lets you set the delimiter, encoding (detected: BOM → UTF-8 → Windows-1252), rows to skip, files without a header, date order, decimal comma, a row limit and per-column types. You can also **paste data** or **import from a URL** (Google Sheets links work); URL sources can refresh on an interval.
- **What Numero assumed**: the import preview lists everything detection decided that is worth a look before a dashboard is built on it — rows with too many or too few cells, `NA` / `None` / `-` markers and how they are read, a decimal comma (applied automatically in semicolon files), and data-quality checks (text in a number column, dates in the future, blanks, stray negatives, likely identifiers). Each check shows the rows concerned and offers a type change or a preparation step; importing anyway is always possible and the notes stay with the dataset under *Source*.
- **Type detection** keeps leading zeros (ZIP codes), treats identifier-named columns (id, phone, SKU, order number) as labels, and reads `15-Jan-24`, `Jan-24`, `Q1 2024`, `Mon, 15 Jan 2024`, compact `20240115` in date-named columns, `−5`, `100-`, `1,234.50 USD`, `1.2M` and a consistent unit suffix (`5 kg`).
- **Large files**: parsing, type detection, prep and computed columns run in a Web Worker. Only the open dataset is in memory, and the raw rows are stored once in IndexedDB, in chunks. CSV is read from the file in 4 MB pieces, so a row limit stops reading early (the first 1,000 rows of a 52 MB file read 4 MB) and a read in progress can be cancelled. Files over 200 MB are offered a row-limited first look. 1M rows / 52 MB imports in about 3 s and the page stays responsive.
- **Suggested dashboards**: KPIs (with "latest period" for snapshot measures), trends, rankings, distributions, correlations, box plots, heatmaps, **maps** (countries, US states, lat/lon points) and summary tables, packed into full rows.
- **Pages**: several dashboards per dataset.
- **Widget editor**: 15 chart types, grouping with date buckets, series splits, 10 aggregations plus **calculated measures**, top-N, stacking/100%/cumulative, comparison series (previous period / last year), **forecasts** with confidence bands, **anomaly** flags, reference lines, notes, shaded ranges, **small multiples**, drill-down settings, tooltip fields, number formatting, per-widget filters.
- **Interaction**: click a mark or table row to **cross-filter** the dashboard (shift adds values); double-click to **drill down** (dates year → day, or into a chosen column); open widgets fullscreen with zoom; click an axis to change the sort; keyboard move/resize (Alt+arrows).
- **Ask a question**: type "average price by symbol since 2005". A local parser (no AI service, nothing leaves the browser) shows how it read the question and a preview before adding the chart.
- **Formulas**: computed columns (row-level) and calculated measures (per chart cell, filter-aware). See [Formulas](#formulas).
- **Prepare**: replayable cleaning steps (dedupe, fill blanks, trim, case, find/replace, split, filter rows, remove/reorder columns, unpivot, join and append other datasets), each showing what it changed.
- **Insights**: automatic findings (correlations, dominant categories, outliers, skew, trends, seasonality, anomalies, gaps), correlation matrix, descriptive statistics, seasonality and forecast, segment comparison.
- **Pivot**: up to 3 row fields × 1 column field, any aggregation or calculated measure, % of row/column/total, heat shading, CSV export.
- **Share**: export/import dashboards as `.numero.json` (columns matched by name), PNG of a page, print / save as PDF, CSV and Excel data export. CSV exports carry a byte-order mark (so Excel reads accents correctly) and text cells that start with `=`, `+`, `-` or `@` are written as text.
- **Update data**: when a new month arrives, load it into the existing dashboard. Append or replace, with columns matched by name (or mapped by hand). When appending, rows whose ID is already loaded are overwritten with the new values and unchanged rows are skipped. It shows the date coverage of both files and keeps the last 5 versions, any of which can be restored. **Relative date filters** ("latest month", "last 12 months", "year to date") move forward with the data, so the dashboard doesn't need editing. Try it on Coffee Chain Sales with the bundled July 2025 file.
- **What changed** after an update: KPI moves, the biggest movers in the latest month, new category values and unusual values in the new rows. **Data checks** warn before loading about text in number columns, new blanks, negatives and future dates. In Chrome and Edge the file can be **linked**, so the next update is one click.
- **Reports**: **text widgets** with live values (`{latest month}`, `{Revenue}`, `{avg Unit Price}`) that follow filters, **conditional formatting** in tables (data bars, color scale, rules), **saved views** of page filters, and **Show rows** (or right-click a mark) to see and export the rows behind any number.
- **More analysis**: **waterfall**, **Pareto** and **funnel** charts, and **cohort** retention tables.
- **Command palette** (⌘K / Ctrl+K) to jump to datasets, tabs, pages and charts, or run actions.
- **Installable and offline**: a web app manifest and a service worker (production builds) cache the app, so it opens without a connection. An offline indicator explains that local datasets keep working while URL imports and refreshes wait. The interface uses the system font: nothing is fetched from another site.
- **URL sources**: downloads can be cancelled, time out after 30 s without an answer, ask before downloads announced above 100 MB and stop at 1 GB whatever the server says. A refresh that returns the same bytes stores nothing ("checked, no change"); one that drops a column asks before replacing; a failing source backs off and shows one status in the header.
- **Recovery**: a rendering error shows a recovery page (reload, return home without reopening the last dataset, copy or download diagnostics that contain counts and types only). A dataset that did not finish opening last time is not reopened automatically.
- **Storage**: dashboards are stored per dataset in IndexedDB, so two open tabs no longer overwrite each other and each tab picks up the other's saves. Removed datasets go to *Recently removed* on Home for 7 days with their dashboard and saved versions. *Storage* shows in plain words how the browser keeps the data and warns when space runs low; *Backup* writes the whole workspace (optionally with the data rows) to one file and restores it, all-or-nothing.
- **Browser history**: the open dataset, tab and page are in the address, so Back, Forward, reload and bookmarks work; Back closes an open dialog first.
- **Undo/redo** for every dashboard and data-model edit; removing a dataset can be undone for 7 days.
- **Formatting**: per column and per widget (decimals, prefix/suffix, short numbers, currency, two percent modes, date patterns). Light/dark/system theme, plus pattern fills for color-blind readers and print.

## Testing

```bash
npm test              # unit tests (Vitest): formula engine, parsing, inference, query engine, prep, measures, forecasting, questions, sharing, geo
npm run test:e2e      # browser tests (Playwright): import, every feature, 1M-row performance, phone layout, storage migration, axe accessibility audit
npm run check         # typecheck + unit tests + production build
```

Locally, the browser tests use your installed Chrome; CI (`.github/workflows/ci.yml`) installs Playwright's Chromium. To measure the production build, start `npx vite preview --port 4180` and run `BASE_URL=http://localhost:4180 npx playwright test large`. The offline test (`pwa.spec.ts`) also needs the production preview, since the service worker isn't part of the dev server; CI runs it after the main suite.

## Formulas

Formulas are parsed and interpreted by a small engine (`src/lib/formula.ts`) — never `eval` — so user data and formulas can't run code.

```
[Revenue] - [Cost]                               columns in [brackets]; bare names work without spaces
IF([Profit] > 0, "Profit", "Loss")              functions are case-insensitive
[Sales] / SUM([Sales]) * 100                     one-argument SUM/AVG/MIN/MAX/MEDIAN/COUNT/COUNTD/STDEV aggregate the column
[Sales] / GROUP_SUM([Sales], [Region]) * 100     GROUP_* aggregates per group
PCT_CHANGE([Price], [Date], [Symbol])            window functions take optional order-by and partition-by columns
DATEDIFF([Order Date], [Ship Date], "day")
BUCKET([Age], 18, 35, 60)                        → "< 18", "18–35", "35–60", "60+"
```

| Group | Functions |
|---|---|
| Operators | `+ - * / % ^`, `&` (join text), `= != <> < > <= >=`, `AND OR NOT` |
| Logic | IF, IFS, SWITCH, COALESCE, ISBLANK, ISNUMBER, NULLIF, AND, OR, NOT, IN, BETWEEN |
| Math | ABS, ROUND, CEILING, FLOOR, TRUNC, SQRT, POWER, EXP, LN, LOG, MOD, SIGN, CLAMP, DIVIDE, PI |
| Text | CONCAT, UPPER, LOWER, PROPER, TRIM, LEN, LEFT, RIGHT, MID, REPLACE, CONTAINS, STARTSWITH, ENDSWITH, FIND, SPLIT, LPAD, REGEXMATCH, REGEXEXTRACT, TEXT, NUMBER, FORMAT |
| Date | YEAR, QUARTER, MONTH, WEEK, DAY, WEEKDAY, HOUR, MINUTE, MONTHNAME, DAYNAME, DATE, TODATE, TODAY, NOW, DATEDIFF, DATEADD, DATETRUNC, EOMONTH, DATEFORMAT |
| Aggregate | SUM, AVG, MIN, MAX, MEDIAN, COUNT, COUNTD, STDEV, PERCENTILE, GROUP_SUM, GROUP_AVG, GROUP_MIN, GROUP_MAX, GROUP_MEDIAN, GROUP_COUNT |
| Window | ROWNUM, RANK, PERCENT_RANK, NTILE, ZSCORE, NORMALIZE, RUNNING_SUM, RUNNING_AVG, MOVING_AVG, LAG, LEAD, PCT_CHANGE |
| Binning | BIN, BUCKET |

**Calculated measures** (*New measure* button) are aggregate formulas evaluated for every bar, slice and cell, so ratios stay right under any grouping or filter: `SUM([Profit]) / SUM([Revenue])`, `SUM([Sales]) / SUM_ALL([Sales])` (share of the filtered total), `SUM(IF([Returned], [Revenue], 0)) / COUNTROWS()`. Every column must sit inside an aggregate.

Semantics: blanks propagate through arithmetic; dividing by zero gives blank; `date ± number` shifts by days and `date − date` gives days; text compared with a date is read as a date. A computed column can use columns defined before it. Renaming a column rewrites `[Old Name]` references in formulas. Window functions use file order unless an order-by column is given.

## Project layout

```
src/engine/worker.ts     data engine (Web Worker): parse, build, store
src/engine/client.ts     promise-based calls into the worker
src/lib/model.ts         rebuild pipeline: raw → prep → types → names/formats → computed columns
src/lib/prep.ts          data-preparation steps
src/lib/measure.ts       calculated measures
src/lib/forecast.ts      Holt-Winters forecasting, anomalies, seasonality
src/lib/ask.ts           plain-English questions → widgets
src/lib/geo.ts           country / state / lat-lon detection
src/lib/share.ts         dashboard export/import, data export
src/lib/update.ts        Update data: column matching, append/replace merge, data checks
src/lib/changes.ts       "What changed" report after an update
src/lib/linked.ts        linked source files (File System Access API)
src/lib/text.ts          text widgets: markdown subset + live placeholders
src/lib/condfmt.ts       table conditional formatting
src/lib/cohort.ts        cohort retention tables
src/lib/db.ts            IndexedDB (meta, sources, chunks, dashboards), with migrations
src/lib/quality.ts       data-quality review of a file before import
src/lib/fetchFile.ts     cancellable, time-limited, size-capped downloads
src/lib/refresh.ts       refresh status and back-off for URL sources
src/lib/durability.ts    storage persistence and quota status
src/lib/backup.ts        workspace backup format, validation, restore planning
src/lib/trash.ts         removing datasets: when to ask, how long they can be restored
src/lib/provenance.ts    where a dataset came from and how fresh it is
src/lib/diagnostics.ts   error log and value-free diagnostics
src/lib/route.ts         dataset / tab / page ↔ URL hash
src/lib/csv.ts           CSV export (byte-order mark, formula cells)
src/routeSync.ts         keeps browser history in step with the view
src/lib/parse.ts         file → raw rows
src/lib/infer.ts         type inference + coercion
src/lib/formula.ts       formula tokenizer, parser, evaluator, function library
src/lib/computed.ts      applies formulas to a dataset, result typing
src/lib/aggregate.ts     query engine (filters, grouping, aggregation, KPI, scatter, pivot)
src/lib/suggest.ts       auto-dashboard + suggestion gallery
src/lib/profile.ts       column profiles + automatic insights
src/lib/chartOptions.ts  widget → ECharts option
src/lib/palette.ts       chart color tokens (CVD-validated categorical order — do not reorder)
src/store.ts             zustand state
src/components/          UI
public/samples/          sample datasets (updates/: next-period files for Update data)
public/manifest.webmanifest, public/icons/, pwa/sw.template.js   installable app; sw.js is generated at build time
public/geo/              world and US-state boundaries (Natural Earth via world-atlas / us-atlas, ISC)
tests/unit, tests/e2e    Vitest and Playwright suites
```

## Sample data

Each sample opens with a **showcase**: extra dashboard pages, prep steps, computed columns and calculated measures that demonstrate the features (defined in `src/lib/presets.ts`). The suggested "Overview" page is kept too.

| File | Showcases | Source | License |
|---|---|---|---|
| coffee-chain-sales.csv | Cleaning messy data, calculated measures, targets, forecast, drill-down, heatmap, US map, text summary, conditional formatting, waterfall, Pareto, Update data (July file) | Synthetic — `scripts/make-coffee-sample.mjs` | CC0-1.0 |
| us-flights-2001.json | Join with US Airports, computed columns, on-time measure, anomalies | vega-datasets `flights-10k.json` | BSD-3-Clause |
| co2-mauna-loa.csv | Seasonal forecast, `LAG`, reference lines | vega-datasets `co2-concentration.csv` (NOAA) | BSD-3-Clause |
| us-employment-by-sector.csv | Unpivot wide data, small multiples, annotations | vega-datasets `us-employment.csv` (BLS) | BSD-3-Clause |
| online-store-events.csv | Funnel, cohort retention, Pareto, waterfall, text summary | Synthetic — `scripts/make-store-sample.mjs` | CC0-1.0 |
| seattle-vs-new-york-weather.csv | Small multiples, cross-filtering | vega-datasets `weather.csv` | BSD-3-Clause |
| seattle-weather.csv | Forecast, anomalies, year-over-year | vega-datasets | BSD-3-Clause |
| gapminder.json | World map, latest-period KPIs | vega-datasets | BSD-3-Clause |
| us-airports.csv | Point and state maps, drill-down | vega-datasets `airports.csv` | BSD-3-Clause |
| movies.json | Prep filter for bad dates, ROI measure, top-N table | vega-datasets | BSD-3-Clause |
| cars.json | Regression, small multiples | vega-datasets | BSD-3-Clause |
| penguins.csv | Faceted scatter, binning | [palmerpenguins](https://github.com/allisonhorst/palmerpenguins) | CC0-1.0 |
| us-unemployment-by-industry.xlsx | Excel sheets, recession annotation, forecast | vega-datasets, converted | BSD-3-Clause |
| tech-stock-prices.xls | Per-symbol `PCT_CHANGE`, `GROUP_AVG`, anomalies | vega-datasets `stocks.csv`, converted to BIFF8 | BSD-3-Clause |

Regenerate the online store sample with `node scripts/make-store-sample.mjs` and the app icons with `node scripts/make-icons.mjs`. Regenerate the coffee sample with `node scripts/make-coffee-sample.mjs` (seeded, so the output is identical). It also writes `public/samples/updates/coffee-chain-sales-2025-07.csv`, the next month's orders, used by *Update data → Try it*.

`movies.json` contains release dates past 2010 (up to 2046) that come from the upstream source data; its showcase adds a prep step that filters them out.
