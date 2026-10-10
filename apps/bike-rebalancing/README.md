# City bike rebalancing planner

For the operator of Helsinki's city bikes: which docking stations are about to run empty or full,
and a route for one service van that takes bikes from the full ones to the empty ones. One page,
in Finnish or English:

- three numbers on opening: the stations about to run empty, those about to be full, and the
  bikes the van moves, over how many kilometres and stops;
- the controls: the van's capacity and where it starts (the fullest station when none is chosen);
- the map, every station in its state's colour and the van's route over them; a click on a station
  takes it into or out of the route and opens it in the entity panel;
- the route, stop by stop: take or leave how many bikes, what is on board after, the distance from
  the last stop;
- the stations most out of balance, each with its button to add it to the route or leave it out;
- the stations by fill, in tenths.

The page sits in the SDK's `AppShell` (SDK-39), with its Suomi/English switch. A station's name in
the route or the table, and a station on the map, open the station in the shell's entity panel
(SDK-40), read fresh through the App's endpoint. A station's choice button says what its click
does: a station about to run empty or full is routed unless left out, so it reads "Leave out" even
before the plan on screen has reached it.

Every choice is kept in the address (`?van=`, `?start=`, `?add=`, `?skip=`, `?lang=`), so a reload
or a shared link shows the same plan. The counts are read again every minute.

## How the plan is made

The planner is Rust, in `wasm/`, compiled to WebAssembly and run in the reader's browser in a Web
Worker, so the page never stalls:

- a station's state from its bikes and places: empty, low (under 15 %), balanced, nearly full
  (over 85 %), full; a station with no count, or out of service, is never routed;
- what it needs: the bikes above or below half its places;
- the route: nearest neighbour from the start under the van's capacity, then 2-opt while the route
  brings more bikes, serves more stations or drives fewer kilometres (haversine distances). At
  most the 60 most urgent stations are planned over.

The page sends the stations as JSON and gets the states and the route back (`plan` in
`wasm/src/lib.rs`).

## Saved plans, drives and route sheets

The page plans in the browser while the operator clicks; what is kept lives on the App's server, a
WebAssembly component on the platform's shared host (`server/`, `kind: wasm`, ADR-N-044):

- **Save this plan** sends the choices on screen (the van's capacity, the start, the stations added
  and left out) with the name of the van or crew it is for. The server reads the stations again
  from the gateway, as the signed-in caller through the App's own Endpoint, plans with the same Rust (`../wasm`, without the
  browser's bindings) and keeps the stops it made in the App's own schema (`migrations/`). What is
  kept is what the city's data said at that moment, never what a browser sent.
- Each saved plan gets a **route sheet**, a CSV of its stops for the driver (what to take or leave,
  what is on board after, the leg's kilometres), stored under the App's own prefix and downloaded
  through a URL valid for two minutes. A cell that would start a spreadsheet formula is quoted.
- **Mark as driven** records that the van drove the plan's stops; a plan lists how often it was
  driven. **Delete** takes the plan, its drives and its sheet away, after a second click.
- The van or crew is kept in the address (`?op=`), so a reload or a shared link shows that van's
  plans. It is a label the operator types, not an account: the server is given no role, so a
  viewer and a steward may both save.

| Route | What it does |
|---|---|
| `GET /api/plans?operator=` | the latest 50 plans, of one operator when named |
| `POST /api/plans` | a plan made from the gateway's counts and kept, with its route sheet |
| `GET /api/plans/{id}` | the plan, its stops and its drives |
| `DELETE /api/plans/{id}` | the plan, its drives and its sheet gone |
| `POST /api/plans/{id}/drives` | a drive recorded; its stops must be the plan's |
| `GET /api/plans/{id}/sheet` | a URL the route sheet downloads from |

## Data

One data need on the Context Space `helsinki`: `BikeHireDockingStation` with `name`, `location`,
`availableBikeNumber`, `freeSlotNumber`, `totalSlotNumber`, `status` and `dateModified`, as the
bikes pipeline writes them from HSL's feed. The app reads through its own endpoint, in the
browser and on its server alike, and writes nothing to the Context Space: its plans and drives are
in its own schema.

**What an operator edits here: nothing.** The `dataNeeds` keep `queryEntity` and
`retrieveEntity`. Every station attribute is the feed's: the pipeline rewrites the counts each
minute, so a value changed by hand would be gone at the next run. The panel never offers Edit; it
links the station to the Portal.

## Run the tests

Needs Rust with the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` 0.2.129, the version
`wasm/Cargo.lock` pins and the build lane binds with.

```sh
pnpm install
pnpm wasm          # cargo test of wasm/, then the module into wasm/pkg (the lane runs builder/build-wasm.sh)
pnpm test          # vitest, with the real WebAssembly module; every control exercised (T-3373)
pnpm build         # the bundle the build lane publishes
pnpm e2e           # the built bundle in Chromium at four widths, light and dark (needs `pnpm build`)
(cd server && cargo test && cargo build --release --target wasm32-wasip2)   # the server component
```

`server/host-test.json` is the server component's scenario on the real host: the platform's
`crates/wasm-host/tests/apps_tests.rs` builds the component, runs `migrations/` twice as the
reconciler does, and plays the scenario against Postgres, RustFS and a mock of the App's own
Endpoint (`JC_WASM_TEST_APPS=<this repository's apps>`), with a second App that must see nothing.

## Where it is built

This tree is the repository `helsinki_bike-rebalancing` on the installation's forge. The build
lane tests and compiles `wasm/` into `wasm/pkg` (builder/build-wasm.sh, AP-142) before `pnpm build`,
tests `server/` and packs its component as `.jc/component.wasm` (builder/build-component.sh, AP-151),
and serves the bundle by its digest; the static host allows `'wasm-unsafe-eval'` and nothing wider.
