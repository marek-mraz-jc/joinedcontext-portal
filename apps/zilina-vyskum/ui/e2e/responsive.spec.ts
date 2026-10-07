import { expect, test } from "@playwright/test";
import { LIVE_BLOCKS, WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { BASE, serve } from "./serve";

// UI-84, SDK-12 (T-3140): the overview and the list, and the list narrowed to one kind, at a
// phone, a tablet, a laptop and a wall: no sideways scroll, no overlap, nothing axe finds.
for (const kind of [null, "Zborník"]) {
  for (const size of WIDTHS) {
    test(`${kind ?? "every work"} at ${size.width} px: no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
      const { missing, problems, outside } = await serve(page);
      await page.setViewportSize(size);
      await page.goto(BASE);
      await expect(page.getByText("251 prác")).toBeVisible();
      if (kind) await page.getByText(new RegExp(`^${kind}`)).click();
      await testInfo.attach(`works-${kind}-${size.width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(await layoutProblems(page, LIVE_BLOCKS)).toEqual([]);
      expect({ missing, problems, outside }).toEqual({ missing: [], problems: [], outside: [] });
    });
  }
}
