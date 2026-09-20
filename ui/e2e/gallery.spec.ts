/**
 * The component gallery in a real browser, at three sizes (T-1729; UI-15, UI-16, UI-27).
 *
 * The gallery is a development route — a production build drops it — so this runs against the
 * dev server (the `gallery` project of `playwright.config.ts`), while every other spec runs
 * against the preview of `dist/`.
 *
 * Two things are asserted at each size. What a picture cannot say: nothing pushes the page
 * sideways, with a sixty-character German label on every specimen, and every specimen is on the
 * page — the measurement `visual.spec.ts` already makes at phone width. And the picture itself
 * (T-2413): one baseline per size, compared the way the page baselines are, so a token, a
 * radius, a focus ring or a spacing scale changed by hand is a red lane instead of something a
 * person notices in a recording.
 *
 * A baseline changes only on purpose: `pnpm e2e -- --project=gallery --update-snapshots`, and
 * the four PNGs under `gallery.spec.ts-snapshots/` are reviewed like code.
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
        // An element inside a horizontal scroller is not what pushes the page sideways — a wide
        // table in its own `overflow-x-auto` is the design (`components/ui/Table.tsx`). Naming
        // those as offenders sent two sessions after a table that was never the cause, so each
        // one now says how far past the edge it reaches and whether anything clips it.
        const clipped = (element: HTMLElement) => {
          for (let node = element.parentElement; node; node = node.parentElement) {
            if (getComputedStyle(node).overflowX !== "visible") {
              return true;
            }
          }
          return false;
        };
        // Everything drawn, not `main *`: the element that widened the page once turned out to be
        // outside `main` and the run before it was `position: fixed`, whose `offsetParent` is
        // null — both invisible to the old scan, which then blamed the table it could see.
        const wide: string[] = [];
        document.querySelectorAll<HTMLElement>("body *").forEach((element) => {
          const box = element.getBoundingClientRect();
          if (box.width === 0 && box.height === 0) {
            return;
          }
          if (box.right > doc.clientWidth + 1) {
            const past = Math.round(box.right - doc.clientWidth);
            const where = clipped(element) ? "inside a scroller" : "NOT CLIPPED";
            const id = element.id ? `#${element.id}` : "";
            wide.push(
              `${element.tagName}${id}.${String(element.className).slice(0, 40)} +${past}px ${getComputedStyle(element).position} ${where}`,
            );
          }
        });
        // The unclipped ones first, widest first: those are the page's own width, the rest are
        // context. A list that is all "inside a scroller" means the cause is none of them.
        const past = (entry: string) => Number(/\+(\d+)px/.exec(entry)?.[1] ?? 0);
        wide.sort(
          (a, b) =>
            Number(b.includes("NOT CLIPPED")) - Number(a.includes("NOT CLIPPED")) ||
            past(b) - past(a),
        );
        return { overflow: doc.scrollWidth - doc.clientWidth, offenders: wide.slice(0, 8) };
      });
      expect(
        overflow,
        `the gallery scrolls sideways by ${overflow}px: ${offenders.join(" | ")}`,
      ).toBeLessThanOrEqual(1);

      // Every specimen is on the page: one section per component, each with its heading.
      const sections = await page.getByRole("region").count();
      expect(sections).toBeGreaterThan(8);

      // UI-15, UI-16, UI-27: the gallery as a person sees it. `fullPage`, because the point is
      // every specimen, not the first screen of them.
      await expect(page).toHaveScreenshot(`gallery-${size.name}.png`, {
        fullPage: true,
        animations: "disabled",
        caret: "hide",
        // Another machine's chromium rasterizes text a shade differently; a layout change is far
        // above this (the ratio `visual.spec.ts` holds its own baselines at).
        maxDiffPixelRatio: 0.03,
      });
    });
  });
}
