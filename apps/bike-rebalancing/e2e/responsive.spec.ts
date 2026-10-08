import { expect, test } from "@playwright/test";
import { WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { BASE, serve } from "./serve";

// T-3328, UI-84, SDK-12: the plan at a phone, a tablet, a laptop and a wall, light and dark, with
// the WebAssembly planner run in its worker under the static host's policy: no sideways scroll, no
// two blocks over each other, nothing axe finds at WCAG 2.1 AA.
for (const scheme of ["light", "dark"] as const) {
  for (const size of WIDTHS) {
    test(`${scheme} at ${size.width} px: the route is planned, no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      const { outside, missing, problems } = await serve(page);
      await page.setViewportSize(size);
      await page.goto(BASE);
      const plan = page.getByRole("region", { name: "Rebalancing" });
      await expect(plan.getByRole("list", { name: "Route" }).getByRole("listitem").first()).toBeVisible();
      await expect(plan.getByTestId("jc-map").locator("canvas")).toHaveCount(1);
      await expect(plan.locator(".jc-chart-canvas canvas")).toHaveCount(1);
      await testInfo.attach(`plan-${scheme}-${size.width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(await layoutProblems(page)).toEqual([]);
      expect({ outside, missing, problems }).toEqual({ outside: [], missing: [], problems: [] });
    });
  }
}

test("a station left out stays out after a reload, by the address", async ({ page }) => {
  await serve(page);
  await page.goto(BASE);
  const route = page.getByRole("list", { name: "Route" });
  const first = route.getByRole("listitem").first();
  const name = (await first.locator("strong").textContent()) ?? "";
  await first.getByRole("button").click();
  await expect(route.getByText(name, { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("list", { name: "Route" }).getByRole("listitem").first()).toBeVisible();
  await expect(page.getByRole("list", { name: "Route" }).getByText(name, { exact: true })).toHaveCount(0);
});
