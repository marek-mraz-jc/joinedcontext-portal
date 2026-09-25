import { expect, test } from "@playwright/test";
import { WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { STEWARD, VIEWER } from "../src/fixtures/access";
import { serve } from "./serve";

// UI-84, SDK-12 (T-2825): every screen at a phone, a tablet, a laptop and a wall: no sideways
// scroll, no two blocks over each other, nothing axe finds at WCAG 2.1 AA. The steward's views
// carry the record form, the viewer's only what they may read.
const VIEWS = [
  { name: "overview", role: "viewer", access: VIEWER, open: "overview" },
  { name: "alerts", role: "viewer", access: VIEWER, open: "list" },
  { name: "a chosen alert", role: "viewer", access: VIEWER, open: "detail" },
  { name: "the steward's new alert form", role: "steward", access: STEWARD, open: "new" },
  { name: "the steward's edit form", role: "steward", access: STEWARD, open: "edit" },
] as const;

for (const view of VIEWS) {
  for (const size of WIDTHS) {
    test(`${view.name} at ${size.width} px: no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
      await page.setViewportSize(size);
      const { alerts, outside, problems } = await serve(page, view.role, view.access);
      await expect(alerts.getByTestId("jc-map").locator("canvas")).toHaveCount(1);
      if (view.open === "overview") {
        await page.goto("http://portal.test/apps/helsinki-alerts/#overview");
        await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
      } else if (view.open === "new") {
        await alerts.getByRole("button", { name: "New alert" }).click();
        await expect(alerts.getByRole("form", { name: "New alert" })).toBeVisible();
      } else if (view.open !== "list") {
        await alerts.getByRole("table").getByText("Mannerheimintie resurfacing").click();
        if (view.open === "edit") {
          await alerts.getByRole("button", { name: "Edit" }).click();
          await expect(alerts.getByRole("form", { name: "Edit Alert" })).toBeVisible();
        } else {
          await expect(alerts.getByRole("heading", { level: 2 })).toBeVisible();
        }
      }
      await testInfo.attach(`${view.name}-${size.width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(await layoutProblems(page)).toEqual([]);
      expect({ outside, problems }).toEqual({ outside: [], problems: [] });
    });
  }
}
