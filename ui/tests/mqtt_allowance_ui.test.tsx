/**
 * T-4860: the MQTT allowance in the Portal (PF-117…PF-119, ADR-N-048 §2.9). The project's page
 * says what is left or who can turn MQTT on; the organization administrator alone gets the
 * per-project MQTT action, which proposes the Project with its `spec.quotas.mqtt`; the device
 * example carries a placeholder and never a token.
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import type { Effective } from "../src/api/permissions";
import { MqttBrokersPage, publishExample, publishTopic } from "../src/pages/mqttbrokers/MqttBrokersPage";
import { fromProjectAllowance, toProjectAllowance, withMqttDefault } from "../src/pages/mqttbrokers/allowance";
import { ProjectMqtt, ProjectMqttState } from "../src/pages/organization/ProjectMqtt";
import { fromMqttBrokerManifest, mqttBrokerSchema, toMqttBrokerManifest } from "../src/schemas/mqttbroker";
import { json, list, renderPage } from "./page_contract";

const PROJECT = "helsinki";

const meter = (limit: number, used: number) => ({ limit, used, left: Math.max(limit - used, 0) });

const OFF = {
  enabled: false,
  origin: "default",
  raise: "an org admin can raise this in Organization settings > Projects > helsinki",
  modes: [],
  addresses: [],
  ports: [],
  brokers: meter(0, 0),
  connections: meter(0, 0),
  messagesPerSecond: meter(0, 0),
  maxMessageBytes: { limit: 0 },
  portsInUse: [],
};

const ON = {
  ...OFF,
  enabled: true,
  origin: "project",
  modes: ["ingest", "capture"],
  addresses: ["platform"],
  brokers: meter(2, 1),
  connections: meter(1000, 600),
  messagesPerSecond: meter(10000, 6000),
  maxMessageBytes: { limit: 65536 },
};

const BROKER = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "MqttBroker",
  metadata: { name: "doors", namespace: PROJECT },
  spec: {
    mode: "capture",
    capture: { messagesPerTopic: 50, window: "PT2H" },
    roles: [{ name: "doors", serviceAccounts: ["door-1"], publish: ["doors/${clientid}/#"] }],
  },
  status: { phase: "Ready" },
};

function showPage(allowance: unknown) {
  return renderPage(<MqttBrokersPage project={PROJECT} />, {
    path: `/projects/${PROJECT}/mqttbrokers`,
    answer: (url) => {
      if (url.pathname.endsWith("/mqtt/allowance")) return json(allowance);
      if (url.pathname.endsWith("/mqttbrokers")) return json(list([BROKER]));
      return undefined;
    },
  });
}

describe("the project's MQTT page (T-4860)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.history.replaceState({}, "", `/projects/${PROJECT}/mqttbrokers`);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("says MQTT is off and who can turn it on", async () => {
    showPage(OFF);
    expect(await screen.findByText(en.mqttAllowance.project.offTitle)).toBeInTheDocument();
    expect(
      screen.getByText("An organization administrator can turn it on in Administration › Projects › helsinki › MQTT."),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-allowance='on']")).toBeNull();
  });

  it("shows what is left and the modes in plain words", async () => {
    showPage(ON);
    expect(
      await screen.findByText(
        "1 of 2 brokers in use, 400 of 1,000 connections left, 4,000 messages per second left.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText(en.mqttAllowance.modeLong.ingest).length).toBeGreaterThan(0);
    expect(screen.getAllByText(en.mqttAllowance.modeLong.capture).length).toBeGreaterThan(0);
    expect(screen.queryByText(en.mqttAllowance.modeLong.relay)).toBeNull();
    expect(document.querySelector("[data-allowance='full']")).toBeNull();
  });

  it("warns at the limit that a new broker is refused", async () => {
    showPage({ ...ON, brokers: meter(2, 2) });
    expect(await screen.findByText(/All 2 brokers are in use: a new one is refused\./)).toBeInTheDocument();
  });

  it("shows the broker's mode and what a capture broker keeps", async () => {
    showPage(ON);
    expect(await screen.findByText("Keeps the last 50 messages per topic for PT2H, for building the mapping.")).toBeInTheDocument();
    expect(document.querySelector("[data-mode='capture']")?.textContent).toBe(en.mqttAllowance.mode.capture);
  });
});

describe("the device example", () => {
  it("names the host, port and client and leaves the token to the shell", () => {
    const topic = publishTopic([{ publish: ["doors/${clientid}/#"] }]);
    const line = publishExample("doors.helsinki.mqtt.dev.joinedcontext.com:8883", "helsinki-door-1", topic);
    expect(line).toContain("-h doors.helsinki.mqtt.dev.joinedcontext.com -p 8883");
    expect(line).toContain("-i helsinki-door-1 -u helsinki-door-1 -P \"$TOKEN\"");
    expect(line).toContain("-t 'doors/helsinki-door-1/data'");
    expect(publishTopic([{ publish: ["s/+/t"] }])).toBe("s/1/t");
  });
});

describe("the allowance form", () => {
  it("writes spec.quotas.mqtt and keeps every other field of the Project", () => {
    const stored = {
      metadata: { name: PROJECT },
      spec: { title: "Helsinki", quotas: { apps: 3 } },
      status: { phase: "Ready" },
    };
    const next = toProjectAllowance(
      { enabled: true, brokers: 2, modes: [], addresses: ["platform", undefined], ports: [18830] },
      stored,
    ) as Record<string, unknown>;
    expect(next).toEqual({
      metadata: { name: PROJECT },
      spec: {
        title: "Helsinki",
        quotas: { apps: 3, mqtt: { enabled: true, brokers: 2, addresses: ["platform"], ports: [18830] } },
      },
    });
    expect(fromProjectAllowance(next)).toEqual({ enabled: true, brokers: 2, addresses: ["platform"], ports: [18830] });
    expect(fromProjectAllowance(stored)).toEqual({ enabled: false });
  });

  it("adds the switch and the lists to the organization's MQTT default, without ports", () => {
    const schema = withMqttDefault(
      { type: "object", properties: { limits: { type: "object", properties: { mqtt: { type: "object", properties: { brokers: { type: "integer" } } } } } } },
      (key) => key,
    ) as { properties: { limits: { properties: { mqtt: { properties: Record<string, unknown> } } } } };
    expect(Object.keys(schema.properties.limits.properties.mqtt.properties)).toEqual(["enabled", "brokers", "modes", "addresses"]);
  });
});

describe("the broker form's mode", () => {
  it("writes mode and capture only when they differ from ingest", () => {
    const base = { name: "doors", roles: [{ name: "d", serviceAccounts: ["door-1"] }] };
    const ingest = toMqttBrokerManifest(PROJECT, { ...base, mode: "ingest", capture: { messagesPerTopic: 5 } }) as { spec: Record<string, unknown> };
    expect(ingest.spec.mode).toBeUndefined();
    expect(ingest.spec.capture).toBeUndefined();
    const capture = toMqttBrokerManifest(PROJECT, { ...base, mode: "capture", capture: { messagesPerTopic: 5, window: "" } }) as { spec: Record<string, unknown> };
    expect(capture.spec).toMatchObject({ mode: "capture", capture: { messagesPerTopic: 5 } });
    expect(fromMqttBrokerManifest(BROKER).mode).toBe("capture");
    const window = (mqttBrokerSchema((key) => key) as { properties: { capture: { properties: { window: { pattern: string } } } } })
      .properties.capture.properties.window.pattern;
    expect(["PT1H", "PT30M", "PT1H30M"].every((value) => new RegExp(window).test(value))).toBe(true);
    expect(["PT", "P1D", "1H"].some((value) => new RegExp(window).test(value))).toBe(false);
  });
});

describe("the per-project MQTT action in Administration", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const ADMIN = {
    project: "org",
    bootstrap: false,
    grants: [{ role: "admin", binding: "admins", rule: { kinds: ["RoleBinding", "Project"], verbs: ["read", "propose", "approve", "delete"] } }],
  } as unknown as Effective;
  const STEWARD = {
    project: "org",
    bootstrap: false,
    grants: [{ role: "steward", binding: "stewards", rule: { kinds: ["Project"], verbs: ["read", "propose"] } }],
  } as unknown as Effective;

  const show = (permissions: Effective) =>
    renderPage(
      <>
        <ProjectMqttState project={PROJECT} />
        <ProjectMqtt project={PROJECT} title="Helsinki" />
      </>,
      {
        path: "/organization/projects",
        answer: (url) => {
          if (url.pathname.endsWith("/permissions/me")) return json(permissions);
          if (url.pathname.endsWith("/mqtt/allowance")) return json(ON);
          return undefined;
        },
      },
    );

  it("is offered to an organization administrator, with the project's state", async () => {
    show(ADMIN);
    expect(await screen.findByRole("button", { name: "MQTT allowance of Helsinki" })).toBeInTheDocument();
    expect(await screen.findByText("On · 1 of 2 brokers")).toBeInTheDocument();
  });

  it("is not rendered for anybody else", async () => {
    show(STEWARD);
    await screen.findByText("On · 1 of 2 brokers");
    await waitFor(() => expect(screen.queryByRole("button", { name: "MQTT allowance of Helsinki" })).toBeNull());
  });
});
