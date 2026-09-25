import { expect, test } from "@playwright/test";
import { LIVE_BLOCKS, WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { BASE, serve } from "./serve";

// UI-84, SDK-12 (T-2825): the live map and its lines at a phone, a tablet, a laptop and a wall,
// light and dark: no sideways scroll, no two blocks over each other, no control cut off, nothing
// axe finds at WCAG 2.1 AA.
for (const scheme of ["light", "dark"] as const) {
  for (const size of WIDTHS) {
    test(`the buses, ${scheme}, at ${size.width} px: no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
      const { missing, problems } = await serve(page);
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(size);
      await page.goto(BASE);
      await expect(page.getByRole("status")).toContainText("6 buses");
      await expect(page.getByTestId("map").locator("canvas")).toHaveCount(1);
      await expect(page.getByText("1000N")).toBeVisible();
      await testInfo.attach(`buses-${scheme}-${size.width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(await layoutProblems(page, LIVE_BLOCKS)).toEqual([]);
      expect({ missing, problems }).toEqual({ missing: [], problems: [] });
    });
  }
}
