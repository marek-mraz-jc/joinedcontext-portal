import { expect, test } from "@playwright/test";
import { LIVE_BLOCKS, WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { BASE, serve } from "./serve";

// UI-84, SDK-12 (T-2825): the stations and a picked station's day at a phone, a tablet, a laptop
// and a wall: no sideways scroll, no two blocks over each other, nothing axe finds at WCAG 2.1 AA.
const VIEWS = [
  { name: "the stations", pick: null },
  { name: "a picked station", pick: "Stanica 2" },
];

for (const view of VIEWS) {
  for (const size of WIDTHS) {
    test(`${view.name} at ${size.width} px: no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
      const { missing, problems } = await serve(page);
      await page.setViewportSize(size);
      await page.goto(BASE);
      const stations = page.getByRole("region", { name: "Stanice" });
      await expect(stations.getByRole("heading", { name: "Stanica 1" })).toBeVisible();
      await expect(page.getByTestId("jc-map").locator("canvas")).toHaveCount(1);
      if (view.pick) {
        await stations.getByRole("article").filter({ has: page.getByRole("heading", { name: view.pick }) }).getByRole("button").click();
        await expect(page.getByRole("region", { name: new RegExp(view.pick) })).toBeVisible();
      }
      await testInfo.attach(`${view.name}-${size.width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(await layoutProblems(page, LIVE_BLOCKS)).toEqual([]);
      expect({ missing, problems }).toEqual({ missing: [], problems: [] });
    });
  }
}
