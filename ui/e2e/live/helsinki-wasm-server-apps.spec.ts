/**
 * The Helsinki apps with a server component on the shared WASM host, on dev (T-3346..T-3350,
 * ADR-N-044): each is published as `kind: wasm` with its shard, answers its main question with live
 * data for a signed-in steward, and keeps what it saves in its own schema across a reload. Every
 * record a run writes carries the run's stamp and is deleted in `finally`, so dev keeps nothing.
 *
 * Every wait is on the thing the step needs, never on the network going idle (T-2452).
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { STEWARD, goSignedIn, signIn } from "./portal";

const PROJECT = "helsinki";
const APPS_URL = process.env.APPS_URL ?? "https://dev.joinedcontext.com";

test.setTimeout(300_000);

/** The App is a server WASM App, placed on a shard, built into a component by its digest. */
async function expectPublishedAsWasm(page: Page, app: string) {
  const answer = await page.request.get(`/api/v1/projects/${PROJECT}/apps/${app}`);
  expect(answer.status(), `${app} is in the project`).toBe(200);
  const manifest = (await answer.json()) as { spec: { kind?: string }; status?: { shard?: string; build?: { component?: string } } };
  expect(manifest.spec.kind).toBe("wasm");
  expect(manifest.status?.shard, `${app} has its shard`).toMatch(/^[a-z0-9_]+$/);
  expect(manifest.status?.build?.component, `${app} runs a component by digest`).toMatch(/^sha256:[0-9a-f]{64}$/);
}

test("bike-rebalancing saves a plan on the server, and it is there after a reload with its route sheet", async ({ browser }) => {
  const steward = await signIn(browser, STEWARD, `/projects/${PROJECT}/apps?lang=en`);
  const page = steward.page;
  const app = `${APPS_URL}/apps/bike-rebalancing/`;
  const operator = `e2e T-3346 ${Date.now()}`;
  const api = `${app}api/plans`;
  try {
    await expectPublishedAsWasm(page, "bike-rebalancing");
    await goSignedIn(page, STEWARD, `${app}?lang=en`, (opened) => opened.getByRole("heading", { level: 1, name: "City bike rebalancing planner" }));
    // The main question, answered in the browser from the live counts.
    await expect(page.getByRole("list", { name: "Route" }).getByRole("listitem").first()).toBeVisible({ timeout: 120_000 });

    await page.getByLabel("Van or crew").fill(operator);
    await page.getByRole("button", { name: "Save this plan" }).click();
    await expect(page.getByRole("status")).toHaveText(new RegExp(`Plan saved: \\d+ stops for ${operator}`), { timeout: 60_000 });

    await page.reload({ waitUntil: "load" });
    const saved = page.getByRole("list", { name: "Saved plans" }).getByRole("listitem").filter({ hasText: operator });
    await expect(saved).toHaveCount(1, { timeout: 60_000 });

    const plans = (await (await page.request.get(`${api}?operator=${encodeURIComponent(operator)}`)).json()) as { id: number }[];
    expect(plans).toHaveLength(1);
    const sheet = await page.request.get(`${api}/${plans[0].id}/sheet`);
    expect(sheet.status()).toBe(200);
    const csv = await page.request.get(((await sheet.json()) as { url: string }).url);
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toMatch(/^# e2e T-3346 \d+\nstop,station,name,action,bikes,load_after,leg_km\n/);

    await saved.getByRole("button", { name: /^Mark as driven:/ }).click();
    await expect(page.getByRole("status")).toHaveText("The drive is recorded.");
    await saved.getByRole("button", { name: /^Delete:/ }).click();
    await page.getByRole("button", { name: "Delete for good" }).click();
    await expect(page.getByText(`No plan is saved for ${operator}.`)).toBeVisible();
  } finally {
    const left = await page.request.get(`${api}?operator=${encodeURIComponent(operator)}`);
    if (left.ok()) {
      for (const plan of (await left.json()) as { id: number }[]) await page.request.delete(`${api}/${plan.id}`);
    }
    await steward.context.close();
  }
});

test("event-day-planner shares a picked day under a link that opens it again, with its calendar file", async ({ browser, page }) => {
  const steward = await signIn(browser, STEWARD, `/projects/${PROJECT}/apps?lang=en`);
  try {
    await expectPublishedAsWasm(steward.page, "event-day-planner");
  } finally {
    await steward.context.close();
  }
  // A public App: an anonymous visitor shares the day.
  const app = `${APPS_URL}/apps/event-day-planner/`;
  await page.goto(`${app}?lang=en`, { waitUntil: "domcontentloaded" });
  const list = page.getByRole("list", { name: "Events of the day" });
  const boxes = list.getByRole("checkbox", { disabled: false });
  await expect(boxes.first()).toBeVisible({ timeout: 120_000 });
  await boxes.first().check();
  await expect(page.getByText(/^1 chosen events in their best order\.$/)).toBeVisible({ timeout: 60_000 });
  const picked = new URL(page.url()).searchParams.get("pick");
  expect(picked).toBeTruthy();

  await page.getByRole("button", { name: "Share this day" }).click();
  const link = page.getByLabel("Link to the shared day");
  await expect(link).toHaveValue(/\?share=[a-z0-9]{12}$/, { timeout: 60_000 });
  const shared = await link.inputValue();
  const code = new URL(shared).searchParams.get("share") ?? "";
  const ics = await page.request.get(`${app}api/itineraries/${code}/ics`);
  expect(ics.status()).toBe(200);
  const file = await page.request.get(((await ics.json()) as { url: string }).url);
  expect(file.status()).toBe(200);
  expect(await file.text()).toMatch(/^BEGIN:VCALENDAR\r\n/);

  // The link in a fresh page: the same day and the same pick, the code gone from the address.
  await page.goto(shared, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/^Shared day opened: 1 events/)).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => new URL(page.url()).searchParams.get("pick")).toBe(picked);
  expect(new URL(page.url()).searchParams.get("share")).toBeNull();
});

test("air-weather-explorer answers from the hours its server keeps, and a saved comparison opens again from its link", async ({ browser, page }) => {
  const steward = await signIn(browser, STEWARD, `/projects/${PROJECT}/apps?lang=en`);
  try {
    await expectPublishedAsWasm(steward.page, "air-weather-explorer");
  } finally {
    await steward.context.close();
  }
  // A public App: an anonymous visitor.
  const app = `${APPS_URL}/apps/air-weather-explorer/`;
  const series = page.waitForResponse((response) => response.url().includes("/apps/air-weather-explorer/api/series"), { timeout: 120_000 });
  await page.goto(`${app}?lang=en&days=3&window=6`, { waitUntil: "domcontentloaded" });
  expect((await series).status()).toBe(200);
  const answer = page.getByRole("region", { name: "The answer" });
  await expect(answer).toHaveText(/(rises|falls) as .* rises|hardly moves with|Too few common hours|No measurements in the chosen period/, { timeout: 120_000 });

  const exported = page.waitForResponse((response) => response.url().endsWith("/apps/air-weather-explorer/api/exports"));
  await page.getByRole("button", { name: "Export the hours (CSV)" }).click();
  const csv = await page.request.get(((await (await exported).json()) as { url: string }).url);
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toMatch(/^# air quality station: urn:ngsi-ld:AirQualityObserved:/);

  await page.goto(`${app}?lang=en&days=3&window=6`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Name of the comparison (optional)").fill(`e2e T-3348 ${Date.now()}`);
  await page.getByRole("button", { name: "Save the comparison" }).click();
  const link = page.getByLabel("Link to the comparison");
  await expect(link).toHaveValue(/\?compare=[a-z0-9]{12}$/, { timeout: 60_000 });
  const shared = await link.inputValue();

  await page.goto(shared, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/^Saved comparison opened: e2e T-3348 \d+\.$/)).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => new URL(page.url()).searchParams.get("window")).toBe("6");
  expect(new URL(page.url()).searchParams.get("compare")).toBeNull();
});

test("transit-reach keeps the areas from a start stop on the server, the same for a second visitor", async ({ browser, page }) => {
  const steward = await signIn(browser, STEWARD, `/projects/${PROJECT}/apps?lang=en`);
  try {
    await expectPublishedAsWasm(steward.page, "transit-reach");
  } finally {
    await steward.context.close();
  }
  const app = `${APPS_URL}/apps/transit-reach/`;
  await page.goto(`${app}?lang=en`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-summary")).toHaveText(/^Reachable from this point/, { timeout: 120_000 });
  const reached = page.getByRole("list", { name: /^Stops within 30 minutes/ });
  await reached.getByRole("button", { name: /: start from here$/ }).first().click();
  await expect(page.getByText(/^Start stop: /)).toBeVisible();

  const kept = page.waitForResponse((response) => response.url().includes("/apps/transit-reach/api/reach?stop="), { timeout: 120_000 });
  await page.getByRole("button", { name: "Download the areas from the start stop (GeoJSON)" }).click();
  const first = await kept;
  expect(first.status()).toBe(200);
  const answer = (await first.json()) as { url: string; stop: string; bands: { minutes: number }[] };
  expect(answer.bands.map((b) => b.minutes)).toEqual([10, 20, 30]);
  const file = await page.request.get(answer.url);
  expect(file.status()).toBe(200);
  expect(await file.text()).toContain('"type":"FeatureCollection"');

  // The same stop again: the server answers from what it kept for this version of the network.
  const again = await page.request.get(`${app}api/reach?stop=${encodeURIComponent(answer.stop)}`);
  expect(again.status()).toBe(200);
  expect(((await again.json()) as { cached: boolean }).cached).toBe(true);
});
