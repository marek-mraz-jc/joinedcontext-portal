/**
 * T-5950 — a person creates a connector of their own, reads it, revokes it, and the next call
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
    const connector = (await created.json()) as { id: string; url: string; state: string; writes: boolean };
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

    expect((await page.request.delete(`/api/v1/connectors/${id}`, { headers })).status()).toBe(204);
    const read = (await (await page.request.get(`/api/v1/connectors/${id}`)).json()) as { state: string };
    expect(read.state).toBe("revoked");
    id = "";
  } finally {
    if (id) await page.request.delete(`/api/v1/connectors/${id}`, { headers });
    await context.close();
  }
});
