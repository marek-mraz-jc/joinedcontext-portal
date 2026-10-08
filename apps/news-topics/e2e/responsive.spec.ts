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

// SDK-40, T-3401: an article of the chosen topic opens in the shell's entity panel, read through the
// app's endpoint, at a phone and a laptop, light and dark; a public App writes nothing, so the panel
// links to the Portal.
for (const scheme of ["light", "dark"] as const) {
  for (const width of [375, 1440]) {
    test(`${scheme} at ${width} px: an article in the entity panel, linked to the Portal, axe clean`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const { outside, missing, problems } = await serve(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${BASE}#topics`);
      const articles = page.getByRole("list", { name: /articles of topic/i });
      await articles.getByRole("heading").first().getByRole("button").click();
      const panel = page.getByRole("dialog");
      await expect(panel.getByRole("link", { name: "Open in the Portal" })).toBeVisible();
      await expect(panel.getByRole("button", { name: "Edit" })).toHaveCount(0);
      expect(await layoutProblems(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect({ outside, missing, problems }).toEqual({ outside: [], missing: [], problems: [] });
    });
  }
}
