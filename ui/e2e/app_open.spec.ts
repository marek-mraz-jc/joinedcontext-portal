import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { axeViolations } from "./axe";

// An App inside the Portal (T-2689, AP-122): `vite preview` has no Portal API and no static host
// behind it, so both are answered in the browser; the page, its route and its frame are real.

const IDENTITY = {
  subject: "b7c1e0f4",
  username: "demo.steward",
  name: "Demo Steward",
  email: "demo.steward@hel.fi",
  roles: ["portal-editor"],
};
const COMMIT = "4f2a9c1e0b7d3a5f6c8e9d0a1b2c3d4e5f6a7b8c";

function app(name: string, lifecycle: string) {
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "App",
    metadata: { name, namespace: "helsinki", title: { en: "City bikes" } },
    spec: { kind: "static", visibility: "internal", lifecycle, dataNeeds: [] },
    status: lifecycle === "published" ? { build: { commit: COMMIT, digest: `sha256:${"b".repeat(64)}` } } : {},
  };
}

async function stub(page: Page): Promise<void> {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) return json(IDENTITY);
    if (path === "/api/v1/projects") {
      return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "ProjectList", items: [{ name: "helsinki" }] });
    }
    if (path.endsWith("/apps/city-bikes/build") || path.endsWith("/apps/old-map/build")) {
      return json({ repositoryUrl: null, packageUrl: null, run: null, rebuild: { allowed: false, reason: "no repository" } });
    }
    if (path.endsWith("/apps/city-bikes")) return json(app("city-bikes", "published"));
    if (path.endsWith("/apps/old-map")) return json(app("old-map", "retired"));
    return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] });
  });
  // The App's own address, as the edge serves it: framed only by the Portal.
  await page.route("**/apps/city-bikes/", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: { "content-security-policy": "default-src 'self'; frame-ancestors 'self'" },
      body: '<!doctype html><html lang="en"><head><title>City bikes</title></head><body><main><h1>Stations</h1></main></body></html>',
    }),
  );
}

test.describe("an App inside the Portal (AP-122)", () => {
  test("runs in a sandboxed frame under the Portal's header, with a window of its own offered", async ({ page }) => {
    await stub(page);
    await page.goto("/projects/helsinki/apps/city-bikes/open?lang=en");

    await expect(page.getByRole("heading", { level: 1, name: "City bikes" })).toBeVisible();
    await expect(page.getByText("Serving commit 4f2a9c1")).toBeVisible();
    const frame = page.locator("iframe");
    await expect(frame).toHaveAttribute("title", "City bikes, the application");
    await expect(frame).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads",
    );
    await expect(page.frameLocator("iframe").getByRole("heading", { name: "Stations" })).toBeVisible();

    const own = page.getByRole("link", { name: /Open in new window/ });
    await expect(own).toHaveAttribute("href", "/apps/city-bikes/");
    await expect(own).toHaveAttribute("target", "_blank");
    await expect(own).toHaveAttribute("rel", "noopener noreferrer");

    expect(await axeViolations(page)).toEqual([]);
  });

  test("a retired App shows its state and no frame", async ({ page }) => {
    await stub(page);
    await page.goto("/projects/helsinki/apps/old-map/open?lang=en");

    await expect(page.getByText("This application is retired")).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Open in new window/ })).toHaveCount(0);
  });
});
