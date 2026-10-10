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
