// covers (T-2137, the module gate in gate_modules.test.ts): the cases in this file drive
// src/pages/knowledge/KnowledgePage.tsx, src/pages/knowledge/SourcePage.tsx,
// src/pages/knowledge/AssistantChat.tsx and src/pages/knowledge/knowledge.ts through the pages
// they belong to; each was confirmed by
// making the module throw and watching this file go red.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { App } from "../src/App";
import { bytesText, embedSnippet, readEvents, timeText } from "../src/pages/knowledge/knowledge";
import { reasonOf } from "../src/pages/knowledge/KnowledgePage";
import { InclusionBadge } from "../src/pages/knowledge/SourcePage";
import { EmbedSnippet } from "../src/pages/knowledge/AssistantChat";
import { ApiError } from "../src/api/client";
import { assistantDeploymentSchema, fromKindManifest, knowledgeSourceSchema, toKindManifest } from "../src/schemas/knowledge";

const IDENTITY = { subject: "b7c1e0f4", username: "jana.kovacova", name: "Jana Kováčová", roles: [] };

const grants = (verbs: string[]) => ({
  project: "banskabystrica",
  bootstrap: false,
  grants: [
    {
      role: verbs.includes("propose") ? "org-admin" : "viewer",
      binding: "people",
      scope: "project:banskabystrica",
      rule: { kinds: ["KnowledgeSource", "AssistantDeployment"], verbs },
    },
  ],
});

const SOURCES = {
  items: [
    {
      source: "bb-web",
      type: "website",
      state: "crawled",
      startUrls: ["https://www.banskabystrica.sk/"],
      ckanInstanceRef: null,
      schedule: "0 3 * * *",
      visibility: "public",
      lastCrawl: "2026-10-06T03:00:00Z",
      pages: 120,
      pagesIncluded: 110,
      documents: 14,
      passages: 900,
      embedded: 850,
      job: { state: "done", attempts: 1, error: null },
    },
    {
      source: "bb-data",
      type: "ckan",
      state: "not-crawled",
      startUrls: [],
      ckanInstanceRef: "open-data",
      schedule: null,
      visibility: "public",
    },
    {
      source: "bb-catalogue",
      type: "catalogue",
      state: "not-crawled",
      startUrls: [],
      ckanInstanceRef: null,
      contextSpaces: [],
      schedule: null,
      visibility: "public",
    },
    {
      source: "bb-old",
      type: "website",
      state: "crawled",
      startUrls: ["https://old.banskabystrica.sk/"],
      ckanInstanceRef: null,
      schedule: null,
      visibility: "internal",
      lastCrawl: "2026-10-05T03:00:00Z",
      pages: 3,
      pagesIncluded: 3,
      documents: 0,
      passages: 10,
      embedded: 10,
      job: { state: "failed", attempts: 3, error: "https://old.banskabystrica.sk/ answered 503" },
    },
  ],
};

const page = (id: number, url: string, extra: Record<string, unknown> = {}) => ({
  id,
  url,
  depth: 0,
  parentId: null,
  status: "fetched",
  included: true,
  excludedBy: null,
  language: "sk",
  fetchedAt: "2026-10-06T03:01:00Z",
  children: 0,
  documents: 0,
  passages: 3,
  ...extra,
});

interface Stub {
  verbs?: string[];
  sources?: { code: number; body: unknown };
  chat?: { code: number; body: string };
}

const ANSWER = [
  'event: conversation\ndata: {"id":"6f1c0e9e-3b1a-4d7e-9b51-2c4f8f2a7c11"}',
  'event: tool\ndata: {"name":"query_entities","endpoint":"ovzdusie-verejne","status":"started"}',
  'event: tool\ndata: {"name":"query_entities","endpoint":"ovzdusie-verejne","status":"done"}',
  'event: script\ndata: {"code":"return data.length;","output":"4"}',
  // T-3325: Markdown, a marker no citation stands behind, two citations of one page, and live data.
  'event: answer\ndata: {"text":"**Štyri stanice** merajú ovzdušie [1, 3]:\\n- Námestie SNP [2]\\n- Stanica [9]\\n\\nNO2 je 21 [4]. <script>x</script>"}',
  'event: citations\ndata: [{"n":1,"url":"https://www.banskabystrica.sk/ovzdusie","title":"Ovzdušie v meste"},{"n":2,"url":"https://www.banskabystrica.sk/ovzdusie"},{"n":3,"url":"https://data.example.sk/dataset/ovzdusie"},{"n":4,"tool":"query_entities","endpoint":"ovzdusie-verejne","url":"https://data.example.sk/dataset/ovzdusie","title":"Kvalita ovzdušia"}]',
  'event: done\ndata: {"tokens":900}',
].join("\n\n") + "\n\n";

function renderAt(path: string, stub: Stub = {}) {
  const writes: { path: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const request = input as Request;
    const url = new URL(request.url);
    const json = (body: unknown, code = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: code,
          headers: { "Content-Type": code >= 400 ? "application/problem+json" : "application/json" },
        }),
      );
    const base = "/api/v1/projects/banskabystrica/knowledge";
    if (url.pathname.endsWith("/auth/me")) return json(IDENTITY);
    if (url.pathname.endsWith("/branding")) return json({ instanceName: "joinedcontext", domain: "dev.example", languages: { default: "en", offered: ["en"] } });
    if (url.pathname.endsWith("/permissions/me")) return json(grants(stub.verbs ?? ["read", "propose"]));
    if (request.method !== "GET") {
      writes.push({ path: url.pathname, body: request.body ? await request.json() : null });
      if (url.pathname.endsWith("/chat")) {
        const chat = stub.chat ?? { code: 200, body: ANSWER };
        return new Response(chat.body, {
          status: chat.code,
          headers: { "Content-Type": chat.code >= 400 ? "application/problem+json" : "text/event-stream" },
        });
      }
      if (url.pathname.endsWith("/recrawl")) return json({ job: 7 }, 202);
      return json({ pages: 2, documents: 1, passagesRemoved: 30 });
    }
    if (url.pathname === `${base}/sources`) return json(stub.sources?.body ?? SOURCES, stub.sources?.code ?? 200);
    if (url.pathname === `${base}/sources/bb-web/pages`) {
      if (url.searchParams.get("parent") === "1") {
        return json({ items: [page(2, "https://www.banskabystrica.sk/odpad", { depth: 1, parentId: 1, excludedBy: "administrator", included: false })] });
      }
      return json({ items: [page(1, "https://www.banskabystrica.sk/", { children: 1, documents: 1 })] });
    }
    if (url.pathname === `${base}/sources/bb-web/documents`) {
      return json({ items: [{ id: 9, url: "https://www.banskabystrica.sk/vzn.pdf", pageId: 1, mime: "application/pdf", bytes: 1_250_000, pages: 12, offDomain: true, status: "fetched", included: true, excludedBy: null, passages: 40 }] });
    }
    if (url.pathname === `${base}/sources/bb-web/passages`) return json({ items: [{ ordinal: 0, text: "Odpad vyvážame v utorok.", lang: "sk", url: "u" }] });
    if (url.pathname === `${base}/sources/bb-web/pages/1/links`) return json({ items: [{ url: "https://www.banskabystrica.sk/vzn.pdf", kind: "document" }] });
    if (url.pathname === `${base}/deployments/obcania/usage`) return json({ items: [{ day: "2026-10-06", requests: 12, tokensIn: 34000, tokensOut: 2100 }] });
    if (url.pathname === "/api/v1/projects/banskabystrica/assistantdeployments") {
      return json({
        apiVersion: "joinedcontext.com/v1alpha1",
        kind: "List",
        items: [{ apiVersion: "joinedcontext.com/v1alpha1", kind: "AssistantDeployment", metadata: { name: "obcania", namespace: "banskabystrica" }, spec: { publicId: "bb-obcania", channel: "public", sources: ["bb-web"], connectors: [{ endpoint: "ovzdusie-verejne", tools: ["query_entities"] }] } }],
      });
    }
    return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  window.history.pushState({}, "", path);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { writes };
}

describe("the knowledge sources page (T-3057)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists every declared source with what the assistant holds, one not crawled and one failed in words", async () => {
    renderAt("/projects/banskabystrica/knowledge");
    const table = await screen.findByRole("table", { name: "Knowledge sources" });
    const web = within(table).getByRole("link", { name: "bb-web" }).closest("tr") as HTMLElement;
    expect(within(web).getByText("110 of 120")).toBeInTheDocument();
    expect(within(web).getByText("900 (850 searchable)")).toBeInTheDocument();
    expect(within(web).getByText("Crawled")).toBeInTheDocument();
    const data = within(table).getByText("bb-data").closest("tr") as HTMLElement;
    expect(within(data).getByText("Not crawled yet")).toBeInTheDocument();
    expect(within(data).getByText("Data catalogue")).toBeInTheDocument();
    expect(within(data).queryByRole("link", { name: "bb-data" })).toBeNull();
    // AG-116: the project's own catalogue, of every space when it names none.
    const catalogue = within(table).getByText("bb-catalogue").closest("tr") as HTMLElement;
    expect(within(catalogue).getByText("Context spaces' catalogue")).toBeInTheDocument();
    expect(within(catalogue).getByText("every space of the project")).toBeInTheDocument();
    const old = within(table).getByRole("link", { name: "bb-old" }).closest("tr") as HTMLElement;
    expect(within(old).getByText("Last crawl failed")).toBeInTheDocument();
    expect(within(old).getByText("https://old.banskabystrica.sk/ answered 503")).toBeInTheDocument();
  });

  it("queues a crawl now and says so", async () => {
    const { writes } = renderAt("/projects/banskabystrica/knowledge");
    await userEvent.click(await screen.findByRole("button", { name: "Crawl bb-web now" }));
    expect(await screen.findByText("A crawl of bb-web is queued. It starts within a minute.")).toBeInTheDocument();
    expect(writes.map((w) => w.path)).toEqual(["/api/v1/projects/banskabystrica/knowledge/sources/bb-web/recrawl"]);
    vi.restoreAllMocks();
  });

  it("a viewer's crawl button says why it is disabled", async () => {
    const { writes } = renderAt("/projects/banskabystrica/knowledge", { verbs: ["read"] });
    const button = await screen.findByRole("button", { name: "Crawl bb-web now" });
    await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"));
    await userEvent.click(button);
    expect(writes).toEqual([]);
  });

  it("lists the assistants with their channel, sources and connectors, and shows one's usage per day", async () => {
    renderAt("/projects/banskabystrica/knowledge");
    const table = await screen.findByRole("table", { name: "Assistants" });
    const row = within(table).getByRole("link", { name: "obcania" }).closest("tr") as HTMLElement;
    expect(within(row).getByText("bb-obcania")).toBeInTheDocument();
    expect(within(row).getByText("Public")).toBeInTheDocument();
    expect(within(row).getByText("ovzdusie-verejne")).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Usage of obcania" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("34,000")).toBeInTheDocument();
    expect(within(dialog).getByText("12")).toBeInTheDocument();
  });

  it("opens the source form from Add a source", async () => {
    renderAt("/projects/banskabystrica/knowledge");
    await userEvent.click(await screen.findByRole("button", { name: "Add a source" }));
    await waitFor(() => expect(window.location.pathname).toBe("/projects/banskabystrica/knowledgesources/new"));
  });

  it("says the sources could not be read instead of claiming there are none", async () => {
    renderAt("/projects/banskabystrica/knowledge", {
      sources: { code: 503, body: { status: 503, title: "Service Unavailable", detail: "the knowledge assistant did not answer; try again shortly" } },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("The sources could not be read: the knowledge assistant did not answer; try again shortly");
    expect(screen.queryByText("This project has no knowledge source")).toBeNull();
  });
});

describe("one source's pages and documents (T-3057, AG-113)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the tree a level at a time and shows who left a page out", async () => {
    renderAt("/projects/banskabystrica/knowledge/bb-web");
    const expand = await screen.findByRole("button", { name: "Show the 1 pages below https://www.banskabystrica.sk/" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(expand);
    expect(await screen.findByText("Excluded by an administrator")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide the 1 pages below https://www.banskabystrica.sk/" })).toHaveAttribute("aria-expanded", "true");
  });

  it("excludes a selected branch with its documents and says what was removed", async () => {
    const { writes } = renderAt("/projects/banskabystrica/knowledge/bb-web");
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select https://www.banskabystrica.sk/" }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Leave out of answers" }));
    expect(await screen.findByText("Left out: 2 pages and 1 documents; 30 passages removed.")).toBeInTheDocument();
    expect(writes).toEqual([
      {
        path: "/api/v1/projects/banskabystrica/knowledge/sources/bb-web/inclusion",
        body: { pages: [1], documents: [], subtree: true, included: false },
      },
    ]);
    expect(screen.getByText("Nothing selected")).toBeInTheDocument();
  });

  it("refuses to send an empty selection and says why", async () => {
    const { writes } = renderAt("/projects/banskabystrica/knowledge/bb-web");
    const exclude = await screen.findByRole("button", { name: "Leave out of answers" });
    expect(exclude).toHaveAttribute("aria-disabled", "true");
    expect(exclude).toHaveAccessibleDescription("Select pages or documents first.");
    await userEvent.click(exclude);
    expect(writes).toEqual([]);
  });

  it("lists the documents with their size and another site's flag, and previews passages and links", async () => {
    renderAt("/projects/banskabystrica/knowledge/bb-web");
    await userEvent.click(await screen.findByRole("tab", { name: "Documents" }));
    const table = await screen.findByRole("table", { name: "Documents" });
    expect(within(table).getByText("1.3 MB")).toBeInTheDocument();
    expect(within(table).getByText("On another site")).toBeInTheDocument();
    await userEvent.click(within(table).getByRole("button", { name: "Passages of https://www.banskabystrica.sk/vzn.pdf" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Odpad vyvážame v utorok.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    await userEvent.click(screen.getByRole("tab", { name: "Pages" }));
    await userEvent.click(await screen.findByRole("button", { name: "Links of https://www.banskabystrica.sk/" }));
    expect(await within(await screen.findByRole("dialog")).findByText("Document")).toBeInTheDocument();
  });
});

describe("asking an assistant in the Portal (T-3058, AG-115)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("streams the answer with its sources and script, and sends the conversation back with the connectors switched", async () => {
    const { writes } = renderAt("/projects/banskabystrica/knowledge");
    const table = await screen.findByRole("table", { name: "Assistants" });
    await userEvent.click(within(table).getByRole("button", { name: "Ask obcania" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask obcania" });
    expect(within(dialog).getByText(/exactly as it answers a visitor/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Your question" }), "Kde sú stanice?{Enter}");
    // The answer formatted: bold, a list, markers as links to the sources, an unknown one dropped,
    // a script tag as text (T-3325, AG-117).
    const answer = await within(dialog).findByTestId("assistant-answer");
    expect(within(answer).getByText("Štyri stanice").tagName).toBe("STRONG");
    expect(within(answer).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Námestie SNP 1", "Stanica "]);
    expect(within(answer).getAllByRole("link", { name: /^Source / }).map((link) => link.getAttribute("href")?.replace(/^#.*-/, "#"))).toEqual(["#1", "#2", "#1", "#2"]);
    expect(answer).toHaveTextContent("NO2 je 21 2. <script>x</script>");
    expect(answer.querySelector("script")).toBeNull();
    expect(answer).not.toHaveTextContent("[9]");
    // One source per address, by its title, live data in words and never by its tool.
    const sources = within(dialog).getByRole("list", { name: "Sources" });
    const listed = within(sources).getAllByRole("listitem");
    expect(listed).toHaveLength(2);
    expect(within(listed[0]).getByRole("link", { name: /Ovzdušie v meste/ })).toHaveAttribute("href", "https://www.banskabystrica.sk/ovzdusie");
    expect(listed[0]).toHaveTextContent("banskabystrica.sk");
    expect(within(listed[1]).getByRole("link", { name: /Kvalita ovzdušia/ })).toHaveAttribute("href", "https://data.example.sk/dataset/ovzdusie");
    expect(sources).not.toHaveTextContent("query_entities");
    const target = within(answer).getAllByRole("link", { name: "Source 2" })[0].getAttribute("href")?.slice(1) ?? "";
    expect(document.getElementById(target)).toBe(listed[1]);
    expect(within(dialog).getByText("Script the assistant ran")).toBeInTheDocument();
    expect(writes).toEqual([
      {
        path: "/api/v1/projects/banskabystrica/knowledge/deployments/obcania/chat",
        body: { message: "Kde sú stanice?", history: [], connectors: ["ovzdusie-verejne"] },
      },
    ]);

    await userEvent.click(within(dialog).getByRole("checkbox", { name: "ovzdusie-verejne" }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Your question" }), "A dnes?{Enter}");
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].body).toEqual({
      conversation: "6f1c0e9e-3b1a-4d7e-9b51-2c4f8f2a7c11",
      message: "A dnes?",
      history: [
        { role: "user", text: "Kde sú stanice?" },
        { role: "assistant", text: "**Štyri stanice** merajú ovzdušie [1, 3]:\n- Námestie SNP [2]\n- Stanica [9]\n\nNO2 je 21 [4]. <script>x</script>" },
      ],
      connectors: [],
    });
  });

  it("says a refusal in the Portal's words and keeps the question box usable", async () => {
    renderAt("/projects/banskabystrica/knowledge", {
      chat: {
        code: 409,
        body: JSON.stringify({ status: 409, title: "Conflict", detail: "This assistant has no budget yet: an administrator sets budget.tokensPerDay on it before anyone can ask." }),
      },
    });
    const table = await screen.findByRole("table", { name: "Assistants" });
    await userEvent.click(within(table).getByRole("button", { name: "Ask obcania" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask obcania" });
    const box = within(dialog).getByRole("textbox", { name: "Your question" });
    await userEvent.type(box, "Ahoj{Enter}");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("an administrator sets budget.tokensPerDay");
    expect(within(dialog).getByRole("button", { name: "Send" })).toBeDisabled();
    await userEvent.type(box, "Znova");
    expect(within(dialog).getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("gives the frame to paste for a public assistant", async () => {
    renderAt("/projects/banskabystrica/knowledge");
    const table = await screen.findByRole("table", { name: "Assistants" });
    await userEvent.click(within(table).getByRole("button", { name: "Embed obcania" }));
    const dialog = await screen.findByRole("dialog", { name: "Embed obcania" });
    expect(within(dialog).getByText(/https:\/\/assistant\.dev\.example\/d\/bb-obcania\/widget/)).toBeInTheDocument();
    expect(within(dialog).getByText(/allowed origins/)).toBeInTheDocument();
  });
});

describe("the chat's stream and snippet", () => {
  it("reads whole events, keeps a part still arriving, and skips a broken one", () => {
    const first = readEvents('event: conversation\r\ndata: {"id":"c1"}\r\n\r\nevent: answer\ndata: {"te');
    expect(first.events).toEqual([{ name: "conversation", id: "c1" }]);
    const second = readEvents(`${first.rest}xt":"Hello"}\n\nevent: tool\ndata: not json\n\nevent: done\ndata: {"tokens":3}\n\n`);
    expect(second.events).toEqual([
      { name: "answer", text: "Hello" },
      { name: "done", tokens: 3 },
    ]);
    expect(second.rest).toBe("");
  });

  it("keeps only http links among the citations and ignores an unknown event", () => {
    const { events } = readEvents(
      'event: citations\ndata: [{"n":1,"url":"javascript:alert(1)"},{"n":2,"url":"https://a.example/"},{"x":3}]\n\nevent: surprise\ndata: {}\n\n',
    );
    expect(events).toEqual([
      {
        name: "citations",
        citations: [
          { n: 1, url: undefined, tool: undefined, endpoint: undefined },
          { n: 2, url: "https://a.example/", tool: undefined, endpoint: undefined },
        ],
      },
    ]);
  });

  it("writes no address when the Portal does not know its domain", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <EmbedSnippet publicId="bb-obcania" title="obcania" />
      </I18nextProvider>,
    );
    expect(screen.getByText(/does not know its domain/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("writes the frame with its title escaped", () => {
    expect(embedSnippet("dev.example", "bb-obcania", 'A "quoted" <title> & more')).toBe(
      '<iframe src="https://assistant.dev.example/d/bb-obcania/widget" title="A &quot;quoted&quot; &lt;title> &amp; more" width="400" height="600" loading="lazy"></iframe>',
    );
  });
});

describe("the knowledge forms (T-3057)", () => {
  it("proposes what the form says and drops what it left empty, keeping the stored metadata", () => {
    const manifest = toKindManifest(
      "AssistantDeployment",
      "banskabystrica",
      { name: "obcania", publicId: "bb-obcania", channel: "internal", systemPrompt: "  ", sources: [], connectors: [{ endpoint: "a", tools: ["query_entities"] }], theme: { greeting: "" } },
      { metadata: { name: "obcania", labels: { team: "web" } } },
    );
    expect(manifest).toEqual({
      apiVersion: "joinedcontext.com/v1alpha1",
      kind: "AssistantDeployment",
      metadata: { name: "obcania", namespace: "banskabystrica", labels: { team: "web" } },
      spec: { publicId: "bb-obcania", channel: "internal", connectors: [{ endpoint: "a", tools: ["query_entities"] }] },
    });
    expect(fromKindManifest({ metadata: { name: "web" }, spec: { source: "website", startUrls: ["https://a.example/"] } })).toEqual({
      name: "web",
      source: "website",
      startUrls: ["https://a.example/"],
    });
    expect(fromKindManifest(null)).toEqual({ name: "" });
  });

  it("holds each schema to jc-core's bounds", () => {
    const t = (key: string) => key;
    const source = knowledgeSourceSchema(t, ["open-data"]);
    expect(source.properties?.maxPages).toMatchObject({ minimum: 1, maximum: 50_000 });
    expect(source.properties?.ckanInstanceRef).toMatchObject({ enum: ["open-data"] });
    const deployment = assistantDeploymentSchema(t, [], ["air-public"]);
    const origins = new RegExp(String((deployment.properties?.allowedOrigins as { items: { pattern: string } }).items.pattern));
    expect(origins.test("https://www.example.org")).toBe(true);
    expect(origins.test("https://www.example.org/path")).toBe(false);
    expect(origins.test("http://www.example.org")).toBe(false);
    expect(origins.test("https://*.example.org")).toBe(false);
  });
});

describe("the knowledge helpers", () => {
  it("says who left an item out, and that an included one is included", async () => {
    await i18n.changeLanguage("en");
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <InclusionBadge included={false} excludedBy="pattern" />
      </I18nextProvider>,
    );
    expect(screen.getByText("Excluded by the source's patterns")).toBeInTheDocument();
    rerender(
      <I18nextProvider i18n={i18n}>
        <InclusionBadge included excludedBy={null} />
      </I18nextProvider>,
    );
    expect(screen.getByText("Included")).toBeInTheDocument();
  });

  it("reads the reason of a refusal, and falls back to the generic sentence", () => {
    expect(reasonOf(new Error("x"), "generic")).toBe("generic");
    const refused = new ApiError(409, "Conflict", { type: "about:blank", status: 409, title: "Conflict", detail: "already queued" });
    expect(reasonOf(refused, "generic")).toBe("already queued");
  });

  it("formats sizes and times in the person's locale, a dash for none", () => {
    expect(bytesText(1_250_000, "en")).toBe("1.3 MB");
    expect(bytesText(340_000, "en")).toBe("340 kB");
    expect(bytesText(null, "en")).toBe("—");
    expect(timeText(null, "en")).toBe("—");
    expect(timeText("not a time", "en")).toBe("—");
    expect(timeText("2026-10-06T03:00:00Z", "en")).toMatch(/2026/);
  });
});
