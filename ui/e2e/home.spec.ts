import { expect, test } from "@playwright/test";
import { axeViolations } from "./axe";

// The project home (T-3233, T-3235): a new editor signs in to a project that holds nothing yet,
// lands on its home, and meets the five steps from nothing to shared data, each one a link.
test("a new editor lands on the home and meets the five steps", async ({ page }) => {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.endsWith("/auth/me")) {
      return json({ subject: "e1", username: "eva", name: "Eva Editor", email: "eva@example.org", roles: [] });
    }
    if (url.pathname === "/api/v1/projects") return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "ProjectList", items: [{ name: "helsinki" }] });
    if (url.pathname.endsWith("/permissions/me")) {
      return json({ project: "helsinki", grants: [{ rule: { kinds: ["ContextSpace", "DataSource", "Pipeline", "Endpoint"], verbs: ["read", "propose"] } }] });
    }
    if (url.pathname === "/api/v1/preferences") return json({});
    return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] });
  });
  await page.goto("/?lang=en");
  await expect(page).toHaveURL(/\/projects\/helsinki\/home/);
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  const checklist = page.getByRole("region", { name: "Getting started" });
  await expect(checklist.getByRole("listitem")).toHaveCount(5);
  await expect(checklist.getByRole("link", { name: "Create a space" })).toHaveAttribute("href", "/projects/helsinki/spaces/new");
  expect(await axeViolations(page)).toEqual([]);
  await page.goto("/projects/helsinki/home?lang=en");
  await expect(checklist.getByRole("status")).toHaveText("0 of 5 done");
});
