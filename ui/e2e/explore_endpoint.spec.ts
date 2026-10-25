import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { axeViolations } from "./axe";

// T-5604: Explore reads a type through the space's own Endpoint before an App's, writes the
// Endpoint it reads into the address and names it under the filters; a link naming an Endpoint
// the person is not shown says so and reads through no other. `vite preview` has no API, so the
// browser answers it.

const TYPE = "AirQualityObserved";
const OWN = { name: "helsinki-air-quality", slug: "jtjnhkaau64zmzz5csmcwem52icvufy2" };
const APP = { name: "app-air-quality", slug: "3jlwl5dg2oidblwqhc6qdi3zxl" };
const list = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });
const LINKML = [
  "id: https://hel.fi/models/air",
  "name: helsinki-air",
  "classes:",
  `  ${TYPE}:`,
  "    slots: [id, name, pm10]",
  "slots:",
  "  id: {}",
  "  name: { range: string }",
  "  pm10: { range: float }",
  "",
].join("\n");

const endpoint = (e: { name: string; slug: string }, spec: Record<string, unknown>, annotations?: Record<string, string>) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Endpoint",
  metadata: { name: e.name, namespace: "helsinki", title: { en: e === OWN ? "Helsinki air quality" : "Air quality" }, ...(annotations ? { annotations } : {}) },
  spec: { contextSpaceRef: "helsinki", slug: e.slug, enabledRepresentations: ["ngsi-ld"], ...spec },
  status: { phase: "Live" },
});

async function stub(page: Page, withApp: boolean): Promise<string[]> {
  const reads: string[] = [];
  await page.route("**/{api,cs}/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, headers: Record<string, string> = {}) =>
      route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(body) });
    const path = url.pathname;
    if (path.endsWith("/auth/me")) return json({ subject: "s1", username: "demo.viewer", name: "Demo Viewer", roles: [], groups: ["helsinki"] });
    // A viewer: reads, never writes.
    if (path.endsWith("/access/check")) return json({ decision: /"(query|retrieve)/.test(route.request().postData() ?? "") });
    if (path.endsWith("/access")) return json({ permissions: [{ resource: { type: TYPE }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" }] });
    if (path.endsWith("/entities")) {
      reads.push(path);
      const rows = [1, 2, 3].map((n) => ({ id: `urn:ngsi-ld:${TYPE}:hel.fi:helsinki:fmi-${n}`, type: TYPE, name: `Station ${n}`, pm10: 10 + n }));
      return json(rows, { "NGSILD-Results-Count": "3" });
    }
    if (path === "/api/v1/projects") return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "ProjectList", items: [{ name: "helsinki" }] });
    if (path.endsWith("/spaces")) {
      return json(list([{ apiVersion: "joinedcontext.com/v1alpha1", kind: "ContextSpace", metadata: { name: "helsinki", namespace: "helsinki", title: { en: "Helsinki city context" } }, spec: { dataModelRef: "helsinki-air" }, status: { phase: "Live" } }]));
    }
    if (path.endsWith("/endpoints")) {
      const own = endpoint(OWN, { audience: "public", policyRef: "urn:ngsi-ld:Policy:hel.fi:helsinki:public-air-quality" });
      const app = endpoint(APP, { audience: "project-list", callerRole: true }, { "joinedcontext.com/generated-by": "portal/app-reconciler" });
      return json(list(withApp ? [app, own] : [own]));
    }
    if (path.endsWith("/datamodels")) {
      return json(list([{ apiVersion: "joinedcontext.com/v1alpha1", kind: "DataModel", metadata: { name: "helsinki-air", namespace: "helsinki" }, spec: { version: "1.0.0", classes: [TYPE], linkml: LINKML } }]));
    }
    return json(list([]));
  });
  return reads;
}

const SHOTS = process.env.T5604_SHOTS ?? "test-results/explore-endpoint";
mkdirSync(SHOTS, { recursive: true });

for (const width of [1440, 400]) {
  test(`reads through the space's own Endpoint and writes it into the address at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const reads = await stub(page, true);
    await page.goto(`/projects/helsinki/explore?space=helsinki&type=${TYPE}&lang=en`);
    await expect(page.locator("tbody tr").first()).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`endpoint=${OWN.name}`));
    await expect(page.locator("#explore-endpoint")).toHaveValue(OWN.name);
    await expect(page.locator("main").getByText(`Read through ${OWN.name}`)).toBeVisible();
    expect(reads.every((path) => path.includes(OWN.slug))).toBe(true);
    expect(await axeViolations(page)).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/read-through-${width}.png`, fullPage: true });
  });

  test(`a link naming an Endpoint the person is not shown says so at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const reads = await stub(page, false);
    await page.goto(`/projects/helsinki/explore?space=helsinki&endpoint=${APP.name}&type=${TYPE}&lang=en`);
    await expect(page.getByText(`The link names the Endpoint ${APP.name}, which this space does not show you`)).toBeVisible();
    await expect(page.locator("#explore-endpoint")).toHaveValue("");
    await expect(page.locator("tbody tr")).toHaveCount(0);
    await expect(page.getByText("Choose an entity type to load entities.")).toHaveCount(0);
    expect(reads).toEqual([]);
    expect(await axeViolations(page)).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/unshown-${width}.png`, fullPage: true });

    // Picking one the person can read clears the refusal and reads through it.
    await page.locator("#explore-endpoint").selectOption(OWN.name);
    await expect(page.locator("tbody tr").first()).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`endpoint=${OWN.name}`));
    await expect(page.getByText(`The link names the Endpoint ${APP.name}`)).toHaveCount(0);
  });
}
