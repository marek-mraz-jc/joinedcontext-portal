import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { axeViolations } from "./axe";

// The space grid shaped like Baserow (T-4883): one toolbar row, row numbers with checkboxes, one
// line a row with the name frozen, a filter panel whose AND/OR conditions reach the endpoint as
// NGSI-LD `q`, a search that asks the endpoint, footer counts the endpoint makes, and a bulk
// delete. `vite preview` has no Portal API behind it, so the API and the space surface are
// answered in the browser, which also records every `q` the grid sent. With SHOTS_DIR set, the
// 1440 px and 400 px screenshots of each state are written there for the task's evidence.

const PROJECT = "helsinki";
const SPACE = "helsinki";
const TYPE = "Event";

const list = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });
const manifest = (kind: string, name: string, spec: Record<string, unknown>, title?: string) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind,
  metadata: { name, namespace: PROJECT, ...(title ? { title: { en: title } } : {}) },
  spec,
  status: { phase: "Live" },
});

const LINKML = [
  "id: https://hel.fi/models/events",
  "name: helsinki-events",
  "classes:",
  "  Event:",
  "    title: Event",
  "    slots: [id, name, address, description, startDate, audience]",
  "slots:",
  "  id: {}",
  "  name: { range: string, title: Name }",
  "  address: { range: string, title: Address }",
  "  description: { range: string, title: Description }",
  "  startDate: { range: datetime, title: Starts }",
  "  audience: { range: integer, title: Places }",
  "",
].join("\n");

const NAMES = [
  "Liiketoimintasuunnitelman laskelmat - video for founders who plan their first year",
  "Workshop for Families",
  "Finnish Language Café at Iso Omena Library",
  "Board game club",
  "Toastmasters - become a better speaker",
  "Men's cafe",
  "Chinese Mid Autumn Festival",
  "Time machine",
];

function event(n: number) {
  return {
    id: `urn:ngsi-ld:Event:hel.fi:linkedevents:${n}`,
    type: TYPE,
    name: { type: "Property", value: NAMES[n % NAMES.length] },
    address: { type: "Property", value: `Leppävaarankatu ${n}, 02600 Espoo` },
    description: { type: "Property", value: "A long description of what happens at the event, who it is for and how to come along." },
    startDate: { type: "Property", value: `2026-10-${String(21 + (n % 7)).padStart(2, "0")}T17:00:00Z` },
    ...(n % 4 ? { audience: { type: "Property", value: 10 * n } } : {}),
  };
}

async function stubApi(page: Page, asked: string[], deleted: string[]): Promise<void> {
  await page.route("**/{api,cs}/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) {
      return json({ subject: "b7c1e0f4", username: "jana.kovacova", name: "Jana Kováčová", roles: ["portal-editor"] });
    }
    if (path.endsWith("/datamodels/helsinki-events/source")) {
      return route.fulfill({ status: 200, contentType: "text/yaml", body: LINKML });
    }
    if (path.includes("/entities/") && method === "DELETE") {
      // The Policy refuses the second row: the bar names it and keeps it.
      const id = decodeURIComponent(path.split("/entities/")[1] ?? "");
      if (id.endsWith(":2")) return json({ title: "Forbidden", detail: "the Policy does not grant this delete" }, 403);
      deleted.push(id);
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith("/entities")) {
      const q = url.searchParams.get("q") ?? "";
      asked.push(q);
      const rows = Array.from({ length: 24 }, (_, i) => event(i + 1));
      const total = q.endsWith(";audience") || q === "audience" ? 18 : 24;
      return json(rows, 200, { "NGSILD-Results-Count": String(total) });
    }
    if (path.endsWith("/access")) {
      return json({ permissions: [{ resource: { type: TYPE }, actions: ["queryEntity", "updateAttrs", "deleteEntity"], attributes: "*" }] });
    }
    if (path.endsWith("/trash") && method === "POST") return json({ id: "c0ffee00-0000-4000-8000-000000000001" }, 201);
    if (path === "/api/v1/projects") return json({ kind: "ProjectList", items: [{ name: PROJECT }] });
    if (path.endsWith(`/spaces/${SPACE}/views`)) return json({ items: [] });
    if (path.endsWith(`/spaces/${SPACE}`)) {
      return json(manifest("ContextSpace", SPACE, { dataModelRef: "helsinki-events" }, "Helsinki city context"));
    }
    if (path.endsWith("/datamodels")) {
      return json(list([manifest("DataModel", "helsinki-events", { contextSpaceRef: SPACE, version: "1.0.0", classes: [TYPE], linkml: LINKML })]));
    }
    if (path.endsWith("/endpoints")) {
      return json(list([manifest("Endpoint", "app-helsinki-data", { contextSpaceRef: SPACE, slug: "k7m2qz4tv6xh3n5jb2ryd3wcfa", audience: "project", enabledRepresentations: ["ngsi-ld"] })]));
    }
    return json(list([]));
  });
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

for (const [label, width, height] of [["desktop-1440", 1440, 900], ["phone-400", 400, 860]] as const) {
  test(`The space grid works like Baserow (${label})`, async ({ page }) => {
    const asked: string[] = [];
    const deleted: string[] = [];
    await page.setViewportSize({ width, height });
    await stubApi(page, asked, deleted);
    await page.goto(`/projects/${PROJECT}/spaces/${SPACE}?lang=en`);

    // One toolbar row, no per-column filter row, numbered rows of one line.
    const toolbar = page.getByTestId("grid-toolbar");
    await expect(toolbar.getByText("Filter", { exact: true })).toBeVisible();
    await expect(page.getByText("Workshop for Families").first()).toBeVisible();
    await expect(page.locator(".jc-grid-filter-row")).toHaveCount(0);
    await expect(page.locator(".jc-grid")).toHaveAttribute("data-row-size", "small");
    await expect(page.locator("tbody .jc-grid-rownum-n").first()).toHaveText("1", { useInnerText: false });
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sideways).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, `grid-toolbar-${label}`);

    // Filter: two conditions, OR, sent to the endpoint as q.
    await toolbar.getByText("Filter", { exact: true }).click();
    await page.getByRole("button", { name: "Add condition", exact: true }).click();
    await page.getByRole("textbox", { name: "Value", exact: true }).fill("cafe");
    await page.getByRole("button", { name: "Add condition", exact: true }).click();
    await page.getByRole("combobox", { name: "Field" }).nth(1).selectOption("audience");
    await page.getByRole("combobox", { name: "Operator" }).nth(1).selectOption("gt");
    await page.getByRole("spinbutton", { name: "Value", exact: true }).fill("50");
    await page.getByRole("combobox", { name: "Join conditions" }).selectOption("or");
    await expect.poll(() => asked.at(-1)).toBe('name~="cafe"|audience>50');
    await shot(page, `grid-filter-${label}`);
    await page.keyboard.press("Escape");
    await expect(toolbar.locator("summary", { hasText: "Filter" })).toContainText("2");

    // Search asks the endpoint across the text fields, beside the filter.
    await page.getByRole("searchbox", { name: "Search the rows" }).fill("Espoo");
    await expect.poll(() => asked.at(-1)).toContain('name~="(?i)Espoo"');
    await expect.poll(() => asked.at(-1)).toContain('address~="(?i)Espoo"');
    await page.getByRole("searchbox", { name: "Search the rows" }).fill("");

    // A footer count the endpoint makes over the whole filtered set.
    await page.getByRole("combobox", { name: "Footer of Places" }).selectOption("percentEmpty");
    await expect(page.getByText("25 %")).toBeVisible();
    await page.getByText("25 %").scrollIntoViewIfNeeded();
    await shot(page, `grid-footer-${label}`);

    // Select rows and delete them: one refused by the Policy stays, named with the reason.
    await page.getByRole("checkbox", { name: /^Select row: / }).nth(0).click();
    await page.getByRole("checkbox", { name: /^Select row: / }).nth(1).click();
    await expect(page.getByText("2 selected")).toBeVisible();
    await shot(page, `grid-selected-${label}`);
    await page.getByRole("button", { name: "Delete selected" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete selected" }).click();
    await expect(page.getByText("1 rows were not deleted")).toBeVisible();
    await expect(page.getByText(/the Policy does not grant this delete/)).toBeVisible();
    expect(deleted).toEqual(["urn:ngsi-ld:Event:hel.fi:linkedevents:1"]);
    // The refused row stays checked, so the bar keeps naming it.
    await expect(page.getByText("1 selected")).toBeVisible();
    await shot(page, `grid-delete-refused-${label}`);

    // Row height: four lines.
    await toolbar.locator("summary", { hasText: "Row height" }).click();
    await page.getByRole("radio", { name: "Large: four lines" }).check();
    await expect(page.locator(".jc-grid")).toHaveAttribute("data-row-size", "large");
    await page.keyboard.press("Escape");
    await shot(page, `grid-row-large-${label}`);
  });
}
