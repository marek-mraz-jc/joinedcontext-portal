/**
 * T-3839: the MQTT brokers page (MF-54, ADR-N-048). Each broker's topic access by role, how a
 * device connects (never a secret), and the edges from a device to the Policy, a broken one red
 * with a link to where it is fixed.
 */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { MqttBrokersPage, brokerAddress } from "../src/pages/mqttbrokers/MqttBrokersPage";
import { connectionsOf, urnName } from "../src/pages/mqttbrokers/connections";
import type { Resources } from "../src/pages/mqttbrokers/connections";
import { fromMqttBrokerManifest, mqttBrokerSchema, toMqttBrokerManifest } from "../src/schemas/mqttbroker";
import { json, list, renderPage } from "./page_contract";

const PROJECT = "espoo";
const API = "joinedcontext.com/v1alpha1";

const item = (kind: string, name: string, spec: unknown, status?: unknown) => ({
  apiVersion: API,
  kind,
  metadata: { name, namespace: PROJECT },
  spec,
  ...(status ? { status } : {}),
});

const CAMERAS = item(
  "MqttBroker",
  "cameras",
  {
    roles: [
      { name: "cams", serviceAccounts: ["cam-1", "cam-2"], publish: ["cameras/${clientid}/frames"] },
      { name: "ops", serviceAccounts: ["cam-1"], subscribe: ["cameras/${clientid}/commands"] },
    ],
  },
  { phase: "Live" },
);

function world(): Resources {
  return {
    project: PROJECT,
    brokers: [CAMERAS],
    dataSources: [
      item("DataSource", "frames", { type: "mqtt", mqtt: { brokerRef: { kind: "MqttBroker", name: "cameras" }, topics: ["cameras/+/frames"] } }),
      item("DataSource", "orphan", { type: "mqtt", mqtt: { brokerRef: { kind: "MqttBroker", name: "gone" }, topics: ["x/#"] } }),
      item("DataSource", "external", { type: "mqtt", mqtt: { urls: ["tls://m:8883"], topics: ["y"] } }),
    ],
    pipelines: [
      item("Pipeline", "camera-frames", {
        source: { dataSourceRef: "frames" },
        targetEndpoint: "urn:ngsi-ld:Endpoint:espoo.fi:espoo:cams-in",
      }),
      item("Pipeline", "elsewhere", {
        sources: [{ dataSourceRef: { kind: "DataSource", name: "frames" } }],
        outputs: [{ targetEndpoint: "urn:ngsi-ld:Endpoint:espoo.fi:espoo:missing" }],
      }),
    ],
    endpoints: [item("Endpoint", "cams-in", { policyRef: "urn:ngsi-ld:Policy:espoo.fi:espoo:cams-write" })],
    policies: [],
    accounts: [item("ServiceAccount", "cam-1", {})],
  } as unknown as Resources;
}

describe("the connections around a project's brokers", () => {
  it("names each edge with what allows it and turns the broken ones red with their fix", () => {
    const edges = connectionsOf(world());
    const red = edges.filter((edge) => edge.problem).map((edge) => [edge.kind, edge.problem?.key, edge.fix]);
    expect(red).toEqual([
      ["device", "mqttbrokers.connections.unknownAccount", { plural: "mqttbrokers", name: "cameras" }],
      ["policy", "mqttbrokers.connections.noPolicy", { plural: "endpoints", name: "cams-in" }],
      ["endpoint", "mqttbrokers.connections.noEndpoint", { plural: "pipelines", name: "elsewhere" }],
      ["broker", "mqttbrokers.connections.noBroker", { plural: "datasources", name: "orphan" }],
      ["pipeline", "mqttbrokers.connections.unread", { plural: "pipelines", name: "" }],
    ]);
    const device = edges.find((edge) => edge.kind === "device" && edge.from === "cam-1");
    expect(device?.allowedBy.values).toEqual({ role: "cams", client: "espoo-cam-1" });
    expect(edges.some((edge) => edge.from === "external" || edge.to === "external")).toBe(false);
  });

  it("is all green when every reference is there, and judges no Endpoint without a policyRef", () => {
    const green = world();
    green.dataSources = green.dataSources.slice(0, 1);
    green.pipelines = green.pipelines.slice(0, 1);
    green.accounts.push(item("ServiceAccount", "cam-2", {}) as never);
    green.policies = [item("Policy", "cams-write", {}) as never];
    expect(connectionsOf(green).filter((edge) => edge.problem)).toEqual([]);
    green.endpoints = [item("Endpoint", "cams-in", {}) as never];
    expect(connectionsOf(green).some((edge) => edge.kind === "policy")).toBe(false);
  });

  it("says a broker in error, and an Endpoint the project does not hold whatever its URN reads", () => {
    const failing = world();
    failing.brokers = [{ ...CAMERAS, status: { phase: "Error" } } as never];
    failing.pipelines[1] = item("Pipeline", "elsewhere", {
      sources: [{ dataSourceRef: "frames" }],
      outputs: [{ targetEndpoint: "urn:ngsi-ld:Endpoint:vantaa.fi:vantaa:shared" }],
    }) as never;
    const edges = connectionsOf(failing);
    expect(edges.find((edge) => edge.kind === "broker" && edge.to === "frames")?.problem?.key).toBe(
      "mqttbrokers.connections.brokerError",
    );
    expect(edges.find((edge) => edge.to === "shared")?.problem?.key).toBe("mqttbrokers.connections.noEndpoint");
  });

  it("reads an Endpoint URN for its name alone and refuses what is not one (ADR-N-041)", () => {
    expect(urnName("urn:ngsi-ld:Endpoint:espoo.fi:espoo:cams-in")).toBe("cams-in");
    expect(urnName("urn:ngsi-ld:Endpoint:cams-in")).toBe("cams-in");
    expect(urnName("urn:ngsi-ld:Endpoint:a:")).toBeUndefined();
    expect(urnName("https://example.org")).toBeUndefined();
    expect(urnName(undefined)).toBeUndefined();
  });
});

describe("the broker form", () => {
  it("writes the roles it was given and keeps the metadata it has no field for", () => {
    const manifest = toMqttBrokerManifest(
      PROJECT,
      {
        name: "cameras",
        roles: [{ name: "cams", serviceAccounts: [" cam-1 ", "", undefined as never], publish: ["cameras/${clientid}/frames"], subscribe: [] }],
        limits: { messagesPerSecond: 20 },
      },
      { metadata: { name: "cameras", labels: { team: "a" } } },
    ) as { metadata: Record<string, unknown>; spec: unknown };
    expect(manifest.metadata).toEqual({ name: "cameras", namespace: PROJECT, labels: { team: "a" } });
    expect(manifest.spec).toEqual({
      roles: [{ name: "cams", serviceAccounts: ["cam-1"], publish: ["cameras/${clientid}/frames"] }],
      limits: { messagesPerSecond: 20 },
    });
    expect(fromMqttBrokerManifest(CAMERAS).roles?.[1]).toEqual({
      name: "ops",
      serviceAccounts: ["cam-1"],
      publish: [],
      subscribe: ["cameras/${clientid}/commands"],
    });
  });

  it("refuses at the field a device subscription outside its own client id, and a port out of range", () => {
    const schema = mqttBrokerSchema((key) => key) as {
      properties: { roles: { items: { properties: { subscribe: { items: { pattern: string } } } } }; port: { minimum: number; maximum: number } };
    };
    const pattern = new RegExp(schema.properties.roles.items.properties.subscribe.items.pattern);
    expect(pattern.test("cameras/${clientid}/commands")).toBe(true);
    expect(pattern.test("cameras/+/${clientid}")).toBe(false);
    expect(pattern.test("#")).toBe(false);
    expect([schema.properties.port.minimum, schema.properties.port.maximum]).toEqual([18830, 18849]);
  });
});

describe("the broker's address", () => {
  it("is the broker's name under the project and the Portal's domain, on 8883 or its own port", () => {
    expect(brokerAddress("cameras", "espoo", "portal.dev.joinedcontext.com")).toBe("cameras.espoo.mqtt.dev.joinedcontext.com:8883");
    expect(brokerAddress("cameras", "espoo", "portal.example.org", 18830)).toBe("cameras.espoo.mqtt.example.org:18830");
    expect(brokerAddress("cameras", "espoo", "localhost")).toBeUndefined();
  });
});

describe("the MQTT brokers page", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.history.replaceState({}, "", `/projects/${PROJECT}/mqttbrokers`);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows each role's topics and accounts, how a device connects, and a red edge with its fix", async () => {
    const resources = world();
    const lists: Record<string, unknown[]> = {
      mqttbrokers: resources.brokers,
      datasources: resources.dataSources,
      pipelines: resources.pipelines,
      endpoints: resources.endpoints,
      policies: resources.policies,
      serviceaccounts: resources.accounts,
    };
    renderPage(<MqttBrokersPage project={PROJECT} />, {
      path: `/projects/${PROJECT}/mqttbrokers`,
      answer: (url) => {
        const plural = url.pathname.split("/").pop() ?? "";
        return lists[plural] ? json(list(lists[plural])) : undefined;
      },
    });

    const accounts = await screen.findByText("cam-1, cam-2");
    const acl = accounts.closest("table") as HTMLElement;
    expect(acl.querySelector("caption")?.textContent).toBe("Topic access of cameras by role");
    const cams = accounts.closest("tr") as HTMLElement;
    expect(within(cams).getByText("cams")).toBeInTheDocument();
    expect(within(cams).getByText("cameras/${clientid}/frames")).toBeInTheDocument();
    expect(screen.getByText("espoo-cam-1")).toBeInTheDocument();
    expect(screen.getByText(en.mqttbrokers.connect.token)).toBeInTheDocument();

    const orphan = await screen.findByText("No broker gone in this project");
    const row = orphan.closest("tr") as HTMLElement;
    expect(row.closest("table")?.querySelector("caption")?.textContent).toBe(en.mqttbrokers.connections.title);
    expect(row.dataset.edge).toBe("red");
    expect(within(row).getByText(en.mqttbrokers.connections.fix).closest("a")).toHaveAttribute(
      "href",
      `/projects/${PROJECT}/datasources/orphan/edit`,
    );
    expect(document.body.textContent).not.toMatch(/password\s*[:=]|secret\s*[:=]/i);
  });
});
