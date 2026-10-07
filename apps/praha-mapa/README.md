# Mapa Prahy / Map of Prague

The citizen map of T-2786: schools, cultural venues, public toilets, PID ticket points and the
sorted-waste points of Prague's open data, on one map with a search and a detail of each place. It
reads the city's public space `praha-mesto` through a public endpoint, never writes and never asks
anybody to sign in.

- Points of interest are one type told apart by `serviceCategory`; one of a category the map does
  not show is left out, never drawn under a wrong layer.
- The sorting isles are several thousand: their layer starts off and is one checkbox away, so the
  map is readable on a phone; each type loads page by page up to 4 000 and says when it was cut.
- Opening hours, wheelchair access, pupils and capacity are said in words or "neuvedeno", never 0;
  only http(s) links open.
- The same layout as the Slovak cities' maps, Prague's kinds, colours and Czech words.

## Files

- `ui/src/places.ts` — rows as places, kinds, search and order; `places.test.ts`
- `ui/src/App.tsx` — the screen, tested in `App.test.tsx` over `ui/src/fixtures/praha.ts`
- `ui/e2e/responsive.spec.ts` — 375, 768, 1440 and 2560 px: no sideways scroll, no overlap, axe clean
