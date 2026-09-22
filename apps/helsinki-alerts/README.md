# helsinki-alerts

Road works and traffic announcements in the capital region, read from the `helsinki` context
space: an overview with the counts the `summary` function computes, and an Alerts page with
filters, a map, a table and the detail of one alert. Sample application 3 of 3 (T-2598): a React
frontend on the App SDK plus serverless functions, with two roles.

| Role | Who (dev) | May |
|---|---|---|
| `viewer` | `demo.viewer@hel.fi` | read every alert and the summary |
| `steward` | `demo.steward@hel.fi` | also add alerts, correct their fields, and remove the alerts a steward added |

The roles are enforced by the gateway, not by this page (AP-96): `app.yaml` grants the write items
to `steward` only, and the delete item carries `q: "!source"`, so only a record with no `source`
(one a steward added, never Fintraffic's) can be removed. The form writes every attribute of
`Alert` but `source` (`name` and `description` language by language, keeping the others); it lists
the fields it leaves alone and why. A later run of the traffic-messages pipeline overwrites a correction of
a Fintraffic record's fields.

## Functions

- `functions/summary.ts`: counts per `category` and `subCategory`, the oldest open alert, and for
  a steward the number of alerts stewards added (`request.user.roles`).
- `functions/expiring.ts`: the alerts whose `validTo` falls in the next `hours` (1 to 168).

Both read only through `ctx.jc` with the caller's own grants and hold no secret.

## Run it

```sh
pnpm install
pnpm test                 # the pages and both functions
pnpm build                # the bundle the build lane publishes
```

The built bundle's browser flow lives in the portal repository, `apps-e2e/helsinki-alerts/`: the
build lane refuses any package the SDK template does not install, `@playwright/test` included
(SDK-12).

Against dev, `pnpm dev` with `JC_ENDPOINT_SLUG` set to the app's endpoint serves the pages with
your own sign-in. The repository of record is
`https://2.28.67.127.sslip.io/git/joinedcontext/helsinki_helsinki-alerts.git`; the build lane
builds `main` with `.gitea/workflows/build.yml` (AP-75, AP-80).
