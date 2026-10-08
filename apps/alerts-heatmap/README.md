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

A `ui` App (AP-142): React on the joinedcontext App SDK for the page, and the analysis in Rust,
compiled to WebAssembly and run in a Web Worker in the visitor's browser. Nothing runs on a server
for it: the static host serves its files, the endpoint answers the alerts.

- `wasm/` is the crate: `geo.rs` (metres around Helsinki, the point that stands for a geometry,
  pointy-top hexagons), `dbscan.rs` (the repeat places), `time.rs` (Helsinki's wall clock with
  its summer time, without a time zone database) and `lib.rs` (`analyse`: JSON in, JSON out,
  every filter applied over the whole set).
- `src/analysis.worker.ts` loads the module once and answers each call; `src/analysis.ts` is the
  page's side of it.
- The data need is one: `Alert` in the Context Space `helsinki`, the place, start and kind.

## Run the tests

```sh
pnpm install
pnpm wasm          # cargo build --target wasm32-unknown-unknown, then wasm-bindgen --target web
(cd wasm && cargo test)
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
