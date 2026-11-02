import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { axeViolations } from "./axe";

// Organization → Data access (ADR-N-067 §2.5, T-6412): the matrix of non-public Endpoints against
// everyone and each group, a group's "Datasets this group reads" and a person's "What this person
// can read", each filled, empty and refused. `vite preview` has no Portal API behind it, so the API
// is answered in the browser. JC_SHOTS=<dir> saves a desktop 1440 and a phone 400 shot of each.

const IDENTITY = { subject: "b7c1e0f4", username: "ada", name: "Ada Admin", email: "ada@hel.fi", roles: [] };
const list = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });
const columns = [{ kind: "organization" }, { kind: "group", group: "traffic-analysts" }];
const cell = (rules: { policy: string; rule: number; types: string[] }[], throughOrganization = false) => ({
  granted: rules.length > 0 || throughOrganization,
  rules,
  throughOrganization,
  unanswered: false,
});
const row = (name: string, title: string, cells: ReturnType<typeof cell>[]) => ({
  project: "helsinki",
  name,
  slug: `${name.slice(0, 4)}2m7q4tv6xh3n5jb2ryd3wcf`,
  title,
  audience: "organization",
  organization: "helsinki",
  cells,
});
const MATRIX = {
  columns,
  rows: [
    row("staff-traffic-counts", "Traffic counts (staff)", [
      cell([{ policy: "staff-traffic", rule: 1, types: ["TrafficFlowObserved"] }]),
      cell([], true),
    ]),
    row("vehicles", "Vehicles on duty", [cell([]), cell([{ policy: "staff-traffic", rule: 2, types: ["Vehicle"] }])]),
    row("internal-incidents", "Incident log", [cell([]), cell([])]),
  ],
  unanswered: 0,
};
const JANA = {
  id: "jana-id",
  email: "jana@hel.fi",
  firstName: "Jana",
  lastName: "Nováková",
  enabled: true,
  emailVerified: true,
  requiredActions: [],
  createdAt: "2026-09-01T08:00:00Z",
  lastSeen: "2026-10-30T10:30:00Z",
  locale: "sk",
  pendingDeletion: null,
};
const GROUP = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Group",
  metadata: { name: "traffic-analysts", namespace: "org" },
  spec: { members: [{ user: "jana-id" }] },
};
const dataset = (name: string, title: string, access: string, group?: string) => ({
  project: "helsinki",
  name,
  slug: `${name.slice(0, 4)}2m7q4tv6xh3n5jb2ryd3wcf`,
  title,
  description: null,
  representations: ["ngsi-ld"],
  access,
  ...(group ? { group } : {}),
});

type State = "filled" | "empty" | "refused";

async function stubApi(page: Page, state: State): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: status >= 400 ? "application/problem+json" : "application/json", body: JSON.stringify(body) });
    const refused = () => json({ title: "Forbidden", status: 403, detail: "you lack read on Person" }, 403);
    if (path.endsWith("/auth/me")) return json(IDENTITY);
    if (path === "/api/v1/projects") return json({ kind: "ProjectList", items: [{ name: "helsinki" }] });
    if (path.endsWith("/permissions/me")) {
      // A refused person administers nothing; the page tells them whose it is.
      const rule =
        state === "refused"
          ? { kinds: ["*"], verbs: ["read"] }
          : { kinds: ["RoleBinding", "Person", "Group"], verbs: ["read", "propose", "approve", "delete"] };
      return json({ project: "org", bootstrap: false, grants: [{ role: "r", binding: "b", rule }] });
    }
    if (path === "/api/v1/organization/data-access") {
      if (state === "refused") return refused();
      if (state === "empty") return json({ columns: columns.slice(0, 1), rows: [], unanswered: 0 });
      return json(MATRIX);
    }
    if (path === "/api/v1/organization/people/jana-id/readable") {
      if (state === "refused") return refused();
      const datasets =
        state === "empty"
          ? [dataset("bikes", "Bike counters", "public")]
          : [
              dataset("bikes", "Bike counters", "public"),
              dataset("staff-traffic-counts", "Traffic counts (staff)", "organization"),
              dataset("vehicles", "Vehicles on duty", "group", "traffic-analysts"),
            ];
      return json({ datasets, unanswered: 0 });
    }
    if (path === "/api/v1/organization/people/jana-id") {
      return json({ person: JANA, groups: [{ name: "traffic-analysts" }], platformRoles: [], appRoles: [] });
    }
    if (path === "/api/v1/projects/org/groups/traffic-analysts") return json(GROUP);
    return json(list([]));
  });
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.JC_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  for (const [width, label] of [[1440, "1440"], [400, "400"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: join(dir, `${name}-${label}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe("Organization → Data access", () => {
  test("an administrator reads the matrix and opens the rule behind a cell", async ({ page }) => {
    await stubApi(page, "filled");
    await page.goto("/organization/data-access?lang=en");
    const table = page.getByRole("table", { name: "Data access" });
    const counts = table.getByRole("row", { name: /Traffic counts/ });
    await expect(counts).toContainText("TrafficFlowObserved");
    await expect(counts).toContainText("Through everyone");
    await expect(table.getByRole("row", { name: /Vehicles on duty/ })).toContainText("staff-traffic, rule 2");
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, "matrix-filled");
    await counts.getByRole("link", { name: "Propose a change of staff-traffic, rule 1" }).click();
    await expect(page).toHaveURL(/\/projects\/helsinki\/policies\/staff-traffic\/edit/);
  });

  test("an organization with only public Endpoints says what to do", async ({ page }) => {
    await stubApi(page, "empty");
    await page.goto("/organization/data-access?lang=en");
    await expect(page.getByText("No internal datasets yet")).toBeVisible();
    await shot(page, "matrix-empty");
  });

  test("anybody else is told the page is the administrators'", async ({ page }) => {
    await stubApi(page, "refused");
    await page.goto("/organization/data-access?lang=en");
    await expect(page.getByText(/This page is for organization administrators/)).toBeVisible();
    await shot(page, "matrix-refused");
  });
});

test.describe("a group's and a person's datasets", () => {
  for (const state of ["filled", "empty", "refused"] as const) {
    test(`the group page lists what the group reads (${state})`, async ({ page }) => {
      await stubApi(page, state);
      await page.goto("/organization/groups/traffic-analysts?lang=en");
      const panel = page.getByRole("region", { name: "Datasets this group reads" });
      const expected = {
        filled: "Vehicles on duty",
        empty: "traffic-analysts reads no internal dataset",
        refused: "Only organization administrators and people administrators",
      }[state];
      await expect(panel.or(page.locator("main")).getByText(expected).first()).toBeVisible();
      await shot(page, `group-${state}`);
    });

    test(`the person page lists what the person can read (${state})`, async ({ page }) => {
      await stubApi(page, state);
      await page.goto("/organization/people/jana-id?lang=en");
      const expected = {
        filled: "Vehicles on duty",
        empty: "reads no internal dataset",
        refused: "Only organization administrators and people administrators",
      }[state];
      await expect(page.getByText(expected).first()).toBeVisible();
      await shot(page, `person-${state}`);
    });
  }
});
