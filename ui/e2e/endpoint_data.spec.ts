import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { attributeTable } from "./attributeAccess";

// T-5082: an Endpoint's own page shows its rows, read with the person's own session through the
// Endpoint. The endpoint orders the whole answer (`orderBy`), the address keeps the type, query and
// order, the space grid's toolbar (T-6303) hides and filters, and the rows download as CSV under the endpoint's limits.

const API = "joinedcontext.com/v1alpha1";
const SLUG = "k7m2qz4tv6xh3n5jb2ryd3wcfa";
const ENDPOINT = {
  apiVersion: API,
  kind: "Endpoint",
  metadata: { name: "air", namespace: "helsinki", labels: { "joinedcontext.com/space": "ovzdusie" } },
  spec: { contextSpaceRef: "ovzdusie", slug: SLUG, audience: "public", enabledRepresentations: ["ngsi-ld", "csv"] },
  status: { phase: "Live" },
};
const SCHEMA = {
  $defs: {
    AirQualityObserved: {
      properties: {
        name: { type: "string", description: "Where the station stands" },
        pm10: { type: "number", description: "PM10 in µg/m³, the hourly mean" },
        dateObserved: { type: "string", format: "date-time", description: "When the hour ended" },
        location: { $ref: "#/$defs/GeoJSONPoint" },
      },
    },
  },
};
const STATIONS = ["Kallio", "Mannerheimintie", "Mäkelänkatu", "Töölö", "Vartiokylä", "Länsisatama", "Kumpula"];
const ROWS = Array.from({ length: 42 }, (_, n) => ({
  id: `urn:ngsi-ld:AirQualityObserved:helsinki-${String(n).padStart(3, "0")}`,
  type: "AirQualityObserved",
  name: { type: "Property", value: `${STATIONS[n % STATIONS.length]} ${n}` },
  ...(n % 9 === 4 ? {} : { pm10: { type: "Property", value: (n * 37) % 90 } }),
  dateObserved: { type: "Property", value: new Date(Date.UTC(2026, 9, 21, n % 24)).toISOString() },
  location: { type: "GeoProperty", value: { type: "Point", coordinates: [24.9 + n / 1000, 60.17] } },
}));

/** The broker's order (CIM 009 4.23): by value, an entity lacking the attribute last either way. */
function ordered(orderBy: string | null) {
  if (!orderBy) return ROWS;
  const [attr, dir] = orderBy.split(";");
  const value = (row: (typeof ROWS)[number]) => (row as Record<string, { value?: unknown } | string>)[attr];
  const of = (row: (typeof ROWS)[number]) => {
    const raw = attr === "id" ? row.id : (value(row) as { value?: unknown } | undefined)?.value;
    return raw as string | number | undefined;
  };
  return [...ROWS].sort((a, b) => {
    const x = of(a);
    const y = of(b);
    if (x === undefined || y === undefined) return Number(x === undefined) - Number(y === undefined);
    const by = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return dir === "desc" ? -by : by;
  });
}

async function stub(page: Page, entities: "rows" | "empty" | "refused" | "values-fail", asked: URL[]): Promise<void> {
  const list = (items: unknown[]) => ({ apiVersion: API, kind: "List", items });
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) return json({ subject: "s1", username: "steward", name: "Steward", email: "s@hel.fi", roles: ["portal-editor"] });
    if (path === "/api/v1/projects") return json(list([{ name: "helsinki" }]));
    if (path === "/api/v1/projects/helsinki/endpoints/air") return json(ENDPOINT);
    return json(list([]));
  });
  await page.route("**/cs/**", (route) => route.fulfill({ contentType: "application/ld+json", body: "[]" }));
  await page.route(`**/api/endpoint/${SLUG}/**`, (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
      route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
    // Every shown column readable, so the page offers the CSV (T-5530).
    if (url.pathname.endsWith("/access/attributes")) return json(attributeTable("AirQualityObserved", ["name", "pm10", "dateObserved", "location"]));
    if (url.pathname.endsWith("/schema/index.json")) return json({ models: [{ name: "air", version: 1 }] });
    if (url.pathname.endsWith("/schema/v1/json-schema")) return json(SCHEMA);
    if (url.pathname.endsWith("/ngsi-ld/v1/entities")) {
      asked.push(url);
      // The page reads with the person's session cookie, never with a token of its own.
      expect(route.request().headers().authorization).toBeUndefined();
      // The header filter's value list reads pages of a thousand; this broker is too busy for them.
      if (entities === "values-fail" && url.searchParams.get("limit") === "1000") {
        return json({ title: "Service Unavailable", detail: "the broker is busy" }, {}, 503);
      }
      if (entities === "refused") {
        return json({ title: "Forbidden", detail: "no policy grants you this type on this endpoint" }, {}, 403);
      }
      const all = entities === "empty" ? [] : ordered(url.searchParams.get("orderBy"));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 25);
      return json(all.slice(offset, offset + limit), { "NGSILD-Results-Count": String(all.length) });
    }
    return json({}, {}, 404);
  });
}

const dir = join("test-results", "T-6303");
mkdirSync(dir, { recursive: true });
mkdirSync(join("test-results", "T-6328"), { recursive: true });

for (const width of [1440, 400]) {
  test(`an Endpoint's rows sort through the endpoint and keep their address at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const asked: URL[] = [];
    await stub(page, "rows", asked);
    await page.goto("/projects/helsinki/endpoints/air?lang=en");
    const section = page.locator("section", { has: page.getByRole("heading", { name: "Data", exact: true }) });
    await expect(section.getByRole("grid")).toBeVisible();
    await expect(section.getByText("42 matching")).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: join(dir, `data-filled-${width}.png`) });

    // Highest PM10 first, across all 42 rows: the endpoint is asked, the first page shows 89.
    const sort = section.getByRole("button", { name: "Sort all rows by PM10", exact: true });
    await sort.click();
    await sort.click();
    await expect.poll(() => asked.at(-1)?.searchParams.get("orderBy")).toBe("pm10;desc");
    await expect(page).toHaveURL(/dataSort=pm10%3Bdesc/);
    await expect(section.getByRole("gridcell", { name: "Your access: PM10 89", exact: true }).first()).toBeVisible();
    await section.screenshot({ path: join(dir, `data-sorted-${width}.png`) });

    // The address opens the same order on a fresh load.
    await page.reload();
    await expect.poll(() => asked.at(-1)?.searchParams.get("orderBy")).toBe("pm10;desc");
    await expect(section.getByRole("columnheader", { name: /Sort all rows by PM10/ }).first()).toHaveAttribute("aria-sort", "descending");

    const csv = section.getByRole("link", { name: "Download these rows as CSV" });
    expect(await csv.getAttribute("href")).toBe(`/api/endpoint/${SLUG}/file.csv?type=AirQualityObserved&orderBy=pm10%3Bdesc`);

    // The space grid's own toolbar (T-6303): Hide fields names each column as the header does.
    const toolbar = section.getByTestId("grid-toolbar");
    await toolbar.getByText("Hide fields", { exact: true }).click();
    await expect(section.getByRole("checkbox", { name: "PM10" })).toBeChecked();
    await page.screenshot({ path: join(dir, `data-hide-${width}.png`) });
    await page.keyboard.press("Escape");

    // Filter: a condition of the panel reaches the endpoint as `q`, and the CSV downloads those rows.
    await toolbar.getByText("Filter", { exact: true }).click();
    const panel = toolbar.locator("details[open]");
    await panel.getByRole("button", { name: "Add condition", exact: true }).click();
    await panel.getByRole("combobox", { name: "Field" }).selectOption("pm10");
    await panel.getByRole("combobox", { name: "Operator" }).selectOption("gt");
    await panel.getByRole("spinbutton", { name: "Value", exact: true }).fill("40");
    await expect.poll(() => asked.at(-1)?.searchParams.get("q")).toBe("pm10>40");
    await page.screenshot({ path: join(dir, `data-filter-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(toolbar.locator("summary", { hasText: "Filter" })).toContainText("1");
    await expect(page.getByRole("list", { name: "Active filters" })).toBeVisible();
    expect(await csv.getAttribute("href")).toBe(`/api/endpoint/${SLUG}/file.csv?type=AirQualityObserved&q=pm10%3E40&orderBy=pm10%3Bdesc`);
    await section.screenshot({ path: join(dir, `data-filtered-${width}.png`) });

    await section.getByRole("button", { name: "Full window" }).click();
    const full = page.getByRole("dialog", { name: "What this endpoint answers" });
    await expect(full).toBeVisible();
    await page.screenshot({ path: join(dir, `data-full-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(full).toBeHidden();
  });

  // T-6328: the owner could not see where to click to filter. A header's funnel opens the column's
  // values over the whole answer; "Only" filters to one of them: two clicks, sent to the endpoint as `q`.
  for (const lang of ["en", "sk"]) {
    test(`a column filters from its header in two clicks, ${lang}, at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const asked: URL[] = [];
      await stub(page, "rows", asked);
      await page.goto(`/projects/helsinki/endpoints/air?lang=${lang}`);
      const grid = page.getByRole("grid");
      await expect(grid).toBeVisible();
      const words = lang === "sk" ? { open: "Filtrovať stĺpec", name: "Názov", only: "Iba toto", menu: "Možnosti stĺpca", chips: "Aktívne filtre", remove: "Odstrániť filter" } : { open: "Filter column", name: "Name", only: "Only", menu: "Column options", chips: "Active filters", remove: "Remove filter" };
      const tag = `${lang}-${width}`;

      await grid.getByRole("button", { name: `${words.menu}: ${words.name}` }).click();
      await page.screenshot({ path: join(dir, `../T-6328/menu-open-${tag}.png`) });
      await page.keyboard.press("Escape");

      await grid.getByRole("button", { name: new RegExp(`^${words.open}: ${words.name}`) }).click();
      const filter = page.getByRole("dialog", { name: new RegExp(`: ${words.name}$`) });
      await expect(filter.getByRole("list")).toBeVisible();
      // Every one of the 42 rows, not the page of 25, read with only the one attribute.
      await expect(filter.getByRole("listitem")).toHaveCount(42);
      expect(asked.some((url) => url.searchParams.get("attrs") === "name" && url.searchParams.get("limit") === "1000")).toBe(true);
      await page.screenshot({ path: join(dir, `../T-6328/filter-open-${tag}.png`) });
      await filter.getByRole("button", { name: `${words.only}: Kallio 0` }).click();

      await expect.poll(() => asked.at(-1)?.searchParams.get("q")).toBe('name=="Kallio 0"');
      const chips = page.getByRole("list", { name: words.chips });
      await expect(chips).toBeVisible();
      await expect(grid.getByRole("button", { name: new RegExp(`^${words.open}: ${words.name} \\(`) })).toHaveAttribute("data-active", "");
      await page.screenshot({ path: join(dir, `../T-6328/filtered-${tag}.png`) });

      await chips.getByRole("button", { name: new RegExp(`^${words.remove}`) }).click();
      await expect.poll(() => asked.at(-1)?.searchParams.get("q")).toBeNull();
      await expect(chips).toBeHidden();
    });
  }

  test(`a header filter whose values cannot be read still offers its condition at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const asked: URL[] = [];
    await stub(page, "values-fail", asked);
    await page.goto("/projects/helsinki/endpoints/air?lang=en");
    const grid = page.getByRole("grid");
    await grid.getByRole("button", { name: /^Filter column: PM10/ }).click();
    const filter = page.getByRole("dialog", { name: "Filter: PM10" });
    await expect(filter.getByRole("alert")).toContainText("The values could not be read");
    await filter.getByRole("combobox", { name: "Condition: PM10" }).selectOption("gt");
    await filter.getByRole("spinbutton", { name: "Value: PM10" }).fill("40");
    await page.screenshot({ path: join(dir, `../T-6328/filter-error-${width}.png`) });
    await filter.getByRole("button", { name: "Apply" }).click();
    await expect.poll(() => asked.at(-1)?.searchParams.get("q")).toBe("pm10>40");
  });

  test(`an Endpoint with no rows and one that refuses say so at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stub(page, "empty", []);
    await page.goto("/projects/helsinki/endpoints/air?lang=en");
    const section = page.locator("section", { has: page.getByRole("heading", { name: "Data", exact: true }) });
    await expect(section.getByRole("grid")).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: join(dir, `data-empty-${width}.png`) });

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await stub(page, "refused", []);
    await page.reload();
    await expect(section.getByText("no policy grants you this type on this endpoint")).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: join(dir, `data-refused-${width}.png`) });
  });
}
