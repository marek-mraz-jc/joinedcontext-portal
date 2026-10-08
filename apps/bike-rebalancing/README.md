# City bike rebalancing planner

For the operator of Helsinki's city bikes: which docking stations are about to run empty or full,
and a route for one service van that takes bikes from the full ones to the empty ones. One page,
in Finnish or English:

- three numbers on opening: the stations about to run empty, those about to be full, and the
  bikes the van moves, over how many kilometres and stops;
- the controls: the van's capacity and where it starts (the fullest station when none is chosen);
- the map, every station in its state's colour and the van's route over them; a click on a station
  takes it into or out of the route;
- the route, stop by stop: take or leave how many bikes, what is on board after, the distance from
  the last stop;
- the stations most out of balance, each with its button to add it to the route or leave it out;
- the stations by fill, in tenths.

Every choice is kept in the address (`?van=`, `?start=`, `?add=`, `?skip=`, `?lang=`), so a reload
or a shared link shows the same plan. The counts are read again every minute.

## How the plan is made

The planner is Rust, in `wasm/`, compiled to WebAssembly and run in the reader's browser in a Web
Worker, so the page never stalls and no server holds it (a `kind: ui` App, no pod):

- a station's state from its bikes and places: empty, low (under 15 %), balanced, nearly full
  (over 85 %), full; a station with no count, or out of service, is never routed;
- what it needs: the bikes above or below half its places;
- the route: nearest neighbour from the start under the van's capacity, then 2-opt while the route
  brings more bikes, serves more stations or drives fewer kilometres (haversine distances). At
  most the 60 most urgent stations are planned over.

The page sends the stations as JSON and gets the states and the route back (`plan` in
`wasm/src/lib.rs`).

## Data

One data need on the Context Space `helsinki`: `BikeHireDockingStation` with `name`, `location`,
`availableBikeNumber`, `freeSlotNumber`, `totalSlotNumber`, `status` and `dateModified`, as the
bikes pipeline writes them from HSL's feed. The app reads through its own endpoint and writes
nothing.

## Run the tests

Needs Rust with the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` 0.2.129, the version
`wasm/Cargo.lock` pins and the build lane binds with.

```sh
pnpm install
pnpm wasm          # cargo test of wasm/, then the module into wasm/pkg (the lane runs builder/build-wasm.sh)
pnpm test          # vitest, with the real WebAssembly module
pnpm build         # the bundle the build lane publishes
pnpm e2e           # the built bundle in Chromium at four widths, light and dark (needs `pnpm build`)
```

## Where it is built

This tree is the repository `helsinki_bike-rebalancing` on the installation's forge. The build
lane tests and compiles `wasm/` into `wasm/pkg` (builder/build-wasm.sh, AP-142) before `pnpm build`,
and serves the bundle by its digest; the static host allows `'wasm-unsafe-eval'` and nothing wider.
