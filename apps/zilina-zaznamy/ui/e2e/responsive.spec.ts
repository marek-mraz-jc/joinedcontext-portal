import { expect, test } from "@playwright/test";
import { LIVE_BLOCKS, WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { BASE, serve } from "./serve";

// UI-84, SDK-12 (T-3140): two datasets, the widest and the one of another space, at a phone, a
// tablet, a laptop and a wall: no sideways scroll, no two blocks over each other, nothing axe finds.
const VIEWS = [
  { dataset: "Kultúrne pamiatky", row: "Trojičný stĺp" },
  { dataset: "Publikácie UNIZA", row: "Conference paper" },
];

for (const view of VIEWS) {
  for (const size of WIDTHS) {
    test(`${view.dataset} at ${size.width} px: no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
      const { missing, problems, outside } = await serve(page);
      await page.setViewportSize(size);
      await page.goto(BASE);
      await page.getByRole("navigation").getByRole("button", { name: new RegExp(view.dataset) }).click();
      await expect(page.getByRole("grid").getByText(view.row).first()).toBeVisible();
      await testInfo.attach(`${view.dataset}-${size.width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(await layoutProblems(page, LIVE_BLOCKS)).toEqual([]);
      expect({ missing, problems, outside }).toEqual({ missing: [], problems: [], outside: [] });
    });
  }
}
