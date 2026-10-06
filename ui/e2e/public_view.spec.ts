import { expect, test } from "@playwright/test";
import { axeViolations } from "./axe";

// A data view published as a public link (T-3108, API/01 §33), opened by somebody who is not
// signed in: the page reads the public Endpoint anonymously and asks the Portal for nothing.

test.describe("a published data view", () => {
  test("a visitor reads the published type read-only, and a link that is gone says so", async ({ page }) => {
    const asked: string[] = [];
    await page.route("**/api/v1/**", async (route) => {
      const url = new URL(route.request().url());
      asked.push(url.pathname);
      const unauthorized = url.pathname.endsWith("/auth/me");
      await route.fulfill({
        status: unauthorized ? 401 : 404,
        contentType: "application/problem+json",
        body: JSON.stringify({ title: unauthorized ? "Unauthorized" : "Not Found", status: unauthorized ? 401 : 404 }),
      });
    });
    await page.route("**/api/endpoint/**", async (route) => {
      const url = new URL(route.request().url());
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (url.pathname.startsWith("/api/endpoint/gone/")) return json({ title: "Not Found", status: 404 }, 404);
      if (url.pathname.endsWith("/ngsi-ld/v1/types")) return json({ typeList: ["BikeHireDockingStation"] });
      return json([
        { id: "urn:ngsi-ld:BikeHireDockingStation:hel.fi:bikes:1", type: "BikeHireDockingStation", name: "Kamppi", availableBikeNumber: 4 },
      ]);
    });

    await page.goto("/v/k7m2qz4tv6xh3n5jb2ryd3wcfa?lang=en");
    await expect(page.getByRole("heading", { level: 1, name: "BikeHireDockingStation" })).toBeVisible();
    await expect(page.getByRole("table", { name: "BikeHireDockingStation" }).getByText("Kamppi")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    expect(asked.filter((path) => path.startsWith("/api/v1/projects"))).toEqual([]);

    await page.goto("/v/gone?lang=en");
    await expect(page.getByText("This view is not published, or not any more.")).toBeVisible();
  });
});
