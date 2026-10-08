# Compare districts

Helsinki districts compared side by side: events, bike stations, alerts, and air quality:

- a choropleth map of all Helsinki districts coloured by the chosen measure (default: events per km²);
- the two districts with the most events preselected on arrival;
- side-by-side comparison table showing each selected district's values, values per km² (where applicable), and ranking among all districts;
- bar chart for the chosen measure across the selected districts;
- ranked district list allowing selection via checkboxes or directly on the map;
- URL hash keeping the active selection and measure (`#compare?d=101,102&m=events`).

Finnish or English (`?lang=fi|en`, else the browser's language). Light and dark themes follow the reader's system.

## How it is built

A `ui` App (AP-142): React on the joinedcontext App SDK for the page, and spatial point-in-polygon and ranking analysis in Rust, compiled to WebAssembly and run in a Web Worker in the visitor's browser. Nothing runs on a server for it: the static host serves its files, and the endpoint answers the entities.

- `wasm/` is the crate: `geo.rs` (point-in-polygon, geometry area in km², bounding boxes, representative coordinate extraction) and `lib.rs` (`compare`: JSON in, JSON out, computing district aggregates, per-km² rates, rankings, and points falling outside districts).
- `src/compare.worker.ts` loads the module once and answers each call; `src/compare.ts` is the page's side of it.
- Reads `CityDistrict` (`divisionLevel = "district"`), `Event`, `BikeHireDockingStation`, `Alert`, and `AirQualityObserved` in the Context Space `helsinki`.

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
The build needs the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` 0.2.129, the version the
crate pins.
