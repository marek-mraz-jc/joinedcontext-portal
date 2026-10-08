import { expect, test } from "@playwright/test";
import { WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { BASE, serve } from "./serve";

// T-3330, UI-84, SDK-12: the comparison at a phone, a tablet, a laptop and a wall, light and dark,
// with the WebAssembly statistics run in their worker under the static host's policy: no sideways
// scroll, no two blocks over each other, nothing axe finds at WCAG 2.1 AA.
for (const scheme of ["light", "dark"] as const) {
  for (const size of WIDTHS) {
    test(`${scheme} at ${size.width} px: the answer is given, no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      const { outside, missing, problems } = await serve(page);
      await page.setViewportSize(size);
      await page.goto(BASE);
      const compare = page.getByRole("region", { name: "Compare" });
      await expect(compare.getByRole("region", { name: "The answer" })).toContainText("falls as wind speed");
      await expect(compare.getByTestId("jc-map").locator("canvas")).toHaveCount(1);
      // Each chart draws (a chart may stack a second canvas for its hover layer).
      await expect(compare.locator(".jc-chart-canvas").filter({ has: page.locator("canvas") })).toHaveCount(2);
      await testInfo.attach(`compare-${scheme}-${size.width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(await layoutProblems(page)).toEqual([]);
      expect({ outside, missing, problems }).toEqual({ outside: [], missing: [], problems: [] });
    });
  }
}

test("a longer period and another station stay chosen after a reload", async ({ page }) => {
  await serve(page);
  await page.goto(BASE);
  await page.getByRole("combobox", { name: "Period" }).selectOption("7");
  await page.getByRole("combobox", { name: "Air quality station" }).selectOption("makelankatu");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Period" })).toHaveValue("7");
  await expect(page.getByRole("combobox", { name: "Air quality station" })).toHaveValue("makelankatu");
});
