import { expect, test } from "@playwright/test";
import { WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { BASE, serve } from "./serve";

for (const scheme of ["light", "dark"] as const) {
  for (const lang of ["fi", "en"] as const) {
    for (const size of WIDTHS) {
      test(`${scheme} ${lang} at ${size.width} px: types list has buttons, chart canvas drawn, choose BikeHireDockingStation shows failing table, axe clean`, async ({ page }, testInfo) => {
        await page.emulateMedia({ colorScheme: scheme });
        const { outside, missing, problems } = await serve(page);
        await page.setViewportSize(size);
        await page.goto(`${BASE}?lang=${lang}`);

        // The types list has buttons
        const typeButtons = page.locator(".app-type-btn");
        await expect(typeButtons).toHaveCount(4);

        // The chart canvas is drawn
        await expect(page.locator(".jc-chart-canvas")).toHaveCount(1);
        await expect(page.locator(".jc-chart-canvas canvas").first()).toBeVisible();

        // Choose BikeHireDockingStation and the failing table has rows
        await page.getByRole("button", { name: "BikeHireDockingStation", exact: true }).click();
        const failingTable = page.locator(
          lang === "fi" ? "table[aria-label='Virheelliset kohteet']" : "table[aria-label='Failing entities']",
        );
        await expect(failingTable).toBeVisible();
        await expect(failingTable.locator("tbody tr")).toHaveCount(4);

        await testInfo.attach(`${scheme}-${lang}-${size.width}.png`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });

        // Sideways scroll, overlap, cut-off controls and what axe finds at WCAG 2.1 AA.
        expect(await layoutProblems(page)).toEqual([]);
        expect({ outside, missing, problems }).toEqual({ outside: [], missing: [], problems: [] });
      });
    }
  }
}

test("clicking back button returns to overview tiles and updates hash to #quality", async ({ page }) => {
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}?lang=en#quality?type=BikeHireDockingStation`);

  await expect(page.getByRole("button", { name: "BikeHireDockingStation", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "← All types" }).click();
  await expect(page.locator(".jc-tiles .jc-tile")).toHaveCount(4);
  expect(new URL(page.url()).hash).toBe("#quality");
});

test("all types failing displays retryable problem message", async ({ page }) => {
  await serve(page, []);
  await page.goto(`${BASE}?lang=en`);
  // All types have 0 entities with empty rows, Vehicle has no schema
  await expect(page.locator(".jc-tiles")).toBeVisible();
});

// T-3391, SDK-40: a failing entity opened in the SDK's entity panel by its id, at a phone and a
// laptop, light and dark. The App is public, so the panel links to the Portal and offers no Edit.
for (const scheme of ["light", "dark"] as const) {
  for (const width of [375, 1440]) {
    test(`${scheme} at ${width} px: a failing entity in the entity panel, linked to the Portal, axe clean`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const served = await serve(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${BASE}?lang=en`);
      await page.getByRole("button", { name: "BikeHireDockingStation", exact: true }).click();
      await page.getByRole("table", { name: "Failing entities" }).getByRole("button", { name: "fail-neg" }).first().click();
      // The panel names the entity by its name once read, by its id until then.
      const panel = page.getByRole("dialog");
      await expect(panel.getByText("BikeHireDockingStation")).toBeVisible();
      await expect(panel.getByRole("link", { name: "Open in the Portal" })).toBeVisible();
      await expect(panel.getByRole("button", { name: "Edit" })).toHaveCount(0);
      expect(await layoutProblems(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(served).toEqual({ outside: [], missing: [], problems: [] });
    });
  }
}
