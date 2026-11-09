import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { join } from "node:path";
import { axeViolations } from "./axe";
import { withODataEndpoints } from "./odataEndpoints";

// T-6645: the Endpoints list is the SDK grid over the project's OData set. One journey per state
// (filled, empty, error, refused edit) at 1440 and 400 px, through the real grid and its OData
// source, the server's answers stubbed in the browser.

const API = "joinedcontext.com/v1alpha1";
const SHOTS = process.env.JC_SHOTS_DIR ?? "test-results/endpoints-odata";

function endpoint(project: string, name: string, title: string, space: string, extra: Record<string, unknown> = {}) {
  return {
    apiVersion: API,
    kind: "Endpoint",
    metadata: { name, namespace: project, title: { en: title } },
    spec: { contextSpaceRef: space, slug: `${name}k7m2qz4tv6xh3n5jb2ryd3w`.slice(0, 26), audience: "public", enabledRepresentations: ["ngsi-ld", "mcp"], ...extra },
    status: { phase: "Live" },
  };
}

const HELSINKI = [
  endpoint("helsinki", "air-quality", "Air quality and weather", "air"),
  endpoint("helsinki", "events", "Helsinki events", "tapahtumat", { audience: "organization", enabledRepresentations: ["ngsi-ld", "ical"] }),
  endpoint("helsinki", "noise", "Noise sensors", "air", { audience: "project-list", allowedProjects: ["espoo"] }),
];
const ESPOO = [endpoint("espoo", "parking", "Parking places in Espoo", "liikenne", { audience: "project-list", allowedProjects: ["helsinki"] })];

const MAY = {
  project: "helsinki",
  bootstrap: false,
  grants: [
    {
      role: "steward",
      binding: "stewards",
      rule: { kinds: ["Endpoint", "SharedSpaceReference", "ContextSpace"], verbs: ["read", "propose", "delete"] },
    },
  ],
};

// A shot is taken once the grid has its answer: no Loading line under rows or in place of them.
async function settled(page: Page): Promise<void> {
  await expect(page.locator(".jc-grid-loading")).toHaveCount(0);
}

async function stubApi(page: Page, own: unknown[], options: { failOData?: boolean } = {}): Promise<void> {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const list = (items: unknown[]) => json({ apiVersion: API, kind: "List", items });
    if (path.endsWith("/auth/me")) return json({ subject: "s", username: "jana", name: "Jana", email: "jana@hel.fi", roles: [] });
    if (path.endsWith("/permissions/me")) return json(MAY);
    if (path.endsWith("/events")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    if (path === "/api/v1/projects") return list([{ name: "helsinki" }, { name: "espoo" }]);
    if (path === "/api/v1/projects/helsinki/endpoints") return list(own);
    if (path === "/api/v1/projects/espoo/endpoints") return list(ESPOO);
    if (path === "/api/v1/projects/helsinki/spaces") {
      return list(["air", "tapahtumat"].map((name) => ({ apiVersion: API, kind: "ContextSpace", metadata: { name, namespace: "helsinki" }, spec: {}, status: { phase: "Live" } })));
    }
    if (path === "/api/v1/projects/helsinki/usage/endpoints") {
      return json({ window: "7d", endpoints: own.map((_, i) => ({ name: (own[i] as { metadata: { name: string } }).metadata.name, total: 120 * (i + 1) })) });
    }
    return list([]);
  });
  await withODataEndpoints(page);
  if (options.failOData) {
    await page.route(/\/odata\/endpointList\?/, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "ServiceUnavailable", message: "the Endpoints could not be read right now" } }),
      }),
    );
  }
}

const grid = (page: Page) => page.getByRole("grid", { name: "Endpoints" });

for (const width of [1440, 400]) {
  test.describe(`the Endpoints grid at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("filled: own and shared rows from the OData set, a search, the next page asked of the server", async ({ page }) => {
      await stubApi(page, HELSINKI);
      const reads: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/odata/endpointList?")) reads.push(decodeURIComponent(request.url()));
      });
      await page.goto("/projects/helsinki/endpoints?lang=en");
      await expect(grid(page).getByRole("link", { name: "Air quality and weather" })).toBeVisible();
      await expect(grid(page).getByRole("link", { name: "Parking places in Espoo" })).toBeVisible();
      await expect(grid(page).getByText("Shared by espoo")).toBeVisible();
      await settled(page);
      expect(await axeViolations(page)).toEqual([]);
      await page.screenshot({ path: join(SHOTS, `filled-${width}.png`) });

      // The header's search runs on the server, any case.
      await page.getByRole("searchbox", { name: "Find an endpoint by name or title" }).fill("NOISE");
      await expect(grid(page).getByRole("link", { name: "Noise sensors" })).toBeVisible();
      await expect(grid(page).getByRole("link", { name: "Air quality and weather" })).toHaveCount(0);
      expect(reads.some((url) => url.includes("contains(search,'noise')"))).toBe(true);
      await settled(page);
      await page.screenshot({ path: join(SHOTS, `search-${width}.png`) });
    });

    test("empty: says what to do next", async ({ page }) => {
      await stubApi(page, []);
      await page.route("**/api/v1/projects/espoo/endpoints", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: API, kind: "List", items: [] }) }),
      );
      await page.goto("/projects/helsinki/endpoints?lang=en");
      await expect(page.getByText("This project publishes no endpoint yet.").first()).toBeVisible();
      await expect(page.getByRole("button", { name: "New endpoint" }).first()).toBeVisible();
      await settled(page);
      // The empty answer stays: nothing reads the rows again behind it.
      await page.waitForTimeout(1500);
      await expect(page.getByText("This project publishes no endpoint yet.").first()).toBeVisible();
      await settled(page);
      expect(await axeViolations(page)).toEqual([]);
      await page.screenshot({ path: join(SHOTS, `empty-${width}.png`) });
    });

    test("error: the server's reason where the rows would be", async ({ page }) => {
      await stubApi(page, HELSINKI, { failOData: true });
      await page.goto("/projects/helsinki/endpoints?lang=en");
      await expect(page.getByRole("alert").filter({ hasText: /could not be read right now/ })).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await page.screenshot({ path: join(SHOTS, `error-${width}.png`) });
      // Try again asks the same question; once the service answers, the rows come back.
      await page.unroute(/\/odata\/endpointList\?/);
      await page.getByRole("button", { name: "Try again" }).click();
      await expect(grid(page).getByRole("link", { name: "Air quality and weather" })).toBeVisible();
    });

    test("refused edit: the decision's reason on the row, nothing sent", async ({ page }) => {
      await stubApi(page, HELSINKI);
      const writes: string[] = [];
      await page.route(/\/odata\/endpointList\/\$allowed/, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            allowed: false,
            reason: "the space air is not one you may propose into",
            notFound: false,
          }),
        }),
      );
      page.on("request", (request) => {
        if (request.url().includes("/odata/") && ["PATCH", "DELETE"].includes(request.method())) writes.push(request.method());
      });
      await page.goto("/projects/helsinki/endpoints?lang=en");
      // A phone shows no space column: the change is made wide, and the review and its refusal
      // are read at the phone's width.
      if (width < 640) await page.setViewportSize({ width: 1440, height: 900 });
      const row = grid(page).getByRole("row").filter({ has: page.getByRole("link", { name: "Helsinki events" }) });
      await expect(row).toBeVisible();
      // The space is picked from the project's spaces, never typed.
      const picker = row.locator('td[data-label="Context Space"] select');
      await expect(picker.locator("option", { hasText: "air" })).toHaveCount(1);
      await expect(picker.locator("option", { hasText: "tapahtumat" })).toHaveCount(1);
      await picker.selectOption("air");
      if (width < 640) await page.setViewportSize({ width, height: 900 });
      await page.getByRole("button", { name: "Review the changes" }).click();
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: /Helsinki events: You may not change this row\. The space air is not one you may propose into\./ })).toBeVisible();
      // The same value would be refused again: Apply waits until the person changes it or discards it.
      await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
      expect(writes).toEqual([]);
      // The rows are read again after the apply; the shot waits for them.
      await expect(page.locator(".jc-grid-loading")).toHaveCount(0);
      await page.screenshot({ path: join(SHOTS, `refused-${width}.png`) });
      // The refusal's own Discard drops that row's change, and its refusal with it.
      await page.getByRole("alert").getByRole("button", { name: "Discard the changes" }).click();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByText("1 not applied yet")).toHaveCount(0);
    });
  });
}
