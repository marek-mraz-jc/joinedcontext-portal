import { expect, test } from "@playwright/test";
import { LIVE_BLOCKS, WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { BASE, serve } from "./serve";

// UI-84, SDK-12 (T-3140): the six cards, one formula open, at a phone, a tablet, a laptop and a
// wall: no sideways scroll, no two blocks over each other, nothing axe finds at WCAG 2.1 AA.
for (const open of [false, true]) {
  for (const size of WIDTHS) {
    test(`the indicators${open ? " with a formula open" : ""} at ${size.width} px: no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
      const { missing, problems, outside } = await serve(page);
      await page.setViewportSize(size);
      await page.goto(BASE);
      await expect(page.getByRole("article")).toHaveCount(6);
      if (open) await page.getByText("Ako sa počíta").first().click();
      await testInfo.attach(`indicators-${open}-${size.width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(await layoutProblems(page, LIVE_BLOCKS)).toEqual([]);
      expect({ missing, problems, outside }).toEqual({ missing: [], problems: [], outside: [] });
    });
  }
}
