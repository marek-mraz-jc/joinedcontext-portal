# Alerts desk

The capital region's traffic alerts (`Alert` of the `helsinki` space, fed by Fintraffic) as one
table: sort by any column, filter by category, subcategory, free text and end date, export the
rows shown as CSV or PDF, and open one alert's every attribute. It reads and never writes: the
owner's decision (a) on T-3016, after the generated version's edit form asked for a write no
person in the project holds.

It is the SDK template (`sdk/template/`) with one page, `src/pages/AlertDesk.tsx`; the template's
generic pages, map, charts, form and functions are left out because the desk uses none of them.
`EntityDetail` takes `labels`, so the detail panel reads like the table.

Checks: `pnpm test` (the page, the template's components), `pnpm typecheck`, and `e2e/` at 375,
768, 1440 and 2560 px against `src/fixtures.ts`, which holds invented alerts, never rows copied
from the endpoint.

## Related

- `apps/helsinki-alerts` — the same alerts on a map, with a steward's record form
- T-3016 — this application; T-3122 — its validation on dev
