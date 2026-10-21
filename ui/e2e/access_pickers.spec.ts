import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { axeViolations } from "./axe";

// The access side's references are picked, not typed (T-4947): a person from the realm's people,
// a group or role from the organization's lists, an entity type from the project's models, a
// manifest kind from the person's rights. `vite preview` has no Portal API, so it is answered here.

const LIST = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });
const manifest = (kind: string, name: string, namespace: string, spec: unknown = {}) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind,
  metadata: { name, namespace },
  spec,
});
const KINDS = ["ContextSpace", "Endpoint", "Group", "Person", "Pipeline", "Policy", "Role", "RoleBinding", "ServiceAccount"];
const PEOPLE = [
  { id: "1", email: "jana.novak@example.org", firstName: "Jana", lastName: "Novák", enabled: true, emailVerified: true, requiredActions: [] },
  { id: "2", email: "petra.kral@example.org", firstName: "Petra", lastName: "Kráľ", enabled: true, emailVerified: true, requiredActions: [] },
  { id: "3", email: "marek.bily@example.org", firstName: "Marek", lastName: "Biely", enabled: true, emailVerified: true, requiredActions: [] },
];

async function mock(page: Page, people = PEOPLE): Promise<void> {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) return json({ subject: "s1", username: "admin", name: "Ada Admin", email: "admin@example.org", roles: [] });
    if (path === "/api/v1/projects") return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "ProjectList", items: [{ name: "helsinki" }] });
    if (path.endsWith("/permissions/me")) {
      return json({ project: "org", grants: [{ role: "org-admin", binding: "admins", scope: "organization", rule: { kinds: KINDS, verbs: ["read", "propose", "approve", "delete"] } }] });
    }
    if (path === "/api/v1/preferences") return json({ firstRunDismissed: true });
    if (path === "/api/v1/organization/people") {
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const found = people.filter((p) => `${p.firstName} ${p.lastName} ${p.email}`.toLowerCase().includes(search));
      return json({ items: found, total: found.length });
    }
    if (path === "/api/v1/projects/org/groups") return json(LIST([manifest("Group", "stewards", "org", { members: [{ user: "jana.novak@example.org" }] }), manifest("Group", "analysts", "org", { members: [] })]));
    if (path === "/api/v1/projects/org/groups/stewards") return json(manifest("Group", "stewards", "org", { members: [{ user: "jana.novak@example.org" }] }));
    if (path === "/api/v1/projects/org/roles") return json(LIST([manifest("Role", "steward", "org", { rules: [{ kinds: ["Endpoint"], verbs: ["read", "propose"] }] }), manifest("Role", "reader", "org", { rules: [{ kinds: ["Endpoint"], verbs: ["read"] }] })]));
    if (path === "/api/v1/projects/helsinki/endpoints") return json(LIST([manifest("Endpoint", "air", "helsinki", { slug: "air-quality", contextSpaceRef: "air" })]));
    if (path === "/api/v1/organization/datamodels") {
      return json({ ...LIST([{ name: "air-quality", level: "project", project: "helsinki", space: "air", version: "1.0.0", lifecycle: "published", classes: ["AirQualityObserved", "WeatherObserved"] }]), smartDataModels: [] });
    }
    if (path.endsWith("/datamodels/air-quality/source")) return route.fulfill({ status: 200, contentType: "text/yaml", body: "classes: {}\n" });
    return json(LIST([]));
  });
}

/** Screenshots for the task, where `JC_EVIDENCE_DIR` asks for them. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.JC_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

for (const width of [1440, 400]) {
  test.describe(`access pickers at ${width} px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
    });

    test("grant a role: the person is picked from the realm's people, searched as typed", async ({ page }) => {
      await mock(page);
      await page.goto("/organization/members?lang=en");
      await page.getByRole("button", { name: "Grant a role" }).first().click();
      const person = page.getByRole("combobox", { name: "Username or e-mail" });
      await shot(page, `grant-closed-${width}`);
      await person.click();
      await expect(page.getByRole("option", { name: /Petra Kráľ/ })).toBeVisible();
      await shot(page, `grant-open-${width}`);
      await person.fill("jana");
      await expect(page.getByRole("option", { name: /Jana Novák/ })).toBeVisible();
      await expect(page.getByRole("option", { name: /Petra/ })).toHaveCount(0);
      await shot(page, `grant-searching-${width}`);
      await page.getByRole("option", { name: /Jana Novák/ }).click();
      await expect(page.getByText("jana.novak@example.org")).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await shot(page, `grant-chosen-${width}`);
    });

    test("grant a role: someone not signed in yet is named only by a full e-mail", async ({ page }) => {
      await mock(page, []);
      await page.goto("/organization/members?lang=en");
      await page.getByRole("button", { name: "Grant a role" }).first().click();
      const person = page.getByRole("combobox", { name: "Username or e-mail" });
      await person.click();
      await expect(page.getByText(/Nobody matches/)).toBeVisible();
      await shot(page, `grant-empty-${width}`);
      await person.fill("eva");
      await expect(page.getByText(/Type the person/)).toBeVisible();
      await person.fill("eva.new@example.org");
      await expect(page.getByText("Use eva.new@example.org (not signed in yet)")).toBeVisible();
      await shot(page, `grant-invite-${width}`);
    });

    test("a group's new member is picked, the members already in it are not offered", async ({ page }) => {
      await mock(page);
      await page.goto("/organization/groups/stewards?lang=en");
      const person = page.getByRole("combobox", { name: "E-mail of the person" });
      await person.click();
      await expect(page.getByRole("option", { name: /Petra Kráľ/ })).toBeVisible();
      await expect(page.getByRole("option", { name: /Jana Novák/ })).toHaveCount(0);
      await shot(page, `group-member-open-${width}`);
    });

    test("try a person: the group and the entity type are picked", async ({ page }) => {
      await mock(page);
      await page.goto("/projects/helsinki/policies?lang=en");
      await page.getByLabel(/^Who/).selectOption("group");
      await page.getByRole("combobox", { name: /A member of a group/ }).click();
      await expect(page.getByRole("option", { name: /analysts/ })).toBeVisible();
      await page.getByRole("option", { name: /stewards/ }).click();
      await page.getByRole("combobox", { name: "Entity type" }).click();
      await expect(page.getByRole("option", { name: /AirQualityObserved/ })).toBeVisible();
      await shot(page, `try-type-open-${width}`);
      await page.getByRole("option", { name: /AirQualityObserved/ }).click();
      expect(await axeViolations(page)).toEqual([]);
      await shot(page, `try-chosen-${width}`);
    });

    test("approval history: the kind is a choice of the kinds the person holds", async ({ page }) => {
      await mock(page);
      await page.goto("/projects/helsinki/approvals?lang=en");
      await page.getByRole("tab", { name: "History" }).click();
      const kind = page.getByLabel("Kind");
      await expect(kind.locator("option", { hasText: "Endpoint" })).toHaveCount(1);
      await kind.selectOption("Endpoint");
      await shot(page, `history-kind-${width}`);
    });
  });
}
