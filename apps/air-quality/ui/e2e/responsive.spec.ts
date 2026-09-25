import { expect, test } from "@playwright/test";
import { LIVE_BLOCKS, WIDTHS, layoutProblems } from "@joinedcontext/sdk/responsive";

// UI-84, SDK-12 (T-2825): the stations as an anonymous reader sees them and with a steward's
// form, through the real binary, at a phone, a tablet, a laptop and a wall: no sideways scroll, no
// two blocks over each other, no control cut off, nothing axe finds at WCAG 2.1 AA.
const BASE = "/apps/air-quality/";

/** The headers the edge puts in front of the app for a signed-in person (AP-28, ADR-N-019). */
const edge = (who: string) => ({
  "x-access-token": `token-for-${who}`,
  "x-userinfo": Buffer.from(
    JSON.stringify({ sub: `f:1:demo.${who}`, preferred_username: `demo.${who}@hel.fi`, email: `demo.${who}@hel.fi` }),
  ).toString("base64"),
});

// The page follows the reader's colour scheme, so a steward's view is checked in both.
const VIEWS = [
  { who: "an anonymous reader", scheme: "light" },
  { who: "a steward", scheme: "light" },
  { who: "a steward", scheme: "dark" },
] as const;

for (const { who, scheme } of VIEWS) {
  for (const size of WIDTHS) {
    test(`the stations for ${who}, ${scheme}, at ${size.width} px: no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(error.message));
      await page.emulateMedia({ colorScheme: scheme });
      if (who === "a steward") await page.setExtraHTTPHeaders(edge("steward"));
      await page.setViewportSize(size);
      await page.goto(BASE);
      await expect(page.getByRole("heading", { name: "Kallio", exact: true })).toBeVisible();
      if (who === "a steward") {
        await expect(page.getByRole("form", { name: "New station" })).toBeVisible();
        await page.getByRole("button", { name: "Edit Kallio" }).click();
        await expect(page.getByRole("form", { name: "Edit Kallio" })).toBeVisible();
      }
      await testInfo.attach(`${who}-${scheme}-${size.width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect(await layoutProblems(page, LIVE_BLOCKS)).toEqual([]);
      expect(problems).toEqual([]);
    });
  }
}
