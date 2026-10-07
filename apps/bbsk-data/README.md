# Registre Banskobystrického kraja / Registers of the Banská Bystrica region

The data grids of T-2784: one tab per register of the region's public space `bbsk-registre`
(hospitals, social services, bridges, organizations, districts and municipalities), each the SDK's
`EntityGrid` with the region's column labels, a filter on every column that becomes the endpoint's
own `q`, the model's enums (hospital kind, form of service, provider, road class, heritage status,
area, level) as pick lists with their words, the name pinned as the row's primary field that opens
the whole row, and the endpoint's own downloads of the register in CSV (human headers) and GeoJSON.
It reads through a public endpoint, never writes and never asks anybody to sign in. The same layout
as the city's grids (`apps/banskabystrica-data`), the region's own registers and words.

## Files

- `ui/src/datasets.ts` — the grids, the enums and the download links; `datasets.test.ts`
- `ui/src/App.tsx` — the tabs and the panel, tested in `App.test.tsx`
- `ui/e2e/responsive.spec.ts` — 375, 768, 1440 and 2560 px: no sideways scroll, no overlap, axe clean
