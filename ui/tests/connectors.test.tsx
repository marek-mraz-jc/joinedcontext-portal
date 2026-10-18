// covers (T-2137, the module gate in gate_modules.test.ts): src/pages/mcp/connectors.ts,
// src/pages/mcp/ConnectorsPage.tsx and src/pages/mcp/ConnectorStar.tsx, a person's own MCP
// connectors (UI-98, EP-123, T-4531).
import type { JSX } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { App } from "../src/App";
import { connectorProblems, connectorUrl, fromForm, reach, toForm, toggledStar } from "../src/pages/mcp/connectors";
import type { Connector, Readable } from "../src/pages/mcp/connectors";
import { ConnectorStar } from "../src/pages/mcp/ConnectorStar";
import { ConnectorsPage } from "../src/pages/mcp/ConnectorsPage";

const IDENTITY = { subject: "b7c1e0f4", username: "eva.steward", name: "Eva Steward", roles: [] };
const list = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });
const endpoint = (project: string, name: string, slug: string, audience: string, space = "air") => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Endpoint",
  metadata: { name, namespace: project, title: { en: name } },
  spec: { slug, audience, contextSpaceRef: { name: space } },
});

const readable: Readable[] = [
  { project: "mesto", name: "air", slug: "air1", space: "air", audience: "public" },
  { project: "mesto", name: "bins", slug: "bins1", space: "waste", audience: "organization" },
  { project: "kraj", name: "roads", slug: "roads1", space: "roads", audience: "project-list" },
];

describe("connector helpers", () => {
  it("reaches what matches every field given, and everything readable when none is", () => {
    const names = (connector: Connector) => reach(connector, readable).map((one) => one.slug);
    expect(names({ name: "a", select: {} })).toEqual(["air1", "bins1", "roads1"]);
    expect(names({ name: "a", select: { projects: ["mesto"], accessLevel: ["organization"] } })).toEqual(["bins1"]);
    expect(names({ name: "a", select: { spaces: ["mesto/air", "kraj/roads"] } })).toEqual(["air1", "roads1"]);
    expect(names({ name: "a", select: { accessLevel: ["grant"] } })).toEqual(["roads1"]);
    expect(names({ name: "a", select: { endpoints: ["gone1", "air1"] } })).toEqual(["air1"]);
    expect(names({ name: "a", select: { projects: ["nosuch"] } })).toEqual([]);
  });

  it("stars into the first connector or a new favourites, and unstars from every one", () => {
    expect(toggledStar([], "air1")).toEqual([{ name: "favourites", select: { endpoints: ["air1"] } }]);
    const two: Connector[] = [
      { name: "a", select: { projects: ["mesto"] } },
      { name: "b", select: { endpoints: ["air1"] } },
    ];
    expect(toggledStar(two, "bins1")[0]).toEqual({ name: "a", select: { projects: ["mesto"], endpoints: ["bins1"] } });
    expect(toggledStar(two, "air1")[1].select?.endpoints).toEqual([]);
  });

  it("refuses a bad name, a taken name, a bad space and too many values before the server is asked", () => {
    const others: Connector[] = [{ name: "air", select: {} }];
    expect(connectorProblems({ name: "Air", select: {} }, []).name).toBeDefined();
    expect(connectorProblems({ name: "air", select: {} }, others).name).toBe("connectors.problem.taken");
    expect(connectorProblems({ name: "x", select: { spaces: ["mesto"] } }, []).spaces).toBeDefined();
    const many = Array.from({ length: 51 }, (_, i) => `e${i}`);
    expect(connectorProblems({ name: "x", select: { endpoints: many } }, []).select).toBeDefined();
    expect(connectorProblems({ name: "x", select: { endpoints: many.slice(0, 50) } }, [])).toEqual({});
  });

  it("round-trips a connector through the form, dropping empty fields", () => {
    const connector: Connector = { name: "air", select: { projects: ["mesto", "kraj"], themes: ["ENVI"], endpoints: ["air1"] } };
    expect(fromForm(toForm(connector))).toEqual(connector);
    expect(fromForm({ ...toForm(), name: " x ", themes: "envi, envi" })).toEqual({ name: "x", select: { themes: ["ENVI"] } });
    expect(connectorUrl("dev.example", "air")).toBe("https://dev.example/api/mcp/me/air");
  });
});

interface Stub {
  stored?: Record<string, unknown>;
  refuse?: string;
}

function renderAt(path: string, stub: Stub = {}, page?: JSX.Element) {
  const writes: unknown[] = [];
  let stored = stub.stored ?? {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      const json = (body: unknown, code = 200) =>
        Promise.resolve(new Response(JSON.stringify(body), { status: code, headers: { "Content-Type": code >= 400 ? "application/problem+json" : "application/json" } }));
      if (url.pathname.endsWith("/auth/me")) return json(IDENTITY);
      if (url.pathname.endsWith("/branding")) return json({ instanceName: "joinedcontext", domain: "dev.example", languages: { default: "en", offered: ["en"] } });
      if (url.pathname.endsWith("/permissions/me")) return json({ project: "mesto", bootstrap: false, grants: [] });
      if (url.pathname === "/api/v1/preferences") {
        if (request.method === "PUT") {
          const body = (await request.json()) as Record<string, unknown>;
          writes.push(body);
          if (stub.refuse) return json({ title: "Bad Request", status: 400, detail: stub.refuse }, 400);
          stored = body;
        }
        return json(stored);
      }
      if (url.pathname === "/api/v1/projects") return json(list([{ name: "mesto" }]));
      if (url.pathname === "/api/v1/projects/mesto/endpoints") return json(list([endpoint("mesto", "air", "air1", "public"), endpoint("mesto", "bins", "bins1", "organization", "waste")]));
      if (url.pathname === "/api/v1/projects/mesto/endpoints/air") return json(endpoint("mesto", "air", "air1", "public"));
      if (url.pathname === "/api/v1/projects/org/mcpservers") {
        return json(list([{ apiVersion: "joinedcontext.com/v1alpha1", kind: "McpServer", metadata: { name: "mobility", namespace: "org", title: { en: "Mobility" } }, spec: {} }]));
      }
      return json(list([]));
    }),
  );
  Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
  window.history.pushState({}, "", path);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nextProvider i18n={i18n}>
        {page ?? <App />}
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { writes };
}

describe("the connectors page (T-4531)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a connector's own address, the entry to paste and what it reaches, beside the organization's servers", async () => {
    renderAt("/connectors", { stored: { theme: "dark", connectors: [{ name: "air", select: { accessLevel: ["public"] } }] } });
    const card = await screen.findByRole("region", { name: "air" });
    expect(within(card).getByText("https://dev.example/api/mcp/me/air")).toBeInTheDocument();
    const entry = within(card).getByLabelText("Entry for the AI client's configuration");
    expect(JSON.parse(entry.textContent ?? "")).toEqual({ mcpServers: { air: { type: "http", url: "https://dev.example/api/mcp/me/air" } } });
    expect(entry.textContent).not.toMatch(/token|Bearer|secret/i);
    const reached = within(card).getByRole("list", { name: "What air reaches" });
    expect(await within(reached).findByText("mesto/air")).toBeInTheDocument();
    expect(within(reached).queryByText("mesto/bins")).toBeNull();
    const org = screen.getByRole("region", { name: "Servers of the organization" });
    expect(within(org).getByText("https://dev.example/api/mcp/org/all")).toBeInTheDocument();
    expect(await within(org).findByText("https://dev.example/api/mcp/org/mobility")).toBeInTheDocument();
  });

  it("creates a connector and keeps the rest of the preferences", async () => {
    const { writes } = renderAt("/connectors", { stored: { theme: "dark" } });
    await userEvent.click((await screen.findAllByRole("button", { name: "New connector" }))[0]);
    const dialog = await screen.findByRole("dialog", { name: "New connector" });
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "waste");
    await userEvent.type(within(dialog).getByLabelText(/^Projects/), "mesto");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Whole organization" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes).toEqual([{ theme: "dark", connectors: [{ name: "waste", select: { projects: ["mesto"], accessLevel: ["organization"] } }] }]);
    const card = await screen.findByRole("region", { name: "waste" });
    expect(await within(card).findByText("mesto/bins")).toBeInTheDocument();
  });

  it("shows the server's refusal and keeps the dialog open", async () => {
    renderAt("/connectors", { refuse: "endpoint 'inner1' is not one you may read" });
    await userEvent.click((await screen.findAllByRole("button", { name: "New connector" }))[0]);
    const dialog = await screen.findByRole("dialog", { name: "New connector" });
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "x");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("endpoint 'inner1' is not one you may read")).toBeInTheDocument();
  });

  it("checks the name before anything is saved", async () => {
    const { writes } = renderAt("/connectors", { stored: { connectors: [{ name: "air", select: {} }] } });
    await userEvent.click((await screen.findAllByRole("button", { name: "New connector" }))[0]);
    const dialog = await screen.findByRole("dialog", { name: "New connector" });
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "air");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("You already have a connector with this name. Pick another one.")).toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it("deletes a connector", async () => {
    const { writes } = renderAt("/", { stored: { connectors: [{ name: "air", select: {} }] } }, <ConnectorsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete connector air" }));
    await waitFor(() => expect(writes).toEqual([{ connectors: [] }]));
    expect(await screen.findByText("No connectors yet")).toBeInTheDocument();
  });

  it("stars an Endpoint on its page into a new favourites connector, and takes it out again", async () => {
    const { writes } = renderAt("/projects/mesto/endpoints/air", { stored: { theme: "dark" } });
    await userEvent.click(await screen.findByRole("button", { name: "Add to my connectors" }));
    const starred = await screen.findByRole("button", { name: "In connector: favourites" });
    expect(starred).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(starred);
    await screen.findByRole("button", { name: "Add to my connectors" });
    expect(writes).toEqual([
      { theme: "dark", connectors: [{ name: "favourites", select: { endpoints: ["air1"] } }] },
      { theme: "dark", connectors: [{ name: "favourites", select: { endpoints: [] } }] },
    ]);
  });

  it("says so when the server refuses a star for an Endpoint the person may not read", async () => {
    const { writes } = renderAt("/", { refuse: "endpoint 'inner1' is not one you may read" }, <ConnectorStar slug="inner1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Add to my connectors" }));
    expect(await screen.findByText("endpoint 'inner1' is not one you may read")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to my connectors" })).toHaveAttribute("aria-pressed", "false");
    expect(writes).toHaveLength(1);
  });
});
