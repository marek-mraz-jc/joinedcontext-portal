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

A `ui` App (AP-142): React on the Joined Context App SDK, and schema validation and quality aggregation in Rust, compiled to WebAssembly and run in a Web Worker in the visitor's browser. Nothing runs on a server for it: the static host serves its files, and the endpoint answers the entities.

- `wasm/` is the crate:
  - `validate.rs`: custom validator checking `type`, `enum`, `minimum`, `maximum`, `pattern`, `format` (`date-time`, `date`, `uri`), `properties` + `required` for objects, and `x-ngsi-ld-kind: LanguageProperty`.
  - `quality.rs`: aggregates completeness, validity (entities with no findings / total), findings, and freshness ages against the timestamp properties.
  - `lib.rs`: `inspect` function (JSON in, JSON out).
- Uses `regex` with `default-features = false` and `features = ["std"]` (no Unicode tables) instead of the `jsonschema` crate to keep the gzipped WebAssembly module under 300 KB (`jsonschema` measured 690 KB gzipped).
- `src/inspect.worker.ts` loads the module once and answers each call; `src/inspect.ts` is the page's React hook.
- Reads 13 entity types from Context Space `helsinki`: AirQualityObserved, Alert, BikeHireDockingStation, CityDistrict, Event, NewsArticle, ParkingArea, ParkingZone, PointOfInterest, PublicAreaPermit, Vehicle, WaterQualityObserved, WeatherObserved.

## Run the tests

```sh
pnpm install
pnpm wasm          # cargo build --target wasm32-unknown-unknown, then wasm-bindgen --target web
(cd wasm && cargo test)
pnpm test          # vitest, with the compiled module run in-process
pnpm build
pnpm e2e           # the built bundle in Chromium: 4 widths, light and dark, fi and en, axe
```

`pnpm test`, `pnpm typecheck` and `pnpm build` import `wasm/pkg/`, so `pnpm wasm` runs first; the build lane runs it as `builder/build-wasm.sh` (T-3327).
The build needs the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` 0.2.129, the version the crate pins.
