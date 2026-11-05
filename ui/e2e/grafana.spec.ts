import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pageFindings } from "../tests/pageChecks";
import { axeViolations } from "./axe";

const NAMESPACES = Object.keys(
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/locales/en.json"), "utf8")) as object,
);

// The whole journey on the built bundle with the API answered from the browser: a person picks an
// Endpoint, a type, an attribute and a kind, sees their rows, saves, and opens the result.

const IDENTITY = {
  subject: "b7c1e0f4",
  username: "jana.kovacova",
  name: "Jana Kováčová",
  email: "jana.kovacova@hel.fi",
  roles: ["portal-approver"],
};
const OPTIONS = {
  endpoints: [
    { name: "helsinki-air-quality", title: "Helsinki air quality", slug: "jtjnhkaau64zmzz5csmcwem52icvufy2", public: true, usable: true },
    { name: "helsinki-bikes-ops", title: "City bike operations", slug: "ydp6nddchg4sewmylsiclg4377mlldrj", public: false, usable: false },
  ],
  types: ["AirQualityObserved"],
  attributes: [
    { name: "pm25", kinds: ["timeseries", "stat", "table"] },
    { name: "location", kinds: ["table", "map"] },
  ],
};
const SAVED = {
  id: "ab12",
  title: "PM2.5 by station",
  endpoint: "helsinki-air-quality",
  endpointTitle: "Helsinki air quality",
  type: "AirQualityObserved",
  attribute: "pm25",
  kind: "timeseries",
  createdAt: "2026-11-02T22:00:00Z",
  openUrl: "https://dev.joinedcontext.com/grafana/d/pv-ab12?orgId=2",
};
const STATIONS = ["Kallio 2", "Mäkelänkatu", "Vartiokylä Huivipolku", "Vantaa Tikkurila Neilikkatie", "Espoo Leppävaara Läkkisepänkuja"].map((name, index) => ({
  id: `urn:ngsi-ld:AirQualityObserved:station-${index}`,
  type: "AirQualityObserved",
  name: { type: "LanguageProperty", languageMap: { fi: name } },
  pm25: { type: "Property", value: 4.2 + index, unitCode: "GQ", observedAt: "2026-11-05T09:00:00Z" },
}));

interface World {
  page?: object;
  pageStatus?: number;
  save?: { status: number; body: unknown };
  /** The preview's read: an answer, or "hang" to film the wait. */
  preview?: { status: number; body: unknown } | "hang";
}

async function stubApi(page: Page, world: World): Promise<void> {
  const items: object[] = [];
  await page.route(/\/api\/endpoint\//, async (route) => {
    if (world.preview === "hang") return;
    const answer = world.preview ?? { status: 200, body: STATIONS };
    await route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.endsWith("/grafana/options")) return json(OPTIONS);
    if (url.pathname.endsWith("/grafana") && route.request().method() === "POST") {
      const save = world.save ?? { status: 201, body: SAVED };
      if (save.status === 201) items.push(SAVED);
      return json(save.body, save.status);
    }
    if (url.pathname.endsWith("/grafana")) {
      return json(world.page ?? { ready: true, mayCreate: true, items }, world.pageStatus);
    }
    if (url.pathname.endsWith("/auth/me")) return json(IDENTITY);
    if (url.pathname === "/api/v1/projects") return json({ kind: "ProjectList", items: [{ name: "helsinki" }] });
    return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] });
  });
}

const SHOTS = process.env.GRAFANA_SHOTS;
async function shot(page: Page, name: string, width: number): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(300);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width, height: Math.min(Math.max(height, 400), 2400) });
  await page.screenshot({ path: `${SHOTS}/${name}-${width}.png` });
}

async function fill(page: Page): Promise<void> {
  await page.getByLabel("Endpoint", { exact: true }).selectOption("helsinki-air-quality");
  await page.getByLabel("Type", { exact: true }).selectOption("AirQualityObserved");
  await page.getByLabel("Attribute", { exact: true }).selectOption("pm25");
  await page.getByLabel("Name", { exact: true }).fill("PM2.5 by station");
}

for (const width of [1440, 400]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("a person saves a visualization and gets its link", async ({ page }) => {
      await stubApi(page, {});
      await page.goto("/projects/helsinki/grafana");
      await expect(page.getByRole("heading", { level: 1, name: "Grafana" })).toBeVisible();
      await expect(page.getByText("Nothing saved yet")).toBeVisible();
      await expect(page.getByText(/Not in Grafana yet: City bike operations/)).toBeVisible();
      await shot(page, "empty-list", width);
      await fill(page);
      await expect(page.getByText("Vartiokylä Huivipolku")).toBeVisible();
      await shot(page, "filled", width);
      await page.getByRole("button", { name: "Save to Grafana" }).click();
      await expect(page.getByRole("link", { name: "Open it" })).toHaveAttribute("href", SAVED.openUrl);
      await expect(page.getByRole("link", { name: "Open PM2.5 by station in Grafana" })).toBeVisible();
      await expect(page.getByText("Helsinki air quality: Air quality observed, PM2.5")).toBeVisible();
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
      await shot(page, "saved", width);
      expect(await page.evaluate(pageFindings, { namespaces: NAMESPACES, layout: true })).toEqual([]);
    });

    test("a refusal names the field and keeps what was typed", async ({ page }) => {
      await stubApi(page, {
        save: {
          status: 422,
          body: {
            status: 422,
            title: "Unprocessable",
            detail: "Grafana cannot read the private Endpoint Helsinki air quality yet",
            errors: [{ path: "endpoint", message: "Grafana cannot read the private Endpoint Helsinki air quality yet; ask your operator to add it to this project's Grafana, or choose another" }],
          },
        },
      });
      await page.goto("/projects/helsinki/grafana");
      await fill(page);
      await page.getByRole("button", { name: "Save to Grafana" }).click();
      await expect(page.getByText(/Grafana cannot read the private Endpoint Helsinki air quality yet; ask your operator/)).toBeVisible();
      await expect(page.getByText(/Not in Grafana yet: City bike operations, Helsinki air quality/)).toBeVisible();
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue("PM2.5 by station");
      await shot(page, "error", width);
    });

    test("a refused save names the field and a missing role says who can help", async ({ page }) => {
      const world: World = {
        save: { status: 422, body: { status: 422, title: "Unprocessable", detail: "a field is refused", errors: [{ path: "attribute", message: "AirQualityObserved has no attribute pm25; choose one from the list" }] } },
      };
      await stubApi(page, world);
      await page.goto("/projects/helsinki/grafana");
      await fill(page);
      await page.getByRole("button", { name: "Save to Grafana" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Not saved: check the marked field" })).toBeVisible();
      await expect(page.getByLabel("Attribute", { exact: true })).toHaveAttribute("aria-invalid", "true");
      await shot(page, "error-field", width);
      world.save = { status: 403, body: { status: 403, title: "Forbidden", detail: "You may not propose dashboards in helsinki." } };
      await page.getByLabel("Name", { exact: true }).fill("PM2.5 by station, daily");
      await page.getByRole("button", { name: "Save to Grafana" }).click();
      await expect(page.getByText("Not saved: you may not do this")).toBeVisible();
      await shot(page, "error-forbidden", width);
    });

    test("the preview waits, then says why it has no rows", async ({ page }) => {
      const world: World = { preview: "hang" };
      await stubApi(page, world);
      await page.goto("/projects/helsinki/grafana");
      await fill(page);
      await expect(page.getByRole("status").filter({ hasText: "Reading the first rows" })).toBeAttached();
      await shot(page, "preview-loading", width);
      world.preview = { status: 403, body: { status: 403, title: "Forbidden", detail: "not yours" } };
      await page.getByLabel("Attribute", { exact: true }).selectOption("location");
      await page.getByLabel("Name", { exact: true }).fill("Station locations");
      await expect(page.getByText("You may not read these rows")).toBeVisible();
      await expect(page.getByText("The preview could not read these rows; the dashboard may be empty for you.")).toBeVisible();
      await shot(page, "preview-forbidden", width);
      world.preview = { status: 503, body: { status: 503, title: "Unavailable", detail: "The broker did not answer in time." } };
      await page.reload();
      await fill(page);
      await expect(page.getByText("The preview could not be read")).toBeVisible();
      await expect(page.getByText("The preview could not read these rows; the dashboard may be empty for you.")).toBeVisible();
      await shot(page, "preview-error", width);
      world.preview = undefined;
      await page.getByRole("button", { name: "Try again" }).first().click();
      await expect(page.getByText("Vartiokylä Huivipolku")).toBeVisible();
    });

    test("a person outside the project is told who can give access", async ({ page }) => {
      await stubApi(page, { pageStatus: 403, page: { status: 403, title: "Forbidden", detail: "You are not a member of helsinki." } });
      await page.goto("/projects/helsinki/grafana");
      await expect(page.getByRole("heading", { level: 1, name: "Grafana" })).toBeVisible();
      await expect(page.getByText(/not a member of helsinki/)).toBeVisible();
      await shot(page, "refusal-403", width);
    });

    test("a reader sees what is saved and no form", async ({ page }) => {
      await stubApi(page, { page: { ready: true, mayCreate: false, items: [SAVED] } });
      await page.goto("/projects/helsinki/grafana");
      await expect(page.getByRole("link", { name: "Open PM2.5 by station in Grafana" })).toBeVisible();
      await expect(page.getByLabel("Endpoint", { exact: true })).toHaveCount(0);
      await shot(page, "refusal-reader", width);
    });

    test("a project without Grafana says who can add it", async ({ page }) => {
      await stubApi(page, {
        page: { ready: false, mayCreate: true, items: [], reason: "Grafana has no organization for helsinki yet; ask your operator to add this project to Grafana" },
      });
      await page.goto("/projects/helsinki/grafana");
      await expect(page.getByText(/ask your operator/)).toBeVisible();
      await shot(page, "not-ready", width);
    });
  });
}

test("the page has no axe violations", async ({ page }) => {
  await stubApi(page, {});
  await page.goto("/projects/helsinki/grafana");
  await expect(page.getByLabel("Endpoint", { exact: true })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});
