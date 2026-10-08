# How far can I get by transit

Click anywhere in Helsinki and see the area you reach in 10, 20 and 30 minutes: walking to a stop,
waiting, riding, changing on foot and walking on.

- one sentence that answers on arrival, from Rautatientori: the area each band reaches and how
  many stops are within 30 minutes;
- a map with the area in three colours, the stops and the starting point; a click anywhere starts
  from there;
- the stops reached, by minutes, each a button that starts from it, and a list to start from any
  stop with the keyboard;
- the starting point and the hours of vehicle history (1, 3 or 6) in the address, so a view is a
  link (`?at=24.95000,60.20000&hours=6&lang=en`).

Finnish or English (`?lang=fi|en`, else the browser's language). Light and dark follow the
reader's system. Times are Helsinki's.

## What the answer rests on

The `helsinki` space carries vehicles, not stops or timetables (T-3356 asks for a GTFS source).
So the App derives them from the vehicles' last hours:

- a **stop** is where readings of at least two vehicles stood still (≤ 0.5 m/s, DBSCAN 35 m,
  three readings), so a traffic light two buses waited at counts too;
- a **ride** is a vehicle's move from one such place to the next on one route, timed by its own
  readings (the median over runs, at most 20 minutes a hop);
- the **trip**: walking at 4.5 km/h along streets 1.3 times the straight line, a 5-minute wait at
  each boarding, changes on foot up to 300 m. Staying aboard costs no second wait.

The page says all of this under the answer.

## How it is built

A `ui` App (AP-142): React on the joinedcontext App SDK for the page, and the analysis in Rust,
compiled to WebAssembly and run in a Web Worker in the visitor's browser. Nothing runs on a server
for it: the static host serves its files, the endpoint answers the vehicles' history.

- `wasm/` is the crate: `stops.rs` (stops and rides from the readings), `reach.rs` (Dijkstra over
  "on foot at a stop" and "aboard a route at a stop", then the hexagons each walk covers),
  `dbscan.rs` and `geo.rs` (from alerts-heatmap), `lib.rs` (`analyse`: JSON in, JSON out).
- `src/vehicles.ts` joins each vehicle's positions, speeds and routes by time; `src/history.ts`
  reads them through the temporal endpoint, at most six hours (`temporalQ`).
- 32 vehicles of 1000 readings each answer in about 100 ms.

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
