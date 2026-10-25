import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { axeViolations } from "./axe";

// T-3839: a project's MQTT brokers and who talks to whom, then an MQTT data source that reads
// one of them. `vite preview` has no Portal API behind it, so the browser answers it; the clicks,
// the routing and the rendering are the real ones. The camera publishing and the data arriving
// are the live journey of T-3838 on dev.

const API = "joinedcontext.com/v1alpha1";
const PROJECT = "helsinki";

const item = (kind: string, name: string, spec: unknown, status?: unknown) => ({
  apiVersion: API,
  kind,
  metadata: { name, namespace: PROJECT },
  spec,
  ...(status ? { status } : {}),
});

const LISTS: Record<string, unknown[]> = {
  mqttbrokers: [
    item(
      "MqttBroker",
      "cameras",
      { roles: [{ name: "cams", serviceAccounts: ["cam-1", "cam-2"], publish: ["cameras/${clientid}/frames"] }] },
      { phase: "Live" },
    ),
  ],
  datasources: [
    item("DataSource", "frames", { type: "mqtt", mqtt: { brokerRef: { kind: "MqttBroker", name: "cameras" }, topics: ["cameras/+/frames"] } }),
  ],
  pipelines: [
    item("Pipeline", "camera-frames", {
      class: "resident",
      source: { dataSourceRef: "frames" },
      targetEndpoint: "urn:ngsi-ld:Endpoint:hel.fi:helsinki:cams-in",
    }),
  ],
  endpoints: [item("Endpoint", "cams-in", {})],
  serviceaccounts: [item("ServiceAccount", "cam-1", {})],
};

async function stubApi(page: Page): Promise<void> {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.endsWith("/auth/me")) {
      return json({ subject: "b7c1e0f4", username: "aino.virtanen", name: "Aino Virtanen", roles: ["portal-editor"] });
    }
    if (url.pathname === "/api/v1/projects") return json({ apiVersion: API, kind: "ProjectList", items: [{ name: PROJECT }] });
    const plural = url.pathname.split("/").pop() ?? "";
    return json({ apiVersion: API, kind: "List", items: LISTS[plural] ?? [] });
  });
}

test.describe("MQTT brokers", () => {
  test("a steward reads a broker's access and connections, then reads it from a new data source", async ({ page }) => {
    await stubApi(page);
    await page.goto(`/projects/${PROJECT}/home?lang=en`);
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "MQTT brokers" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "MQTT brokers" })).toBeVisible();
    const acl = page.getByRole("table", { name: "Topic access of cameras by role" });
    await expect(acl.getByRole("row", { name: /cams/ })).toContainText("cam-1, cam-2");
    await expect(page.getByText("helsinki-cam-2", { exact: true })).toBeVisible();

    // cam-2 is named by the role but not declared in the project: that edge is red, with its fix.
    const connections = page.getByRole("table", { name: "Connections" });
    const red = connections.locator('tr[data-edge="red"]');
    await expect(red).toHaveCount(1);
    await expect(red).toContainText("No service account cam-2 in this project");
    await expect(red.getByRole("link", { name: "Fix it" })).toHaveAttribute("href", `/projects/${PROJECT}/mqttbrokers/cameras/edit`);
    await expect(connections.locator('tr[data-edge="green"]')).toHaveCount(4);
    expect(await axeViolations(page)).toEqual([]);

    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Data sources" }).click();
    await page.getByRole("button", { name: "New data source" }).first().click();
    await page.getByRole("combobox", { name: "Type" }).selectOption("mqtt");
    const broker = page.getByRole("combobox", { name: "Broker", exact: true });
    await expect(broker.getByRole("option", { name: "cameras · Live" })).toHaveCount(1);
    await broker.selectOption({ label: "cameras · Live" });
    await expect(broker.locator("option:checked")).toHaveText("cameras · Live");
  });

  // T-5590: a role's devices are picked from the project's ServiceAccounts the API lists for this
  // person; cam-2, named by the stored broker but not declared, is never offered.
  test("a steward adds a broker whose role picks its device from the project's accounts", async ({ page }) => {
    await stubApi(page);
    // A route added later answers first: this steward may create brokers here.
    await page.route("**/api/v1/projects/helsinki/permissions/me", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ project: PROJECT, bootstrap: true, grants: [] }) }),
    );
    // The form saves its shared draft as it is typed (AG-61); the draft comes back as written.
    await page.route("**/api/v1/projects/helsinki/drafts/MqttBroker/*", async (route) => {
      const manifest = (route.request().postDataJSON() as { manifest?: unknown } | null)?.manifest ?? null;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ project: PROJECT, kind: "MqttBroker", name: "sensors", manifest, verdict: null, touchedBy: "aino.virtanen", touchedKind: "person", version: 1, updatedAt: "2026-10-25T03:00:00Z" }),
      });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/projects/${PROJECT}/mqttbrokers/new?lang=en`);
    await expect(page.getByRole("heading", { level: 1, name: "New MQTT broker" })).toBeVisible();
    const account = page.locator("#root_roles_0_serviceAccounts_0");
    await expect(account.locator("option")).toHaveText(["Choose…", "cam-1"]);
    await page.locator("#root_name").fill("sensors");
    await page.locator("#root_roles_0_name").fill("sensors");
    await account.selectOption("cam-1");
    await expect(account.locator("option:checked")).toHaveText("cam-1");
    await expect(page.locator("#root_roles_0_serviceAccounts__description")).toContainText("E.g. vent-1.");
    expect(await axeViolations(page)).toEqual([]);
    const shots = process.env.T5590_SHOTS;
    if (shots) {
      for (const width of [1440, 400]) {
        await page.setViewportSize({ width, height: width === 400 ? 860 : 900 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${shots}/mqtt-add-broker-picked-${width}.png`, fullPage: true });
      }
    }
  });

  test("a steward who reads no account is told where one comes from", async ({ page }) => {
    await stubApi(page);
    await page.route("**/api/v1/projects/helsinki/permissions/me", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ project: PROJECT, bootstrap: true, grants: [] }) }),
    );
    await page.route("**/api/v1/projects/helsinki/serviceaccounts", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ apiVersion: API, kind: "List", items: [] }) }),
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/projects/${PROJECT}/mqttbrokers/new?lang=en`);
    const hint = page.locator("#root_roles_0_serviceAccounts_0-empty");
    await expect(hint).toContainText("Add a device from the broker's page");
    expect(await axeViolations(page)).toEqual([]);
    const shots = process.env.T5590_SHOTS;
    if (shots) {
      for (const width of [1440, 400]) {
        await page.setViewportSize({ width, height: width === 400 ? 860 : 900 });
        await hint.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${shots}/mqtt-add-broker-no-accounts-${width}.png` });
      }
    }
  });
});
