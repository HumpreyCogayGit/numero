# Numero — Improvement Plan

Updated: 2026-11-15

## Purpose

This document turns the feature review into a prioritized improvement roadmap. It was implemented on 2026-11-15; the status table below records what was built and where it differs from the text. Numero already covers the core local-first BI workflow well, so the next work should strengthen reliability, data trust, recovery, and durability before adding more chart types or infrastructure-heavy features.

## Implementation status (2026-11-15)

The roadmap below has been implemented. Verified after the work: TypeScript compiles; 307 unit tests pass (143 before); the production build succeeds; 73 browser tests pass against the development server (46 before; the production-only offline test is skipped there) and the offline, smoke and reliability suites pass against a production preview. The 1,000,000-row run measured import commit 3.1 s, worst main-thread lag 4 ms, filter round trip 1.09 s, click response 0.28 s, Insights tab 1.8 s, and a 1,000-row preview of the same file in 0.14 s reading 4 MB of 52 MB.

| Item | Status | Where | Notes and deviations |
|---|---|---|---|
| R1 Type detection | Done | `src/lib/infer.ts`, `tests/unit/infer.test.ts` | One addition to the plan: a marker the same file also uses under a number or date (R and pandas write `NA` everywhere) is treated as that file's "missing" marker in text columns too. Without it the Penguins sample changed. The preview says how each marker is read and has a three-way setting. |
| R2 Default aggregation | Done | `src/lib/suggest.ts`, `tests/unit/default-agg.test.ts` | KPI titles already named the aggregate ("Sum of…", "Average of…"). The data fallback sums whole numbers only when they reach toward zero; whole numbers in a narrow band are levels and stay averaged (otherwise the Employment sample changed). One reviewed sample change: US Flights now sums `distance`. `tests/fixtures/sample-baseline.json` guards the rest. |
| R3 Unreadable files | Done | `src/lib/parse.ts`, `src/lib/multi.ts` | Multi-file drops offer to combine delimited files with the same columns, otherwise queue and say so. |
| R4 Bounded memory, cancel | Done | `src/lib/parse.ts`, worker `cancel` | CSV only: JSON and workbooks must be read whole and are refused above 500 MB with a message. Threshold for the row-limit offer: 200 MB. |
| R5 Safer deletion | Done | worker `delete`/`undelete`/`purge`, `src/lib/trash.ts`, Home | Retention is 7 days (was 60 seconds in memory) and survives reloads; the trash keeps its storage until then or until erased by hand. |
| Local durability | Done | `src/lib/durability.ts`, Storage dialog | The workspace-backup format the item asks to define is the one built under "Workspace backup". |
| Crash recovery | Done | `src/components/ErrorBoundary.tsx`, `src/lib/diagnostics.ts` | |
| Abortable URL imports | Done | `src/lib/fetchFile.ts` | Timeout 30 s per stall, confirm above 100 MB, hard stop at 1 GB. Timeout and large-size confirmation are covered by unit tests, not browser tests. |
| First-import checks | Done | `src/lib/quality.ts`, import preview | "Inspect rows" shows row numbers and the values as written, not a row browser. |
| Privacy and offline | Done | `index.html`, `src/index.css`, `pwa/sw.template.js` | System font stack rather than self-hosted Inter; the visual comparison the plan asks for still needs a human eye. |
| Provenance and confidence | Done | `src/lib/provenance.ts`, `src/lib/profile.ts` | |
| Workspace backup | Done | `src/lib/backup.ts`, `src/components/BackupDialog.tsx` | Format version 1, so there is no older version to migrate yet; the migration hook and its tests (current accepted, newer refused) are in place. No encryption, as the plan defers it. |
| R6 Two tabs | Done | `src/lib/db.ts` (v4), `src/store.ts` | |
| R7 URL refresh | Done | worker `replaceSource`, `src/lib/refresh.ts` | |
| R8 Insights | Done | `src/lib/profile.ts`, `src/lib/text.ts` | Measured at 1M rows: sampled above 200,000 rows rather than moved to the worker. |
| R9 Exports | Done | `src/lib/csv.ts` | Excel export: text cells are already stored as text with no formula, which a test now asserts. No apostrophe is added there, because in an .xlsx file it would appear as a literal character. |
| R10 History | Done | `src/lib/route.ts`, `src/routeSync.ts` | |
| R11 Formats | Done | `src/lib/parse.ts` | `.ods`, `.xlsb`, gzipped CSV and JSON. Parquet not added, as planned. |
| R12 CSP | Done | `vite.config.ts` | As a meta tag in the production build only (the dev server needs inline scripts). `connect-src` allows any http(s) address, since URL imports can point anywhere. |
| N9b, N10b, F20 | Not started | | Decision-gated; nothing here changes those decisions. No telemetry was added. |

## Verified baseline

- TypeScript compilation and all 143 unit tests pass (re-run during the 2026-11-15 code review). The production build and the browser suite were not re-run in that review; the figures below are from the earlier run the same day.
- The development-server browser suite passes 46 tests; the one production-only offline test is skipped there by design and is run against a production preview in CI.
- Covered browser behavior includes imports, URL errors, data preparation, calculations, chart interactions, updates and version restore, sharing, accessibility, mobile layout, and large-file performance.
- The latest local 1,000,000-row browser run measured:
  - import commit: 2.325 s;
  - worst main-thread lag during parsing: 8 ms;
  - filter round trip: 1.136 s;
  - immediate click response measured by the test: 284 ms.
- Performance numbers vary with hardware, browser state, build mode, dashboard shape, and measurement definition. The existing notes' approximately 0.75 s refresh and 40 ms click figures remain useful historical observations, but should not be presented as guarantees. The automated acceptance threshold is currently less than 3 s for the tested filter round trip and less than 1.5 s worst main-thread lag.

## Product principles

1. Preserve the local-first model: imported data remains on the device unless the user explicitly exports it or requests a remote source.
2. Prefer visible recovery and diagnostics over silent failure.
3. Warn about questionable data before presenting confident-looking analysis.
4. Protect work stored in the browser and make backup status understandable.
5. Require evidence of user need before undertaking query-engine, localization, or server-platform rewrites.

## Code review findings (2026-11-15)

A read-through of the import, inference, suggestion, insight, storage, and state code, with the parsing and inference claims checked by running the functions on small inputs. Each item below was confirmed in the code or by a probe unless it says otherwise. The four P1 items and two P2 items that were already in this plan (durability, crash recovery, URL imports, first-import checks, privacy/offline, provenance) are still open: there is no error boundary, no `storage.persist()` call, no `AbortController`, and Google Fonts is still loaded from `index.html`.

The common thread: for a tool whose promise is "drop a file, get a dashboard", the largest risk is a file that is read wrongly without the user being told. Those items come first.

| # | Area | Finding | Priority |
|---|---|---|---|
| R1 | Type detection | Values and formats that are silently misread (see P1 below) | P1 |
| R2 | Suggested dashboard | Default sum/average is chosen by substring match on the column name | P1 |
| R3 | Import | Unsupported files are parsed as CSV; ragged rows lose cells silently | P1 |
| R4 | Import | The whole file is read into memory before any limit or warning applies | P1 |
| R5 | Datasets | One-click delete with an undo that is easy to lose | P1 |
| R6 | Storage | Two open tabs overwrite each other's dashboards | P2 |
| R7 | URL refresh | No column check, a saved version on every refresh, repeated error toasts | P2 |
| R8 | Insights | Trend insights use the first numeric column and always average | P2 |
| R9 | Export | CSV has no BOM and does not neutralize formula cells | P2 |
| R10 | Navigation | No browser history: Back leaves the app | P2 |
| R11 | Formats | `.ods`, `.xlsb`, and gzipped CSV are cheap to add | P3 |
| R12 | Security | No Content-Security-Policy | P3 |

## Priority roadmap

### P1 — Type detection that does not misread common data (R1)

**Problem:** Several ordinary inputs are converted to something else on import, with no warning. Results of running `src/lib/infer.ts` on sample values:

| Input | What happens now | Why it matters |
|---|---|---|
| `NA`, `None`, `-` as category values | Treated as blank (`isBlank`) | A region coded `NA` (North America, Namibia) or a "Discount type: None" row disappears from every chart. |
| ZIP or postal codes such as `02134` | Number `2134` | The leading zero is lost and the column is offered as a measure. |
| An `order_id` that repeats across line items | Number, default aggregate average | The ID rule needs more than 90% unique values, so a repeating ID becomes a headline KPI ("Avg Order Id"). Phone numbers are also read as numbers. |
| `12,5` in a semicolon-delimited file | Category | The delimiter is detected as `;`, but the decimal separator always defaults to dot, so European price columns become text until the user finds the setting. |
| `15-Jan-24`, `15-Jan-2024`, `Jan-24`, `20240115`, `Q1 2024`, `Mon, 15 Jan 2024` | Not recognized as dates | `15-Jan-24` is Excel's default `d-mmm-yy` export. The column becomes a category and no time charts are suggested. |
| `−5` (Unicode minus), `100-`, `1,234.50 USD`, `5 kg`, `1.2M` | Not a number | One such style across a column turns it into text. |

**Scope:**

- Make blank tokens conservative: treat `NA`, `None`, and `-` as blank only when the column is otherwise numeric or date; keep them as values in category columns. Show the tokens treated as blank in the import preview and let the user change them.
- Keep digit strings with leading zeros as text, and treat columns named like identifiers (zip, postal, phone, id, code, number, sku) as categories regardless of the uniqueness share.
- Detect the decimal separator per file: when a column fails as dot-decimal but parses as comma-decimal, propose comma, and preselect it when the delimiter is `;`.
- Extend `parseDate` to `d-mmm-yy(yy)`, `mmm-yy`, compact `yyyymmdd` (only for columns named like dates), quarters, and weekday-prefixed dates.
- Extend `parseNumber` to Unicode minus, trailing minus, trailing currency codes, and a single consistent unit suffix.
- In the preview, mark each column whose detection was not unanimous with the share of values that did not fit.

**Acceptance criteria:**

- Each row of the table above has a unit test with the corrected result.
- No existing sample changes its detected types, or each change is reviewed and intended.
- Detection never changes stored source values; the raw rows stay as imported.

### P1 — Sensible default aggregation in suggested dashboards (R2)

**Problem:** `defaultAgg` in `src/lib/suggest.ts` tests the column key against `ADDITIVE_RE` and `AVG_RE` without word boundaries. `count` matches inside "dis**count**" and "**count**ry"; `per` inside "o**per**ating" and "ex**per**ience"; `age` inside "us**age**", "mile**age**", and "post**age**". Columns that match neither list are averaged unless they carry a currency symbol, so plain numeric `tax`, `fee`, `shipping`, `tip`, `hours`, and `salary` columns all default to average. The first KPI row a new user sees can therefore show an average where a total is expected, or the reverse.

**Scope:**

- Match on whole words after splitting the key on separators and camel case.
- Add the common additive names that are missing (tax, fee, shipping, tip, hours, minutes, duration, distance, discount amount, salary, payroll).
- Fall back on the data when the name gives no signal: non-negative integers with many distinct values lean toward sum; values bounded in 0–1 or 0–100 lean toward average.
- Show the chosen aggregate in the KPI title in every case ("Total Tax", "Avg Rating") so a wrong guess is visible and one click from being fixed.

**Acceptance criteria:**

- Unit tests cover the false matches above and the new names.
- The bundled samples keep their current suggested KPIs, or each change is reviewed.

### P1 — Reject or explain files that cannot be read (R3)

**Problem:**

- `formatOf` in `src/lib/parse.ts` returns `csv` for every unknown extension, and the drop handler in `src/App.tsx` accepts any file. A dropped PDF imports as a one-column dataset whose header is `%PDF-1.7`.
- A row with more cells than the header loses the extra cells; a short row is padded with blanks. Neither is reported (`a,b` / `1,2,3,4` keeps only `1,2`).
- A malformed `.json` or `.ndjson` file shows the raw engine message, for example "Expected ',' or '}' after property value in JSON at position 6".
- Dropping several files imports the first and ignores the rest without saying so.

**Scope:**

- Check the extension and sniff the first bytes (PDF, ZIP, image, and other binary signatures; a high share of control characters). Refuse with a message that names the supported formats.
- Count rows whose cell count differs from the header and show the count, with examples, in the import preview.
- Rewrite JSON errors in plain language with the line number, and for NDJSON name the first bad line.
- For a multi-file drop, either queue the files or state that only the first was imported. If the files share headers, offer to combine them into one dataset.

**Acceptance criteria:**

- A binary file never reaches the preview as a table.
- Ragged-row counts appear in the preview and never change which rows are imported.
- Tests cover binary rejection, ragged rows, malformed JSON, malformed NDJSON, and a multi-file drop.

### P1 — Bounded memory and cancellation for local imports (R4)

**Problem:** `parseFile` calls `file.arrayBuffer()` and decodes the whole file to one string before parsing. The row limit is applied afterwards, so "First 1,000 rows" still loads the full file, and the over-a-million-rows warning appears only once everything is in memory. A file near or above the browser's maximum string length fails inside the worker with no specific message. The progress overlay has no Cancel button. `cancelImport` in `src/store.ts` clears the dialog but the worker keeps the parsed rows in `pendingPreview` until the next import.

**Scope:**

- Before reading, compare `file.size` with a documented threshold and offer a row-limited import first.
- Parse CSV from the `File` in chunks so a row limit stops reading early and memory stays proportional to the rows kept.
- Add Cancel to the progress overlay for local parsing, and a worker message that drops `pendingPreview` and `pendingUpdate` on cancel.
- Give worker out-of-memory and oversize failures a specific message that suggests a row limit.

**Acceptance criteria:**

- Importing the first 1,000 rows of a very large CSV does not read the whole file.
- Cancel returns the interface to its earlier state and releases the parsed rows.
- This shares its cancellation design with the URL-import item below.

### P1 — Safer dataset deletion (R5)

**Problem:** The trash buttons in the sidebar, the Home list, and the Storage dialog delete a dataset, its dashboard, and all its saved versions on one click with no confirmation. Undo is offered only in a toast that lasts nine seconds, and the app shows one toast at a time, so any later message replaces it. The worker keeps the deleted rows for 60 seconds, but nothing in the interface can reach them once the toast is gone. Saved versions are not restored by undo (K13). If the page reloads inside the 60-second window, the timer that removes the dashboard never runs and the dashboard entry is left in `localStorage`.

**Scope:**

- Ask for confirmation when the dataset has edits worth keeping: a customized dashboard, prep steps, formulas, or saved versions.
- Keep Undo reachable for the whole retention window, for example a "Recently removed" row on Home, and let toasts queue so an action toast is not replaced.
- Keep saved versions with the trashed dataset so undo restores them.
- On startup, remove dashboards whose dataset no longer exists.

**Acceptance criteria:**

- A deleted dataset can be restored at any point in the retention window, with its versions.
- No orphaned dashboard entries remain after a reload.

### P1 — Local data durability

**Problem:** IndexedDB data may be evicted under browser storage pressure, and browser storage is confined to one browser profile.

**Scope:**

- Check `navigator.storage.persisted()` where supported.
- Request `navigator.storage.persist()` after a meaningful user action, preferably after the first successful import rather than on first page load.
- Show persistent/browser-managed status, estimated usage, quota, and a clear unsupported-browser state in Storage management.
- Warn when usage approaches quota without blocking ordinary work.
- Keep `.numero.json` export guidance and source-file retention guidance visible; persistence is not a backup.
- Define a later workspace-backup format that can carry dashboards, formulas, preparation steps, settings, and—only with an explicit size warning—source rows.

**Acceptance criteria:**

- Permission is not requested before user intent is established.
- Grant, denial, unsupported API, and API failure all leave the app usable.
- Storage status is understandable without browser-storage terminology.
- Automated tests cover each API result and quota-warning state.

### P1 — Crash recovery and safe startup

**Problem:** An unexpected React/rendering error can blank the interface. Reopening the last dataset automatically may reproduce a dataset-specific startup failure.

**Scope:**

- Add a top-level React error boundary.
- Offer Reload, Return home without reopening the last dataset, and diagnostic-copy/download actions.
- State explicitly that recovery does not delete stored datasets.
- Handle global rejected promises where they otherwise have no user-facing owner.
- Give map/resource loading an explicit failure state instead of allowing an unhandled rejection.
- Keep diagnostics free of imported row values by default.

**Acceptance criteria:**

- A deliberately throwing child renders recovery UI rather than a blank page.
- Safe startup clears or bypasses only the last-open pointer, not stored data.
- Resource-load failures identify the affected feature and preserve the rest of the dashboard.
- Error-boundary, safe-start, and map-load failure paths have automated coverage.

### P1 — Abortable and bounded URL imports

**Problem:** Remote fetches have no timeout, cancellation, or size safeguard. Closing UI does not necessarily stop network or worker activity.

**Scope:**

- Use `AbortController` for remote fetches and connect it to visible cancellation.
- Apply a documented timeout with an actionable retry message.
- Distinguish cancellation, timeout, HTTP response, connectivity, and likely CORS failures.
- Read `Content-Length` when available and ask for confirmation before unexpectedly large downloads.
- Show byte progress when the browser exposes a stream and total size; otherwise show indeterminate progress.
- Extend cancellation to parsing/commit work where safely possible, with token-based protection against stale operation results.
- Ensure scheduled URL refreshes cannot overlap.

**Acceptance criteria:**

- Cancel stops the request and prevents a late preview from appearing.
- Timeout and HTTP failures produce different guidance.
- Missing or dishonest `Content-Length` does not bypass any hard memory/row safeguards.
- Tests cover cancellation, timeout, large-size confirmation, stale completion, and successful retry.

### P1 — Data-quality checks on first import

**Problem:** Update-time checks warn about future dates, text in numeric columns, blanks, and negatives, but first import can build a polished dashboard before showing equivalent concerns.

**Scope:**

- Reuse and generalize update-check logic where semantics match.
- Run checks after parsing and type inference, before commit.
- Initially cover invalid/future dates, mixed numeric values, missing values, suspicious negatives, and likely identifiers or near-unique dimensions.
- Show severity, count, examples, and affected rows without treating every domain-valid negative or future date as an error.
- Let users change a type, add a preparation step, inspect rows, or import anyway.
- Record acknowledged warnings so reopening a dataset does not repeatedly imply they are new.

**Acceptance criteria:**

- The first-import preview exposes the same applicable type/date/blanks checks as Update data.
- Warnings never silently alter source values.
- Large-file checks are sampled or streamed without duplicating all rows or blocking the main thread.
- Clean, warning, override, and import-anyway paths have unit and browser coverage.

### P2 — Privacy and offline clarity

**Problem:** The product is local-first, but Google-hosted fonts create third-party requests, and offline/refresh state is not prominent.

**Scope:**

- Self-host the required Inter font subsets or adopt a system-font stack.
- Remove Google Fonts requests and service-worker exceptions after visual comparison.
- Add a small offline/back-online indicator.
- Explain that local datasets remain usable offline while URL imports and refreshes wait for connectivity.
- Distinguish an offline postponement from a successful refresh with no data change.
- Review all privacy text so “data never leaves” remains accurate for explicit URL downloads, exports, and any future optional services.

**Acceptance criteria:**

- A fresh production load makes no font request to a third-party origin.
- Offline state does not appear as a generic URL/CORS failure.
- Existing production-preview offline tests continue to pass, with added status assertions.

### P2 — Provenance, freshness, and insight confidence

**Problem:** Source and analytical context exist but should be more visible when users revisit or export a report.

**Scope:**

- Show source type/name, import time, last successful refresh, refresh policy, link state, row limit/truncation, row-count change, and preparation-step count.
- For generated insights, expose rows used, active filters, missing-value treatment, comparison period, and whether a result is descriptive or predictive.
- For forecasts and anomalies, expose method-level explanations and confidence/threshold context without claiming causal conclusions.
- Include suitable provenance in shared dashboard metadata while avoiding local filesystem paths and sensitive row examples.

**Acceptance criteria:**

- Users can determine when and from where a dataset was loaded without entering an editor.
- Truncated datasets are clearly marked wherever conclusions are presented.
- Insight explanations update with filters and contain no unsupported certainty language.

### P2 — Workspace backup and restore

**Problem:** Per-dashboard exchange exists, but local browser storage needs a coherent disaster-recovery path.

**Scope:**

- Specify a versioned workspace archive with a manifest and integrity checks.
- Let users select metadata/dashboard-only or data-inclusive backup.
- Estimate archive size before creation and report skipped/failed datasets.
- Validate before mutation, detect name/ID conflicts, and offer merge or isolated restore behavior.
- Consider optional client-side passphrase encryption only after the unencrypted format and recovery UX are stable.

**Acceptance criteria:**

- Restore is transactional: invalid archives do not leave partial state.
- Older supported archive versions migrate through explicit tests.
- Export/import round trips preserve dashboards, formulas, prep steps, formats, and source metadata.

### P2 — Dashboards that survive two open tabs (R6)

**Problem:** All dashboards live in one `localStorage` key (`numero:dashboards`), read once at startup and rewritten in full on every edit (`saveDashboards` in `src/lib/db.ts`). Nothing listens for changes from another tab. With the installed app and a browser tab both open, an edit in one writes its older copy of every dashboard over the other's work. The single key also shares the roughly 5 MB `localStorage` limit across all datasets, and a failed save leaves the screen ahead of what is stored.

**Scope:**

- Move dashboards into IndexedDB, one record per dataset, with a migration from the current key.
- Reload a dashboard when another tab changes it (`BroadcastChannel` or the `storage` event), and warn when the same dataset is being edited in two tabs.
- When a save fails, say that the latest edits are not stored and offer the `.numero.json` export.

**Acceptance criteria:**

- Edits made to different datasets in two tabs are both kept.
- The migration is covered by the storage-migration browser test.

### P2 — URL refresh that checks before replacing (R7)

**Problem:** `replaceSource` in `src/engine/worker.ts` swaps in whatever the URL returns. It does not run the column comparison that Update data uses, so a renamed or removed column breaks widgets with no warning beforehand. Every refresh saves a full version and adds an undo step even when the content is identical, which fills the version list (K11). A failing source shows the same error toast on every interval.

**Scope:**

- Hash the downloaded bytes and skip the swap when nothing changed, showing "checked, no change" with the time.
- Run `compareHeaders` and the data checks first; when columns are missing or renamed, pause the refresh and ask.
- After repeated failures, back off and show one persistent status in the header in place of repeated toasts.

**Acceptance criteria:**

- An unchanged source creates no version and no undo step.
- A source that drops a column in use prompts before any widget breaks.

### P2 — Insights that match the dashboard (R8)

**Problem:** In `findInsights` (`src/lib/profile.ts`), the trend, peak, seasonality, and anomaly insights use `nums[0]`, the first numeric column in file order, where the dashboard uses the ranked measures from `suggest.ts`. They also average the measure per period even when it is additive, so the Insights tab can report "Average Revenue rose" beside a dashboard that shows total revenue. Correlation insights include near-identical pairs (`r` close to 1), which the dashboard's scatter suggestion already filters out. The peak insight is always produced, whatever the data. Insights are computed on the main thread over all rows; the effect at one million rows was not measured in this review. Insights appear only in their own tab, although they are half of the product's pitch.

**Scope:**

- Share measure ranking and default aggregation with `suggest.ts`.
- Drop near-duplicate correlations and emit the peak insight only when it stands out from the rest of the series.
- Put the top few insights on the suggested dashboard as a text widget, with a link to the Insights tab.
- Measure the Insights tab at one million rows; move the work to the worker or sample if it blocks.

**Acceptance criteria:**

- For each bundled sample, the insight text and the suggested dashboard name the same measure with the same aggregate.

### P2 — Exports that open correctly in Excel (R9)

**Problem:** `toCsv` and `downloadText` in `src/lib/hooks.ts` write UTF-8 without a byte-order mark, so Excel shows accented and non-Latin text as garbage when the file is double-clicked. Cells that begin with `=`, `+`, `-`, or `@` are written as they are; a text value from an untrusted source file would run as a formula when the export is opened.

**Scope:**

- Prefix CSV exports with a BOM.
- Prefix text cells that start with a formula character with an apostrophe, leaving real numbers untouched. Apply the same rule to the Excel export for text cells.

**Acceptance criteria:**

- A round trip of non-ASCII text through CSV export opens correctly in Excel.
- A text cell containing `=1+1` is exported as text.

### P2 — Browser history and Back (R10)

**Problem:** The app keeps the open dataset, tab, and page in memory only. There is no use of the History API, so the browser's Back button, and the system Back gesture in the installed app on a phone, leave Numero. A dataset or page cannot be bookmarked.

**Scope:**

- Reflect dataset, tab, and page in the URL hash and push history entries on navigation, not on edits.
- Make Back close an open dialog or editor before leaving a view.

**Acceptance criteria:**

- Back from a dataset returns Home; reloading keeps the same dataset, tab, and page.

### P3 — Smaller items

- **R11 More formats.** SheetJS is already bundled and reads `.ods` and `.xlsb`; adding them needs entries in `ACCEPT` and `formatOf`. Gzipped CSV and JSON can be read with the browser's `DecompressionStream` and no new dependency. Parquet would need a new dependency and should wait for user demand.
- **R12 Content-Security-Policy.** Add a policy that limits scripts to the app's own origin and connections to user-requested URLs. It also makes the "nothing leaves the device" promise enforceable once the fonts are self-hosted.

## Decision-gated work

### N9b — Faster dashboards on 1M+ rows

**Decision: do not schedule now.**

The current worker architecture keeps the page responsive and the verified million-row filter round trip remains below the existing 3-second acceptance threshold. Further material improvement is likely to require query-engine changes such as streaming/incremental aggregation, shared scans across widgets, indexed categorical filtering, or cached intermediate groups. That work increases memory, invalidation, numerical-consistency, and maintenance risk.

Reconsider N9b only if at least one trigger is met:

- product evidence shows 1M+ rows are normal rather than exceptional;
- p95 refresh on representative production hardware exceeds 2 s for common dashboards;
- target users require several-million-row local analysis;
- profiling shows one reusable engine bottleneck rather than chart rendering or an unusually expensive widget.

Before implementation, collect anonymized opt-in telemetry or structured user benchmark reports for row count, column count, widget count/type, filter latency, browser, and hardware class. Never collect row values. Establish representative benchmark fixtures and compare production builds, not only the development server.

If triggered, start with profiling and low-risk shared-scan/caching experiments behind benchmarks. Do not commit to a streaming-engine rewrite until the experiments demonstrate a meaningful p95 improvement without unacceptable memory growth or semantic regressions.

### N10b — Translate the interface and Ask bar

**Decision: defer pending target languages and product need.**

Interface localization and Ask localization are separate projects. Extracting interface strings, plural rules, number/date formats, accessibility labels, layout direction, and test selectors is substantial but straightforward. The Ask bar is language-specific product logic: synonyms, word order, date phrases, aggregation grammar, ambiguity messages, and examples must be designed and tested separately for every language.

Required decision inputs:

- ranked target languages and expected user demand;
- whether right-to-left languages are in scope;
- whether translated UI with an English-only Ask bar is acceptable for an initial release;
- translation ownership and review process;
- locale rules for CSV parsing defaults, dates, decimals, currencies, and exported files.

Recommended sequence once languages are chosen:

1. Introduce locale infrastructure and extract UI strings without changing English behavior.
2. Localize formatting, accessibility text, validation, samples, and documentation.
3. Ship one reviewed UI locale behind a setting and add screenshot/layout/a11y coverage.
4. Treat each Ask grammar as a separate, versioned parser module with language-native fixtures.
5. Add further languages only after the first locale's maintenance process is proven.

Do not use automatic translation at runtime for analytical grammar or critical data warnings.

### F20 — Collaboration, cloud sync, share links, and comments

**Decision: keep deferred.**

Collaboration requires accounts, authorization, server storage, synchronization/conflict semantics, tenancy isolation, deletion/export controls, abuse controls, operations, and a materially different privacy model. Building it would contradict the current promise that imported data remains on-device unless that promise is deliberately changed.

The existing local-first alternatives remain appropriate:

- `.numero.json` dashboard exchange;
- PNG and print/PDF output;
- CSV/Excel export;
- the proposed workspace backup/restore flow.

Reconsider F20 only with an explicit product decision covering:

- whether source rows, aggregates, or dashboard definitions may leave the device;
- account and hosting model;
- end-to-end encryption expectations and key recovery;
- regional data residency, retention, deletion, audit, and compliance requirements;
- offline edits and conflict resolution;
- pricing and operational ownership.

A possible lower-risk precursor is a user-created encrypted export file that users share through their own channel. It should not be described as collaboration and should not introduce a Numero server.

## Suggested delivery sequence

Correctness of what the first dashboard shows comes first, then protection of stored work, then the rest.

1. Type detection fixes (R1) and default aggregation (R2). Both are contained changes in `infer.ts` and `suggest.ts` with unit-test coverage.
2. Reject unreadable files and report ragged rows (R3).
3. First-import data-quality checks. Build these on R1 and R3 so the preview has one place for "what Numero assumed".
4. Safer dataset deletion (R5).
5. Crash boundary and safe startup.
6. Persistent-storage status and request flow.
7. Cancellation and bounded memory for local imports (R4) together with abortable URL imports; they share one cancellation design.
8. Dashboards in IndexedDB with multi-tab handling (R6). Do this before workspace backup, which depends on the storage layout.
9. URL refresh checks (R7), with self-hosted fonts and offline/refresh status.
10. Insights alignment (R8), with provenance and insight-confidence details.
11. Export fixes (R9) and browser history (R10).
12. Workspace backup and restore.
13. Smaller items (R11, R12).
14. Reassess N9b and N10b using collected product evidence.
15. Keep F20 deferred until the local-only product promise is explicitly reconsidered.

Each delivery should include unit tests for core logic, Playwright coverage for the primary and recovery paths, accessibility checks for new UI, production-build validation, and documentation updates. Large-file and production-offline tests must remain green.

## Out of scope for this plan

- Additional chart types without a validated user requirement.
- Server accounts or hosted data.
- Runtime AI/LLM services that transmit questions, schema, or row data.
- A query-engine rewrite without the N9b trigger evidence.
- Translation work before target languages and ownership are selected.