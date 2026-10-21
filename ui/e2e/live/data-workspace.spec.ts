/**
 * T-5064 — the data workspace of a space, live on dev, as a person uses it (UI-33, API/01 §30,
 * ADR-N-042 §3.2). The steward opens the type's form from "Add row" and finds every field with its
 * hint, then corrects one cell of a seed row in the grid with a reason and undoes it; the write
 * goes through the space's Endpoint as the signed-in person and the undo puts the value back. A
 * `finally` writes the old value again if a step failed between the two. The viewer meets the same
 * grid without an editor and is refused a crafted write.
 *
 * The steward also adds an Alert through "Add row" and deletes it from the grid again (T-5092): the
 * seed's steward-row-journey Policy lets them create and delete only Alerts of category `journey`
 * without `source`, so the journey reaches no pipeline row.
 *
 * SHOTS_DIR set: each state is photographed at 1440 and 400 px.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { STEWARD, VIEWER, csrf, signIn } from "./portal";

test.setTimeout(600_000);

const SPACE = "helsinki";
// The type dev's steward may correct: app-alerts-desk grants updateAttrs on Alert's category
// (its access document); Event is read-only for the demo steward.
const TYPE = "Alert";
const PAGE = `/projects/helsinki/spaces/${SPACE}?lang=en&type=${TYPE}`;
const SUFFIX = process.env.E2E_SUFFIX ?? `${Date.now()}`;
const SHOTS = process.env.SHOTS_DIR;

async function shoot(page: Page, state: string): Promise<void> {
  if (!SHOTS) return;
  const size = page.viewportSize() ?? { width: 1440, height: 900 };
  for (const width of [1440, 400]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/data-workspace-${state}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize(size);
}

/** A row's category as dev stores it, read with the person's session. */
async function categoryOf(page: Page, id: string): Promise<unknown> {
  const answer = await page.request.get(`/cs/${SPACE}/ngsi-ld/v1/entities/${encodeURIComponent(id)}?format=keyValues&pick=category`);
  expect(answer.status()).toBe(200);
  return ((await answer.json()) as { category?: unknown }).category;
}

test("a steward opens a row form and corrects a cell in the grid with a reason, then undoes it", async ({ browser }) => {
  const { context, page } = await signIn(browser, STEWARD, PAGE);
  let restore: { id: string; category: string } | undefined;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    // Opened again after the sign-in's redirects, which a route does not see: WALK_UI_DIST serves
    // this tree's UI only to a navigation of its own.
    await page.goto(PAGE);
    await expect(page.getByRole("tab", { name: "Grid" })).toBeVisible({ timeout: 60_000 });
    await shoot(page, "grid-steward");

    // "Add row": the type's form, each field with the model's hint; nothing is sent.
    await page.getByRole("button", { name: "Add row" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(/^category/).first()).toBeVisible();
    await expect(dialog.getByText("The alert's domain; traffic for everything Fintraffic and HSL publish.")).toBeVisible();
    await shoot(page, "add-row-steward");
    await page.keyboard.press("Escape");

    // The first seed row with a category: correct it, give the reason, apply.
    const [seed] = (await (
      await page.request.get(`/cs/${SPACE}/ngsi-ld/v1/entities?type=${TYPE}&q=category&pick=id,category&format=keyValues&limit=1`)
    ).json()) as { id: string; category: string }[];
    expect(seed, "dev holds an Alert with a category").toBeTruthy();
    await page.getByPlaceholder("Search").first().fill(seed.id.split(":").pop() ?? seed.id);
    const cell = page.getByLabel(/^Edit category$/i).first();
    await expect(cell).toHaveValue(seed.category, { timeout: 60_000 });
    const edited = `${seed.category}-${SUFFIX}`;
    restore = seed;
    await cell.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(edited);
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Review the changes" }).click();
    const review = page.getByRole("region", { name: "Review the changes" });
    await review.getByRole("textbox", { name: "Why you change these values" }).fill("Data workspace journey");
    await shoot(page, "edit-review-steward");
    await review.getByRole("button", { name: "Apply" }).click();
    const undo = page.getByRole("button", { name: "Undo" });
    const refusal = review.getByText(/does not exist|refused|denied|no policy/i);
    await expect(undo.or(refusal).first()).toBeVisible({ timeout: 60_000 });
    await expect(refusal, "the Endpoint takes the correction").toHaveCount(0);
    await expect.poll(() => categoryOf(page, seed.id), { timeout: 30_000 }).toBe(edited);
    await shoot(page, "edited-steward");

    await undo.click();
    await expect(page.getByText("The change was undone.")).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => categoryOf(page, seed.id), { timeout: 30_000 }).toBe(seed.category);
    restore = undefined;
  } finally {
    if (restore && (await categoryOf(page, restore.id).catch(() => restore?.category)) !== restore.category) {
      await page.request.patch(`/cs/${SPACE}/ngsi-ld/v1/entities/${encodeURIComponent(restore.id)}/attrs`, {
        headers: { "x-csrf-token": await csrf(context), "JC-Reason": "T-5064 journey: the value it had" },
        data: { category: { type: "Property", value: restore.category } },
      });
    }
    await context.close();
  }
});

/** A row's stored answer, read with the person's session: 200 while it exists, 404 after. */
async function statusOf(page: Page, id: string): Promise<number> {
  return (await page.request.get(`/cs/${SPACE}/ngsi-ld/v1/entities/${encodeURIComponent(id)}?pick=id`)).status();
}

test("a steward adds a row through the form and deletes it from the grid", async ({ browser }) => {
  const { context, page } = await signIn(browser, STEWARD, PAGE);
  const name = `Journey row ${SUFFIX}`;
  let created: string | undefined;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(PAGE);
    await expect(page.getByRole("tab", { name: "Grid" })).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: "Add row" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^name/).first().fill(name);
    await dialog.getByLabel(/^category/).first().fill("journey");
    await dialog.getByRole("button", { name: "Create" }).click();
    const status = dialog.getByRole("status");
    await expect(status.or(dialog.getByRole("alert")).first()).toBeVisible({ timeout: 60_000 });
    await expect(status, "the steward-row-journey Policy lets the steward create a journey Alert").toHaveText(/^Created urn:ngsi-ld:Alert:/);
    created = (await status.textContent())?.replace(/^Created /, "").replace(/\.$/, "");
    expect(created).toMatch(/^urn:ngsi-ld:Alert:/);
    expect(await statusOf(page, created ?? "")).toBe(200);
    await shoot(page, "row-created-steward");
    await page.keyboard.press("Escape");

    await page.getByPlaceholder("Search").first().fill(name);
    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row).toHaveCount(1, { timeout: 60_000 });
    await row.getByRole("checkbox", { name: /^Select row/ }).check();
    await page.getByRole("button", { name: "Delete selected" }).click();
    await shoot(page, "row-delete-confirm-steward");
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete selected" }).click();
    await expect.poll(() => statusOf(page, created ?? ""), { timeout: 30_000 }).toBe(404);
    await expect(page.getByText(/rows were not deleted/)).toHaveCount(0);
    await expect(row).toHaveCount(0, { timeout: 30_000 });
    await shoot(page, "row-deleted-steward");
  } finally {
    if (created && (await statusOf(page, created).catch(() => 404)) === 200) {
      await page.request.delete(`/cs/${SPACE}/ngsi-ld/v1/entities/${encodeURIComponent(created)}`, {
        headers: { "x-csrf-token": await csrf(context), "JC-Reason": "T-5092 journey: its own row" },
      });
    }
    // The grid keeps the person's copy of a deleted row for 30 days; the journey's copy goes now.
    const trash = await page.request.get(`/api/v1/projects/helsinki/spaces/${SPACE}/trash`);
    if (created && trash.ok()) {
      for (const kept of ((await trash.json()) as { id: number; urn: string }[]).filter((item) => item.urn === created)) {
        await page.request.delete(`/api/v1/projects/helsinki/spaces/${SPACE}/trash/${kept.id}`, {
          headers: { "x-csrf-token": await csrf(context) },
        });
      }
    }
    await context.close();
  }
});

// The viewer reads Event, which app-helsinki-data grants them only to read; Alert is no case for a
// refusal on dev, whose app-alerts-desk Policy grants every signed-in person createEntity on it.
const READ_ONLY = `/projects/helsinki/spaces/${SPACE}?lang=en&type=Event`;

test("a viewer reads the grid without an editor and a crafted write is refused", async ({ browser }) => {
  const { context, page } = await signIn(browser, VIEWER, READ_ONLY);
  try {
    await page.goto(READ_ONLY);
    await expect(page.getByRole("tab", { name: "Grid" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("columnheader", { name: /Name/ }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("input[aria-label^='Edit ']")).toHaveCount(0);
    await shoot(page, "grid-viewer");

    const headers = { "x-csrf-token": await csrf(context), "content-type": "application/ld+json" };
    const entity = { id: `urn:ngsi-ld:Event:journey-${SUFFIX}`, type: "Event", eventStatus: { type: "Property", value: "EventScheduled" } };
    const crafted = await page.request.post(`/cs/${SPACE}/ngsi-ld/v1/entities`, { headers, data: entity });
    // Dev's space surface checks the model's quality rules before the Policy (400 for this body,
    // chyby.md T-5064): either way nothing is created.
    expect([400, 403], "a viewer may not create a row through the space").toContain(crafted.status());
    const created = await page.request.get(`/cs/${SPACE}/ngsi-ld/v1/entities/${encodeURIComponent(entity.id)}`);
    expect(created.status(), "the crafted row does not exist").toBe(404);
    const seed = (await (await page.request.get(`/cs/${SPACE}/ngsi-ld/v1/entities?type=Event&pick=id&limit=1`)).json()) as { id: string }[];
    const patched = await page.request.patch(`/cs/${SPACE}/ngsi-ld/v1/entities/${encodeURIComponent(seed[0].id)}/attrs`, {
      headers: { ...headers, "content-type": "application/json", "JC-Reason": "T-5064 viewer refusal" },
      data: { eventStatus: { type: "Property", value: "EventCancelled" } },
    });
    expect(patched.status(), "a viewer may not correct a cell by a crafted request").toBe(403);
  } finally {
    await context.close();
  }
});
