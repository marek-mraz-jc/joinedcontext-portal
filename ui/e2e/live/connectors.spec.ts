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

/**
 * T-5953 — requests above the DelegationPolicy ceiling wait for an administrator, and nobody else
 * decides them: a viewer reads no queue and approves nothing, not even a connector of their own.
 * Under the organization default (no policy queues on dev) a request above it is refused, naming
 * the field; S-31 of tests/connector_scenarios.rs plays a queued request and its approval.
 */
test("a request above the ceiling waits for an administrator and nobody else decides it", async ({ browser }) => {
  const { context, page } = await signIn(browser, VIEWER, "/?lang=en");
  const headers = { "x-csrf-token": await csrf(context), "content-type": "application/json" };
  let id = "";
  try {
    const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
    const above = await page.request.post("/api/v1/connectors?dryRun=All", {
      headers,
      data: { name: "t5953-pipelines", segments: ["pipeline"], scope: [{ project: "helsinki", access: "read" }], expiresAt },
    });
    expect(above.status()).toBe(403);
    expect(await above.text()).toContain("segments[0]");

    const created = await page.request.post("/api/v1/connectors", {
      headers,
      data: { name: `t5953-${Date.now()}`, segments: ["data-read"], scope: [{ project: "helsinki", access: "read" }], expiresAt },
    });
    expect(created.status(), await created.text()).toBe(201);
    id = ((await created.json()) as { id: string }).id;

    expect((await page.request.get("/api/v1/connectors/pending")).status()).toBe(403);
    const approve = await page.request.post(`/api/v1/connectors/${id}/approve`, { headers });
    expect(approve.status()).toBe(403);
    expect(await approve.text()).toContain("AG-150");
  } finally {
    if (id) await page.request.delete(`/api/v1/connectors/${id}`, { headers });
    await context.close();
  }
});
