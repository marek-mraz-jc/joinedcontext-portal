# Ukazovatele mesta Žilina / Indicators of the city of Žilina

The KPI dashboard of T-3140: the six indicators of `joinedcontext-docs/Development/13-zilina-kpis.md`
(residents, total change, mean age, ageing index, registered jobseekers, visitors per year), read
from the public space `zilina-kpi` through a public endpoint. It never writes and never asks
anybody to sign in.

## How it reads

- Only the six indicators of Development/13, from the space `zilina-kpi`, whose `name` is the
  id's `{localId}`: anything else is a number nobody could place and is left out.
- "not measured" is said as "nemerané", never shown as 0.
- Each card says its window (a quarter or a year) and, behind "Ako sa počíta", the formula the
  pipeline recorded and when it ran.
- None of the six has a published limit, so no card carries a colour that judges it.

## Files

- `ui/src/indicators.ts` — an entity as a card, the refusals and the window; `indicators.test.ts`
- `ui/src/App.tsx` — the screen, tested over the pipeline's own output in `App.test.tsx`
- `ui/src/fixtures/kpi.ts` — what ukazovatele computed from the cubes recorded on 2026-10-06
- `ui/e2e/responsive.spec.ts` — 375, 768, 1440 and 2560 px: no sideways scroll, no overlap, axe clean
