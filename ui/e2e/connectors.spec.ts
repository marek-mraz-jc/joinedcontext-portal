import { expect, test } from "@playwright/test";
import { axeViolations } from "./axe";

// A person's own MCP connectors (UI-98, T-4531): `vite preview` has no portal API behind it, so
// the API is answered in the browser; the stored connector shows, and its address is the
// organization's MCP address with the connector's name.

test("my MCP connectors: the stored one shows with its address", async ({ page }) => {
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (path.endsWith("/auth/me")) {
      return json({ subject: "s", username: "jana", name: "Jana", email: "jana@bbsk.sk", roles: ["portal-editor"] });
    }
    if (path === "/api/v1/preferences") {
      return json({ connectors: [{ name: "air", select: {} }] });
    }
    if (path === "/api/v1/projects") {
      return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "ProjectList", items: [{ name: "bbsk" }] });
    }
    return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] });
  });

  await page.goto("/connectors?lang=en");
  await expect(page.getByRole("heading", { level: 1, name: "My MCP connectors" })).toBeVisible();
  await expect(page.getByText("/api/mcp/me/air").first()).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});
