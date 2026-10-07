# Helsingin palvelukartta / Helsinki service map

The citizen map of T-2788: the libraries, health stations, swimming halls, beaches and schools of
Helsinki's service register, and the beaches' water-temperature sensors, on one map with a search
and a detail of each place. It reads the city's public space `helsinki` through a public endpoint,
never writes and never asks anybody to sign in. Finnish and English; a name is read in the reader's
language where the register has it (fi, sv, en), else in Finnish.

- Services are one type told apart by `serviceCategory`; one of a category the map does not show is
  left out, never drawn under a wrong layer.
- A water sensor's sheet says the temperature, when it was measured and the beach it stands at
  (its `refPointOfInterest`, named from the loaded services); a sensor that reports nothing says so.
- Missing values read "ei tiedossa", never 0; only http(s) links open.
- The same layout as the other cities' maps; the bikes, events, alerts and transport are the
  existing Helsinki apps' (`helsinki-bikes`, `helsinki-events`, `helsinki-alerts`, `hsl-transport`).

## Files

- `ui/src/places.ts` — rows as places, kinds, search and order; `places.test.ts`
- `ui/src/App.tsx` — the screen, tested in `App.test.tsx` over `ui/src/fixtures/helsinki.ts`
- `ui/e2e/responsive.spec.ts` — 375, 768, 1440 and 2560 px: no sideways scroll, no overlap, axe clean
