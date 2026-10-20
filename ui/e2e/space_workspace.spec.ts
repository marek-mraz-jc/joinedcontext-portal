import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { axeViolations } from "./axe";

// A space's "Look inside" as a data workspace (T-4825): it lands on the rows, the entity types
// and their saved views in a left list, the model, quality, retention, endpoints and policies as
// tabs, the broker's count under the rows. `vite preview` has no Portal API behind it, so the API
// and the space surface are answered in the browser. With SHOTS_DIR set, the 1440 px and 400 px
// screenshots are written there for the task's evidence.

const PROJECT = "helsinki";
const SPACE = "helsinki-kpi";
const TYPES = ["KeyPerformanceIndicator", "BikeHireDockingStation"];

const list = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });
const manifest = (kind: string, name: string, spec: Record<string, unknown>, title?: string) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind,
  metadata: { name, namespace: PROJECT, ...(title ? { title: { en: title } } : {}) },
  spec,
  status: { phase: "Live" },
});

const LINKML = [
  "id: https://hel.fi/models/kpi",
  "name: helsinki-kpi",
  "classes:",
  "  KeyPerformanceIndicator:",
  "    title: Key performance indicator",
  "    slots: [id, name, kpiValue, category]",
  "  BikeHireDockingStation:",
  "    title: Bike station",
  "    slots: [id, name, availableBikeNumber]",
  "slots:",
  "  id: {}",
  "  name: { range: string, title: Name }",
  "  kpiValue: { range: float, title: Value }",
  "  category: { range: string, title: Category }",
  "  availableBikeNumber: { range: integer }",
  "",
].join("\n");

const VIEW = {
  id: "7f1c2a9e-4b1d-4a57-9a0e-2f6d1c3b8e01",
  type: TYPES[0],
  kind: "grid",
  mode: "collaborative",
  title: "Over target",
  owner: "jana.kovacova",
  config: { q: "kpiValue>50" },
  version: 1,
  createdAt: "2026-10-20T15:00:00Z",
  updatedAt: "2026-10-20T15:00:00Z",
};

function kpi(n: number) {
  return {
    id: `urn:ngsi-ld:KeyPerformanceIndicator:hel.fi:kpi:${n}`,
    type: TYPES[0],
    name: { type: "Property", value: `District ${n}` },
    kpiValue: { type: "Property", value: 10 * n },
    category: { type: "Property", value: n % 2 ? "quantitative" : "qualitative" },
  };
}

async function stubApi(page: Page): Promise<void> {
  await page.route("**/{api,cs}/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) {
      return json({ subject: "b7c1e0f4", username: "jana.kovacova", name: "Jana Kováčová", roles: ["portal-editor"] });
    }
    if (path.endsWith("/datamodels/helsinki-kpi/source")) {
      return route.fulfill({ status: 200, contentType: "text/yaml", body: LINKML });
    }
    if (path.endsWith("/entities")) {
      const rows = Array.from({ length: 12 }, (_, i) => kpi(i + 1));
      return json(rows, 200, { "NGSILD-Results-Count": String(rows.length) });
    }
    if (path === "/api/v1/projects") return json({ kind: "ProjectList", items: [{ name: PROJECT }] });
    if (path.endsWith(`/spaces/${SPACE}/usage`)) {
      return json({ entities: 14232, broker: "main", observedAt: "2026-10-20T16:00:00Z" });
    }
    if (path.endsWith(`/spaces/${SPACE}/views`)) return json({ items: [VIEW] });
    if (path.endsWith(`/spaces/${SPACE}`)) {
      return json(manifest("ContextSpace", SPACE, { dataModelRef: "helsinki-kpi" }, "Helsinki KPIs"));
    }
    if (path.endsWith("/datamodels")) {
      return json(list([manifest("DataModel", "helsinki-kpi", { contextSpaceRef: SPACE, version: "1.0.0", classes: TYPES, linkml: LINKML })]));
    }
    if (path.endsWith("/endpoints")) {
      return json(list([manifest("Endpoint", "kpi-public", { contextSpaceRef: SPACE, slug: "k7m2qz4tv6xh3n5jb2ryd3wcfa", audience: "public", enabledRepresentations: ["ngsi-ld"] })]));
    }
    return json(list([]));
  });
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

for (const [label, width, height] of [["desktop-1440", 1440, 900], ["phone-400", 400, 860]] as const) {
  test(`Look inside lands on the rows with the types on the left (${label})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await stubApi(page);
    await page.goto(`/projects/${PROJECT}/spaces/${SPACE}?lang=en`);

    const tabs = page.getByRole("tablist", { name: "Parts of the space" });
    await expect(tabs.getByRole("tab", { name: "Data", exact: true })).toHaveAttribute("aria-selected", "true");
    const types = page.getByRole("navigation", { name: "Entity types" });
    await expect(types.locator('button[aria-current="true"]').first()).toHaveAttribute("title", TYPES[0]);
    await expect(types.getByRole("button", { name: "Over target" })).toBeVisible();
    await expect(page.getByText("District 1", { exact: true })).toBeVisible();
    await expect(page.getByTestId("space-total")).toHaveText("The space holds 14,232 entities.");
    // Nothing wider than the screen: the page body never scrolls sideways (UI-27).
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sideways).toBeLessThanOrEqual(0);
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, `look-inside-${label}`);

    await tabs.getByRole("tab", { name: "Data model" }).click();
    await expect(page).toHaveURL(/[?&]tab=model/);
    await expect(page.getByRole("table", { name: "Entity types" })).toBeVisible();
    await shot(page, `model-tab-${label}`);
  });
}
