/**
 * The component gallery in a real browser, at three sizes (T-1729; UI-15, UI-16, UI-27).
 *
 * The gallery is a development route — a production build drops it — so this runs against the
 * dev server (the `gallery` project of `playwright.config.ts`), while every other spec runs
 * against the preview of `dist/`.
 *
 * What is asserted here is what a picture cannot: at each size nothing pushes the page sideways,
 * with a sixty-character German label on every specimen, and every specimen is on the page. The
 * measurement is the one `visual.spec.ts` already makes at phone width. The visual baselines
 * themselves are not in this file: `toHaveScreenshot` fails a lane the first time it meets a
 * missing baseline, and this sandbox's browser rasterizes text differently from the one in CI, so a baseline made
 * here would be a red lane rather than a check. They are generated once from the `ci-full` e2e
 * lane and committed — the task that does it is named in T-1729.
 *
 * The dark theme is `@media (prefers-color-scheme: dark)` in `src/tokens.css`, so it is a size
 * here like any other: the same page with `colorScheme: "dark"`.
 */
import { expect, test } from "@playwright/test";

const SIZES = [
  // The recording: 1920×1080 at zoom 1.5 lays the page out at 1280 CSS px.
  { name: "1920x1080-zoom1.5", viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, colorScheme: "light" as const },
  { name: "400px", viewport: { width: 400, height: 860 }, deviceScaleFactor: 1, colorScheme: "light" as const },
  // WCAG 1.4.4: the page at twice the text size, laid out at 640 CSS px.
  { name: "text-200", viewport: { width: 640, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" as const },
  // The same controls in the other colour way (`prefers-color-scheme: dark`, src/tokens.css).
  { name: "dark", viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, colorScheme: "dark" as const },
];

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use({
      viewport: size.viewport,
      deviceScaleFactor: size.deviceScaleFactor,
      colorScheme: size.colorScheme,
    });

    test(`every control is drawn inside the page at ${size.name}`, async ({ page }) => {
      await page.route("**/api/v1/**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ grants: [], bootstrap: true }),
        }),
      );
      await page.goto("/__gallery?lang=en", { waitUntil: "networkidle" });
      await expect(page.getByRole("heading", { level: 1, name: "Component gallery" })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);

      // A page scrolls down, never sideways (UI-27) — a sixty-character German label is what
      // pushes a row out of the page, and it is on every specimen.
      const { overflow, offenders } = await page.evaluate(() => {
        const doc = document.documentElement;
        const wide: string[] = [];
        document.querySelectorAll<HTMLElement>("main *").forEach((element) => {
          const box = element.getBoundingClientRect();
          if (box.right > doc.clientWidth + 1 && element.offsetParent !== null) {
            wide.push(`${element.tagName}.${String(element.className).slice(0, 60)}`);
          }
        });
        return { overflow: doc.scrollWidth - doc.clientWidth, offenders: wide.slice(0, 6) };
      });
      expect(overflow, `the gallery scrolls sideways: ${offenders.join(" | ")}`).toBeLessThanOrEqual(1);

      // Every specimen is on the page: one section per component, each with its heading.
      const sections = await page.getByRole("region").count();
      expect(sections).toBeGreaterThan(8);
    });
  });
}
