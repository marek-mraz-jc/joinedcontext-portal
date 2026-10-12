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
});
