/**
 * T-2424, T-2423, T-2421: where the assistant's input sits, what stands beside it, and which
 * corners it has.
 *
 * Three defects the user met on 2026-09-20, all in the same dock. The composer sat in the middle of
 * a scrolling column with a `Recent conversations` list of truncated prompts under it, so the input
 * moved as content grew and the last thing in the panel was a list of old questions. Inside a
 * conversation the example prompts and the app builder were gone altogether, because they render
 * only when no run is remembered. And every corner in the dock was Tailwind's bare `rounded`,
 * 0.25rem, which is on no token of `src/tokens.css`, beside a page built from `rounded-md` and
 * `rounded-lg`.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { RouterProvider, createRootRoute, createRouter } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { expectDenied } from "./checks";
import en from "../src/locales/en.json";
import { AssistantDock } from "../src/assistant/AssistantDock";
import { rememberRun } from "../src/assistant/state";

const PROJECT = "helsinki";
const RUN_ID = "01J8ZQ4T7K9M2N3P4Q5R6S7T8V";
const OTHER_RUN = "01J8ZQ4T7K9M2N3P4Q5R6S7T8W";

/** Two live conversations, which is what used to draw the `Resume:` list. */
const RECENT = {
  items: [
    { id: RUN_ID, project: PROJECT, kind: "conversation", prompt: "Which stations were empty yesterday?", status: "interviewing" },
    { id: OTHER_RUN, project: PROJECT, kind: "conversation", prompt: "what are currenlt helsinky traffic alerts ??", status: "answering" },
  ],
};

class StubEventSource {
  static opened: StubEventSource[] = [];
  private readonly listeners = new Map<string, Set<EventListener>>();
  constructor() {
    StubEventSource.opened.push(this);
  }
  addEventListener(kind: string, listener: EventListener): void {
    const set = this.listeners.get(kind) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(kind, set);
  }
  removeEventListener(kind: string, listener: EventListener): void {
    this.listeners.get(kind)?.delete(listener);
  }
  close(): void {}
  emit(kind: string, payload: Record<string, unknown>): void {
    const frame = new MessageEvent(kind, { data: JSON.stringify(payload), lastEventId: String(payload.seq ?? "") });
    for (const listener of [...(this.listeners.get(kind) ?? [])]) {
      listener(frame);
    }
  }
}

/** The rule the caller holds: `propose` on everything, or read only. */
function permissions(mayPropose: boolean) {
  return {
    project: PROJECT,
    bootstrap: false,
    grants: [
      {
        role: "reader",
        binding: "readers",
        scope: "project",
        rule: { kinds: ["Endpoint", "Dashboard"], verbs: mayPropose ? ["read", "propose"] : ["read"] },
      },
    ],
  };
}

function renderDock({ mayPropose = true }: { mayPropose?: boolean } = {}) {
  const messages: unknown[] = [];
  const started: unknown[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const request = input as Request;
    const url = new URL(request.url, "http://localhost");
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname.endsWith("/auth/me")) {
      return json({ subject: "s", username: "demo.steward", roles: ["domain-editor"] });
    }
    if (url.pathname.endsWith("/permissions/me")) {
      return json(permissions(mayPropose));
    }
    if (request.method === "POST" && url.pathname.endsWith("/assistant/conversations")) {
      started.push(JSON.parse(await request.text()));
      return json({ id: RUN_ID, status: "queued" }, 202);
    }
    if (request.method === "POST" && url.pathname.endsWith(`/agent-runs/${RUN_ID}/messages`)) {
      messages.push(JSON.parse(await request.text()));
      return json({}, 202);
    }
    if (url.pathname.endsWith(`/agent-runs/${RUN_ID}`)) {
      return json({
        id: RUN_ID,
        project: PROJECT,
        kind: "conversation",
        appName: "",
        endpointName: "helsinki-alerts",
        prompt: "what are currenlt helsinky traffic alerts ??",
        status: "interviewing",
        steps: 1,
        tokensUsed: 10,
        createdBy: "demo.steward",
        createdAt: "2026-09-20T17:00:00Z",
        endpoints: [{ name: "helsinki-alerts", slug: "helsinkialertsslug", space: "helsinki" }],
      });
    }
    if (url.pathname.endsWith("/agent-runs")) {
      return json(RECENT);
    }
    if (url.pathname.endsWith("/endpoints")) {
      return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", StubEventSource as unknown as typeof EventSource);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <AssistantDock project={PROJECT} /> });
  const router = createRouter({ routeTree: rootRoute });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { messages, started };
}

const dock = () => screen.getByRole("complementary", { name: en.agentRun.conversation.title });

/** The dock opens as a bubble; a person clicks it. */
async function openDock() {
  const person = userEvent.setup();
  await person.click(await screen.findByRole("button", { name: en.assistant.open }));
  return person;
}

/** The panel's own children, in the order a person reads them. */
const children = () => [...dock().children] as HTMLElement[];

describe("where the assistant's input sits", () => {
  beforeEach(async () => {
    StubEventSource.opened = [];
    rememberRun(null);
    window.localStorage.clear();
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rememberRun(null);
  });

  it("puts the text box last in the empty state, with only scrolling content above it", async () => {
    renderDock();
    await openDock();
    const composer = await screen.findByLabelText(en.assistant.empty.composer);
    const form = composer.closest("form") as HTMLElement;
    const last = children().at(-1);
    expect(last, "the composer is the panel's last child, so it cannot be pushed down").toBe(form);
    // What is above it scrolls; the form itself does not.
    expect(screen.getByTestId("assistant-empty").className).toContain("overflow-y-auto");
    expect(form.className).not.toContain("overflow-y-auto");
  });

  it("draws no list of old prompts under the text box, with two live conversations to draw", async () => {
    renderDock();
    await openDock();
    await screen.findByLabelText(en.assistant.empty.composer);
    for (const prompt of RECENT.items) {
      expect(screen.queryByText(new RegExp(prompt.prompt.slice(0, 20), "i"))).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
    // and the two strings that drew it are gone from the bundle, in every language
    const empty = en.assistant.empty as Record<string, unknown>;
    expect(empty.recent).toBeUndefined();
    expect(empty.resume).toBeUndefined();
  });

  it("offers the same prompts inside a conversation, and a click sends one into it", async () => {
    const { messages, started } = renderDock();
    const person = await openDock();
    await act(async () => {
      rememberRun({ project: PROJECT, runId: RUN_ID });
    });
    const suggestions = await screen.findByTestId("assistant-suggestions");
    const find = within(suggestions).getByRole("button", { name: en.assistant.empty.examples.find });
    await person.click(find);
    await waitFor(() => {
      expect(messages).toEqual([{ text: en.assistant.empty.examples.find }]);
    });
    // The open conversation continues; a chip does not start a second run.
    expect(started).toEqual([]);
  });

  it("keeps the app builder reachable from inside a conversation", async () => {
    renderDock();
    const person = await openDock();
    await act(async () => {
      rememberRun({ project: PROJECT, runId: RUN_ID });
    });
    const suggestions = await screen.findByTestId("assistant-suggestions");
    await person.click(within(suggestions).getByRole("button", { name: en.apps.generate.title }));
    expect(await screen.findByRole("button", { name: en.assistant.backToChat })).toBeInTheDocument();
  });

  it("disables a prompt the caller's role cannot carry out, with the reason on it", async () => {
    renderDock({ mayPropose: false });
    await openDock();
    const suggestions = await screen.findByTestId("assistant-examples");
    expectDenied(
      within(suggestions).getByRole("button", { name: en.assistant.empty.examples.share }),
      // The reason is `permissions.denied` filled in by i18next, which is what a person reads.
      i18n.t("permissions.denied", { verb: "propose", kind: "Endpoint" }),
    );
    // The one that proposes nothing stays open.
    expect(
      within(suggestions).getByRole("button", { name: en.assistant.empty.examples.find }),
    ).not.toHaveAttribute("aria-disabled", "true");
  });
});

describe("the assistant's corners", () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it("come from the radius scale, never Tailwind's bare rounded", () => {
    for (const file of ["AssistantDock.tsx", "EndpointPicker.tsx", "HandOff.tsx"]) {
      const source = readFileSync(resolve(here, join("..", "src", "assistant", file)), "utf8");
      const bare = [...source.matchAll(/\brounded(?=[ "'`])/g)];
      expect(bare, `${file} uses rounded-sm|md|lg|xl|full, not the bare class`).toEqual([]);
    }
  });
});
