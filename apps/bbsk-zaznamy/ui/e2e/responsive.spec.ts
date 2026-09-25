import { expect, test } from "@playwright/test";
import { LIVE_BLOCKS, WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { REGION } from "../src/fixtures/records";
import { BASE, serve } from "./serve";

// The Slovak words of src/locales.ts, written out: that module imports the SDK, which Node does
// not load outside the bundle.
const TITLE = "Záznamy Banskobystrického kraja";
const NOTE_BOX = "Upraviť Poznámka správcu";
const REVIEW = "Skontrolovať zmeny";

// UI-84, SDK-12 (T-2825): the records and a note under review at a phone, a tablet, a laptop and
// a wall: no sideways scroll, no two blocks over each other, nothing axe finds at WCAG 2.1 AA.
for (const view of ["the records", "a note under review"]) {
  for (const size of WIDTHS) {
    test(`${view} at ${size.width} px: no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
      const { outside, missing, problems } = await serve(page);
      await page.setViewportSize(size);
      await page.goto(BASE);
      await expect(page.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();
      await expect(page.getByRole("row").filter({ has: page.getByRole("gridcell") })).toHaveCount(REGION.length);
      if (view === "a note under review") {
        await page.getByRole("textbox", { name: NOTE_BOX }).first().fill("Overené s odborom.");
        await page.getByRole("button", { name: REVIEW }).click();
        await expect(page.getByRole("region", { name: REVIEW })).toBeVisible();
      }
      await testInfo.attach(`${view}-${size.width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(await layoutProblems(page, LIVE_BLOCKS)).toEqual([]);
      expect({ outside, missing, problems }).toEqual({ outside: [], missing: [], problems: [] });
    });
  }
}
