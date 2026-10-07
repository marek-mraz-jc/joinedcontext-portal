import { expect, test } from "@playwright/test";
import { LIVE_BLOCKS, WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { BASE, serve } from "./serve";

// UI-84, SDK-12 (T-3140): the places and a picked place's sheet at a phone, a tablet, a laptop and
// a wall: no sideways scroll, no two blocks over each other, nothing axe finds at WCAG 2.1 AA.
const VIEWS = [
  { name: "the places", pick: null },
  { name: "the picked air station", pick: "Stanica SK0020A" },
];

for (const view of VIEWS) {
  for (const size of WIDTHS) {
    test(`${view.name} at ${size.width} px: no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
      const { missing, problems, outside } = await serve(page);
      await page.setViewportSize(size);
      await page.goto(BASE);
      const results = page.getByRole("region", { name: /miest/ });
      await expect(results.getByRole("button", { name: /Kaštieľ Bytčica/ })).toBeVisible();
      await expect(page.getByTestId("jc-map").locator("canvas")).toHaveCount(1);
      if (view.pick) {
        await results.getByRole("button", { name: new RegExp(view.pick) }).click();
        await expect(page.getByRole("region", { name: new RegExp(view.pick) })).toBeVisible();
      }
      await testInfo.attach(`${view.name}-${size.width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      // An open sheet is meant to lie over the list on a phone; the blocks under it are not the layout.
      expect(await layoutProblems(page, LIVE_BLOCKS)).toEqual([]);
      expect({ missing, problems, outside }).toEqual({ missing: [], problems: [], outside: [] });
    });
  }
}
