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
  /** Arrived through an invitation's link (PF-108). */
  welcome?: boolean;
  onWelcomeClosed?: () => void;
  /** What `GET /api/v1/projects` lists for the person (PF-109). */
  projects?: { name: string; sample: boolean }[];
}

function show(world: World) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const result = renderPage(<HomePage project="helsinki" welcome={world.welcome} onWelcomeClosed={world.onWelcomeClosed} />, {
    path: "/projects/helsinki/home",
    answer: async (url, request) => {
      if (request.method !== "GET") {
        sent.push({ method: request.method, path: url.pathname, body: await request.clone().json().catch(() => undefined) });
        return json({ firstRunDismissed: true });
      }
      const path = url.pathname;
      if (path.endsWith("/permissions/me")) {
        const grants = world.verbs.length > 0 ? [{ rule: { kinds: ["ContextSpace", "DataSource", "Pipeline", "Endpoint", "Dashboard"], verbs: world.verbs } }] : [];
        return json({ project: "helsinki", grants });
      }
      if (path === "/api/v1/preferences") return json(world.dismissed ? { firstRunDismissed: true } : {});
      if (path === "/api/v1/projects") return json({ apiVersion: "v1", kind: "List", items: world.projects ?? [{ name: "helsinki", sample: false }] });
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

describe("the welcome an invitation leads to (PF-108)", () => {
  it("greets a viewer with their role and their first step, one click away", async () => {
    const closed = vi.fn();
    const { container } = show({ verbs: ["read"], welcome: true, onWelcomeClosed: closed });
    const welcome = await screen.findByRole("region", { name: "Welcome to helsinki" });
    expect(welcome).toHaveTextContent(en.home.welcome.role.viewer);
    expect(within(welcome).getByRole("link", { name: en.home.welcome.first.viewer })).toHaveAttribute("href", "/projects/helsinki/spaces");
    await expectNoViolations(container);
    await userEvent.click(within(welcome).getByRole("button", { name: en.home.welcome.close }));
    expect(closed).toHaveBeenCalledOnce();
  });

  it("sends an editor to connect a source and a steward to the changes waiting", async () => {
    show({ verbs: ["read", "propose"], welcome: true });
    let welcome = await screen.findByRole("region", { name: "Welcome to helsinki" });
    expect(within(welcome).getByRole("link", { name: en.home.welcome.first.editor })).toHaveAttribute("href", "/projects/helsinki/datasources/new");
    cleanup();
    show({ verbs: ["read", "propose", "approve"], welcome: true });
    welcome = await screen.findByRole("region", { name: "Welcome to helsinki" });
    expect(within(welcome).getByRole("link", { name: en.home.welcome.first.steward })).toHaveAttribute("href", "/projects/helsinki/approvals");
  });

  it("says the role waits for its approval while the person holds nothing here, and offers no step", async () => {
    show({ verbs: [], welcome: true });
    const welcome = await screen.findByRole("region", { name: "Welcome to helsinki" });
    expect(welcome).toHaveTextContent(en.home.welcome.unknown);
    expect(within(welcome).queryByRole("link")).toBeNull();
  });

  it("greets nobody who came without the invitation's link", async () => {
    show({ verbs: ["read"] });
    await screen.findByRole("heading", { name: en.home.title });
    expect(screen.queryByRole("region", { name: "Welcome to helsinki" })).toBeNull();
  });
});

describe("the sample project (PF-109, T-3234)", () => {
  it("offers a newcomer's checklist the sample to look around in first, one click away", async () => {
    const { container } = show({
      verbs: ["read"],
      projects: [
        { name: "banskabystrica", sample: true },
        { name: "helsinki", sample: false },
      ],
    });
    const checklist = await screen.findByRole("region", { name: en.home.firstRun.title });
    const link = await within(checklist).findByRole("link", { name: en.home.sample.try });
    expect(link).toHaveAttribute("href", "/projects/banskabystrica/home");
    expect(screen.queryByText(en.home.sample.title)).toBeNull();
    await expectNoViolations(container);
  });

  it("marks the sample itself and says what a person may do there, without sending them elsewhere", async () => {
    const { container } = show({ verbs: ["read"], projects: [{ name: "helsinki", sample: true }] });
    expect(await screen.findByText(en.home.sample.title)).toBeInTheDocument();
    expect(screen.getByText(en.home.sample.body)).toBeInTheDocument();
    expect(screen.getByText(en.home.sample.badge)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: en.home.sample.try })).toBeNull();
    await expectNoViolations(container);
  });

  it("offers the sample while the person keeps the guidance, and not after it was put away", async () => {
    const projects = [
      { name: "banskabystrica", sample: true },
      { name: "helsinki", sample: false },
    ];
    show({ verbs: ["read"], spaces: ["air"], entities: 3, pipelines: ["Live"], projects });
    expect(await screen.findByRole("link", { name: en.home.sample.try })).toHaveAttribute("href", "/projects/banskabystrica/home");
    cleanup();
    show({ verbs: ["read"], dismissed: true, projects });
    await screen.findByText(en.home.lead.viewer);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("link", { name: en.home.sample.try })).toBeNull();
  });

  it("offers no sample the person may not read: none listed, none named", async () => {
    show({ verbs: ["read"], projects: [{ name: "helsinki", sample: false }] });
    await screen.findByRole("region", { name: en.home.firstRun.title });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("link", { name: en.home.sample.try })).toBeNull();
    expect(screen.queryByText(en.home.sample.badge)).toBeNull();
  });
});
