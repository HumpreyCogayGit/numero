# Numero — Plan

Open work only (updated 2026-11-15; the 2026-11-15 improvement plan in `improvement.md` has been implemented — see its status table). Everything finished so far has been removed: features F0–F33, bugs B1–B16 and R1–R14, and follow-ups N1–N12 except the two below that need a decision. Their behavior is covered by the tests: 307 unit tests (`npm test`) and 74 browser tests (`npm run test:e2e`). The browser tests include an accessibility audit (WCAG A/AA plus best practices, moderate and up), a dialog focus test, an offline check against the production preview, and a 1M-row performance test that runs after the rest.

## Needs a decision first

Nothing else is scheduled. These are worth building only after a decision.

- [ ] **N9b Streaming aggregation for 1M+ rows (K3).** A full refresh takes about 0.75 s at 1M rows. This is only worth reworking the query engine if files that size are common.
- [ ] **N10b Translate the UI and the Ask bar (K5).** Needs a list of target languages, and the question grammar would have to be rewritten for each.
- **F20 Collaboration (deferred).** Cloud sync, share links and comments need a server and accounts. That would break the promise that data never leaves the device. File sharing covers this for now: `.numero.json` export and import, PNG, and PDF. Revisit only together with a decision on hosting data off-device.

## Known limitations

| # | Area | Limitation | Workaround |
|---|---|---|---|
| K1 | Dates | Impossible future dates are still taken at face value when imported, but the import preview now warns about them and offers a *Leave those rows out* step. | Accept the step in the preview, or add a *Filter rows* prep step later. |
| K3 | Performance | On 1M+ rows, a full dashboard refresh after a filter takes about 0.75 s. Clicks respond in about 40 ms. | Fine for typical files (or build N9b). |
| K5 | Questions | The Ask bar understands English and a fixed set of phrasings only. | It says when it can't match; build the chart in the editor. |
| K6 | Refresh | URL sources refresh only while their dataset is open. | Open the dataset or press Refresh. |
| K7 | Formulas | Computed columns are row-level, so totals inside them (e.g. `SUM([x])`) ignore dashboard filters. This is by design. | Use a calculated measure for filter-aware ratios; the editor explains this. |
| K8 | Prep | Proper case lowercases inner capitals ("SoHo" → "Soho"). | Follow it with find & replace, or skip the case step. |
| K10 | Storage | Browser storage belongs to one browser. Numero asks the browser to keep it (after your first own import), but that is not a backup. | Home → Backup writes the workspace to a file; keep the source files. |
| K11 | Update data | Saved versions are full copies of the rows: up to 5, or 3 above 50 MB and 2 above 200 MB. (A URL refresh that returns unchanged data no longer saves a version.) | Delete versions one by one, or all at once, in the Storage manager. |
| K12 | Update data | URL sources refresh by replacing everything; they can't append. This was a deliberate decision. | Download the file and use Update data. |
| K13 | Update data | Overwriting rows and sync (removing rows a full export no longer lists) need a key column. ⌘Z undoes an update only while its saved version still exists. | Pick an ID in *Match rows by*. |
| K14 | Linked files | Linked files work in Chrome and Edge only. After a browser restart, you have to grant permission again from the dialog. | In other browsers, choose the file each time. |
| K15 | What changed | Movers compare the latest *complete* period with the one before, using the first date column. Computed columns are left out. | While a period is incomplete, read the KPIs. |
| K16 | Cohorts | Entities that were active before the data starts look new in the first period. Tables show at most 24 cohorts × 24 periods. The suggested dashboard skips cohorts above 250,000 rows, because each filter would mean another full pass. | Filter to start after the history begins. |
| K17 | Offline | The service worker exists only in production builds and needs a first visit. A sample is available offline once it has been opened. | — |
| K19 | Blank markers | `NA`, `None` and `-` are values in a text column unless the same file also uses that marker under a number or date (then it is taken as the file's "missing" marker everywhere). | Choose *Always blank* or *Always a value* in the import preview. |
| K20 | Backup | Workspace backups are built in memory as one JSON file, unencrypted; saved data versions and linked-file permissions are not included. | For very large workspaces, back up dashboards only and keep the source files. |
| K21 | Insights | Above 200,000 rows, correlations, distributions and the statistics table use an even sample; the insights summary is not added to suggested dashboards above 250,000 rows. | Trends over time still use every row. |
| K18 | Text widgets | Placeholders match column and measure names, with English keywords (sum, avg, min, max, median, count, count distinct, latest month…). | Unknown names are highlighted in the widget. |
