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

The page sits in the SDK's shell (SDK-39), and "All details" opens the chosen indicator in the
SDK's entity panel (SDK-40), which links it to the Portal: a public App writes nothing.

Finnish or English (`?lang=fi|en`, else the browser's language, switched in the shell); the indicators' names are the
pipelines' own, in English. Light and dark follow the reader's system. Times are Helsinki's.

## How it is built

A `wasm` App (AP-142, ADR-N-044): React on the joinedcontext App SDK for the page, and the analysis
in Rust, compiled to WebAssembly and run in a Web Worker in the visitor's browser, so the period and
the chosen indicator answer at once. The static host serves its files, the endpoint answers the
indicators and their history, and the App's server keeps the forecasts (below).

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

## Forecasts kept, set against what came

The App's server is a WebAssembly component on the platform's shared host (`server/`):

- the day's first visit asks it to record the day's forecasts for the period on screen: it reads
  every indicator's history from the App's own Endpoint, forecasts each with the page's own crate
  (`../wasm`) and keeps each forecast with the day it was made in the App's schema
  (`migrations/`); a later visit that day reads and records nothing. The Endpoint is public and its
  policies are its own role, so every visitor reads the same history;
- **Earlier forecasts against what came**, under the chosen indicator: its kept forecasts whose
  time has come, each with the reading at that time (within half the model's step) and whether it
  fell within the 95 % band, the latest ten;
- **Monthly report**: for this month or one of the two before, every kept forecast point of the
  month against the reading, as CSV under the App's own prefix, `reports/{YYYY-MM}.csv`, downloaded
  through a URL valid for two minutes. A month that is over is written once more after it ends and
  then kept as it is; a month older than the 90 days of history the App may read is refused.

| Route | What it does |
|---|---|
| `POST /api/forecasts` `{days}` | the day's forecasts of the period recorded, once a day |
| `GET /api/forecasts?kpi=&days=` | an indicator's kept forecasts, newest first |
| `POST /api/reports` `{month}` | a month's forecasts against the readings as CSV; a URL it downloads from |

## Run the tests

```sh
pnpm install
pnpm wasm          # cargo build --target wasm32-unknown-unknown, then wasm-bindgen --target web
(cd wasm && cargo test)
pnpm test          # vitest, with the compiled module run in-process
pnpm build
pnpm e2e           # the built bundle in Chromium: 4 widths, light and dark, fi and en, axe, the panel
(cd server && cargo test && cargo build --release --target wasm32-wasip2)   # the server component
```

`server/host-test.json` is the server component's scenario on the real host: the portal
repository's `tests/wasm-apps` (`tests/scenarios.rs`, ci-full) builds the component, runs
`migrations/` twice as the reconciler does, and plays the scenario against Postgres, RustFS and a
mock of the App's own Endpoint, with a second App that must see nothing.

`pnpm wasm` comes first: the tests, the type check and the build import `wasm/pkg/`. The build lane
runs the same two steps itself (builder/build-wasm.sh) on the app-build-rust runner. It needs the
`wasm32-unknown-unknown` target and `wasm-bindgen-cli` 0.2.129, the version the crate pins.
