import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// T-5118: a publisher reads how an Endpoint is used, per day and per way of reading, on the
// Endpoint's page; and every Endpoint of the project on the Endpoints page, with a month as CSV.
// Each state at 1440 and 400 px: calls, no calls yet, the database refusing.

const API = "joinedcontext.com/v1alpha1";
const ENDPOINT = {
  apiVersion: API,
  kind: "Endpoint",
  metadata: { name: "air", namespace: "helsinki" },
  spec: { contextSpaceRef: "ovzdusie", slug: "k7m2qz4tv6xh3n5jb2ryd3wcfa", audience: "public", enabledRepresentations: ["ngsi-ld", "ogc"] },
  status: { phase: "Live" },
};
const QUIET = { ...ENDPOINT, metadata: { name: "noise", namespace: "helsinki" }, spec: { ...ENDPOINT.spec, slug: "n0ise" } };
const DAILY = Array.from({ length: 30 }, (_, n) => (n % 7 === 5 ? 0 : 40 + ((n * 37) % 90)));
const TOTAL = DAILY.reduce((a, b) => a + b, 0);
const day = (n: number) => new Date(Date.UTC(2026, 8, 23 + n)).toISOString().slice(0, 10);
const USAGE = {
  name: "air",
  from: day(0),
  to: day(29),
  days: DAILY.map((total, n) => ({ day: day(n), calls: total ? { "ngsi-ld": total - 6, ogc: 4, download: 1, mcp: 1 } : {}, total })),
  totals: { "ngsi-ld": TOTAL - 6 * 26, ogc: 4 * 26, download: 26, mcp: 26 },
  total: TOTAL,
};
const PROJECT_USAGE = {
  from: day(0),
  to: day(29),
  endpoints: [
    { name: "air", slug: ENDPOINT.spec.slug, total: TOTAL, totals: USAGE.totals, daily: DAILY },
    { name: "noise", slug: "n0ise", total: 0, totals: {}, daily: DAILY.map(() => 0) },
  ],
};
const CSV = "day,endpoint,surface,calls\n2026-10-01,air,ngsi-ld,95\n2026-10-01,air,ogc,4\n";

type State = "calls" | "empty" | "refused";

async function stub(page: Page, state: State) {
  const list = (items: unknown[]) => ({ apiVersion: API, kind: "List", items });
  await page.route("**/api/v1/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) return json({ subject: "s1", username: "steward", name: "Steward", email: "s@hel.fi", roles: ["portal-editor"] });
    if (path === "/api/v1/projects") return json(list([{ name: "helsinki" }]));
    if (path.endsWith("/usage") || path.endsWith("/usage/endpoints")) {
      if (state === "refused") {
        return route.fulfill({
          status: 503,
          contentType: "application/problem+json",
          body: JSON.stringify({ type: "about:blank", title: "Service Unavailable", status: 503, detail: "the usage database did not answer; try again in a minute" }),
        });
      }
      if (path.endsWith("/usage/endpoints")) {
        return json(state === "empty" ? { ...PROJECT_USAGE, endpoints: PROJECT_USAGE.endpoints.map((e) => ({ ...e, total: 0, totals: {}, daily: e.daily.map(() => 0) })) } : PROJECT_USAGE);
      }
      return json(state === "empty" ? { ...USAGE, days: USAGE.days.map((d) => ({ ...d, calls: {}, total: 0 })), totals: {}, total: 0 } : USAGE);
    }
    if (path.endsWith("/usage/endpoints/export")) {
      return route.fulfill({ contentType: "text/csv; charset=utf-8", body: CSV });
    }
    if (path === "/api/v1/projects/helsinki/endpoints/air") return json(ENDPOINT);
    if (path === "/api/v1/projects/helsinki/endpoints") return json(list([ENDPOINT, QUIET]));
    return json(list([]));
  });
  await page.route("**/api/endpoint/**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
}

for (const width of [1440, 400]) {
  for (const state of ["calls", "empty", "refused"] as const) {
    test(`an Endpoint's usage reads at ${width} px: ${state} (T-5118)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await stub(page, state);
      const dir = join("test-results", "T-5118");
      mkdirSync(dir, { recursive: true });

      await page.goto("/projects/helsinki/endpoints/air?lang=en");
      const section = page.locator("section", { has: page.getByRole("heading", { name: "Usage", exact: true }) });
      await expect(section.getByLabel("Period")).toBeVisible();
      if (state === "calls") {
        await expect(section.getByRole("img", { name: `Calls per day: ${TOTAL.toLocaleString("en")} in total over 30 days` })).toBeVisible();
        await expect(section.locator("dt", { hasText: "Assistants (MCP)" })).toBeVisible();
        await section.locator("summary").click();
        await expect(section.getByRole("table")).toBeVisible();
      } else if (state === "empty") {
        await expect(section.getByText(/Nobody called this Endpoint in this period/)).toBeVisible();
      } else {
        await expect(section.getByRole("alert")).toContainText("the usage database did not answer");
      }
      await section.scrollIntoViewIfNeeded();
      await section.screenshot({ path: join(dir, `endpoint-${state}-${width}.png`) });

      await page.goto("/projects/helsinki/endpoints?lang=en");
      const project = page.locator("section", { has: page.getByRole("heading", { name: "Usage", exact: true }) });
      await expect(project.getByLabel("Month to download")).toBeVisible();
      if (state === "calls") {
        await expect(project.getByRole("link", { name: "air" })).toBeVisible();
        await expect(project.getByText("No calls")).toBeVisible();
        await project.getByLabel("Month to download").fill("2026-10");
        const saved = page.waitForEvent("download");
        await project.getByRole("button", { name: "Download CSV" }).click();
        const file = await saved;
        expect(file.suggestedFilename()).toBe("helsinki-usage-2026-10.csv");
        const path = join(dir, `usage-${width}.csv`);
        await file.saveAs(path);
        expect(readFileSync(path, "utf8")).toBe(CSV);
      }
      await project.scrollIntoViewIfNeeded();
      await project.screenshot({ path: join(dir, `project-${state}-${width}.png`) });
      // Nothing on the page is wider than a phone.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }
}
