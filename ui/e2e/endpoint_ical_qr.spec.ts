import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// T-5296: the Endpoint page shows each calendar's webcal:// address as a QR code a phone camera
// opens as a subscription, named by that address for a screen reader.

const API = "joinedcontext.com/v1alpha1";
const SLUG = "k7m2qz4tv6xh3n5jb2ryd3wcfa";
const ENDPOINT = {
  apiVersion: API,
  kind: "Endpoint",
  metadata: { name: "events", namespace: "helsinki", labels: { "joinedcontext.com/space": "tapahtumat" } },
  spec: {
    contextSpaceRef: "tapahtumat",
    slug: SLUG,
    audience: "public",
    enabledRepresentations: ["ngsi-ld", "ical"],
    representations: {
      ical: [
        { name: "kalendar", title: { en: "City events" }, sources: [{ type: "Event" }] },
        { name: "sport", title: { en: "Sport" }, sources: [{ type: "SportsEvent" }] },
      ],
    },
  },
  status: { phase: "Live" },
};

for (const width of [1440, 400]) {
  test(`each calendar of an Endpoint has a QR code of its webcal address at ${width} px (T-5296)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const list = (items: unknown[]) => ({ apiVersion: API, kind: "List", items });
    await page.route("**/api/v1/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
      if (path.endsWith("/auth/me")) {
        return json({ subject: "s1", username: "steward", name: "Steward", email: "s@hel.fi", roles: ["portal-editor"] });
      }
      if (path === "/api/v1/projects") return json(list([{ name: "helsinki" }]));
      if (path === "/api/v1/projects/helsinki/endpoints/events") return json(ENDPOINT);
      return json(list([]));
    });
    await page.route("**/cs/**", (route) => route.fulfill({ contentType: "application/ld+json", body: "[]" }));
    await page.route("**/api/endpoint/**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));

    await page.goto("/projects/helsinki/endpoints/events?lang=en");
    const codes = page.getByRole("img", { name: /^QR code of the calendar subscription webcal:\/\// });
    await expect(codes).toHaveCount(2);
    for (const [n, name] of ["kalendar", "sport"].entries()) {
      const code = codes.nth(n);
      await expect(code).toHaveAccessibleName(new RegExp(`/api/endpoint/${SLUG}/ical/v1/${name}\\.ics$`));
      await expect(code).toBeVisible();
      const box = await code.boundingBox();
      // Large enough for a phone camera at arm's length, and inside a 400 px screen.
      expect(box?.width).toBe(128);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    }
    await expect(page.getByText("Scan it with a phone camera to add the calendar.").first()).toBeVisible();

    const dir = join("test-results", "T-5296");
    mkdirSync(dir, { recursive: true });
    await codes.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(dir, `endpoint-ical-qr-${width}.png`) });
  });
}
