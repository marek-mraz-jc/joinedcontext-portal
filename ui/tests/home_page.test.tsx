// covers (T-2137, the module gate in gate_modules.test.ts): src/pages/home/HomePage.tsx and
// src/pages/home/firstRun.ts: the project home, its first-run checklist and the role cards.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { HomePage } from "../src/pages/home/HomePage";
import "../src/pages/home/firstRun";
import { expectNoViolations } from "./checks";
import { json, list, renderPage } from "./page_contract";

const named = (name: string, phase?: string) => ({ metadata: { name, namespace: "helsinki" }, spec: {}, ...(phase ? { status: { phase } } : {}) });

interface World {
  verbs: string[];
  spaces?: string[];
  entities?: number;
  pipelines?: string[];
  dismissed?: boolean;
}

function show(world: World) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const result = renderPage(<HomePage project="helsinki" />, {
    path: "/projects/helsinki/home",
    answer: async (url, request) => {
      if (request.method !== "GET") {
        sent.push({ method: request.method, path: url.pathname, body: await request.clone().json().catch(() => undefined) });
        return json({ firstRunDismissed: true });
      }
      const path = url.pathname;
      if (path.endsWith("/permissions/me")) {
        return json({ project: "helsinki", grants: [{ rule: { kinds: ["ContextSpace", "DataSource", "Pipeline", "Endpoint", "Dashboard"], verbs: world.verbs } }] });
      }
      if (path === "/api/v1/preferences") return json(world.dismissed ? { firstRunDismissed: true } : {});
      if (path === "/api/v1/projects/helsinki/spaces") return json(list((world.spaces ?? []).map((s) => named(s))));
      if (path.match(/\/spaces\/[^/]+\/usage$/)) return json({ entities: world.entities ?? 0, observedAt: "2026-10-07T20:00:00Z" });
      if (path === "/api/v1/projects/helsinki/pipelines") return json(list((world.pipelines ?? []).map((phase, at) => named(`p${at}`, phase))));
      if (path === "/api/v1/projects/helsinki/changes") return json(list([{ metadata: { name: "chg-1" }, status: { phase: "PendingApproval" } }]));
      if (path === "/api/v1/organization/people") return json({ title: "Forbidden", status: 403 }, 403);
      if (path.startsWith("/api/v1/projects/helsinki/")) return json(list([]));
      return undefined;
    },
  });
  return { ...result, sent };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the project home (T-3233, T-3235)", () => {
  it("shows a new project's checklist with every step still to do, each linking to its form", async () => {
    const { container } = show({ verbs: ["read", "propose"] });
    const checklist = await screen.findByRole("region", { name: en.home.firstRun.title });
    expect(within(checklist).getByRole("status")).toHaveTextContent("0 of 5 done");
    expect(within(checklist).getByRole("link", { name: en.home.firstRun.go.space })).toHaveAttribute("href", "/projects/helsinki/spaces/new");
    expect(within(checklist).getByRole("link", { name: en.home.firstRun.go.share })).toHaveAttribute("href", "/projects/helsinki/endpoints/new");
    await expectNoViolations(container);
  });

  it("ticks the steps the project has taken, from its own state", async () => {
    show({ verbs: ["read", "propose"], spaces: ["air"], entities: 12, pipelines: ["Live"] });
    const checklist = await screen.findByRole("region", { name: en.home.firstRun.title });
    await waitFor(() => expect(within(checklist).getByRole("status")).toHaveTextContent("3 of 5 done"));
    expect(within(checklist).queryByRole("link", { name: en.home.firstRun.go.data })).toBeNull();
  });

  it("puts the checklist away for the person, in their preferences", async () => {
    const { sent } = show({ verbs: ["read", "propose"] });
    await userEvent.click(await screen.findByRole("button", { name: en.home.firstRun.dismiss }));
    expect(screen.queryByRole("region", { name: en.home.firstRun.title })).toBeNull();
    await waitFor(() => expect(sent).toEqual([{ method: "PUT", path: "/api/v1/preferences", body: { firstRunDismissed: true } }]));
  });

  it("stays away once put away", async () => {
    show({ verbs: ["read"], dismissed: true });
    await screen.findByText(en.home.lead.viewer);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("region", { name: en.home.firstRun.title })).toBeNull();
  });

  it("shows a steward the change waiting and the failing pipeline, one click each, and no card for what they may not list", async () => {
    show({ verbs: ["read", "propose", "approve"], pipelines: ["Error", "Live"] });
    const next = await screen.findByRole("region", { name: en.home.next });
    await waitFor(() => expect(within(next).getAllByRole("link")).toHaveLength(2));
    expect(within(next).getByRole("link", { name: /1 change waits for approval/ })).toHaveAttribute("href", "/projects/helsinki/approvals");
    expect(within(next).getByRole("link", { name: /1 pipeline is failing/ })).toHaveAttribute("href", "/projects/helsinki/pipelines");
  });

  it("shows a viewer nothing to count when there is nothing to read yet", async () => {
    show({ verbs: ["read"], dismissed: true });
    await screen.findByText(en.home.lead.viewer);
    expect(screen.queryByRole("region", { name: en.home.next })).toBeNull();
  });
});
