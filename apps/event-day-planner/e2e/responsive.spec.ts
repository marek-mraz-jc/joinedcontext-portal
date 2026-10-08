import { expect, test } from "@playwright/test";
import { WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";
import { BASE, serve } from "./serve";

// T-3329, UI-84, SDK-12: the day at a phone, a tablet, a laptop and a wall, light and dark, with the
// WebAssembly planner run in its worker under the static host's policy: no sideways scroll, no two
// blocks over each other, nothing axe finds at WCAG 2.1 AA.
for (const scheme of ["light", "dark"] as const) {
  for (const size of WIDTHS) {
    test(`${scheme} at ${size.width} px: a day is suggested, no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      const { outside, missing, problems } = await serve(page);
      await page.setViewportSize(size);
      await page.goto(BASE);
      const day = page.getByRole("region", { name: "My day" });
      await expect(day.getByRole("list", { name: "The plan" }).getByRole("listitem").first()).toBeVisible();
      await expect(day.getByTestId("jc-map").locator("canvas")).toHaveCount(1);
      await expect(day.locator(".jc-chart-canvas canvas")).toHaveCount(1);
      await testInfo.attach(`day-${scheme}-${size.width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(await layoutProblems(page)).toEqual([]);
      expect({ outside, missing, problems }).toEqual({ outside: [], missing: [], problems: [] });
    });
  }
}

test("picked events are planned in order and stay picked after a reload", async ({ page }) => {
  await serve(page);
  await page.goto(BASE);
  const list = page.getByRole("list", { name: "Events of the day" });
  await list.getByRole("checkbox", { name: /Jazz at Stoa/ }).check();
  await list.getByRole("checkbox", { name: /Workshop for Families/ }).check();
  const plan = page.getByRole("list", { name: "The plan" });
  await expect(plan.getByRole("listitem")).toHaveCount(2);
  await expect(plan.getByRole("listitem").first()).toContainText("Workshop for Families");
  await page.reload();
  await expect(page.getByRole("list", { name: "The plan" }).getByRole("listitem").last()).toContainText("Jazz at Stoa");
});
