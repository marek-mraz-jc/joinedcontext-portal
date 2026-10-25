import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { axeViolations } from "./axe";

// One Policy as a reader and an editor meet it (T-5591): from the Policies list, one click on the
// row opens what it allows in words, its assigner, validity and last change, with the fields
// folded under "Show the manifest fields". `vite preview` has no Portal API behind it, so the API
// is answered in the browser; the page is the real build. Shots at 1440 and 400 go to $SHOTS_DIR.

const DIR = process.env.SHOTS_DIR ?? "test-results/policy-summary";
const list = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });

const POLICY = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Policy",
  metadata: { name: "bikes-ops-steward", namespace: "helsinki", title: { en: "The steward sets a station's status" } },
  spec: {
    contextSpaceRef: { kind: "ContextSpace", name: "helsinki" },
    assigner: "did:web:hel.fi",
    assignee: { kind: "role", id: "steward" },
    operations: ["updateOps"],
    information: [{ entities: [{ type: "BikeHireDockingStation" }], propertyNames: ["status"] }],
    validity: { from: "2026-10-01T00:00:00Z" },
  },
  status: { phase: "Live" },
};

const MERGED = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Change",
  metadata: { name: "42", namespace: "helsinki" },
  author: { name: "Anna Steward" },
  createdAt: "2026-10-20T08:00:00Z",
  decision: { at: "2026-10-20T09:30:00Z", by: "Pekka Approver" },
  status: { phase: "Merged", lane: "standard", plan: {} },
  summary: { kind: "update", params: { kind: "Policy", name: "bikes-ops-steward" } },
};

const PERSONAS = {
  viewer: { roles: ["portal-viewer"], grants: [{ rule: { kinds: ["Policy"], verbs: ["read"] } }] },
  editor: { roles: ["portal-editor"], grants: [{ rule: { kinds: ["Policy"], verbs: ["read", "propose"] } }] },
};

async function stubApi(page: Page, persona: keyof typeof PERSONAS): Promise<void> {
  const who = PERSONAS[persona];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) return json({ subject: "s1", username: `demo.${persona}`, name: `Demo ${persona}`, roles: who.roles });
    if (path.endsWith("/permissions/me")) return json({ project: "helsinki", bootstrap: false, grants: who.grants });
    if (path === "/api/v1/projects") return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "ProjectList", items: [{ name: "helsinki" }] });
    if (path.endsWith("/policies")) return json(list([POLICY]));
    if (path.endsWith("/policies/bikes-ops-steward")) return json(POLICY);
    if (path.endsWith("/changes/history")) return json({ ...list([MERGED]), next: null });
    return json(list([]));
  });
}

for (const persona of ["viewer", "editor"] as const) {
  test(`the ${persona} reads what a Policy allows without opening a field`, async ({ page }) => {
    mkdirSync(DIR, { recursive: true });
    await stubApi(page, persona);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/projects/helsinki/policies?lang=en");
    await page.getByRole("link", { name: "The steward sets a station's status" }).click();
    const summary = page.getByTestId("policy-summary");
    await expect(summary).toBeVisible();
    await expect(summary.getByTestId("policy-summary-sentence")).toContainText("status");
    await expect(summary.getByTestId("policy-summary-sentence")).toContainText("BikeHireDockingStation");
    await expect(summary.getByTestId("policy-summary-sentence")).toContainText("Holders of the role steward may change");
    await expect(summary).toContainText("did:web:hel.fi");
    await expect(summary).toContainText("approved by Pekka Approver");
    const fields = page.locator("details").filter({ hasText: "Show the manifest fields" });
    if (persona === "viewer") {
      await expect(page.getByText("Read only", { exact: true })).toBeVisible();
      await expect(fields).not.toHaveAttribute("open", "");
    } else {
      await expect(fields).toHaveAttribute("open", "");
    }
    expect((await axeViolations(page)).filter((v) => /\((serious|critical)\)/.test(v))).toEqual([]);
    for (const width of [1440, 400]) {
      await page.setViewportSize({ width, height: width === 400 ? 860 : 900 });
      await page.screenshot({ path: join(DIR, `${persona}-policy-${width}.png`), fullPage: true });
    }
  });
}
