import { expect, test } from "@playwright/test";
import { WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { BASE, serve } from "./serve";

// UI-84, SDK-12, AP-138 (T-3334): the news topics page at a phone, a tablet, a laptop and a wall,
// with its chart and topics list drawn: no sideways scroll, no two blocks over each other,
// nothing axe finds at WCAG 2.1 AA.
const VIEWS = [
  { name: "topics", search: null },
  { name: "a search", search: "traffic" },
];

for (const view of VIEWS) {
  for (const size of WIDTHS) {
    test(`${view.name} at ${size.width} px: no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
      const { outside, missing, problems } = await serve(page);
      await page.setViewportSize(size);
      await page.goto(`${BASE}#topics`);
      const topicsList = page.getByRole("list", { name: /Topics|Aiheet/i }).or(page.locator(".app-topics"));
      await expect(topicsList.getByRole("listitem").first()).toBeVisible();
      await expect(page.locator(".jc-chart-canvas canvas")).toHaveCount(1);
      if (view.search) {
        await page.getByRole("searchbox").fill(view.search);
        await expect(topicsList.getByRole("listitem").first()).toBeVisible();
      }
      await testInfo.attach(`${view.name}-${size.width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(await layoutProblems(page)).toEqual([]);
      expect({ outside, missing, problems }).toEqual({ outside: [], missing: [], problems: [] });
    });
  }
}
