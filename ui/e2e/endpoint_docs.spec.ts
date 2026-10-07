import { expect, test } from "@playwright/test";
import { axeViolations } from "./axe";

// A public Endpoint's API documentation (T-3265, EP-99), opened by somebody who is not signed in:
// the page reads the gateway's generated OpenAPI anonymously and asks the Portal for nothing.

const DOC = {
  openapi: "3.1.0",
  info: { title: "Helsinki city bikes", description: "Stations and free bikes.", version: "1.0.0" },
  paths: {
    "/ngsi-ld/v1/entities": {
      get: {
        summary: "The entities of a type",
        parameters: [{ name: "type", in: "query", description: "The entity type", schema: { type: "string", enum: ["BikeHireDockingStation"] } }],
      },
    },
  },
  components: { schemas: { BikeHireDockingStation: { type: "object", properties: { availableBikeNumber: { type: "integer" } } } } },
};

test.describe("an endpoint's public documentation", () => {
  test("a visitor reads the operations, an example call and the types, and a slug that is gone says so", async ({ page }) => {
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
      if (url.pathname.startsWith("/api/endpoint/gone/")) {
        return route.fulfill({ status: 404, contentType: "application/problem+json", body: JSON.stringify({ title: "Not Found", status: 404 }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DOC) });
    });

    await page.goto("/d/k7m2qz4tv6xh3n5jb2ryd3wcfa?lang=en");
    await expect(page.getByRole("heading", { level: 1, name: "Helsinki city bikes" })).toBeVisible();
    await expect(page.getByRole("region", { name: "GET /ngsi-ld/v1/entities" }).getByText(/curl .*type=BikeHireDockingStation/)).toBeVisible();
    await expect(page.getByRole("region", { name: "BikeHireDockingStation" })).toContainText("availableBikeNumber");
    expect(await axeViolations(page)).toEqual([]);
    expect(asked.filter((path) => path.startsWith("/api/v1/projects"))).toEqual([]);

    await page.goto("/d/gone?lang=en");
    await expect(page.getByText("This endpoint's documentation cannot be read: it does not exist, or you may not read it.")).toBeVisible();
  });
});
