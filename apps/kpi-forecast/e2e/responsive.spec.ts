import { expect, test } from "@playwright/test";
import { WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { BASE, serve } from "./serve";

// T-3332: the page at a phone, a tablet, a laptop and a wall, light and dark, in Finnish and
// English: the answer on arrival (computed by the WebAssembly module under the static host's CSP),
// the indicators, the chosen one's chart and its odd reading; no sideways scroll, no overlap,
// nothing axe finds.
for (const scheme of ["light", "dark"] as const) {
  for (const lang of ["fi", "en"] as const) {
    for (const size of WIDTHS) {
      test(`${scheme} ${lang} at ${size.width} px: answers on arrival, no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
        await page.emulateMedia({ colorScheme: scheme });
        const { outside, missing, problems } = await serve(page);
        await page.setViewportSize(size);
        await page.goto(`${BASE}?lang=${lang}`);
        const summary = lang === "fi" ? /^4 mittaria, viimeiset 30 päivää: 1 nousee, 1 laskee, 1 pysyy ennallaan\./ : /^4 indicators over the last 30 days: 1 rising, 1 falling, 1 flat\./;
        await expect(page.locator(".app-summary")).toHaveText(summary);
        await expect(page.locator(".app-kpi")).toHaveCount(4);
        await expect(page.locator(".jc-chart-canvas canvas").first()).toBeVisible();
        await expect(page.locator(".app-anomalies li")).toHaveCount(1);
        await testInfo.attach(`${scheme}-${lang}-${size.width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
        // Sideways scroll, overlap, cut-off controls and what axe finds at WCAG 2.1 AA.
        expect(await layoutProblems(page)).toEqual([]);
        expect({ outside, missing, problems }).toEqual({ outside: [], missing: [], problems: [] });
      });
    }
  }
}

test("a picked indicator and the period go into the address and come back from it", async ({ page }) => {
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}?lang=en`);
  await expect(page.locator(".app-summary")).toHaveText(/^4 indicators /);
  await page.getByRole("button", { name: /^Demo counter/ }).click();
  await page.getByRole("combobox", { name: "Period" }).selectOption("7");
  await expect(page.locator(".app-summary")).toHaveText(/^4 indicators over the last 7 days/);
  const url = new URL(page.url());
  expect(url.searchParams.get("days")).toBe("7");
  expect(url.searchParams.get("kpi")).toMatch(/demo-counter-1$/);
  await page.reload();
  await expect(page.getByRole("button", { name: /^Demo counter/ })).toHaveAttribute("aria-pressed", "true");
});

test("no indicators says so instead of an empty page", async ({ page }) => {
  await serve(page, [], []);
  await page.goto(`${BASE}?lang=en`);
  await expect(page.getByText("No indicators.")).toBeVisible();
});
