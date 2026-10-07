import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { axeViolations } from "./axe";

// T-3156: a project's named MCP servers in a real browser, the API and the members' own MCP
// surfaces answered in the browser. A server's address, client and entry; its members' health and
// the tools they offer this person; a new server over two Endpoints of two projects, by keyboard,
// proposed as a checked Change. At phone and desktop width, with axe.

const IDENTITY = { subject: "b7c1e0f4", username: "eva.steward", name: "Eva Steward", email: "eva@hel.fi", roles: [] };
const GRANTS = {
  project: "helsinki",
  bootstrap: false,
  grants: [{ role: "steward", binding: "helsinki-people", scope: "project:helsinki", rule: { kinds: ["McpServer", "Endpoint"], verbs: ["read", "propose", "delete"] } }],
};
const list = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });
const endpoint = (project: string, name: string, slug: string, audience: string) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Endpoint",
  metadata: { name, namespace: project, title: { en: name } },
  spec: { slug, audience, contextSpaceRef: { name: project } },
});
const SERVER = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "McpServer",
  metadata: { name: "mobility", namespace: "helsinki", title: { en: "Mobility data" }, description: { en: "Bikes and parking." } },
  spec: {
    members: [
      { kind: "Endpoint", name: "bikes", namespace: "helsinki" },
      { kind: "Endpoint", name: "parking", namespace: "espoo" },
    ],
    audience: "organization",
  },
};
const tools = (names: string[]) => ({
  jsonrpc: "2.0",
  id: 1,
  result: { tools: names.map((name) => ({ name, description: `${name} of the endpoint`, annotations: { readOnlyHint: true } })) },
});

async function stubApi(page: Page): Promise<{ writes: { path: string; body: unknown }[] }> {
  const writes: { path: string; body: unknown }[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: status >= 400 ? "application/problem+json" : "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/endpoint/bikeslug/mcp") return json(tools(["list_types", "query_entities"]));
    if (url.pathname === "/api/endpoint/parkslug/mcp") return json(tools(["query_entities"]));
    if (url.pathname.endsWith("/auth/me")) return json(IDENTITY);
    if (url.pathname.endsWith("/branding")) return json({ instanceName: "joinedcontext", domain: "dev.example", languages: { default: "en", offered: ["en"] } });
    if (url.pathname.endsWith("/permissions/me")) return json(GRANTS);
    if (request.method() !== "GET") {
      writes.push({ path: url.pathname + url.search, body: request.postDataJSON() as unknown });
      if (url.searchParams.get("dryRun") === "All") return json({ valid: true, verdict: { ok: true, findings: [] } });
      return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "Change", metadata: { name: "chg-mcp-1", namespace: "helsinki" }, spec: { lane: "Yellow" }, status: { phase: "Proposed" } }, 202);
    }
    if (url.pathname === "/api/v1/projects") return json(list([{ name: "helsinki" }, { name: "espoo" }]));
    if (url.pathname === "/api/v1/projects/helsinki/endpoints") return json(list([endpoint("helsinki", "bikes", "bikeslug", "public")]));
    if (url.pathname === "/api/v1/projects/espoo/endpoints") return json(list([endpoint("espoo", "parking", "parkslug", "organization")]));
    if (url.pathname === "/api/v1/projects/helsinki/mcpservers") return json(list([SERVER]));
    return json(list([]));
  });
  return { writes };
}

for (const width of [375, 1440]) {
  test.describe(`the MCP servers at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("a server shows its address, entry and members' tools, with no sideways scroll and no axe violations", async ({ page }) => {
      await stubApi(page);
      await page.goto("/projects/helsinki/mcp?lang=en");
      await expect(page.getByRole("heading", { level: 1, name: "MCP servers" })).toBeVisible();
      const card = page.getByRole("region", { name: "Mobility data" });
      await expect(card.getByText("https://dev.example/api/mcp/helsinki/mobility", { exact: true })).toBeVisible();
      await expect(card.getByText("mcp-helsinki-mobility", { exact: true })).toBeVisible();
      await expect(card.getByRole("list", { name: "Members and how they answer you" }).getByText("Answers, tools: 2")).toBeVisible();
      await expect(card.getByRole("list", { name: "Tools of the server" }).getByText("query_entities", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await axeViolations(page)).toEqual([]);
    });

    test("a new server over two projects' Endpoints is proposed by keyboard as a checked Change", async ({ page }) => {
      const { writes } = await stubApi(page);
      await page.goto("/projects/helsinki/mcp?lang=en");
      await page.getByRole("button", { name: "New MCP server" }).click();
      const dialog = page.getByRole("dialog", { name: "New MCP server" });
      await dialog.getByLabel(/^Name/).fill("transit");
      await dialog.getByRole("checkbox", { name: "bikes (helsinki/bikes)" }).focus();
      await page.keyboard.press("Space");
      await dialog.getByRole("checkbox", { name: "parking (espoo/parking)" }).focus();
      await page.keyboard.press("Space");
      await dialog.getByLabel(/^Who may connect/).selectOption("organization");
      await expect(dialog.getByRole("list", { name: "Tools of the server" }).getByText("list_types", { exact: true })).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await dialog.getByRole("button", { name: "Check and propose" }).click();
      await expect(dialog.getByText("chg-mcp-1")).toBeVisible();
      expect(writes.map((write) => write.path)).toEqual(["/api/v1/projects/helsinki/mcpservers?dryRun=All", "/api/v1/projects/helsinki/mcpservers"]);
      expect(writes[1].body).toMatchObject({
        kind: "McpServer",
        metadata: { name: "transit", namespace: "helsinki" },
        spec: {
          members: [
            { kind: "Endpoint", name: "bikes", namespace: "helsinki" },
            { kind: "Endpoint", name: "parking", namespace: "espoo" },
          ],
          audience: "organization",
        },
      });
    });
  });
}
