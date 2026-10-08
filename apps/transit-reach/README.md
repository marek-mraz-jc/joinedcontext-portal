# How far can I get by transit

Click anywhere in Helsinki and see the area you reach in 10, 20 and 30 minutes: walking to a stop,
waiting, riding, changing on foot and walking on.

- one sentence that answers on arrival, from Rautatientori: the area each band reaches and how
  many stops are within 30 minutes;
- a map with the area in three colours, the stops and the starting point; a click anywhere starts
  from there;
- the stops reached, by minutes, each a button that starts from it, and a list to start from any
  stop with the keyboard; an HSL stop also opens in the SDK's entity panel, read only, with a link
  to the Portal (SDK-40, AP-140);
- the starting point and the hours of vehicle history (1, 3 or 6) in the address, so a view is a
  link (`?at=24.95000,60.20000&hours=6&lang=en`).

Finnish or English (`?lang=fi|en`, else the browser's language). Light and dark follow the
reader's system. Times are Helsinki's.

## What the answer rests on

HSL's own registers when the space holds them (T-3356): 8389 stops and platforms with their
names and sign codes, and 1121 line variants with their stops in order. They carry no timetable,
so a ride between two stops of a line takes the distance (1.2 times the straight line) at the
mode's usual speed, stops included: metro 40 km/h, commuter train 50, bus 20, tram 15, ferry 18.

Where the space holds no stops and lines, or refuses them, the App derives them from the vehicles'
last hours instead:

- a **stop** is where readings of at least two vehicles stood still (≤ 0.5 m/s, DBSCAN 35 m,
  three readings), so a traffic light two buses waited at counts too;
- a **ride** is a vehicle's move from one such place to the next on one route, timed by its own
  readings (the median over runs, at most 20 minutes a hop).

Either way the **trip** is: walking at 4.5 km/h along streets 1.3 times the straight line, a
5-minute wait at each boarding, changes on foot up to 300 m. Staying aboard costs no second wait.
The page says which of the two it used, under the answer.

## How it is built

A `ui` App (AP-142): React on the joinedcontext App SDK for the page, inside the SDK's `AppShell`, and the analysis in Rust,
compiled to WebAssembly and run in a Web Worker in the visitor's browser. Nothing runs on a server
for it: the static host serves its files, the endpoint answers the vehicles' history.

- `wasm/` is the crate: `network.rs` (stops and rides from HSL's registers), `stops.rs` (stops
  and rides from the readings), `reach.rs` (Dijkstra over
  "on foot at a stop" and "aboard a route at a stop", then the hexagons each walk covers),
  `dbscan.rs` and `geo.rs` (from alerts-heatmap), `lib.rs` (`analyse`: JSON in, JSON out).
- `src/network.ts` reads the stops and lines, every page (some 8400 stops, past the SDK's `all`).
- `src/vehicles.ts` joins each vehicle's positions, speeds and routes by time; `src/history.ts`
  reads them through the temporal endpoint, at most six hours (`temporalQ`).
- HSL's whole network answers in about 100 ms in the module, 0.6 to 1.1 s to the first answer in
  the page; 32 vehicles of 1000 readings each in about 100 ms.

## Run the tests

```sh
pnpm install
pnpm wasm          # cargo build --target wasm32-unknown-unknown, then wasm-bindgen --target web
(cd wasm && cargo test)
pnpm test          # vitest, with the compiled module run in-process
pnpm build
pnpm e2e           # the built bundle in Chromium: 4 widths, light and dark, fi and en, axe, the panel
```

The coverage gate (T-3373): `sh ../../scripts/app-coverage-run.sh transit-reach --rust` holds the
page at 95 % of lines and 90 % of branches, every control used by a test, and `wasm/` at 95 %
(`cargo llvm-cov`). `wasm/pkg/` is generated and left out of the page's figure.

`pnpm wasm` comes first: the tests, the type check and the build import `wasm/pkg/`. The build lane
runs the same two steps itself (builder/build-wasm.sh) on the app-build-rust runner. It needs the
`wasm32-unknown-unknown` target and `wasm-bindgen-cli` 0.2.129, the version the crate pins.
