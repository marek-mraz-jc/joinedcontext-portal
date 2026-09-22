import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { axeViolations } from "./axe";

// T-2605, UI-75: the Organization page in a real browser, the API answered in the browser as the
// other mocked specs do. What a browser adds over the vitest suite: the router's own addresses,
// the tab list driven by the keyboard, and a deletion that sends exactly one DELETE.

const IDENTITY = {
  subject: "b7c1e0f4",
  username: "ida.admin",
  name: "Ida Admin",
  email: "ida@hel.fi",
  roles: ["portal-editor"],
};

const LIST = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });

const ORGANIZATION = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Organization",
  metadata: { name: "hel", namespace: "org" },
  spec: {
    domain: "hel.fi",
    locales: ["fi", "en"],
    defaultLocale: "fi",
    projects: { creation: "org-admin", visibility: "organization" },
  },
};

const ADMIN = {
  project: "org",
  bootstrap: false,
  grants: [
    {
      role: "org-admin",
      binding: "admins",
      rule: {
        kinds: ["RoleBinding", "Role", "Group", "Organization", "Project", "ServiceAccount"],
        verbs: ["propose", "approve", "delete"],
      },
    },
  ],
};

async function stubApi(page: Page): Promise<{ writes: string[] }> {
  const writes: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path.endsWith("/auth/me")) return json(IDENTITY);
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${path}`);
      return json(
        {
          apiVersion: "joinedcontext.com/v1alpha1",
          kind: "Change",
          metadata: { name: "chg-000002a1", namespace: "helsinki" },
          status: { lane: "red", phase: "PendingApproval" },
        },
        202,
      );
    }
    if (path.endsWith("/permissions/me")) return json(ADMIN);
    if (path === "/api/v1/projects") return json(LIST([{ name: "helsinki" }]));
    if (path === "/api/v1/projects/helsinki") {
      return json({
        apiVersion: "joinedcontext.com/v1alpha1",
        kind: "Project",
        metadata: {},
        spec: {},
        status: { usage: { contextSpaces: 2 } },
      });
    }
    if (path === "/api/v1/projects/org/organizations") return json(LIST([ORGANIZATION]));
    if (path === "/api/v1/projects/org/roles") {
      return json(
        LIST([
          {
            apiVersion: "joinedcontext.com/v1alpha1",
            kind: "Role",
            metadata: { name: "org-admin", namespace: "org" },
            spec: { rules: [{ kinds: ["Project"], verbs: ["propose", "approve", "delete"] }] },
          },
        ]),
      );
    }
    return json(LIST([]));
  });
  return { writes };
}

test.describe("the Organization page", () => {
  test("opens on Settings and walks its tabs by keyboard, each at its own address", async ({ page }) => {
    await stubApi(page);
    await page.goto("/organization?lang=en");
    await expect(page).toHaveURL(/\/organization\/settings$/);
    await expect(page.getByRole("heading", { level: 1, name: "Organization" })).toBeVisible();
    await expect(page.getByText("Only an organization administrator opens projects.")).toBeVisible();

    await page.getByRole("tab", { name: "Settings" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(/\/organization\/roles$/);
    await expect(page.getByRole("row", { name: /org-admin/ }).getByText("seeded")).toBeVisible();
  });

  test("deleting a project lists what goes with it and sends one DELETE after the name is typed", async ({
    page,
  }) => {
    const { writes } = await stubApi(page);
    await page.goto("/organization/projects?lang=en");
    await page.getByRole("button", { name: "Delete project helsinki" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("2 × Context Spaces")).toBeVisible();
    await dialog.getByRole("textbox").fill("helsinki");
    await dialog.getByRole("button", { name: "Propose deleting the project" }).click();
    await expect(dialog.getByText("chg-000002a1")).toBeVisible();
    expect(writes).toEqual(["DELETE /api/v1/projects/helsinki"]);
  });

  test("a tab's create form is a page of its own", async ({ page }) => {
    await stubApi(page);
    await page.goto("/organization/groups/new?lang=en");
    await expect(page.getByRole("heading", { name: "New group" })).toBeVisible();
  });

  test("has no axe violations", async ({ page }) => {
    await stubApi(page);
    await page.goto("/organization/settings?lang=en");
    await expect(page.getByRole("heading", { level: 1, name: "Organization" })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });
});
