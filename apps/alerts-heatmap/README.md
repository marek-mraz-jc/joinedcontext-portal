# Where and when alerts happen

Helsinki-region traffic alerts, the whole history the city's feed holds, on one page:

- one sentence that answers the question on arrival: how many alerts, from when to when, the most
  in one place, and the busiest starting hour of the week;
- a hexagon map: each hexagon coloured by its alerts, a circle around each place alerts keep
  coming back to (at least three within 120 metres);
- the hours of the week the alerts start in, on Helsinki's clock; a click on a cell keeps only
  that hour;
- the repeat places by name, the most alerts first; a name, or a place's circle on the map, opens
  its alert in the entity panel;
- a From and To date and the kinds (road works, traffic announcements), all in the address, so a
  view is a link (`?from=2026-09-01&kind=ROAD_WORK&day=0&hour=7&lang=en`).

Finnish or English (`?lang=fi|en`, else the browser's language); the alerts' own texts are Finnish,
as the feed publishes them. Light and dark follow the reader's system.

The page sits in the SDK's `AppShell` (SDK-39), which carries the language switch. The entity panel
(SDK-40) shows the alert's attributes as the App's grant reads them and links to it in the Portal,
where a person with the rights changes it. The App is public and writes nothing, so the panel
offers no Edit (AP-140). A hexagon is a count of alerts, not an entity: its popup says the count.

## How it is built

A `wasm` App (AP-142, AP-148): React on the joinedcontext App SDK for the page, the interactive
analysis in Rust compiled to WebAssembly and run in a Web Worker in the visitor's browser, and a
server component in Rust on the shared WASM host for what the browser cannot keep (T-3351).

- `wasm/` is the browser's crate: `geo.rs` (metres around Helsinki, the point that stands for a
  geometry, pointy-top hexagons), `dbscan.rs` (the repeat places), `time.rs` (Helsinki's wall
  clock with its summer time, without a time zone database) and `lib.rs` (`analyse`: JSON in, JSON
  out, every filter applied over the whole set). Its `browser` feature (the default) exports it
  through wasm-bindgen.
- `server/` is the server component (`wasm32-wasip2`, on `jc-app-sdk`), reusing `wasm/` without
  wasm-bindgen. It reads the alerts through the App's own Endpoint with the reader's token, keeps
  each week's repeat places in its table `weekly_places` (recomputed when older than six hours,
  and kept after the feed drops the week), and the hotspot reports readers save in `reports`, at
  most 200, the oldest dropped first. A report's map picture goes from the browser to the App's
  storage prefix through a presigned URL, once per report.
- `migrations/` holds the tables; the reconciler runs them at publish, the App never runs DDL.
- `src/analysis.worker.ts` loads the browser module once and answers each call; `src/analysis.ts`
  is the page's side of it, `src/server.ts` the page's side of the server.
- The data need is one: `Alert` in the Context Space `helsinki`, the place, start and kind.

| Route | What it does |
|---|---|
| `GET /apps/alerts-heatmap/api/weeks` | the repeat places per week, the newest first |
| `GET /apps/alerts-heatmap/api/reports` | the saved reports, newest first |
| `POST /apps/alerts-heatmap/api/reports` `{title, view, kept, places}` | a report saved |
| `GET /apps/alerts-heatmap/api/reports/{id}` | one report |
| `POST /apps/alerts-heatmap/api/reports/{id}/snapshot` | a URL to upload its map picture to, once |
| `GET /apps/alerts-heatmap/api/reports/{id}/snapshot` | a URL to download it from |

The App is public and the host passes no reader's identity, so any reader can save a report and
nobody can delete one; the cap of 200 keeps the App's quota.

## Run the tests

```sh
pnpm install
pnpm wasm          # cargo build --target wasm32-unknown-unknown, then wasm-bindgen --target web
(cd wasm && cargo test)
(cd server && cargo test && cargo build --release --target wasm32-wasip2)
pnpm test          # vitest, with the compiled module run in-process
pnpm build
pnpm e2e           # the built bundle in Chromium: 4 widths, light and dark, fi and en, axe, and an alert in the panel
```

The App is under the Apps' coverage gate (T-3373): vitest 95 % (branches 90 %) with every control
exercised, and `cargo llvm-cov` of `wasm/` at 95 % lines; wasm-bindgen's glue in `wasm/pkg` is not
counted.

`pnpm wasm` comes first: the tests, the type check and the build import `wasm/pkg/`. The build lane
runs the same two steps itself (builder/build-wasm.sh) on the app-build-rust runner. It needs the
`wasm32-unknown-unknown` target and `wasm-bindgen-cli` 0.2.129, the version the crate pins.
