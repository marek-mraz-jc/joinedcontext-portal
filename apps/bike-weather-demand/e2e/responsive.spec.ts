import { expect, test } from "@playwright/test";
import { WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { BASE, serve } from "./serve";

for (const scheme of ["light", "dark"] as const) {
  for (const lang of ["fi", "en"] as const) {
    for (const size of WIDTHS) {
      test(`${scheme} ${lang} at ${size.width} px: answers on arrival, map canvas, tiles, chart, heat table, axe clean`, async ({ page }, testInfo) => {
        await page.emulateMedia({ colorScheme: scheme });
        const { outside, missing, problems } = await serve(page);
        await page.setViewportSize(size);
        await page.goto(`${BASE}?lang=${lang}`);

        // The map canvas is drawn
        await expect(page.getByTestId("jc-map").locator("canvas")).toHaveCount(1);

        // The station selector is present
        const combobox = page.getByRole("combobox");
        await expect(combobox).toBeVisible();

        // Availability tiles are visible
        const tiles = page.locator(".jc-tiles .jc-tile");
        await expect(tiles).toHaveCount(3);

        // The chart canvas is drawn
        await expect(page.locator(".jc-chart-canvas")).toHaveCount(1);

        // The profile heat table is visible
        await expect(page.locator(".app-heat-table")).toBeVisible();

        await testInfo.attach(`${scheme}-${lang}-${size.width}.png`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });

        expect(await layoutProblems(page)).toEqual([]);
        expect({ outside, missing, problems }).toEqual({ outside: [], missing: [], problems: [] });
      });
    }
  }
}

test("changing the station in combobox updates URL hash and tiles", async ({ page }) => {
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}?lang=en`);

  const combobox = page.getByRole("combobox", { name: "Station" });
  await expect(combobox).toBeVisible();

  await combobox.selectOption({ label: "Hakaniemi (10 / 20)" });
  expect(page.url()).toContain("id=urn%3Angsi-ld%3ABikeHireDockingStation%3Ahel.fi%3Ahelsinki%3Astation-2");

  await expect(page.getByText("No history available for this station.").first()).toBeVisible();
});

test("switching language toggles between Finnish and English", async ({ page }) => {
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}?lang=fi`);

  await expect(page.getByRole("heading", { level: 1, name: "Pyörät ja sää" })).toBeVisible();

  await page.getByRole("button", { name: "In English" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Bikes and the weather" })).toBeVisible();
  expect(page.url()).toContain("lang=en");
});

test("empty stations shows message instead of broken UI", async ({ page }) => {
  await serve(page, []);
  await page.goto(`${BASE}?lang=en`);
  await expect(page.getByText("No bike stations readable.")).toBeVisible();
});
