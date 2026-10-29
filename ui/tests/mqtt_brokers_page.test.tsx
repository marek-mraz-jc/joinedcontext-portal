/**
 * T-3839: the MQTT brokers page (MF-54, ADR-N-048). Each broker's topic access by role, how a
 * device connects (never a secret), and the edges from a device to the Policy, a broken one red
 * with a link to where it is fixed.
 */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { MqttBrokerPage } from "../src/pages/mqttbrokers/MqttBrokerPage";
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

  it("takes allowedSources as CIDR ranges at the field and carries them to the manifest and back (PF-129)", () => {
    const schema = mqttBrokerSchema((key) => key) as {
      properties: { allowedSources: { maxItems: number; items: { pattern: string } } };
    };
    const range = new RegExp(schema.properties.allowedSources.items.pattern);
    for (const ok of ["203.0.113.0/24", "198.51.100.7/32", "2001:db8::/48", "::ffff:203.0.113.0/120"]) {
      expect(range.test(ok)).toBe(true);
    }
    for (const bad of ["203.0.113.0", "sensors.city.example/24", "203.0.113.0/33", "256.1.1.1/8", "2001:db8::/129", ""]) {
      expect(range.test(bad)).toBe(false);
    }
    expect(schema.properties.allowedSources.maxItems).toBe(32);
    const manifest = toMqttBrokerManifest("espoo", {
      name: "cameras",
      roles: [{ name: "camera", serviceAccounts: ["cam-1"], publish: ["cameras/${clientid}/#"] }],
      allowedSources: [" 203.0.113.0/24 ", undefined as unknown as string, ""],
    }) as { spec: { allowedSources?: string[] } };
    expect(manifest.spec.allowedSources).toEqual(["203.0.113.0/24"]);
    expect(fromMqttBrokerManifest(manifest).allowedSources).toEqual(["203.0.113.0/24"]);
    const open = toMqttBrokerManifest("espoo", { name: "cameras", roles: [], allowedSources: [] }) as { spec: object };
    expect(open.spec).not.toHaveProperty("allowedSources");
  });

  it("takes connectionsPerAddress in 1..10000 and carries it to the manifest and back (T-5888)", () => {
    const schema = mqttBrokerSchema((key) => key) as {
      properties: { limits: { properties: { connectionsPerAddress: { minimum: number; maximum: number } } } };
    };
    const field = schema.properties.limits.properties.connectionsPerAddress;
    expect([field.minimum, field.maximum]).toEqual([1, 10_000]);
    const manifest = toMqttBrokerManifest("espoo", {
      name: "cameras",
      roles: [{ name: "camera", serviceAccounts: ["cam-1"], publish: ["cameras/${clientid}/#"] }],
      limits: { connectionsPerAddress: 50 },
    }) as { spec: { limits?: object } };
    expect(manifest.spec.limits).toEqual({ connectionsPerAddress: 50 });
    expect(fromMqttBrokerManifest(manifest).limits).toEqual({ connectionsPerAddress: 50 });
  });
});

describe("the broker's address", () => {
  it("is the broker's name under the project and the Portal's domain, on 8883 or its own port", () => {
    expect(brokerAddress("cameras", "espoo", "portal.dev.joinedcontext.com")).toBe("cameras.espoo.mqtt.dev.joinedcontext.com:8883");
    expect(brokerAddress("cameras", "espoo", "portal.example.org", 18830)).toBe("cameras.espoo.mqtt.example.org:18830");
    expect(brokerAddress("cameras", "espoo", "localhost")).toBeUndefined();
  });

  it("is the city's own name on 8883 for a custom hostname, wherever the Portal runs (T-5874)", () => {
    expect(brokerAddress("cameras", "espoo", "localhost", undefined, "mqtt.espoo.example")).toBe("mqtt.espoo.example:8883");
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

  const lists = (): Record<string, unknown[]> => {
    const resources = world();
    return {
      mqttbrokers: resources.brokers,
      datasources: resources.dataSources,
      pipelines: resources.pipelines,
      endpoints: resources.endpoints,
      policies: resources.policies,
      serviceaccounts: resources.accounts,
    };
  };

  it("lists the brokers, each opening its own page, and turns a broken edge red with its fix", async () => {
    const all = lists();
    renderPage(<MqttBrokersPage project={PROJECT} />, {
      path: `/projects/${PROJECT}/mqttbrokers`,
      answer: (url) => {
        const plural = url.pathname.split("/").pop() ?? "";
        return all[plural] ? json(list(all[plural])) : undefined;
      },
    });
    const orphan = await screen.findByText("No broker gone in this project");
    const row = orphan.closest("tr") as HTMLElement;
    expect(row.closest("table")?.querySelector("caption")?.textContent).toBe(en.mqttbrokers.connections.title);
    expect(row.dataset.edge).toBe("red");
    expect(within(row).getByText(en.mqttbrokers.connections.fix).closest("a")).toHaveAttribute(
      "href",
      `/projects/${PROJECT}/datasources/orphan/edit`,
    );
    // T-6103: a broker has a page of its own; the list no longer repeats its settings.
    expect(screen.queryByText("cam-1, cam-2")).toBeNull();
    expect(document.body.textContent).not.toMatch(/password\s*[:=]|secret\s*[:=]/i);
  });
});

/** One broker's page (T-6103) over stubbed reads: the broker, its lists, measured and watch. */
function showBroker(
  options: { broker?: unknown; measured?: () => Response; watch?: () => Response; brokerAnswer?: () => Response } = {},
) {
  const resources = world();
  const all: Record<string, unknown[]> = {
    datasources: resources.dataSources,
    pipelines: resources.pipelines,
    endpoints: resources.endpoints,
    policies: resources.policies,
    serviceaccounts: resources.accounts,
  };
  return renderPage(<MqttBrokerPage project={PROJECT} name="cameras" />, {
    path: `/projects/${PROJECT}/mqttbrokers/cameras`,
    answer: (url) => {
      if (url.pathname.endsWith("/mqttbrokers/cameras/measured")) return options.measured?.();
      if (url.pathname.endsWith("/mqttbrokers/cameras/watch")) return options.watch?.();
      if (url.pathname.endsWith("/mqttbrokers/cameras/access")) return json({ roles: [], outOfWindow: [] });
      if (url.pathname.endsWith("/mqttbrokers/cameras")) return options.brokerAnswer?.() ?? json(options.broker ?? CAMERAS);
      const plural = url.pathname.split("/").pop() ?? "";
      return all[plural] ? json(list(all[plural])) : undefined;
    },
  });
}

const MEASURED = {
  measured: true,
  observedAt: "2026-10-12T08:47:00Z",
  messagesPerSecond: 2.5,
  publishers: 2,
  reason: null,
  accounts: [
    { serviceAccount: "cam-1", connected: 2, since: "2026-10-12T08:46:51Z" },
    { serviceAccount: "cam-2", connected: 0, since: null },
  ],
  rates: [
    { at: "2026-10-12T08:46:50Z", perSecond: 2 },
    { at: "2026-10-12T08:46:55Z", perSecond: 4 },
    { at: "2026-10-12T08:47:00Z", perSecond: 2.5 },
  ],
  refusedPublishes: 812,
};

const WATCHED = {
  observedAt: "2026-10-12T08:47:00Z",
  refusals: [
    { at: "2026-10-12T08:40:00Z", reason: "expired", account: "cam-1" },
    { at: "2026-10-12T08:41:00Z", reason: "expired", account: "cam-1" },
    { at: "2026-10-12T08:42:00Z", reason: "no_role", account: "cam-2" },
  ],
  refusalsRead: true,
  connected: null,
  messagesPerSecond: null,
  reason: null,
};

describe("one MQTT broker's page (T-6103)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.history.replaceState({}, "", `/projects/${PROJECT}/mqttbrokers/cameras`);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows each role's topics and accounts, how a device connects, and the data path", async () => {
    showBroker();
    const accounts = await screen.findByText("cam-1, cam-2");
    const acl = accounts.closest("table") as HTMLElement;
    expect(acl.querySelector("caption")?.textContent).toBe("Topic access of cameras by role");
    const cams = accounts.closest("tr") as HTMLElement;
    expect(within(cams).getByText("cams")).toBeInTheDocument();
    expect(within(cams).getByText("cameras/${clientid}/frames")).toBeInTheDocument();
    expect(screen.getByText("espoo-cam-1")).toBeInTheDocument();
    expect(screen.getByText(en.mqttbrokers.connect.token)).toBeInTheDocument();
    for (const section of Object.values(en.mqttbrokers.page.section)) {
      expect(screen.getByRole("link", { name: section })).toHaveAttribute("href", expect.stringMatching(/^#broker-/));
    }
    expect((await screen.findAllByText("camera-frames")).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/password\s*[:=]|secret\s*[:=]/i);
  });

  it("reads the live tiles, the chart and each account's connections from the broker and the gateway", async () => {
    showBroker({ measured: () => json(MEASURED), watch: () => json(WATCHED) });
    const figures = await screen.findByText(en.mqttbrokers.page.figure.rate);
    const tiles = figures.closest("dl") as HTMLElement;
    expect(within(tiles).getByText("2.5")).toBeInTheDocument();
    expect(within(tiles).getByText("2 / 1,000")).toBeInTheDocument();
    expect(within(tiles).getByText("812")).toBeInTheDocument();
    expect(await within(tiles).findByText("3")).toBeInTheDocument();
    expect(within(tiles).getByText("Mostly: expired")).toBeInTheDocument();
    expect(screen.getByText(en.mqttbrokers.page.state.receiving)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /last 1 min: highest 4, now 2.5/ })).toBeInTheDocument();
    const devices = screen.getByRole("table", { name: en.mqttbrokers.page.devices });
    expect(within(devices).getByText("2 connected")).toBeInTheDocument();
    expect(within(devices).getByText(en.mqttbrokers.page.offlineNow)).toBeInTheDocument();
    expect(screen.getByTestId("live-strip").textContent).toBe("2.5 messages/s · 2 connected · 3 refused sign-ins today");
  });

  it("says idle with no traffic yet: no chart until two samples, and what to do without a device", async () => {
    const idle = { ...MEASURED, messagesPerSecond: 0, accounts: [], rates: [], refusedPublishes: 0 };
    showBroker({ measured: () => json(idle), watch: () => json({ ...WATCHED, refusals: [] }) });
    expect(await screen.findByText(en.mqttbrokers.page.state.idle)).toBeInTheDocument();
    expect(screen.getByText(en.mqttbrokers.page.chartEmpty)).toBeInTheDocument();
    expect(screen.getByText(en.mqttbrokers.page.noDevices)).toBeInTheDocument();
    expect(screen.getByText(en.mqttbrokers.page.figure.refusedSignInsNote)).toBeInTheDocument();
  });

  it("states the broker's highest QoS and what happens to an offline device, as checked on RMQTT 0.24", async () => {
    showBroker();
    const qos = await screen.findByText(en.mqttbrokers.page.qosValue);
    expect(qos.closest("[data-qos]")).toHaveAttribute("data-qos", "1");
    expect(screen.getByText(en.mqttbrokers.page.qosWords)).toBeInTheDocument();
    expect(screen.getByText(en.mqttbrokers.page.offlineWords)).toBeInTheDocument();
    // No networks named: the page warns that any address may connect.
    expect(screen.getByTestId("broker-sources").textContent).toContain(en.mqttbrokers.connect.anySource);
  });

  it("names a broker's own limits with their units, and its networks as chips", async () => {
    const limited = {
      ...CAMERAS,
      spec: { ...(CAMERAS as { spec: object }).spec, limits: { messagesPerSecond: 5, maxConnections: 20 }, allowedSources: ["192.0.2.0/24"] },
    };
    showBroker({ broker: limited, measured: () => json(MEASURED) });
    expect(await screen.findByText("5 per second per device")).toBeInTheDocument();
    expect(screen.getByText("20 connections")).toBeInTheDocument();
    expect(screen.getByText("65,536 bytes")).toBeInTheDocument();
    expect(screen.getByText("20 per address")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "2 of 20 in use" })).toBeInTheDocument();
    expect(screen.getByTestId("broker-sources").textContent).toBe("192.0.2.0/24");
  });

  it("shows the refusal and no settings to a caller who may not read the broker", async () => {
    showBroker({
      brokerAnswer: () =>
        new Response(JSON.stringify({ type: "about:blank", title: "Not Found", status: 404, detail: "MQTT broker 'cameras' not found in project 'espoo'" }), {
          status: 404,
          headers: { "content-type": "application/problem+json" },
        }),
    });
    expect(await screen.findByRole("link", { name: en.mqttbrokers.page.back })).toBeInTheDocument();
    expect(screen.queryByText("cam-1, cam-2")).toBeNull();
    expect(screen.queryByText(en.mqttbrokers.page.section.live)).toBeNull();
  });
});

describe("what a broker measures (T-4043)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.history.replaceState({}, "", `/projects/${PROJECT}/mqttbrokers/cameras`);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("says what the city does next while its custom hostname waits for DNS, and the city's address (T-5874)", async () => {
    const waiting = {
      ...CAMERAS,
      spec: { ...(CAMERAS as { spec: object }).spec, address: "customHostname", hostname: "mqtt.espoo.example" },
      status: { phase: "Pending", conditions: [{ type: "Ready", status: "False", reason: "WaitingForDns", message: "waiting for DNS" }] },
    };
    showBroker({ broker: waiting });
    expect(await screen.findByText(en.mqttbrokers.connect.waitingForDnsTitle)).toBeInTheDocument();
    const alert = document.querySelector("[data-dns='waiting']") as HTMLElement;
    expect(alert.textContent).toContain("Point a CNAME record from mqtt.espoo.example");
    expect(screen.getAllByText("mqtt.espoo.example:8883").length).toBeGreaterThan(0);
  });

  it("shows no DNS notice once the hostname's certificate is issued", async () => {
    const served = { ...CAMERAS, spec: { ...(CAMERAS as { spec: object }).spec, address: "customHostname", hostname: "mqtt.espoo.example" } };
    showBroker({ broker: served });
    expect((await screen.findAllByText("mqtt.espoo.example:8883")).length).toBeGreaterThan(0);
    expect(document.querySelector("[data-dns='waiting']")).toBeNull();
  });

  it("shows each account's connected clients in its role", async () => {
    showBroker({ measured: () => json(MEASURED) });
    const cams = (await screen.findByText("cam-1, cam-2")).closest("tr") as HTMLElement;
    expect(await within(cams).findByText(/^cam-1: 2, newest since /)).toBeInTheDocument();
    expect(within(cams).getByText("cam-2: 0")).toBeInTheDocument();
  });

  it("says not measured, and why, when the broker did not answer the Portal", async () => {
    showBroker({
      measured: () =>
        json({
          measured: false,
          observedAt: "2026-10-12T08:47:00Z",
          messagesPerSecond: null,
          publishers: null,
          reason: "the broker did not answer; try again in a minute",
          accounts: [],
          rates: [],
          refusedPublishes: null,
        }),
    });
    expect(await screen.findByText("the broker did not answer; try again in a minute")).toBeInTheDocument();
    expect(document.querySelector("[data-state='unmeasured']")?.textContent).toBe(en.mqttbrokers.page.state.unmeasured);
    expect(screen.queryByText(en.mqttbrokers.page.figure.rate)).toBeNull();
    const cams = screen.getByText("cam-1, cam-2").closest("tr") as HTMLElement;
    expect(within(cams).queryByText(/^cam-1:/)).toBeNull();
  });

  it("says not measured, never a zero, when the Portal itself cannot be read", async () => {
    showBroker({ measured: () => new Response("", { status: 502 }) });
    expect(await screen.findByText(en.mqttbrokers.page.notRead, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText(en.mqttbrokers.page.figure.rate)).toBeNull();
  });
});
