import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { greenVerdict, isCheck } from "./verdict";

// The Endpoint form asks four plain questions (T-6099): what data, who may read it, where it is
// published, which formats; the rest folds under Advanced and the manifest shows only behind
// View source. A new Endpoint and an edit run through the real form against a stubbed API, as
// representation_outputs.spec.ts does: `vite preview` has no Portal behind it. Shots of each
// state at 1440 and 400 go to test-results/endpoint-human-form.

const V = "joinedcontext.com/v1alpha1";
const list = (items: unknown[]) => ({ apiVersion: V, kind: "List", items });
const SLUG = "k7m2qz4tv6xh3n5jb2ryd3wcfa";
const ENDPOINT = {
  apiVersion: V,
  kind: "Endpoint",
  metadata: { name: "parkoviska", namespace: "zilina", title: "Parkoviská v Žiline" },
  spec: { contextSpaceRef: "doprava", slug: SLUG, audience: "public", disabledRepresentations: ["sta"] },
};
const CHANGE = { apiVersion: V, kind: "Change", metadata: { name: "chg-7", namespace: "zilina" }, status: { lane: "yellow", phase: "PendingApproval" } };
const grant = (verbs: string[]) => ({
  project: "zilina",
  bootstrap: false,
  grants: [{ role: "steward", binding: "stewards", rule: { kinds: ["Endpoint", "ContextSpace", "CkanInstance", "Project", "SharedSpaceReference"], verbs } }],
});

async function stubApi(page: Page, verbs: string[]): Promise<string[]> {
  const posted: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) return json({ subject: "b7c1e0f4", username: "jana", name: "Jana Kováčová", email: "jana@example.org", roles: ["portal-editor"] });
    if (path.endsWith("/permissions/me")) return json(grant(verbs));
    if (path.endsWith("/events")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    if (path === "/api/v1/projects") return json({ apiVersion: V, kind: "ProjectList", items: [{ name: "zilina" }, { name: "doprava-mesta" }] });
    if (path.endsWith("/spaces"))
      return json(list([{ apiVersion: V, kind: "ContextSpace", metadata: { name: "doprava", namespace: "zilina" }, spec: {} }]));
    if (path.endsWith("/ckaninstances"))
      return json(list([{ apiVersion: V, kind: "CkanInstance", metadata: { name: "zilina", namespace: "zilina" }, spec: {} }]));
    if (isCheck(method, route.request().url())) return json(greenVerdict(route.request().postData() ?? ""));
    const draft = /^\/api\/v1\/projects\/([^/]+)\/drafts\/([^/]+)\/([^/]+)$/.exec(path);
    if (draft && method === "PUT") {
      const { manifest } = JSON.parse(route.request().postData() ?? "{}") as { manifest: unknown };
      return json({ project: draft[1], kind: draft[2], name: draft[3], manifest, touchedBy: "jana", touchedKind: "person", version: 1, updatedAt: new Date().toISOString() });
    }
    if (method === "POST" || method === "PUT") {
      posted.push(`${method} ${path} ${route.request().postData() ?? ""}`);
      return json(CHANGE, 202);
    }
    if (path.endsWith("/endpoints/parkoviska")) return json(ENDPOINT);
    if (path.endsWith("/endpoints")) return json(list([ENDPOINT]));
    return json(list([]));
  });
  return posted;
}

const SHOTS = join(process.cwd(), "test-results", "endpoint-human-form");

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}-${page.viewportSize()?.width ?? 0}.png`), fullPage: true });
}

const STEWARD = ["read", "propose", "approve"];

for (const width of [1440, 400]) {
  test.describe(`endpoint form at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("a new endpoint: empty, a refused check, filled with its summary, proposed", async ({ page }) => {
      const posted = await stubApi(page, STEWARD);
      await page.goto("/projects/zilina/endpoints/new?lang=en");
      const form = page.getByTestId("form-page");
      await expect(form.getByText("1. What data?")).toBeVisible();
      await expect(form.getByRole("checkbox", { name: "Spreadsheet (CSV)" })).toBeChecked();
      await shot(page, "new-empty");

      await form.getByRole("button", { name: "Check", exact: true }).click();
      await expect(form.getByRole("textbox", { name: "Name", exact: true })).toHaveAttribute("aria-invalid", "true");
      await shot(page, "new-error");

      await form.getByRole("textbox", { name: "Name", exact: true }).fill("parkoviska");
      await form.getByRole("textbox", { name: /^Title people see/ }).fill("Parkoviská v Žiline");
      await form.getByLabel(/^Readers/).selectOption({ label: "Everyone, without logging in" });
      await form.getByLabel(/^Open-data portal/).selectOption("zilina");
      const summary = form.getByTestId("proposal-summary");
      await expect(summary).toContainText("Creates the endpoint “Parkoviská v Žiline” over the space doprava.");
      await expect(summary).toContainText("Anyone can read it without logging in.");
      await expect(summary).toContainText("listed as a dataset in the open-data portal zilina");
      await shot(page, "new-filled");

      await form.getByRole("button", { name: "Check", exact: true }).click();
      await form.getByRole("button", { name: "Propose change" }).click();
      await expect.poll(() => posted.some((line) => line.startsWith("POST") && line.includes('"parkoviska"'))).toBe(true);
      await shot(page, "new-proposed");
    });

    test("an edit: what it changes in sentences, then proposed", async ({ page }) => {
      const posted = await stubApi(page, STEWARD);
      await page.goto("/projects/zilina/endpoints/parkoviska/edit?lang=en");
      const form = page.getByTestId("form-page");
      await expect(form.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("parkoviska");
      await shot(page, "edit-filled");
      await form.getByRole("checkbox", { name: "Spreadsheet (CSV)" }).uncheck();
      await expect(form.getByTestId("proposal-summary")).toContainText("Formats removed: Spreadsheet (CSV).");
      await form.getByText("View source", { exact: true }).click();
      await expect(form.getByTestId("endpoint-preview")).toContainText("kind: Endpoint");
      await shot(page, "edit-changed");
      await form.getByRole("button", { name: "Check", exact: true }).click();
      await form.getByRole("button", { name: "Propose change" }).click();
      await expect.poll(() => posted.some((line) => line.includes("parkoviska") && line.includes("csv"))).toBe(true);
    });

    test("no permission: the form says who can give the right", async ({ page }) => {
      await stubApi(page, ["read"]);
      await page.goto("/projects/zilina/endpoints/new?lang=en");
      await expect(page.getByText("Your role lets you look at these, not create one here.")).toBeVisible();
      await shot(page, "no-permission");
    });
  });
}
