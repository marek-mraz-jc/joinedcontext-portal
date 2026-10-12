# hsl-transport

The public reference app (AP-34, AP-38). HSL's vehicles on a map, moving: the buses of four
trunk lines and every tram, metro, train and ferry, at most 90 at a time (the HFP pipeline's caps
per mode, T-3893), with a filter per mode, the departures of a chosen stop and HSL's service
alerts beside the map, the stops they name marked on it (T-3895).

It reads one Context Space through one Endpoint and nothing else: no broker, no database, no
second host, no credential. The Endpoint it is bound to is public, so the app never sees a
user and asks nobody to sign in (AP-28). Its sibling `air-quality` covers the other half of
the login front, with a Keycloak session and a write.

The page sits in the SDK's shell (SDK-39). A bus clicked on the map, or chosen from the list of
those in view, opens in the shell's entity panel (SDK-40), read from this app's own backend
(`ui/src/api.ts` `panelSource`), never from the endpoint. The app writes nothing, so the panel
links the bus to the Portal, at the `portal` the reconciler puts into `JC_APP_CONFIG`.

## How it stays live without a streaming endpoint

An Endpoint has no subscription surface and this app does not add one. One poll loop reads
`ngsi-ld/v1/entities` as GeoJSON every two seconds, keeps the last known position of each bus
in memory, and pushes what moved to every open browser as Server-Sent Events on
`{JC_BASE_PATH}api/stream`. A hundred open maps are still one query per interval, and the
browser never learns the Endpoint URL.

A poll that fails leaves the last known fleet on every map: the buses stop moving rather than
disappearing, which is the honest thing to show.

## Departures and alerts (T-3895)

Every 30 s the same poll loop reads, in the simplified representation: the GtfsStops that carry
`departures` (`q=departures`, the curated set of T-3891), the headsign of each line and direction
from TransitRoute (read again hourly), HSL's Alerts (the space's Digitraffic road alerts are left
out by their `source`) and the GtfsStops those alerts name, for their place on the map. The
browser reads them from `{JC_BASE_PATH}api/departures` and `{JC_BASE_PATH}api/alerts` (503 before
the first read), every 30 s; a failed read keeps what was shown. Alert text is HSL's and the page
renders it as text, never as HTML.

## Environment

| Variable | Meaning |
|---|---|
| `JC_ENDPOINT_URL` | the Endpoint this app reads, the only host it calls. Required |
| `JC_BASE_PATH` | the path it is served under, `/apps/hsl-transport/`. Defaults to `/` |
| `JC_POLL_SECONDS` | seconds between two polls. Defaults to 2 |
| `JC_BIND_ADDRESS` | defaults to `127.0.0.1:8080` on a laptop; the reconciler sets `0.0.0.0:8080` in the pod, where the edge is the only caller |

## Running it

```sh
cd ui && pnpm install && pnpm build && cd ..
JC_ENDPOINT_URL=https://<host>/api/endpoint/<slug>/ cargo run
```

## Tests

```sh
cargo test -p hsl-transport      # the contract with the Endpoint, against a stub
cd ui && pnpm test               # the map source, against a MapLibre double
cd ui && pnpm build && pnpm e2e  # the built page at four widths, light and dark
```

`pnpm e2e` serves the built bundle under `/apps/hsl-transport/` with the snapshot and one stream
frame answered from `ui/e2e/serve.ts`, and holds the map and its lines to 375, 768, 1440 and
2560 px: no sideways scroll, no overlap, no control cut off, axe clean (T-2825). It is also what
found MapLibre's worker missing from the bundle, which `ui/map-worker.ts` now ships.

The Rust tests assert what actually leaves the pod: the representation asked for, the thirty
bus cap, that no credential is ever attached, and that serving a browser costs no query. The
UI tests assert that a bus moving on the Endpoint reaches the one GeoJSON source the map
draws from, without the layer being rebuilt. MapLibre needs WebGL, which jsdom has not, so
the library is replaced by a double; there is no Playwright flow here for the same reason.
