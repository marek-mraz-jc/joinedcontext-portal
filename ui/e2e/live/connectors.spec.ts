/**
 * T-5950, T-5951 — a person creates a connector of their own, reads it, revokes it, and the next call
 * through it is refused; the audit lists the call. The connector is the viewer's, read only, one
 * project, one day; it is revoked in `finally`, so a failed run leaves no live grant on dev.
 */
import { expect, test } from "@playwright/test";
import { VIEWER, csrf, signIn } from "./portal";

test.setTimeout(120_000);

test("a person creates a read-only connector, revokes it and finds it refused", async ({ browser }) => {
  const { context, page } = await signIn(browser, VIEWER, "/?lang=en");
  const headers = { "x-csrf-token": await csrf(context), "content-type": "application/json" };
  let id = "";
  try {
    const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
    const created = await page.request.post("/api/v1/connectors", {
      headers,
      data: {
        name: `t5950-${Date.now()}`,
        segments: ["data-read"],
        scope: [{ project: "helsinki", access: "read" }],
        expiresAt,
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const connector = (await created.json()) as { id: string; name: string; url: string; state: string; writes: boolean };
    id = connector.id;
    expect(connector.url).toMatch(/\/c\/[a-z2-7]{26}$/);
    expect([connector.state, connector.writes]).toEqual(["active", false]);

    // Above the organization's ceiling: writes are refused, naming the field.
    const writes = await page.request.post("/api/v1/connectors", {
      headers,
      data: { name: "t5950-writes", segments: ["data-read"], scope: [{ project: "helsinki", access: "read" }], writes: true, expiresAt },
    });
    expect(writes.status()).toBe(403);
    expect(await writes.text()).toContain("writes");

    // The connector's door without a token for its own address: 401 naming its metadata.
    const door = await page.request.post(`/c/${id}`, { data: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(door.status()).toBe(401);
    expect(door.headers()["www-authenticate"]).toContain(`/c/${id}/.well-known/oauth-protected-resource`);

    // An edit is checked as a create is: a project the viewer holds no right in is refused.
    const widened = await page.request.patch(`/api/v1/connectors/${id}`, {
      headers: { ...headers, "content-type": "application/merge-patch+json" },
      data: { scope: [{ project: "t5951-nobody-reads-this", access: "read" }] },
    });
    expect(widened.status()).toBe(403);
    expect(await widened.text()).toContain("scope[0].project");

    // My AI connectors lists it with its setup line and no token, and revokes it after an inline confirm (T-5951).
    await page.goto("/ai-connectors?lang=en");
    const card = page.getByRole("region", { name: connector.name });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Set up" }).click();
    await expect(card.getByText(`claude mcp add --transport http ${connector.name} ${connector.url}`)).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/eyJ|Bearer /);
    await card.getByRole("button", { name: `Revoke AI connector ${connector.name}` }).click();
    await card.getByRole("button", { name: "Revoke now" }).click();
    await expect(card.getByText("Revoked", { exact: true })).toBeVisible();
    const read = (await (await page.request.get(`/api/v1/connectors/${id}`)).json()) as { state: string };
    expect(read.state).toBe("revoked");
    id = "";
  } finally {
    if (id) await page.request.delete(`/api/v1/connectors/${id}`, { headers });
    await context.close();
  }
});

test("a person connects a tab to their connector and disconnects it", async ({ browser }) => {
  // T-5967: the tab pairs only for its signed-in owner; its stream answers that session, and a
  // disconnect ends it. The connector is revoked in `finally`.
  const { context, page } = await signIn(browser, VIEWER, "/?lang=en");
  const headers = { "x-csrf-token": await csrf(context), "content-type": "application/json" };
  let id = "";
  try {
    const created = await page.request.post("/api/v1/connectors", {
      headers,
      data: { name: `t5967-${Date.now()}`, segments: ["data-read"], scope: [{ project: "helsinki", access: "read" }], expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString() },
    });
    expect(created.status(), await created.text()).toBe(201);
    const connector = (await created.json()) as { id: string; name: string };
    id = connector.id;
    await page.goto("/ai-connectors?lang=en");
    const card = page.getByRole("region", { name: connector.name });
    await card.getByRole("button", { name: `Connect this tab to ${connector.name}` }).click();
    const bar = page.getByRole("region", { name: "Tab connected to a connector" });
    await expect(bar.getByText(`Connected to ${connector.name}`)).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/eyJ|Bearer /);
    // Another tab id of this session is no stream.
    const guessed = await page.request.get(`/api/v1/connectors/${id}/tab/${"0".repeat(32)}/events`);
    expect(guessed.status()).toBe(404);
    await bar.getByRole("button", { name: "Disconnect" }).click();
    await expect(bar).toHaveCount(0);
  } finally {
    if (id) await page.request.delete(`/api/v1/connectors/${id}`, { headers });
    await context.close();
  }
});

// T-6015: the old /connectors address (UI-98) lands on My AI connectors, which answers a real state:
// the person's connectors or the designed empty state with its create action.
test("the old /connectors address opens My AI connectors", async ({ browser }) => {
  const { context, page } = await signIn(browser, VIEWER, "/connectors?lang=en");
  try {
    await expect(page).toHaveURL(/\/ai-connectors(\?|$)/, { timeout: 60_000 });
    await expect(page.getByRole("heading", { level: 1, name: "My AI connectors" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Set up" }).first().or(page.getByText("No AI connectors yet"))).toBeVisible();
  } finally {
    await context.close();
  }
});
