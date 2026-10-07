# Mapa Banskobystrického kraja / Map of the Banská Bystrica region

The citizen map of T-2784: the hospitals, the public social services and the organizations the
Banskobystrický samosprávny kraj founded, on one map with a search and a detail of each place. It
reads the region's public register space `bbsk-registre` through a public endpoint, never writes
and never asks anybody to sign in.

- Each kind loads on its own, page by page up to 1 000; a kind the endpoint refuses is a sentence
  saying why, and the others stay.
- Social services publish no position: they are in the list, said so ("bez polohy"), and never
  placed on the map by a guess.
- The model's enum values (hospital kind, form of service, provider, area) are said in words; a
  value the register does not publish reads "neuvedené", never 0; only http(s) links open.
- The same layout as the city's map (`apps/banskabystrica-mapa`), its own kinds, colours and words.

## Files

- `ui/src/places.ts` — rows as places, search and order; `places.test.ts`
- `ui/src/App.tsx` — the screen, tested in `App.test.tsx` over `ui/src/fixtures/registre.ts`
- `ui/e2e/responsive.spec.ts` — 375, 768, 1440 and 2560 px: no sideways scroll, no overlap, axe clean
