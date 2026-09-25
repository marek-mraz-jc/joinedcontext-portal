/**
 * An App opens inside the Portal, under its header and sidebar (T-2689, AP-122, UI-44).
 *
 * The steward opens three published Apps of Helsinki from their catalog cards: each one runs in a
 * sandboxed frame of the Portal page and shows its data there, the frame's own login being the
 * two redirects of the realm session. "Open in new window" opens the same App as a page of its
 * own. The edge lets only the Portal's host frame an App, so the frame loading at all is the
 * header's check; a framed App that the edge refused would show the browser's refusal instead.
 *
 * Every wait is on the thing the step needs, never on the network going idle (T-2452).
 */
import { expect, test } from "@playwright/test";
import type { FrameLocator, Locator } from "@playwright/test";
import { STEWARD, signIn } from "./portal";

const PROJECT = "helsinki";

test.setTimeout(600_000);

/** Each App and what shows that it read its data inside the frame. */
const APPS: { name: string; data: (frame: FrameLocator) => Locator }[] = [
  {
    name: "helsinki-bikes",
    data: (frame) => frame.getByRole("region", { name: "Overview" }).getByText(/\d/).first(),
  },
  {
    name: "helsinki-alerts",
    data: (frame) =>
      frame
        .getByRole("region", { name: "Overview" })
        .getByText(/^[a-zA-Z][\w -]*: \d+$/)
        .first(),
  },
  {
    name: "air-quality",
    data: (frame) => frame.getByRole("heading", { level: 1, name: "Air quality" }),
  },
];

for (const app of APPS) {
  test(`${app.name} opens inside the Portal with its data, and in a window of its own`, async ({ browser }) => {
    const steward = await signIn(browser, STEWARD, `/projects/${PROJECT}/apps/${app.name}/open?lang=en`);
    try {
      const page = steward.page;
      // The Portal's own page stays around the App: its sidebar and the App's title row.
      await expect(page.getByRole("navigation").first()).toBeVisible({ timeout: 60_000 });
      const frameElement = page.locator("iframe[sandbox]");
      // The frame keeps its own origin only on an Apps origin apart from the Portal's (AP-19,
      // T-2840); it never gets the Portal's window.
      const src = new URL((await frameElement.getAttribute("src")) ?? "", page.url());
      const ownOrigin = src.origin !== new URL(page.url()).origin;
      await expect(frameElement).toHaveAttribute(
        "sandbox",
        `allow-scripts allow-forms allow-popups allow-downloads${ownOrigin ? " allow-same-origin" : ""}`,
      );
      await expect(app.data(page.frameLocator("iframe[sandbox]"))).toBeVisible({ timeout: 120_000 });
      expect(new URL(page.url()).pathname, "the Portal kept its window").toBe(
        `/projects/${PROJECT}/apps/${app.name}/open`,
      );

      const popup = page.waitForEvent("popup");
      await page.getByRole("link", { name: /Open in new window/ }).click();
      const own = await popup;
      // The realm session makes the App's own login two redirects before the App's address.
      await own.waitForURL((url) => url.pathname === `/apps/${app.name}/`, { timeout: 60_000 });
      await own.close();
    } finally {
      await steward.context.close();
    }
  });
}
