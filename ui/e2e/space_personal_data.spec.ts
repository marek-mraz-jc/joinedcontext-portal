import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe";

// A person's data on a space's Retention tab (T-4870, DM-124, DM-126): the owner exports one
// person's records to a file, previews an erasure, confirms it and follows it to done; empty fields
// are named before anything is sent, a refusal is shown in words, and a viewer finds both buttons
// off. `vite preview` has no Portal API behind it, so the API is answered in the browser. With
// SHOTS_DIR set, the 1440 px and 400 px screenshots of each state are written there.

const PROJECT = "helsinki";
const SPACE = "riders";
const BASE = `/api/v1/projects/${PROJECT}/spaces/${SPACE}`;
const SPACE_MANIFEST = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "ContextSpace",
  metadata: { name: SPACE, namespace: PROJECT, title: { en: "City bike riders" } },
  spec: {},
  status: { phase: "Live" },
};
const PREVIEW = {
  dryRun: true,
  entities: 3,
  groups: [
    { class: "Rider", entities: ["urn:ngsi-ld:Rider:r-42"], attrs: ["riderName", "phone"] },
    { class: "Trip", entities: ["urn:ngsi-ld:Trip:1", "urn:ngsi-ld:Trip:2"], attrs: null },
  ],
};
const ERASURE = {
  id: "er-20261021-0a1b2c3d4e5f",
  state: "done",
  requestedAt: "2026-10-21T08:00:00Z",
  completedAt: "2026-10-21T08:00:04Z",
  entities: 3,
  counts: { broker: 3, versions: 17, portal: 1, ckanDatastore: 0, conversations: 0, exports: 0, caches: 0 },
  stores: {
    broker: { state: "done", count: 3, versions: 17 },
    portal: { state: "done", count: 1 },
    ckanDatastore: { state: "done", count: 0 },
    conversations: { state: "done", count: 0 },
    exports: { state: "done", count: 0 },
    caches: { state: "done", count: 0 },
  },
};
const OWNER_GRANT = { rule: { kinds: ["ContextSpace"], verbs: ["read", "propose", "approve"] } };
const VIEWER_GRANT = { rule: { kinds: ["ContextSpace"], verbs: ["read"] } };

type Sent = { path: string; search: string; body: unknown };

async function stubApi(page: Page, { owner = true, refuse = false } = {}): Promise<Sent[]> {
  const sent: Sent[] = [];
  await page.route("**/{api,cs}/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) {
      return json({ subject: "b7c1e0f4", username: "jana.kovacova", name: "Jana Kováčová", roles: ["portal-editor"] });
    }
    if (path === "/api/v1/projects") return json({ kind: "ProjectList", items: [{ name: PROJECT }] });
    if (path.endsWith("/permissions/me")) {
      return json({ project: PROJECT, bootstrap: false, grants: [owner ? OWNER_GRANT : VIEWER_GRANT] });
    }
    if (route.request().method() === "POST" && path.startsWith(BASE)) {
      sent.push({ path, search: url.search, body: route.request().postDataJSON() });
      if (refuse) {
        return json(
          {
            type: "about:blank",
            title: "Forbidden",
            status: 403,
            detail: `only an owner of context space '${SPACE}' runs a data subject's export and erasure (DM-124)`,
          },
          403,
        );
      }
      if (path === `${BASE}/subjects/export`) {
        return json({ space: SPACE, subject: "hmac", exportedAt: "2026-10-21T08:00:00Z", entities: [{ class: "Rider" }, { class: "Trip" }, { class: "Trip" }] });
      }
      if (path === `${BASE}/erasures`) return url.searchParams.get("dryRun") === "All" ? json(PREVIEW) : json(ERASURE, 202);
    }
    if (path === `${BASE}/erasures/${ERASURE.id}`) return json(ERASURE);
    if (path.endsWith("/retention/deleted")) return json({ counts: [] });
    if (path.endsWith(`/spaces/${SPACE}`)) return json(SPACE_MANIFEST);
    return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] });
  });
  return sent;
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

async function open(page: Page) {
  await page.goto(`/projects/${PROJECT}/spaces/${SPACE}?tab=retention&lang=en`);
  const heading = page.getByRole("heading", { name: "A person's data" });
  await expect(heading).toBeVisible();
  await heading.scrollIntoViewIfNeeded();
  return heading;
}

async function sound(page: Page): Promise<void> {
  // Nothing wider than the screen: the page body never scrolls sideways (UI-27).
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(sideways).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
}

for (const [label, width, height] of [["desktop-1440", 1440, 900], ["phone-400", 400, 860]] as const) {
  test(`an owner exports and erases a person's data (${label})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const sent = await stubApi(page);
    await open(page);
    await shot(page, `personal-empty-${label}`);

    await page.getByRole("button", { name: "Export the person's data" }).click();
    await expect(page.getByText("Enter the person's identifier.")).toBeVisible();
    await expect(page.getByText("Enter the reason, for example the request's reference.")).toBeVisible();
    expect(sent).toEqual([]);
    await sound(page);
    await shot(page, `personal-required-${label}`);

    await page.getByLabel("Person's identifier").fill("r-42");
    await page.getByLabel("Reason").fill("Art. 15 and 17 request 2026-10-21-01");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export the person's data" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^personal-data-riders-\d{4}-\d{2}-\d{2}\.json$/);
    const exported = JSON.parse(readFileSync(await file.path(), "utf8")) as { entities: unknown[] };
    expect(exported.entities).toHaveLength(3);
    await expect(page.getByText("Exported 3 records to a file in your downloads.")).toBeVisible();
    await shot(page, `personal-exported-${label}`);

    await page.getByRole("button", { name: "Erase the person's data…" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Rider: the personal attributes (riderName, phone) of 1 entity")).toBeVisible();
    await expect(dialog.getByText("Trip: 2 whole entities")).toBeVisible();
    await sound(page);
    await shot(page, `personal-preview-${label}`);

    await dialog.getByRole("button", { name: "Erase" }).click();
    await expect(page.getByText(/Erasure er-20261021-0a1b2c3d4e5f is done/)).toBeVisible();
    await expect(page.getByText("Current values and history: done, 3 removed")).toBeVisible();
    await expect(page.getByLabel("Person's identifier")).toHaveValue("");
    // Every call carried the subject in its body, never in the address.
    expect(sent.map((s) => `${s.path}${s.search}`)).toEqual([
      `${BASE}/subjects/export`,
      `${BASE}/erasures?dryRun=All`,
      `${BASE}/erasures`,
    ]);
    expect(sent.every((s) => (s.body as { subject: string }).subject === "r-42")).toBe(true);
    await sound(page);
    await shot(page, `personal-done-${label}`);
  });

  test(`a refusal is said in words (${label})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await stubApi(page, { refuse: true });
    await open(page);
    await page.getByLabel("Person's identifier").fill("r-42");
    await page.getByLabel("Reason").fill("Art. 17 request 2026-10-21-02");
    await page.getByRole("button", { name: "Erase the person's data…" }).click();
    await expect(page.getByText(/only an owner of context space 'riders'/)).toBeVisible();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await sound(page);
    await shot(page, `personal-refused-${label}`);
  });

  test(`a viewer finds both buttons off (${label})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const sent = await stubApi(page, { owner: false });
    await open(page);
    await expect(page.getByRole("button", { name: "Export the person's data" })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("button", { name: "Erase the person's data…" })).toHaveAttribute("aria-disabled", "true");
    expect(sent).toEqual([]);
    await shot(page, `personal-viewer-${label}`);
  });
}
