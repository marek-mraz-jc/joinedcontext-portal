# Helsinki events

Upcoming events of the City of Helsinki's Linked Events register, with search, a date filter, a detail view and a map of where they are. It is the plain-HTML sample application (T-2597): `spec.build: {}`, so this folder is the bundle as it is, with no build step and no package manager (AP-83).

| File | What it is |
|---|---|
| `app.yaml` | The App manifest: `static`, `build: {}`, public, one data need on `Event` in `helsinki` |
| `index.html` | The page: landmarks, the filter form, the list, the map and the detail |
| `app.js` | Pure functions (endpoint choice, query, entity → view, filter, map projection) and the DOM wiring below them |
| `style.css` | Light and dark colours, a one-column layout below 48 rem |
| `test/app.test.mjs` | `node --test` of the pure functions on `test/events.json` |

## Where the data comes from

The Portal static host writes a `#jc-config` element into `index.html` when it serves the page. The page takes from its `endpoints` the one named `helsinki-events`, else one serving `Event`, else the primary `slug`, and reads `GET /api/endpoint/{slug}/ngsi-ld/v1/entities?type=Event&limit=100&q=endDate>={start of the day}` on its own origin with `Accept: application/ld+json`. It reads nothing else and talks to no other host: the map is an SVG drawn from the entities' `location`, with no tile server.

The attributes it shows are the ones the Event entities carry on dev: `name` and `description` (language maps, shown in the reader's language, else English, Finnish or Swedish), `startDate`, `endDate`, `eventStatus`, `address`, `location` and `source`. A `source` that is not an `https:` link is not shown as a link.

## Run it locally

Tests:

```sh
node --test test/*.test.mjs
```

The browser flow runs with the Portal UI's Playwright suite (`ui/e2e/app_helsinki_events.spec.ts`). It serves this folder with a `#jc-config`, the static host's Content Security Policy and a stubbed endpoint.

`python3 -m http.server 8000` in this folder serves the page, but without the `#jc-config` the platform writes, it says it has no endpoint to read. Your browser also refuses to read dev's endpoint from `localhost`, because `connect-src` and CORS both stay on one origin. To see it with data, run the Playwright flow, or open it on dev once T-2599 has seeded it.

## How it reaches dev

The repository of record is `joinedcontext/helsinki_helsinki-events` on the dev forge (AP-75). T-2599 pushes this folder there unchanged and proposes `app.yaml`; the build lane uploads the tree with its `integrity.json` (AP-80, AP-83), and the static host serves it under `/apps/helsinki-events/`.
