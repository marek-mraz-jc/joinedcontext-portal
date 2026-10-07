# Mosty Banskobystrického kraja / Bridges of the Banská Bystrica region

The staff operations app of T-2784: a bridge desk for the region's road management. Every bridge of
the region's register (`bbsk-registre`) with its code, road, year built, spans, bridged length,
material, heritage status, manager and district, and the region's figures: total length, median
age, listed monuments and bridges without a year or a length. Staff sign in: the App is opened by
its `viewer` role, which its default group `bbsk-mosty-viewer` holds (T-2686, AP-118). It reads and
never writes.

- A bridge's age is this year minus the published year; a year in the future (a typing error in the
  register) gives no age rather than a negative one.
- The oldest and the longest tenth are judged against the region's own bridges (ceil(n / 10) of
  them), marked in words beside the number; with fewer than ten bridges with the figure nothing is
  marked. There is no norm in this app.
- Filters by district, road class and listed status, search by name, code and manager; the table
  sorts by age, spans and length, a missing value always last.
- The CSV is the table as shown, the enum values in words, UTF-8 with a BOM; a cell a spreadsheet
  would run as a formula is prefixed so it never executes.

## Files

- `ui/src/bridges.ts` — age, totals, the tenth, sorting and the CSV; `bridges.test.ts`
- `ui/src/App.tsx` — the desk, tested in `App.test.tsx`
- `ui/e2e/responsive.spec.ts` — 375, 768, 1440 and 2560 px: no sideways scroll, no overlap, axe clean
