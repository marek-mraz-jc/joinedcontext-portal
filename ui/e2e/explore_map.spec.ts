import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { axeViolations } from "./axe";

// The explorer's map (T-3256): a type whose model gives it a location opens on a Map tab beside
// the table, reads the view through the endpoint with the table's own filter, and draws it.
// `vite preview` has no API and no gateway, so both are answered in the browser.

const TYPE = "BikeHireDockingStation";
const SLUG = "scsd2eehkx42n53z2zyd6vshfh7s7irf";
const list = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });
const LINKML = [
  "id: https://hel.fi/models/mobility",
  "name: helsinki-mobility",
  "classes:",
  `  ${TYPE}:`,
  "    slots: [id, availableBikeNumber, name, location]",
  "slots:",
  "  id: {}",
  "  availableBikeNumber: { range: integer }",
  "  name: { range: string }",
  "  location:",
  "    range: string",
  "    annotations:",
  "      ngsi_ld_kind: GeoProperty",
  "",
].join("\n");

function dock(n: number, bikes: number, lon: number, lat: number) {
  return {
    id: `urn:ngsi-ld:${TYPE}:hel.fi:mobility:${String(n).padStart(3, "0")}`,
    type: TYPE,
    availableBikeNumber: bikes,
    name: `Dock ${n}`,
    location: { type: "Point", coordinates: [lon, lat] },
  };
}

async function stub(page: Page): Promise<string[]> {
  const reads: string[] = [];
  await page.route("**/{api,cs}/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, headers: Record<string, string> = {}) =>
      route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(body) });
    const path = url.pathname;
    // No basemap here: the map draws on its plain ground, as on an installation without one.
    if (path.includes("/basemap/")) return route.fulfill({ status: 404, body: "" });
    if (path.endsWith("/auth/me")) return json({ subject: "s1", username: "jana", name: "Jana Kováčová", roles: [] });
    if (path.endsWith("/access/check")) return json({ decision: false });
    if (path.endsWith("/access")) return json({ permissions: [{ action: "queryEntity", resource: { type: TYPE }, attributes: "*" }], prohibitions: [] });
    if (path.endsWith("/entities")) {
      reads.push(url.search);
      const docks = Array.from({ length: 40 }, (_, i) => dock(i + 1, i % 5, 24.9 + (i % 8) * 0.01, 60.15 + Math.floor(i / 8) * 0.01));
      const q = url.searchParams.get("q") ?? "";
      const shown = q.includes("availableBikeNumber==0") ? docks.filter((d) => d.availableBikeNumber === 0) : docks;
      return json(shown, { "NGSILD-Results-Count": String(shown.length) });
    }
    if (path === "/api/v1/projects") return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "ProjectList", items: [{ name: "helsinki" }] });
    if (path.endsWith("/spaces")) {
      return json(list([{ apiVersion: "joinedcontext.com/v1alpha1", kind: "ContextSpace", metadata: { name: "mobility", namespace: "helsinki", title: { en: "Mobility" } }, spec: { dataModelRef: "helsinki-mobility" }, status: { phase: "Live" } }]));
    }
    if (path.endsWith("/endpoints")) {
      return json(list([{ apiVersion: "joinedcontext.com/v1alpha1", kind: "Endpoint", metadata: { name: "helsinki-bikes", namespace: "helsinki", title: { en: "Helsinki city bike stations" } }, spec: { contextSpaceRef: "mobility", slug: SLUG, audience: "public", enabledRepresentations: ["ngsi-ld"] }, status: { phase: "Live" } }]));
    }
    if (path.endsWith("/datamodels")) {
      return json(list([{ apiVersion: "joinedcontext.com/v1alpha1", kind: "DataModel", metadata: { name: "helsinki-mobility", namespace: "helsinki" }, spec: { version: "1.0.0", classes: [TYPE], linkml: LINKML } }]));
    }
    return json(list([]));
  });
  return reads;
}

test("a located type opens on the map with the view's filter", async ({ page }) => {
  const reads = await stub(page);
  await page.goto(`/projects/helsinki/explore?endpoint=helsinki-bikes&type=${TYPE}&q=${encodeURIComponent("availableBikeNumber==0")}&lang=en`);
  await expect(page.locator("tbody tr").first()).toBeVisible();

  await page.getByRole("tab", { name: "Map" }).click();
  await expect(page.getByRole("status").filter({ hasText: "on the map" })).toHaveText("8 of 8 on the map");
  await expect(page.getByRole("application", { name: `Map of ${TYPE}` })).toBeVisible();
  expect(reads.some((search) => search.includes("availableBikeNumber%3D%3D0") && search.includes("attrs=location"))).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  // Back to the table, which waited where it was.
  await page.getByRole("tab", { name: "Entities" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(8);
});
