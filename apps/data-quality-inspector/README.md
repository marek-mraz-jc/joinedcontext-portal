# Helsinki data quality

Helsinki open data quality inspector for data stewards: how complete, fresh and valid the open data of the Helsinki space is, per entity type and per attribute, and which entities fail.

- Overview tile per entity type showing entities read, completeness %, valid %, and median age of the newest timestamp (sorted with the lowest valid % first).
- Bar chart of completeness across all entity types.
- Type-level detail with completeness per schema attribute.
- Failing entities table showing the local id, failing attribute, and reason in plain words (first 200 rows with count of remaining). The inspector names an entity by its whole id, so two with the same local id under different prefixes count as two; the id opens the entity in the SDK's entity panel (SDK-40), which links it to the Portal for correcting: the App is public and writes nothing (AP-140).
- Freshness metrics (median, oldest, share older than 24 h) based on the first timestamp property present in the type schema.
- A rule behind a `$ref` (the enum definitions the SDK's schema leaves out) is counted as not checked, never as a failure.
- Types without a published schema show completeness over the attributes they carry with a "no published schema" note.
- URL hash navigation (`#quality?type=BikeHireDockingStation`).
- Finnish and English (`?lang=fi|en`, else browser preference), switched in the SDK's `AppShell` (SDK-39), with light and dark themes; the loading, empty and error states are the SDK's.

## How it is built

A `wasm` App (AP-142, AP-148): React on the Joined Context App SDK, schema validation and quality aggregation in Rust, compiled to WebAssembly and run in a Web Worker in the visitor's browser, and a server component on the shared WASM host that keeps the runs (T-3354).

- `wasm/` is the crate:
  - `validate.rs`: custom validator checking `type`, `enum`, `minimum`, `maximum`, `pattern`, `format` (`date-time`, `date`, `uri`), `properties` + `required` for objects, and `x-ngsi-ld-kind: LanguageProperty`.
  - `quality.rs`: aggregates completeness, validity (entities with no findings / total), findings, and freshness ages against the timestamp properties.
  - `lib.rs`: `inspect` function (JSON in, JSON out).
- Uses `regex` with `default-features = false` and `features = ["std"]` (no Unicode tables) instead of the `jsonschema` crate to keep the gzipped WebAssembly module under 300 KB (`jsonschema` measured 690 KB gzipped).
- `src/inspect.worker.ts` loads the module once and answers each call; `src/inspect.ts` is the page's React hook.
- Reads 13 entity types from Context Space `helsinki`: AirQualityObserved, Alert, BikeHireDockingStation, CityDistrict, Event, NewsArticle, ParkingArea, ParkingZone, PointOfInterest, PublicAreaPermit, Vehicle, WaterQualityObserved, WeatherObserved.
- `server/` is the server component (`wasm32-wasip2`, on `jc-app-sdk`), reusing `wasm/` without wasm-bindgen (`inspect_type_with` keeps every finding). Once a day, or when a reader presses Inspect now (at most once every ten minutes), it reads the Endpoint's published schema and its entities through the App's own Endpoint with the reader's token, rows flattened as the SDK flattens them, runs the same inspection and keeps the run's scores per type in `quality_runs` and `run_types` (`migrations/`), so the page shows the trend. The run's full report, every finding grouped by entity, goes to `runs/<id>/report.json` under the App's storage prefix and downloads through a presigned URL.

| Route | What it does |
|---|---|
| `GET /apps/data-quality-inspector/api/runs` | the kept runs, newest first, with their scores per type |
| `POST /apps/data-quality-inspector/api/runs` | a run now, at most one every ten minutes |
| `GET /apps/data-quality-inspector/api/runs/{id}/report` | a URL to download the run's full report from |

## Run the tests

```sh
pnpm install
pnpm wasm          # cargo build --target wasm32-unknown-unknown, then wasm-bindgen --target web
(cd wasm && cargo test)
(cd server && cargo test && cargo build --release --target wasm32-wasip2)
pnpm test          # vitest, with the compiled module run in-process
pnpm build
pnpm e2e           # the built bundle in Chromium: 4 widths, light and dark, fi and en, axe
```

`pnpm test`, `pnpm typecheck` and `pnpm build` import `wasm/pkg/`, so `pnpm wasm` runs first; the build lane runs it as `builder/build-wasm.sh` (T-3327).
The build needs the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` 0.2.129, the version the crate pins.
