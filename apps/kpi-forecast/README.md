# Helsinki KPIs: trend and forecast

Every indicator of Helsinki's `helsinki-kpi` space on one page:

- one sentence that answers on arrival: how many indicators, how many are rising, falling or flat
  over the period, how many readings look wrong, and how many have too little history;
- the indicators, each with its current value, its direction and change a week, and its odd
  readings;
- the chosen one in full: what was measured, what the model expected one step ahead, the forecast
  with its 95 % band and the readings that look wrong; its formula, source and the model's step
  and season;
- the period (7, 30 or 90 days), "only indicators with odd readings" and the chosen indicator in
  the address, so a view is a link (`?kpi=urn:…&days=7&odd=1&lang=en`).

Finnish or English (`?lang=fi|en`, else the browser's language); the indicators' names are the
pipelines' own, in English. Light and dark follow the reader's system. Times are Helsinki's.

## How it is built

A `ui` App (AP-142): React on the joinedcontext App SDK for the page, and the analysis in Rust,
compiled to WebAssembly and run in a Web Worker in the visitor's browser. Nothing runs on a server
for it: the static host serves its files, the endpoint answers the indicators and their history.

- `wasm/` is the crate. `stats.rs`: median, quantiles, a robust standard deviation (IQR / 1.349),
  least squares. `forecast.rs`: the history onto a regular clock (the median step, at most 2000
  steps), the season (a day of hourly steps, a week of daily ones), robust Holt-Winters (an error
  over three robust deviations moves the model by three only) with its weights picked from a grid
  by the smallest clipped one-step error. `lib.rs` (`analyse`: JSON in, JSON out): per indicator
  the trend (flat under a 2 % move or an R² under 0.3), the forecast (one season, else a quarter of
  the history, at most 24 steps) and the readings three robust deviations off the model.
- `src/history.ts` reads `currentValue` over the period through the temporal endpoint; a refused
  read keeps the current values on screen and says so.
- The data need is one: `KeyPerformanceIndicator` in the Context Space `helsinki-kpi`, with the
  temporal read limited to 90 days (`temporalQ`).

## Run the tests

```sh
pnpm install
pnpm wasm          # cargo build --target wasm32-unknown-unknown, then wasm-bindgen --target web
(cd wasm && cargo test)
pnpm test          # vitest, with the compiled module run in-process
pnpm build
pnpm e2e           # the built bundle in Chromium: 4 widths, light and dark, fi and en, axe
```

`pnpm wasm` comes first: the tests, the type check and the build import `wasm/pkg/`. The build lane
runs the same two steps itself (builder/build-wasm.sh) on the app-build-rust runner. It needs the
`wasm32-unknown-unknown` target and `wasm-bindgen-cli` 0.2.129, the version the crate pins.
