import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// T-5082: an Endpoint's own page shows its rows, read with the person's own session through the
// Endpoint. The endpoint orders the whole answer (`orderBy`), the address keeps the type, query and
// order, the Fields name each column, and the rows download as CSV under the endpoint's limits.

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

async function stub(page: Page, entities: "rows" | "empty" | "refused", asked: URL[]): Promise<void> {
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
    if (url.pathname.endsWith("/schema/index.json")) return json({ models: [{ name: "air", version: 1 }] });
    if (url.pathname.endsWith("/schema/v1/json-schema")) return json(SCHEMA);
    if (url.pathname.endsWith("/ngsi-ld/v1/entities")) {
      asked.push(url);
      // The page reads with the person's session cookie, never with a token of its own.
      expect(route.request().headers().authorization).toBeUndefined();
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

const dir = join("test-results", "T-5082");
mkdirSync(dir, { recursive: true });

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
    const sort = section.getByRole("button", { name: "Sort all rows by pm10" });
    await sort.click();
    await sort.click();
    await expect.poll(() => asked.at(-1)?.searchParams.get("orderBy")).toBe("pm10;desc");
    await expect(page).toHaveURL(/dataSort=pm10%3Bdesc/);
    await expect(section.getByRole("gridcell", { name: "89", exact: true }).first()).toBeVisible();
    await section.screenshot({ path: join(dir, `data-sorted-${width}.png`) });

    // The address opens the same order on a fresh load.
    await page.reload();
    await expect.poll(() => asked.at(-1)?.searchParams.get("orderBy")).toBe("pm10;desc");
    await expect(section.getByRole("columnheader", { name: /pm10/ }).first()).toHaveAttribute("aria-sort", "descending");

    const csv = section.getByRole("link", { name: "Download these rows as CSV" });
    expect(await csv.getAttribute("href")).toBe(`/api/endpoint/${SLUG}/file.csv?type=AirQualityObserved&orderBy=pm10%3Bdesc`);

    await section.getByText("Fields", { exact: true }).first().click();
    await expect(section.getByText("PM10 in µg/m³, the hourly mean")).toBeVisible();
    await section.getByRole("list", { name: "Fields" }).screenshot({ path: join(dir, `data-fields-${width}.png`) });

    await section.getByRole("button", { name: "Full window" }).click();
    const full = page.getByRole("dialog", { name: "What this endpoint answers" });
    await expect(full).toBeVisible();
    await page.screenshot({ path: join(dir, `data-full-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(full).toBeHidden();
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
