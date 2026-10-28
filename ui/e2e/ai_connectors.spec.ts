import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// My AI connectors (T-5951, AG-142): create from the tick tree, copy the setup line, revoke after an
// inline confirm, read the activity; and the refusal the server gives beside the field it names.
// `vite preview` has no Portal behind it, so the API is answered in the browser.

const IDENTITY = { subject: "b7c1e0f4", username: "jana.kovacova", name: "Jana Kováčová", email: "jana.kovacova@hel.fi", roles: [] };
const ID = "abcdefghijklmnopqrstuvwxyz";
const URL_OF = `https://portal.dev.example/c/${ID}`;
const OPTIONS = {
  segments: ["data-read", "context", "pipeline", "access", "publish", "apps", "operate", "admin"],
  ceiling: { segments: ["data-read"], writes: false, maxDays: 30 },
  projects: [
    { project: "doprava", spaces: ["parking", "traffic"], endpoints: ["bike-counters", "parking-lots"], pipelines: ["load-counters"] },
    { project: "ovzdusie", spaces: ["air"], endpoints: ["air-quality"], pipelines: [] },
  ],
  clients: [
    { id: "mcp-mobile", isBoundary: false },
    { id: "mcp-hub", isBoundary: false },
    { id: "mcp-local", isBoundary: false },
  ],
};

interface Stub {
  refuse?: boolean;
}

async function stubApi(page: Page, stub: Stub = {}) {
  const requests: { method: string; path: string; body?: unknown }[] = [];
  let items: Record<string, unknown>[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: status >= 400 ? "application/problem+json" : "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) return json(IDENTITY);
    if (path === "/api/v1/projects") return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "ProjectList", items: [{ name: "doprava" }] });
    if (path.startsWith("/api/v1/connectors")) {
      const body = request.method() === "POST" ? request.postDataJSON() : undefined;
      requests.push({ method: request.method(), path, body });
      if (path === "/api/v1/connectors/options") return json(OPTIONS);
      if (path === "/api/v1/connectors" && request.method() === "GET") return json({ items });
      if (path === "/api/v1/connectors" && request.method() === "POST") {
        if (stub.refuse) {
          return json(
            { type: "https://docs.joinedcontext.com/problems/unprocessable", title: "Unprocessable Content", status: 422, detail: "project doprava has no Endpoint parking-lots you may read", errors: ["scope[0].endpoint"] },
            422,
          );
        }
        const made = {
          id: ID,
          name: body.name,
          owner: IDENTITY.subject,
          segments: body.segments,
          scope: body.scope,
          writes: false,
          expiresAt: body.expiresAt,
          allowedClients: body.allowedClients,
          clientIsBoundary: false,
          state: "active",
          createdAt: "2026-10-28T12:00:00Z",
          lastUsedAt: null,
          url: URL_OF,
        };
        items = [made];
        return json(made, 201);
      }
      if (path.endsWith("/activity")) {
        return json({
          items: [
            { at: "2026-10-28T12:31:00Z", subject: IDENTITY.subject, client: "mcp-local", tool: "jc_resource_list", target: "doprava/Endpoint", verdict: "refused: a list in a narrowed project", durationMs: 3 },
            { at: "2026-10-28T12:30:00Z", subject: IDENTITY.subject, client: "mcp-local", tool: "jc_resource_get", target: "doprava/Endpoint/bike-counters", verdict: "allowed", durationMs: 12 },
          ],
        });
      }
      if (request.method() === "DELETE") {
        items = items.map((one) => ({ ...one, state: "revoked" }));
        return route.fulfill({ status: 204 });
      }
    }
    return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] });
  });
  return requests;
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.JC_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

for (const width of [1440, 400]) {
  test.describe(`my AI connectors at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("a person creates a connector from the tree, copies its setup and revokes it", async ({ page, context }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const requests = await stubApi(page);
      await page.goto("/ai-connectors?lang=en");
      await expect(page.getByText("No AI connectors yet")).toBeVisible();
      await shot(page, `ai-connectors-empty-${width}`);

      await page.getByRole("button", { name: "New AI connector" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox", { name: /Name/ }).fill("doprava-in-claude");
      await dialog.getByRole("checkbox", { name: "bike-counters" }).check();
      await dialog.getByRole("checkbox", { name: /Claude Code, VS Code/ }).check();
      await shot(page, `ai-connectors-form-${width}`);
      await dialog.getByRole("button", { name: "Create" }).click();

      const card = page.getByRole("region", { name: "doprava-in-claude" });
      await expect(card.getByText(`claude mcp add --transport http doprava-in-claude ${URL_OF}`)).toBeVisible();
      await card.getByRole("button", { name: "Copy: Claude Code" }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`claude mcp add --transport http doprava-in-claude ${URL_OF}`);
      const created = requests.find((one) => one.method === "POST")?.body as { scope: unknown; allowedClients: string[] };
      expect(created.scope).toEqual([{ project: "doprava", endpoint: "bike-counters", access: "read" }]);
      expect(created.allowedClients).toEqual(["mcp-local"]);
      await card.getByRole("button", { name: "Activity" }).click();
      await expect(card.getByRole("table", { name: "Calls through doprava-in-claude" })).toBeVisible();
      await shot(page, `ai-connectors-filled-${width}`);

      await card.getByRole("button", { name: "Revoke AI connector doprava-in-claude" }).click();
      await expect(card.getByRole("alert")).toContainText("The next call through it is refused");
      await card.getByRole("button", { name: "Revoke now" }).click();
      await expect(card.getByText("Revoked", { exact: true })).toBeVisible();
      expect(requests.some((one) => one.method === "DELETE" && one.path === `/api/v1/connectors/${ID}`)).toBe(true);
      await expect(page.locator("body")).not.toContainText(/eyJ|Bearer /);
      await shot(page, `ai-connectors-revoked-${width}`);
    });

    test("an empty form is refused in place, and a server refusal names its field", async ({ page }) => {
      await stubApi(page, { refuse: true });
      await page.goto("/ai-connectors?lang=en");
      await page.getByRole("button", { name: "New AI connector" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Create" }).click();
      await expect(dialog.getByText(/Give a name of lowercase letters/)).toBeVisible();
      await shot(page, `ai-connectors-error-${width}`);

      await dialog.getByRole("textbox", { name: /Name/ }).fill("parking");
      await dialog.getByRole("checkbox", { name: "parking-lots" }).check();
      await dialog.getByRole("button", { name: "Create" }).click();
      await expect(dialog.getByText("project doprava has no Endpoint parking-lots you may read")).toBeVisible();
      await expect(dialog.getByRole("checkbox", { name: /Pipelines/ }).first()).toHaveAttribute("aria-disabled", "true");
      await shot(page, `ai-connectors-refusal-${width}`);
    });
  });
}
