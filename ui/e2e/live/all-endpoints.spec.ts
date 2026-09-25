/**
 * T-2729 — /endpoints on dev: every endpoint of every project the person may read, in one table
 * (EP-08, EP-44, PF-60, R20).
 *
 * dev holds more than one project now (`helsinki`, and the region's `bbsk` and the city's
 * `banskabystrica`, T-2455), which is what the page needed to be walked. `demo.steward`
 * administers the organization and reads every project, so the table holds more than one; a
 * project name opens that project's own Endpoints page. `demo.viewer` reads fewer, and the page
 * lists exactly the projects the Portal lets them read and nothing of any other: the table is the
 * organization route's answer, and that route decides what is in it.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { STEWARD, VIEWER, signIn } from "./portal";

test.setTimeout(180_000);

/** The projects of the endpoints the organization route gives this person. */
async function projectsServed(page: Page): Promise<string[]> {
  const answer = await page.request.get("/api/v1/endpoints");
  expect(answer.ok(), "the organization's endpoints are read").toBe(true);
  const items = ((await answer.json()) as { items: { metadata: { namespace?: string } }[] }).items;
  return [...new Set(items.map((item) => item.metadata.namespace ?? ""))].sort();
}

/** The projects this person may read, as the Portal lists them. */
async function readable(page: Page): Promise<string[]> {
  const answer = await page.request.get("/api/v1/projects");
  expect(answer.ok(), "the person's projects are read").toBe(true);
  return ((await answer.json()) as { items: { name: string }[] }).items.map((item) => item.name).sort();
}

/** The project column of the table, as a person reads it. */
async function projectsShown(page: Page): Promise<string[]> {
  const table = page.getByRole("table", { name: "All endpoints" });
  await expect(table).toBeVisible({ timeout: 60_000 });
  const cells = await table.getByRole("row").locator("td:first-child a").allTextContents();
  return [...new Set(cells.map((cell) => cell.trim()))].sort();
}

test("an administrator reads every project's endpoints in one table and opens one project's", async ({ browser }) => {
  const { context, page } = await signIn(browser, STEWARD, "/endpoints?lang=en");
  try {
    await expect(page.getByRole("heading", { level: 1, name: "All endpoints" })).toBeVisible();
    const served = await projectsServed(page);
    expect(served.length, "the organization publishes endpoints in more than one project").toBeGreaterThan(1);
    expect(await projectsShown(page), "the table is what the route answers").toEqual(served);

    const other = served.find((project) => project !== "helsinki") ?? served[0];
    await page.getByRole("table", { name: "All endpoints" }).getByRole("link", { name: other, exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`/projects/${other}/endpoints`));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a viewer sees the endpoints of the projects they may read, and of no other", async ({ browser }) => {
  const { context, page } = await signIn(browser, VIEWER, "/endpoints?lang=en");
  try {
    await expect(page.getByRole("heading", { level: 1, name: "All endpoints" })).toBeVisible();
    const mine = await readable(page);
    const served = await projectsServed(page);
    expect(served.filter((project) => !mine.includes(project)), "no endpoint of a project the viewer may not read").toEqual([]);
    const shown = await projectsShown(page);
    expect(shown).toEqual(served);
    // Nothing on the page offers to publish: a viewer publishes nothing (UI-44).
    await expect(page.getByRole("main").getByRole("button", { name: /^New / })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
