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
- the stations on the map; a click chooses one;
- every pair in a table, with Spearman, Pearson and the hours.

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

Needs Rust with the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` 0.2.128 (the version
`wasm/Cargo.lock` names).

```sh
pnpm install
pnpm test          # cargo test of the statistics, then vitest with the WebAssembly module built
pnpm build         # the statistics to WebAssembly, then the bundle the build lane publishes
pnpm e2e           # the built bundle in Chromium at four widths, light and dark (needs `pnpm build`)
```
