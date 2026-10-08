# My day of events

For a visitor to Helsinki: which of the day's events to see, in which order, with the walk
between them. One page, in Finnish or English (the events' own names in Finnish, Swedish or
English as the Portal's language asks):

- the day (today, or a later one) and a search;
- the plan on opening: with nothing picked, a suggested day of events that follow one another on
  foot; with events picked, those events in the order that fits most of them, each with its time,
  the walk from the last one, and a mark when it starts before the visitor can get there or is out
  of reach; the events that take place at the same time are named;
- the plan's stops on the map, with the walk between them;
- the day's events, soonest first, each with a box to add it to the day (a cancelled one is shown
  and cannot be picked), its place, its source and what it is about;
- how many events start each hour; a click on a bar lists that hour's;
- the day as a calendar file (.ics) to save.

The day, the search, the hour and the picks are kept in the address (`?day=`, `?q=`, `?hour=`,
`?pick=`, `?lang=`), so a reload or a shared link shows the same day.

## How the day is planned

The planner is Rust, in `wasm/`, compiled to WebAssembly and run in the reader's browser in a Web
Worker, so no server holds it (a `kind: ui` App, no pod):

- an event of up to three hours is sat through from its start; a longer one (an exhibition, a
  fair) is a place to drop by for an hour while it is open;
- the walk between two places is the great-circle distance at 5 km/h; an event with no place adds
  no walk and says so;
- up to eight picked events every order is tried, more by start time then 2-opt; the best order
  fits the most events, then is the least late, then walks the least; at most 20 are planned;
- with nothing picked, the suggested day takes the events by earliest end, each reachable before
  it starts, at most four;
- the calendar file is RFC 5545: UTC times, escaped text, lines folded at 75 octets.

## Data

One data need on the Context Space `helsinki`: `Event` with `name`, `description`, `startDate`,
`endDate`, `eventStatus`, `address`, `location` and `source`, the Linked Events registers the
events pipeline writes. Only events that have not ended are read. The app writes nothing.

## Run the tests

Needs Rust with the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` 0.2.128 (the version
`wasm/Cargo.lock` names).

```sh
pnpm install
pnpm test          # cargo test of the planner, then vitest with the WebAssembly module built
pnpm build         # the planner to WebAssembly, then the bundle the build lane publishes
pnpm e2e           # the built bundle in Chromium at four widths, light and dark (needs `pnpm build`)
```
