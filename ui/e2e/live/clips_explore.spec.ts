/**
 * T-6454, journey 3: Explore data. Pick an Endpoint of the space, filter a column, open a row and read an attribute's history. Read only.
 */
import { expect, test } from "@playwright/test";
import { EDITOR } from "./portal";
import { SIZES, clipOf } from "./clips";

test.setTimeout(240_000);

for (const size of SIZES) {
  test(`Explore data at ${size.width}`, async ({ browser }) => {
    const clip = await clipOf(browser, EDITOR, "explore", size, "/projects/helsinki/explore?lang=en");
    const { page } = clip;
    try {
      const rows = page.getByRole("button", { name: /^Open: / });
      await clip.step("Explore data: the page opens on a space and an Endpoint", async () => {
        await expect(page.getByRole("heading", { level: 1, name: "Explore data" })).toBeVisible({ timeout: 60_000 });
        await expect(page.getByRole("combobox", { name: "Context space" })).toBeVisible({ timeout: 60_000 });
      });
      await clip.step("Pick the Endpoint: its rows fill the grid", async () => {
        await page.getByRole("combobox", { name: "Endpoint" }).selectOption({ label: "Helsinki air quality" });
        await expect(rows.first()).toBeVisible({ timeout: 60_000 });
      });
      await clip.step("Filter a column by one of its values", async () => {
        // A phone folds the filter row under one button.
        if (size.width < 640) await page.locator(".jc-grid-filter-toggle").first().click();
        const filter = page.locator(".jc-grid-filter-row select").first();
        await filter.selectOption({ index: 1 });
        await expect(page.getByText(/^\d+ of \d+ loaded/)).toBeVisible({ timeout: 60_000 });
        await expect(rows.first()).toBeVisible({ timeout: 60_000 });
      });
      const dialog = page.getByRole("dialog", { name: /^Details:/ });
      await clip.step("Open a row: its fields", async () => {
        await rows.first().click();
        await expect(dialog).toBeVisible({ timeout: 30_000 });
      });
      await clip.step("History: one attribute over time", async () => {
        await dialog.getByRole("tab", { name: "History" }).click();
        await expect(dialog.getByRole("tabpanel")).not.toContainText("Loading", { timeout: 60_000 });
      });
    } finally {
      await clip.finish();
    }
  });
}
