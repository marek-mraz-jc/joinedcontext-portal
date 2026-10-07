import { expect, test } from "@playwright/test";
import { LIVE_BLOCKS, WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { BASE, serve } from "./serve";

// UI-84, SDK-12 (T-2784): the desk at a phone, a tablet, a laptop and a wall: the figures and the
// table, sorted, with no sideways scroll of the page (the table scrolls in its own region).
for (const size of WIDTHS) {
  test(`the bridge desk at ${size.width} px: no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
    const { missing, problems, outside } = await serve(page);
    await page.setViewportSize(size);
    await page.goto(BASE);
    await expect(page.getByRole("table")).toBeVisible();
    await page.getByRole("button", { name: "Zoradiť podľa: Dĺžka (m)" }).click();
    await testInfo.attach(`desk-${size.width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    expect(await layoutProblems(page, LIVE_BLOCKS)).toEqual([]);
    expect({ missing, problems, outside }).toEqual({ missing: [], problems: [], outside: [] });
  });
}
