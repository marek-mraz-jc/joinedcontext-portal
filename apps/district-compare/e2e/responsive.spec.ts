import { expect, test } from "@playwright/test";
import { WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { BASE, serve } from "./serve";

for (const scheme of ["light", "dark"] as const) {
  for (const lang of ["fi", "en"] as const) {
    for (const size of WIDTHS) {
      test(`${scheme} ${lang} at ${size.width} px: answers on arrival, table with two districts, map canvas, axe clean`, async ({ page }, testInfo) => {
        await page.emulateMedia({ colorScheme: scheme });
        const { outside, missing, problems } = await serve(page);
        await page.setViewportSize(size);
        await page.goto(`${BASE}?lang=${lang}`);

        // The map canvas is drawn
        await expect(page.getByTestId("jc-map").locator("canvas")).toHaveCount(1);

        // The ranked list has items
        const rankedList = page.locator(".app-ranked-list");
        await expect(rankedList).toBeVisible();
        await expect(rankedList.locator("li")).toHaveCount(3);

        // The table has two district columns (plus 1 measure column = 3 headers)
        await expect(page.locator(".jc-table thead th")).toHaveCount(3);

        // The chart canvas is drawn
        await expect(page.locator(".jc-chart-canvas")).toHaveCount(1);

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

test("toggling a district in the list adds it to the comparison table and updates URL hash", async ({ page }) => {
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}?lang=en`);

  // Initially 2 districts (Kamppi and Kallio)
  await expect(page.locator(".jc-table thead th")).toHaveCount(3);

  // Check Töölö
  await page.getByRole("checkbox", { name: "Töölö" }).check();

  // Now 3 districts (Kamppi, Kallio, Töölö) -> 4 header columns
  await expect(page.locator(".jc-table thead th")).toHaveCount(4);
  expect(page.url()).toContain("d=101%2C102%2C103");
});

test("changing the measure updates table rows and chart", async ({ page }) => {
  await serve(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}?lang=en`);

  // The data is still arriving when the measure changes: the address must end on the person's choice.
  await page.getByLabel("Measure").selectOption("bikes");
  await expect(page).toHaveURL(/m=bikes/);
  await expect(page.getByRole("table", { name: "Selected districts compared" })).toBeVisible();
  await expect(page).toHaveURL(/m=bikes/);
  await expect(page.locator("figcaption")).toHaveText("Selected districts: City-bike stations");
});

test("empty districts shows message instead of broken UI", async ({ page }) => {
  await serve(page, []);
  await page.goto(`${BASE}?lang=en`);
  await expect(page.getByText("No district boundaries readable.")).toBeVisible();
});
