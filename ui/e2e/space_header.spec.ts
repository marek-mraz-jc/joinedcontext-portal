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
const SPACE = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "ContextSpace",
  metadata: { name: "ovzdusie", namespace: "city", title: { en: "Air quality" }, description: { en: DESCRIPTION } },
  spec: {},
  status: { phase: "Ready" },
};

async function stubApi(page: Page): Promise<void> {
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

    test("says what the space is for right under its name, and opens the whole text", async ({ page }) => {
      await stubApi(page);
      await page.goto("/projects/city/spaces/ovzdusie?lang=en");
      const h1 = page.getByRole("heading", { level: 1, name: "Air quality" });
      await expect(h1).toBeVisible();
      await expect(h1.locator("xpath=following-sibling::*[1]")).toHaveJSProperty("tagName", "P");
      await expect(h1.locator("xpath=following-sibling::p[1]")).toContainText(DESCRIPTION);
      await expect(page.getByRole("button", { name: "ovzdusie" })).toBeVisible();
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `1-closed-${width}.png`) });
      const alerts = page.getByRole("button", { name: "Alerts", exact: true });
      const before = await alerts.boundingBox();
      await page.getByRole("button", { name: "More", exact: true }).click();
      await expect(page.getByRole("button", { name: "Less", exact: true })).toHaveAttribute("aria-expanded", "true");
      // The actions keep their place while the description opens under the title (UI judge, T-6138).
      if (width === 1440) expect((await alerts.boundingBox())?.y).toBe(before?.y);
      await page.screenshot({ path: join(SHOTS, `2-open-${width}.png`) });
    });
  });
}
