/**
 * T-5534 (API/01 §44a): the broker card's "Test a message" dialog. The person picks a publishing
 * account, gets a topic its filter allows, runs the dry run and reads each step's chip; the watch
 * polls the refusals and words each reason.
 */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../src/locales/en.json";
import { MqttBrokersPage } from "../src/pages/mqttbrokers/MqttBrokersPage";
import { publishers, sampleTopic } from "../src/pages/mqttbrokers/TestPublish";
import { json, list, problem, renderPage } from "./page_contract";

const PROJECT = "espoo";
const ROLES = [
  { name: "cams", serviceAccounts: ["cam-2", "cam-1"], publish: ["cameras/${clientid}/#"] },
  { name: "ops", serviceAccounts: ["dashboard"], subscribe: ["cameras/${clientid}/commands"] },
];
const BROKER = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "MqttBroker",
  metadata: { name: "cameras", namespace: PROJECT },
  spec: { roles: ROLES },
  status: { phase: "Live" },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the test message's defaults", () => {
  it("offers only accounts that publish, and a topic their filter allows", () => {
    expect(publishers(ROLES)).toEqual(["cam-1", "cam-2"]);
    expect(sampleTopic(ROLES, PROJECT, "cam-1")).toBe("cameras/espoo-cam-1/reading");
    expect(sampleTopic([{ name: "r", serviceAccounts: ["a"], publish: ["+/x/#"] }], PROJECT, "a")).toBe("sensor-1/x/reading");
    expect(sampleTopic(ROLES, PROJECT, "dashboard")).toBe("");
  });
});

describe("the Test a message dialog", () => {
  function render(answers: { run: () => Response; watch: () => Response }) {
    const sent: { url: string; body: unknown }[] = [];
    renderPage(<MqttBrokersPage project={PROJECT} />, {
      path: `/projects/${PROJECT}/mqttbrokers`,
      answer: async (url, request) => {
        if (url.pathname.endsWith("/test-publish")) {
          sent.push({ url: url.pathname, body: await request.json() });
          return answers.run();
        }
        if (url.pathname.endsWith("/watch")) {
          sent.push({ url: `${url.pathname}${url.search}`, body: null });
          return answers.watch();
        }
        if (url.pathname.endsWith("/mqttbrokers")) return json(list([BROKER]));
        return undefined;
      },
    });
    return sent;
  }

  it("runs the dry run with the chosen account and shows each step's chip", async () => {
    const sent = render({
      run: () =>
        json({
          clientId: "espoo-cam-1",
          published: false,
          steps: [
            { step: "acl", outcome: "ok", reason: "allowed by cameras/espoo-cam-1/#" },
            { step: "size", outcome: "refused", reason: "70000 bytes is above the broker's limit" },
            { step: "binding", outcome: "refused", reason: "no DataSource of this project reads this topic" },
            { step: "mapping", outcome: "unchecked", reason: "no Pipeline takes this topic" },
          ],
        }),
      watch: () => json({}),
    });
    fireEvent.click(await screen.findByRole("button", { name: en.mqttbrokers.test.open }));
    const dialog = await screen.findByRole("dialog");
    const account = within(dialog).getByLabelText(new RegExp(en.mqttbrokers.test.account)) as HTMLSelectElement;
    expect([...account.options].map((option) => option.value)).toEqual(["cam-1", "cam-2"]);
    expect((within(dialog).getByLabelText(new RegExp(`^${en.mqttbrokers.test.topic}`)) as HTMLInputElement).value).toBe(
      "cameras/espoo-cam-1/reading",
    );
    expect(within(dialog).getByText(en.mqttbrokers.test.hints.topic)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: en.mqttbrokers.test.run }));
    const acl = await within(dialog).findByText("allowed by cameras/espoo-cam-1/#");
    expect(acl.closest("li")?.dataset.outcome).toBe("ok");
    const size = within(dialog).getByText(/70000 bytes/).closest("li") as HTMLElement;
    expect(size.dataset.outcome).toBe("refused");
    expect(within(size).getByText(en.mqttbrokers.test.outcome.refused)).toBeInTheDocument();
    expect(within(dialog).getByText(/espoo-cam-1/, { selector: "p" })).toBeInTheDocument();
    expect(sent[0]).toEqual({
      url: `/api/v1/projects/${PROJECT}/mqttbrokers/cameras/test-publish`,
      body: { account: "cam-1", topic: "cameras/espoo-cam-1/reading", payload: '{"temperature": 21.5}' },
    });
  });

  it("shows the server's refusal of a field as an alert", async () => {
    render({
      run: () => problem(422, "topic: a device publishes on one topic: no + or # wildcard"),
      watch: () => json({}),
    });
    fireEvent.click(await screen.findByRole("button", { name: en.mqttbrokers.test.open }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: en.mqttbrokers.test.run }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
  });

  it("watches from the moment it is switched on and words each refusal", async () => {
    const sent = render({
      run: () => json({ clientId: "espoo-cam-1", published: false, steps: [] }),
      watch: () =>
        json({
          observedAt: "2026-10-24T10:00:05Z",
          refusals: [{ at: "2026-10-24T10:00:03Z", reason: "expired", account: "cam-1" }],
          refusalsRead: true,
          connected: 0,
          messagesPerSecond: null,
          reason: null,
        }),
    });
    fireEvent.click(await screen.findByRole("button", { name: en.mqttbrokers.test.open }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("switch", { name: en.mqttbrokers.test.watch }));
    expect(await within(dialog).findByText(en.mqttbrokers.test.refusal.expired)).toBeInTheDocument();
    const watched = sent.find((request) => request.url.includes("/watch"));
    expect(watched?.url).toMatch(/account=cam-1&since=\d{4}-\d\d-\d\dT/);
  });
});
