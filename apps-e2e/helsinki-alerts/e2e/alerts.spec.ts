import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { stubTransport } from "@joinedcontext/sdk/testing";
import type { AccessDocument } from "@joinedcontext/sdk";
import { ALERTS } from "../src/fixtures/alerts";
import { STEWARD, VIEWER } from "../src/fixtures/access";
import { SCHEMA } from "../src/fixtures/schema";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const APP = "/apps/helsinki-alerts/";
const SLUG = "helsinkialerts";
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Serves the built bundle as the static host does, `#jc-config` filled for `role`, and the endpoint from the SDK's stub. */
async function serve(page: Page, role: "viewer" | "steward", access: AccessDocument) {
  const transport = stubTransport({ entities: ALERTS, schema: SCHEMA, access });
  const config = {
    slug: SLUG,
    orgDomain: "hel.fi",
    space: "helsinki",
    transport: "origin",
    appName: "helsinki-alerts",
    user: { id: `demo.${role}`, name: `Demo ${role}`, roles: [role] },
  };
  const writes: Call[] = [];
  const outside: string[] = [];
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("dialog", (dialog) => void dialog.accept());

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== "http://portal.test") {
      outside.push(url.href);
      return route.abort();
    }
    if (url.pathname.startsWith(`/api/endpoint/${SLUG}/`)) {
      const raw = request.postData();
      const body = raw ? JSON.parse(raw) : undefined;
      if (request.method() !== "GET") writes.push({ method: request.method(), path: url.pathname, body });
      const answer = await transport({ method: request.method() as "GET", path: url.pathname + url.search, body });
      return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body ?? null) });
    }
    if (!url.pathname.startsWith(APP)) return route.fulfill({ status: 404, body: "" });
    const file = normalize(url.pathname.slice(APP.length) || "index.html");
    if (file.startsWith("..") || !existsSync(join(DIST, file))) return route.fulfill({ status: 404, body: "" });
    let body = readFileSync(join(DIST, file));
    if (file === "index.html") {
      body = Buffer.from(
        body.toString("utf8").replace('<script id="jc-config" type="application/json"></script>', `<script id="jc-config" type="application/json">${JSON.stringify(config)}</script>`),
      );
    }
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body });
  });

  await page.goto(`http://portal.test${APP}#alerts`);
  const alerts = page.getByRole("region", { name: "Alerts" });
  await expect(alerts.getByRole("table").getByText("Mannerheimintie resurfacing")).toBeVisible();
  return { alerts, writes, outside, problems };
}

// AP-09, AP-96: the viewer reads every alert and is offered no way to change one.
test("a viewer reads the alerts and gets no form, no edit and no delete", async ({ page }) => {
  const { alerts, writes, outside, problems } = await serve(page, "viewer", VIEWER);

  await alerts.getByRole("table").getByText("Kauppatori, Helsinki").click();
  await expect(alerts.getByRole("heading", { level: 2 })).toBeVisible();
  await expect(alerts.getByRole("button", { name: "New alert" })).toHaveCount(0);
  await expect(alerts.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(alerts.getByRole("button", { name: "Delete" })).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(outside).toEqual([]);
  expect(problems).toEqual([]);
});

// AP-62: the steward's correction is one PATCH of the attribute that changed, and nothing else.
test("a steward corrects an alert with one PATCH of the changed attribute", async ({ page }) => {
  const { alerts, writes, outside, problems } = await serve(page, "steward", STEWARD);

  await alerts.getByRole("table").getByText("Mannerheimintie resurfacing").click();
  await alerts.getByRole("button", { name: "Edit" }).click();
  const form = alerts.getByRole("form", { name: "Edit Alert" });
  await form.getByLabel("address").fill("Mannerheimintie 14, Helsinki");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);

  expect(writes).toEqual([
    {
      method: "PATCH",
      path: `/api/endpoint/${SLUG}/ngsi-ld/v1/entities/${encodeURIComponent("urn:ngsi-ld:Alert:hel.fi:helsinki:GUID50001")}/attrs`,
      body: { address: { type: "Property", value: "Mannerheimintie 14, Helsinki" } },
    },
  ]);
  await expect(alerts.getByRole("table").getByText("Mannerheimintie 14, Helsinki")).toBeVisible();
  expect(outside).toEqual([]);
  expect(problems).toEqual([]);
});

// AP-09: a steward adds an alert, and removes only an alert a steward added.
test("a steward adds an alert and deletes it, and cannot delete Fintraffic's", async ({ page }) => {
  const { alerts, writes, problems } = await serve(page, "steward", STEWARD);

  await alerts.getByRole("button", { name: "New alert" }).click();
  const form = alerts.getByRole("form", { name: "New alert" });
  await form.getByLabel("Local id").fill("steward-closure");
  await form.getByLabel("address", { exact: true }).fill("Senaatintori, Helsinki");
  await form.getByLabel("category", { exact: true }).fill("event");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);

  await alerts.getByRole("table").getByText("Mannerheimintie resurfacing").click();
  await expect(alerts.getByRole("button", { name: "Delete" })).toHaveCount(0);

  await alerts.getByRole("table").getByText("Senaatintori, Helsinki").click();
  await alerts.getByRole("button", { name: "Delete" }).click();
  await expect(alerts.getByRole("table").getByText("Senaatintori, Helsinki")).toHaveCount(0);

  expect(writes.map((write) => write.method)).toEqual(["POST", "DELETE"]);
  expect(writes[0].body).not.toHaveProperty("source");
  expect(writes[1].path).toContain(encodeURIComponent("urn:ngsi-ld:Alert:hel.fi:helsinki:steward-closure"));
  expect(problems).toEqual([]);
});
