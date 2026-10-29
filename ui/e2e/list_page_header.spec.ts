import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { axeViolations } from "./axe";

// T-6095 (owner 2026-10-29): a list page is one compact line (title, description on hover, search,
// primary action) with the rows right below; a row opens by its name and keeps one ⋯ menu, with
// the forge file in it instead of a Source column; "Connect an AI assistant" sits behind a header
// button on the Endpoints page.

const API = "joinedcontext.com/v1alpha1";
const SOURCE = "https://git.example.sk/bbsk/config/src/branch/main";

const endpoint = (name: string, en: string, space: string) => ({
  apiVersion: API,
  kind: "Endpoint",
  metadata: { name, namespace: "bbsk", title: { en } },
  spec: { contextSpaceRef: space, slug: name, audience: "public", enabledRepresentations: ["ngsi-ld", "ogc-features"] },
  status: { phase: "Live", sourceUrl: `${SOURCE}/endpoints/${name}.yaml` },
});

const ENDPOINTS = [
  endpoint("parking", "Parking", "otvorene-data"),
  endpoint("air-quality", "Air quality", "ovzdusie"),
  endpoint("events", "Cultural events", "kultura"),
];

const SPACES = ["otvorene-data", "ovzdusie", "kultura"].map((name) => ({
  apiVersion: API,
  kind: "ContextSpace",
  metadata: { name, namespace: "bbsk", title: { en: name } },
  spec: {},
  status: { phase: "Live", sourceUrl: `${SOURCE}/spaces/${name}/space.yaml` },
}));

async function stub(page: Page, filled: boolean) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) {
      return json({ subject: "s", username: "jana", name: "Jana", email: "jana@bbsk.sk", roles: ["portal-editor"] });
    }
    if (path.endsWith("/permissions/me")) return json({ project: "bbsk", bootstrap: true, grants: [] });
    if (path === "/api/v1/projects") return json({ apiVersion: API, kind: "ProjectList", items: [{ name: "bbsk" }] });
    if (path === "/api/v1/projects/bbsk/endpoints") return json({ apiVersion: API, kind: "List", items: filled ? ENDPOINTS : [] });
    if (path === "/api/v1/projects/bbsk/spaces") return json({ apiVersion: API, kind: "List", items: filled ? SPACES : [] });
    if (/\/spaces\/[^/]+\/usage$/.test(path)) return json({ entities: 1200, broker: "main", observedAt: "2026-10-29T10:00:00Z" });
    if (path.endsWith("/events")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    return json({ apiVersion: API, kind: "List", items: [] });
  });
}

const dir = join("test-results", "T-6095");

for (const width of [1440, 400]) {
  test(`the Endpoints list is one header line, a grid and a row menu at ${width} px`, async ({ page }) => {
    mkdirSync(dir, { recursive: true });
    await page.setViewportSize({ width, height: 900 });
    await stub(page, true);
    await page.goto("/projects/bbsk/endpoints?lang=en");

    await expect(page.getByRole("heading", { level: 1, name: "Endpoints" })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Find an endpoint" })).toBeVisible();
    await expect(page.getByRole("button", { name: "View data" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Connect an AI assistant" })).toHaveCount(0);
    await page.screenshot({ path: join(dir, `endpoints-filled-${width}.png`) });
    expect(await axeViolations(page)).toEqual([]);

    // The description shows on hover of the info mark.
    await page.getByRole("button", { name: "About this page" }).hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.screenshot({ path: join(dir, `endpoints-description-${width}.png`) });
    await page.mouse.move(0, 0);

    // The search narrows the rows.
    await page.getByRole("searchbox", { name: "Find an endpoint" }).fill("air");
    await expect(page.getByRole("link", { name: "Air quality" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Parking" })).toHaveCount(0);
    await page.getByRole("searchbox", { name: "Find an endpoint" }).fill("");

    // One menu: Open, Edit, View source (Git) among the rest.
    await page.getByRole("button", { name: /More actions.*Parking/ }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Open" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "View source (Git)" })).toBeVisible();
    await page.screenshot({ path: join(dir, `endpoints-menu-${width}.png`) });
    await menu.getByRole("menuitem", { name: "Open" }).click();
    await expect(page).toHaveURL(/\/projects\/bbsk\/endpoints\/parking/);

    // Connect AI opens the same content as a dialog.
    await page.goto("/projects/bbsk/endpoints?lang=en");
    await page.getByRole("button", { name: "Connect AI" }).click();
    const dialog = page.getByRole("dialog", { name: "Connect an AI assistant" });
    await expect(dialog.getByLabel("Claude Code command")).toBeVisible();
    await page.screenshot({ path: join(dir, `endpoints-connect-${width}.png`) });
    expect(await axeViolations(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });

  test(`an empty Endpoints list says what to do next at ${width} px`, async ({ page }) => {
    mkdirSync(dir, { recursive: true });
    await page.setViewportSize({ width, height: 900 });
    await stub(page, false);
    await page.goto("/projects/bbsk/endpoints?lang=en");
    await expect(page.getByText("This project publishes no endpoint yet.")).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Find an endpoint" })).toHaveCount(0);
    await page.screenshot({ path: join(dir, `endpoints-empty-${width}.png`) });
  });

  test(`the Context Spaces list has no Look inside and no Source column at ${width} px`, async ({ page }) => {
    mkdirSync(dir, { recursive: true });
    await page.setViewportSize({ width, height: 900 });
    await stub(page, true);
    await page.goto("/projects/bbsk/spaces?lang=en");
    await expect(page.getByRole("link", { name: "ovzdusie" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Look inside" })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "Source" })).toHaveCount(0);
    await page.screenshot({ path: join(dir, `spaces-filled-${width}.png`) });
    expect(await axeViolations(page)).toEqual([]);
    await page.getByRole("button", { name: /More actions.*ovzdusie/ }).click();
    await expect(page.getByRole("menuitem", { name: "View source (Git)" })).toBeVisible();
    await page.screenshot({ path: join(dir, `spaces-menu-${width}.png`) });
  });
}
