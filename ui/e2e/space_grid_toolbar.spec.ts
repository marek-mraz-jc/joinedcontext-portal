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

// The bulk tools' model adds a status enum, which "Colour by field" and "Set a field" pick from.
const LINKML_STATUS = LINKML.replace("audience]", "audience, status]")
  .replace("slots:\n  id", "enums:\n  EventStatus:\n    permissible_values: { open: {}, cancelled: {} }\nslots:\n  id")
  .concat("  status: { range: EventStatus, title: Status }\n");

interface Recorded {
  asked: string[];
  deleted: string[];
  patched: { id: string; body: unknown; reason: string | null }[];
  /** Live changes the space's event stream has sent. */
  live: number;
}

async function stubApi(page: Page, asked: string[], deleted: string[], extra?: { linkml: string; seen: Recorded }): Promise<void> {
  const linkml = extra?.linkml ?? LINKML;
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
      return route.fulfill({ status: 200, contentType: "text/yaml", body: linkml });
    }
    if (extra && path.endsWith("/attrs") && method === "PATCH") {
      // The Policy refuses the value on the second row: the dialog names it, the others land.
      const id = decodeURIComponent(path.split("/entities/")[1]?.replace(/\/attrs$/, "") ?? "");
      if (id.endsWith(":2")) return json({ title: "Forbidden", detail: "the Policy does not grant status on this row" }, 403);
      extra.seen.patched.push({ id, body: route.request().postDataJSON(), reason: route.request().headers()["jc-reason"] ?? null });
      return route.fulfill({ status: 204 });
    }
    if (extra && path.endsWith("/live")) {
      // The change comes after the rows are on the screen, as one made by someone else would.
      if (extra.seen.live === 0) await page.getByText("Workshop for Families").first().waitFor();
      extra.seen.live += 1;
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: extra.seen.live === 1 ? 'retry: 600000\nevent: changed\ndata: {"type":"Event"}\n\n' : "retry: 600000\n\n",
      });
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
      // After a live change the third row holds another name: the grid flashes it.
      const rows = Array.from({ length: 24 }, (_, i) => event(i + 1)).map((row, i) =>
        extra && extra.seen.live > 0 && i === 2 ? { ...row, name: { type: "Property", value: "Renamed while you looked" } } : row,
      );
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
      return json(list([manifest("DataModel", "helsinki-events", { contextSpaceRef: SPACE, version: "1.0.0", classes: [TYPE], linkml })]));
    }
    if (path.endsWith("/endpoints")) {
      return json(list([manifest("Endpoint", "app-helsinki-data", { contextSpaceRef: SPACE, slug: "k7m2qz4tv6xh3n5jb2ryd3wcfa", audience: "project", enabledRepresentations: ["ngsi-ld", "csv"] })]));
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

for (const [label, width, height] of [["desktop-1440", 1440, 900], ["phone-400", 400, 860]] as const) {
  test(`The grid's bulk tools, live flash, colours and share (${label})`, async ({ page }) => {
    const seen: Recorded = { asked: [], deleted: [], patched: [], live: 0 };
    await page.setViewportSize({ width, height });
    await stubApi(page, seen.asked, seen.deleted, { linkml: LINKML_STATUS, seen });
    await page.goto(`/projects/${PROJECT}/spaces/${SPACE}?lang=en`);
    const toolbar = page.getByTestId("grid-toolbar");

    // A live change reads the rows again and flashes the one that changed, its reason named.
    await expect(page.getByText("Renamed while you looked")).toBeVisible();
    await expect(page.locator("tr.jc-grid-tr--info")).toHaveCount(1);
    await expect(page.locator("tr.jc-grid-tr--info")).toContainText("Renamed while you looked");
    await shot(page, `grid-live-flash-${label}`);

    // Colour by an enum field: one rule per value.
    await toolbar.locator("summary", { hasText: "Row colour" }).click();
    await page.getByRole("combobox", { name: "Colour by field" }).selectOption("status");
    await expect(page.getByRole("textbox", { name: "When" })).toHaveCount(2);
    await expect(page.getByRole("textbox", { name: "When" }).first()).toHaveValue('status=="open"');
    await shot(page, `grid-colour-by-${label}`);
    await page.keyboard.press("Escape");

    // Check three rows: export just them, then set a field in each through the Policy.
    for (const at of [0, 1, 3]) await page.getByRole("checkbox", { name: /^Select row: / }).nth(at).click();
    await expect(page.getByText("3 selected")).toBeVisible();
    const csv = page.getByRole("region", { name: "Selected rows" }).getByRole("link", { name: /CSV/i });
    await expect(csv).toHaveAttribute("href", /[?&]id=urn%3Angsi-ld%3AEvent%3Ahel\.fi%3Alinkedevents%3A1%2C/);
    await page.getByRole("button", { name: "Set a field" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "Field" }).selectOption("audience");
    await dialog.getByRole("textbox", { name: "New value" }).fill("4.5");
    await expect(dialog.getByText("This field takes a value of type integer.")).toBeVisible();
    await dialog.getByRole("combobox", { name: "Field" }).selectOption("status");
    await dialog.getByRole("combobox", { name: "New value" }).selectOption("cancelled");
    await expect(dialog.getByRole("button", { name: "Set in 3 rows" })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "Why" }).fill("Venue closed for repairs");
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, `grid-bulk-set-${label}`);
    await dialog.getByRole("button", { name: "Set in 3 rows" }).click();
    await expect(dialog.getByText("1 row was not changed")).toBeVisible();
    await expect(dialog.getByText(/the Policy does not grant status on this row/)).toBeVisible();
    expect(seen.patched.map((each) => each.id)).toEqual(["urn:ngsi-ld:Event:hel.fi:linkedevents:1", "urn:ngsi-ld:Event:hel.fi:linkedevents:4"]);
    expect(seen.patched[0]?.body).toEqual({ status: { type: "Property", value: "cancelled" } });
    await shot(page, `grid-bulk-set-refused-${label}`);
    await page.keyboard.press("Escape");

    // Share the view: the public Endpoint proposal opens from the toolbar with the view's fields.
    await toolbar.locator("summary", { hasText: "Share view" }).click();
    await expect(page.getByRole("textbox", { name: "Endpoint name" })).toBeVisible();
    await expect(page.getByText("the view's filter is not part of it")).toBeVisible();
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sideways).toBeLessThanOrEqual(0);
    await shot(page, `grid-share-${label}`);
  });
}

// T-5188: the Sort panel's keys and the Group panel's fields reach the endpoint as one `orderBy`,
// each group gets a header with the endpoint's count, and the footer reads a maximum off the
// endpoint's own order. The space surface here filters, orders and counts like the broker does.
type Row = ReturnType<typeof event>;
const valueOf = (row: Row, attr: string): unknown => (row as Record<string, { value?: unknown } | undefined>)[attr]?.value;

function answer(url: URL): { rows: Row[]; total: number } {
  let rows = Array.from({ length: 24 }, (_, i) => event(i + 1));
  for (const term of (url.searchParams.get("q") ?? "").split(";").filter(Boolean)) {
    const equal = /^(\w+)=="(.*)"$/.exec(term);
    if (equal) rows = rows.filter((row) => valueOf(row, equal[1]) === equal[2]);
    else if (/^!\w+$/.test(term)) rows = rows.filter((row) => valueOf(row, term.slice(1)) === undefined);
    else if (/^\w+$/.test(term)) rows = rows.filter((row) => valueOf(row, term) !== undefined);
  }
  const keys = (url.searchParams.get("orderBy") ?? "").split(",").filter(Boolean).map((key) => key.split(";"));
  rows.sort((a, b) => {
    for (const [attr, dir] of keys) {
      const x = valueOf(a, attr);
      const y = valueOf(b, attr);
      if (x === y) continue;
      if (x === undefined || y === undefined) return x === undefined ? 1 : -1;
      const by = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return dir === "desc" ? -by : by;
    }
    return 0;
  });
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 24);
  return { rows: rows.slice(offset, offset + limit), total: rows.length };
}

for (const [label, width, height] of [["desktop-1440", 1440, 900], ["phone-400", 400, 860]] as const) {
  test(`The grid sorts by three keys, groups with headers and reads a maximum (${label})`, async ({ page }) => {
    const orders: string[] = [];
    await page.setViewportSize({ width, height });
    await stubApi(page, [], []);
    await page.route((url) => url.pathname.startsWith("/cs/") && url.pathname.endsWith("/entities"), async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET") return route.fallback();
      orders.push(url.searchParams.get("orderBy") ?? "");
      const { rows, total } = answer(url);
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "NGSILD-Results-Count": String(total) }, body: JSON.stringify(rows) });
    });
    await page.goto(`/projects/${PROJECT}/spaces/${SPACE}?lang=en`);
    const toolbar = page.getByTestId("grid-toolbar");
    await expect(page.getByText("Workshop for Families").first()).toBeVisible();

    // Sort: empty says what to do; two keys, the first turned round.
    await toolbar.locator("summary", { hasText: "Sort" }).click();
    await expect(page.getByText("No order set: the rows come as the endpoint keeps them.", { exact: false })).toBeVisible();
    await shot(page, `grid-sort-empty-${label}`);
    await page.getByRole("button", { name: "Add a sort key" }).click();
    await page.getByRole("combobox", { name: "Sort rows by, field 1" }).selectOption("startDate");
    await page.getByRole("combobox", { name: "Direction of sort key 1" }).selectOption("desc");
    await page.getByRole("button", { name: "Add a sort key" }).click();
    await page.getByRole("combobox", { name: "Sort rows by, field 2" }).selectOption("name");
    await expect.poll(() => orders.at(-1)).toBe("startDate;desc,name");
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, `grid-sort-two-keys-${label}`);
    await page.keyboard.press("Escape");
    await expect(toolbar.locator("summary", { hasText: "Sort" })).toContainText("2");

    // Group by the start: the rows come ordered by it first, each date under a counted header.
    await toolbar.locator("summary", { hasText: "Group" }).click();
    await page.getByRole("button", { name: "Add a group field" }).click();
    await page.getByRole("combobox", { name: "Group rows by, field 1" }).selectOption("startDate");
    await expect.poll(() => orders.at(-1)).toBe("startDate;desc,name");
    await page.keyboard.press("Escape");
    const headers = page.locator("tr.jc-grid-group");
    await expect(headers.first()).toContainText("Starts");
    await expect(headers.first()).toContainText("2026-10-27");
    await expect(headers.first()).toContainText("3 rows");
    expect(await headers.count()).toBe(7);
    expect(await axeViolations(page)).toEqual([]);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sideways).toBeLessThanOrEqual(0);
    await shot(page, `grid-grouped-${label}`);

    // A second group level under the first.
    await toolbar.locator("summary", { hasText: "Group" }).click();
    await page.getByRole("button", { name: "Add a group field" }).click();
    await page.getByRole("combobox", { name: "Group rows by, field 2" }).selectOption("name");
    await page.keyboard.press("Escape");
    await expect(page.locator('tr.jc-grid-group[data-level="1"]').first()).toContainText("1 row");
    await shot(page, `grid-grouped-two-${label}`);

    // The footer's maximum is the first row of the endpoint's descending order among filled rows.
    await page.getByRole("combobox", { name: "Footer of Places" }).selectOption("max");
    await expect.poll(() => orders.includes("audience;desc")).toBe(true);
    await expect(page.locator("tfoot output").filter({ hasText: "230" })).toBeVisible();
    await page.locator("tfoot").scrollIntoViewIfNeeded();
    await shot(page, `grid-footer-max-${label}`);
  });
}
