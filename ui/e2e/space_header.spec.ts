import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// The space page's header (T-6092, T-6138): the way back, the name with its copy chip and state, the
// actions, and the description as the h1's next sibling <p>, the purpose line the live walker reads.
// Against a stubbed API; shots at 1440 and 400 go to test-results/space-header.

const IDENTITY = { subject: "b7c1e0f4", username: "jana", name: "Jana Kováčová", email: "jana@example.org", roles: ["portal-editor"] };
const list = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });
const DESCRIPTION = "Air quality stations of the city and what they measured every hour, kept for five years.";
const LONG =
  "Air quality stations of the city and what they measured every hour: PM10, PM2.5, nitrogen dioxide and ozone, " +
  "kept for five years and published to the open data catalogue for anyone who wants to compare the districts.";
const space = (description: string) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "ContextSpace",
  metadata: { name: "ovzdusie", namespace: "city", title: { en: "Air quality" }, description: { en: description } },
  spec: {},
  status: { phase: "Ready" },
});

async function stubApi(page: Page, description: string): Promise<void> {
  const SPACE = space(description);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) return json(IDENTITY);
    if (path === "/api/v1/projects") return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "ProjectList", items: [{ name: "city" }] });
    if (path === "/api/v1/projects/city/spaces/ovzdusie") return json(SPACE);
    if (path.endsWith("/spaces")) return json(list([SPACE]));
    return json(list([]));
  });
}

const SHOTS = join(process.cwd(), "test-results", "space-header");

for (const width of [1440, 400]) {
  test.describe(`space header at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("says what the space is for right under its name, with More only where the line cuts it", async ({ page }) => {
      await stubApi(page, DESCRIPTION);
      await page.goto("/projects/city/spaces/ovzdusie?lang=en");
      const h1 = page.getByRole("heading", { level: 1, name: "Air quality" });
      await expect(h1).toBeVisible();
      await expect(h1.locator("xpath=following-sibling::*[1]")).toHaveJSProperty("tagName", "P");
      await expect(h1.locator("xpath=following-sibling::p[1]")).toContainText(DESCRIPTION);
      await expect(page.getByRole("button", { name: "ovzdusie" })).toBeVisible();
      // The whole sentence fits a desktop line; a phone line cuts it.
      await expect(page.getByRole("button", { name: "More", exact: true })).toHaveCount(width === 1440 ? 0 : 1);
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `1-short-${width}.png`) });
    });

    test("opens a long description in place, the actions where they were", async ({ page }) => {
      await stubApi(page, LONG);
      await page.goto("/projects/city/spaces/ovzdusie?lang=en");
      const alerts = page.getByRole("button", { name: "Alerts", exact: true });
      await expect(alerts).toBeVisible();
      const before = await alerts.boundingBox();
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `2-long-closed-${width}.png`) });
      await page.getByRole("button", { name: "More", exact: true }).click();
      await expect(page.getByRole("button", { name: "Less", exact: true })).toHaveAttribute("aria-expanded", "true");
      // Beside the title the actions keep their place while the description opens (UI judge, T-6138).
      if (width === 1440) expect((await alerts.boundingBox())?.y).toBe(before?.y);
      await page.screenshot({ path: join(SHOTS, `3-long-open-${width}.png`) });
    });
  });
}
