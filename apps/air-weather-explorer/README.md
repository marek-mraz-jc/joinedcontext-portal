# Air quality and weather

How the weather moves Helsinki's air quality, station by station. One page, in Finnish or
English:

- the answer on opening, in one sentence: at the first air quality station, compared with the
  nearest weather station over three days, which pollutant moves most with which weather variable,
  which way and how strongly, with the Spearman and Pearson correlations and the number of hours
  they are computed over;
- the choices: the air quality station, the weather station (the nearest named with its distance),
  the period (1, 3 or 7 days), the rolling mean (1 to 12 hours), the pollutant and the variable;
- the chosen pair hour by hour on one chart, the pollutant's outlying readings marked;
- every pollutant against every weather variable as a heat map; a click on a cell shows that pair;
- the stations on the map; a click chooses one and opens it in the entity panel;
- every pair in a table, with Spearman, Pearson and the hours.

The page sits in the SDK's `AppShell` (SDK-39), which carries the language switch. A station on the
map, or the "Details of" button of each chosen station, opens it in the SDK's entity panel
(SDK-40): its attributes as the App's grant reads them, and a link to it in the Portal, where a
person with the rights changes it. The App is public and writes nothing, so the panel offers no
Edit (AP-140).

Every choice is kept in the address (`?station=`, `?weather=`, `?days=`, `?window=`, `?air=`,
`?w=`, `?lang=`).

## How it is computed

The statistics are Rust, in `wasm/`, compiled to WebAssembly and run in the reader's browser in a
Web Worker, so no server holds them (a `kind: ui` App, no pod):

- each attribute's readings are averaged per hour, and all of them put on the same hours;
- a rolling mean over the chosen window smooths each series, skipping missing hours;
- Pearson's and Spearman's correlation (ranks, ties shared) over the hours both sides have, at
  least six; a constant side says nothing;
- an outlier is a reading more than 3.5 robust standard deviations (1.4826 × MAD) from the median.

The strength words are: under 0.2 "hardly", under 0.4 "weakly", under 0.7 "moderately", else
"strongly". A correlation is not a cause: the page says how they move together, nothing more.

## Data

Two data needs on the Context Space `helsinki`, each with a week of history (`retrieveTemporal`,
window `P7D`): `AirQualityObserved` with `pm10`, `pm25` and `airQualityIndex`, and
`WeatherObserved` with `temperature`, `windSpeed`, `relativeHumidity` (stored as a share, shown in
per cent) and `precipitation`, each with `name`, `location` and `dateObserved`. The app writes
nothing.

## Run the tests

Needs Rust with the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` 0.2.129, the version
`wasm/Cargo.lock` pins and the build lane binds with.

```sh
pnpm install
pnpm wasm          # cargo test of wasm/, then the module into wasm/pkg (the lane runs builder/build-wasm.sh)
pnpm test          # vitest, with the real WebAssembly module
pnpm build         # the bundle the build lane publishes
pnpm e2e           # the built bundle in Chromium at four widths, light and dark, and a station in the panel (needs `pnpm build`)
```

The App is under the Apps' coverage gate (T-3373): `sh ../../scripts/app-coverage-run.sh
air-weather-explorer --rust` in a throwaway copy, vitest 95 % (branches 90 %) with every control
exercised, and `cargo llvm-cov` of `wasm/` at 95 % lines. wasm-bindgen's generated glue in
`wasm/pkg` is not counted.
