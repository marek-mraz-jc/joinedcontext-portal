import { expect, test } from "@playwright/test";
import { LIVE_BLOCKS, WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { BASE, serve } from "./serve";

// UI-84, SDK-12 (T-2782): each dataset's grid at a phone, a tablet, a laptop and a wall: no
// sideways scroll of the page (the table scrolls in its own box), no overlap, axe clean.
const VIEWS = [
  { tab: "Podujatia", row: "Radvanský jarmok" },
  { tab: "Školy", row: "Základná škola, Moyzesova 18" },
];

for (const view of VIEWS) {
  for (const size of WIDTHS) {
    test(`${view.tab} at ${size.width} px: no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
      const { missing, problems, outside } = await serve(page);
      await page.setViewportSize(size);
      await page.goto(BASE);
      await page.getByRole("tab", { name: view.tab }).click();
      await expect(page.getByRole("tabpanel", { name: view.tab }).getByText(view.row)).toBeVisible();
      await testInfo.attach(`${view.tab}-${size.width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(await layoutProblems(page, LIVE_BLOCKS)).toEqual([]);
      expect({ missing, problems, outside }).toEqual({ missing: [], problems: [], outside: [] });
    });
  }
}
