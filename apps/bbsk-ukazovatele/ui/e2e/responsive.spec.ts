import { expect, test } from "@playwright/test";
import { LIVE_BLOCKS, WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { BASE, serve } from "./serve";

// The Slovak words of src/locales.ts, written out: that module imports the SDK, which Node does
// not load outside the bundle.
const BODIES = ["Banskobystrický samosprávny kraj", "Mesto Banská Bystrica"];

// UI-84, SDK-12 (T-2825): both bodies' indicators at a phone, a tablet, a laptop and a wall: no
// sideways scroll, no two blocks over each other, nothing axe finds at WCAG 2.1 AA.
for (const size of WIDTHS) {
  test(`the indicators at ${size.width} px: no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
    const { outside, missing, problems } = await serve(page);
    await page.setViewportSize(size);
    await page.goto(BASE);
    for (const body of BODIES) {
      await expect(page.getByRole("region", { name: body }).getByRole("article").first()).toBeVisible();
    }
    await testInfo.attach(`indicators-${size.width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    expect(await layoutProblems(page, LIVE_BLOCKS)).toEqual([]);
    expect({ outside, missing, problems }).toEqual({ outside: [], missing: [], problems: [] });
  });
}
