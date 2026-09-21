# Záznamy Banskobystrického kraja / Records of the Banská Bystrica region

The region's published statistical rows, by the page, with a filter on every column and one
attribute a person may write. It is the same bundle as the city's grid,
`apps/banskabystrica-zaznamy`: same `ui/src`, byte for byte, and a different manifest.

Everything that is worth saying about how it works is said once, in
[`../banskabystrica-zaznamy/README.md`](../banskabystrica-zaznamy/README.md): why only
`stewardNote` opens, where the narrowing is enforced, what a person sees when a write is refused,
and why there is no history panel. What is this application's own is the manifest beside this
file: the project `bbsk`, the space `bbsk-kraj` and the region's own endpoint.

The two are two applications and not one because a published App belongs to one project and one
space: `metadata.namespace`, the rendered Endpoint and the Policy that opens the note are the
region's here and the city's there. The repository's own convention binds one app name to one
folder (`tests/reference_apps_tests.rs`), and the same test holds the two `ui/src` trees
identical, which is what keeps them from drifting.

## Related

- `apps/banskabystrica-zaznamy` — the city's grid, and the README for both
- T-2437 — this application; T-2434 — the steward attribute and the region's two grants
- `apps/bbsk-ukazovatele` — the region's dashboard, which already ships
