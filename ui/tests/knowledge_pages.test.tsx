// covers (T-2137, the module gate in gate_modules.test.ts): the cases in this file drive
// src/pages/knowledge/KnowledgePage.tsx, src/pages/knowledge/SourcePage.tsx,
// src/pages/knowledge/AssistantChat.tsx, src/pages/knowledge/UploadedFiles.tsx,
// src/pages/knowledge/IndexStatus.tsx and
// src/pages/knowledge/knowledge.ts through the pages
// they belong to; each was confirmed by
// making the module throw and watching this file go red.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { App } from "../src/App";
import { bytesText, dataChart, embedSnippet, readEvents, timeText } from "../src/pages/knowledge/knowledge";
import { reasonOf } from "../src/pages/knowledge/KnowledgePage";
import { InclusionBadge } from "../src/pages/knowledge/SourcePage";
import { UploadedFiles } from "../src/pages/knowledge/UploadedFiles";
import { sum } from "../src/pages/knowledge/IndexStatus";
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
      pending: 50,
      failed: 0,
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
      source: "bb-guide",
      type: "guide",
      state: "not-crawled",
      startUrls: [],
      ckanInstanceRef: null,
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
      pending: 0,
      failed: 2,
      job: {
        state: "failed",
        attempts: 3,
        error: "https://old.banskabystrica.sk/ answered 503",
        startedAt: "2026-10-05T03:00:00Z",
        finishedAt: "2026-10-05T03:04:00Z",
      },
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
  upload?: { code: number; body: unknown };
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
    if (url.pathname === `${base}/sources/bb-files/files` && request.method === "POST") {
      writes.push({ path: `${url.pathname}${url.search}`, body: await request.text() });
      const upload = stub.upload ?? { code: 201, body: { id: 8, name: "ziadosti.csv", mime: "text/csv", bytes: 8, passages: 3, status: "fetched" } };
      return json(upload.body, upload.code);
    }
    if (url.pathname === `${base}/sources/bb-files/files`) {
      return json({ items: [{ id: 7, name: "rozpocet-2026.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: 48_000, passages: 12, status: "fetched" }] });
    }
    if (request.method === "DELETE") {
      writes.push({ path: url.pathname, body: null });
      return new Response(null, { status: 204 });
    }
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
    if (url.pathname === `${base}/sources/bb-old/errors`) {
      writes.push({ path: url.pathname, body: null });
      return json({ items: [
        { url: "https://old.banskabystrica.sk/gone", kind: "page", reason: "HTTP 404" },
        { url: "https://old.banskabystrica.sk/vzn.pdf", kind: "document", reason: "connection refused" },
      ] });
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
        items: [{ apiVersion: "joinedcontext.com/v1alpha1", kind: "AssistantDeployment", metadata: { name: "obcania", namespace: "banskabystrica" }, spec: { publicId: "bb-obcania", channel: "public", languages: ["sk"], sources: ["bb-web"], connectors: [{ endpoint: "ovzdusie-verejne", tools: ["query_entities"] }] } }],
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
    // AG-118: the platform's User Guide.
    const guide = within(table).getByText("bb-guide").closest("tr") as HTMLElement;
    expect(within(guide).getByText("User Guide")).toBeInTheDocument();
    expect(within(guide).getByText("the platform's User Guide, with links into this project")).toBeInTheDocument();
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

describe("a source's index status (T-4197)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds nothing for a source not crawled yet", () => {
    const rows = SOURCES.items as unknown as Parameters<typeof sum>[0];
    expect([sum(rows, "pending"), sum(rows, "failed"), sum([], "pages")]).toEqual([50, 2, 0]);
  });

  it("sums every source above the list", async () => {
    renderAt("/projects/banskabystrica/knowledge");
    expect(
      await screen.findByText("All sources: 123 pages, 14 files, 860 of 910 passages searchable, 50 waiting, 2 not read"),
    ).toBeInTheDocument();
  });

  it("counts what waits, and re-indexes without reading errors there are none of", async () => {
    const { writes } = renderAt("/projects/banskabystrica/knowledge/bb-web");
    const status = await screen.findByRole("region", { name: "Index status" });
    expect(within(status).getByText("Waiting to index").nextSibling).toHaveTextContent("50");
    expect(within(status).getByText("Searchable").nextSibling).toHaveTextContent("850");
    await userEvent.click(within(status).getByRole("button", { name: "Re-index" }));
    expect(await within(status).findByText("A crawl of bb-web is queued. It starts within a minute.")).toBeInTheDocument();
    expect(writes.map((w) => w.path)).toEqual(["/api/v1/projects/banskabystrica/knowledge/sources/bb-web/recrawl"]);
  });

  it("holds the re-index while a run is going and says no run happened before the first", async () => {
    const running = { ...SOURCES.items[0], job: { state: "running", attempts: 1, error: null, startedAt: "2026-10-06T03:00:00Z", finishedAt: null } };
    renderAt("/projects/banskabystrica/knowledge/bb-web", { sources: { code: 200, body: { items: [running] } } });
    const status = await screen.findByRole("region", { name: "Index status" });
    expect(within(status).getByText("Crawling")).toBeInTheDocument();
    expect(within(status).getByText(/ended —/)).toBeInTheDocument();
    const button = within(status).getByRole("button", { name: "Re-index" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription("A crawl of this source is already queued or running.");
  });

  it("lists each failed read with why to a person who may steer the source", async () => {
    renderAt("/projects/banskabystrica/knowledge/bb-old");
    const errors = await screen.findByRole("list", { name: "Pages and files not read" });
    expect(within(errors).getByText("HTTP 404")).toBeInTheDocument();
    expect(within(errors).getByText("connection refused")).toBeInTheDocument();
    expect(within(errors).getByText("https://old.banskabystrica.sk/gone")).toBeInTheDocument();
  });

  it("shows a viewer the counts and never asks for the errors", async () => {
    const { writes } = renderAt("/projects/banskabystrica/knowledge/bb-old", { verbs: ["read"] });
    const status = await screen.findByRole("region", { name: "Index status" });
    expect(within(status).getByText("Not read").nextSibling).toHaveTextContent("2");
    await waitFor(() => expect(within(status).getByRole("button", { name: "Re-index" })).toHaveAttribute("aria-disabled", "true"));
    expect(screen.queryByRole("list", { name: "Pages and files not read" })).toBeNull();
    expect(writes).toEqual([]);
  });
});

describe("the files of an upload source (T-4185)", () => {
  const FILES = { items: [...SOURCES.items, { source: "bb-files", type: "upload", state: "not-crawled", startUrls: [], ckanInstanceRef: null, schedule: null, visibility: "public" }] };
  const base = "/api/v1/projects/banskabystrica/knowledge/sources/bb-files/files";
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens from the sources list before its first file, with no crawl to start", async () => {
    renderAt("/projects/banskabystrica/knowledge", { sources: { code: 200, body: FILES } });
    const table = await screen.findByRole("table", { name: "Knowledge sources" });
    expect(within(table).getByRole("link", { name: "bb-files" })).toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: "Crawl bb-files now" })).toBeNull();
  });

  it("lists the files, uploads the chosen ones as they are and removes one", async () => {
    const { writes } = renderAt("/projects/banskabystrica/knowledge/bb-files", { sources: { code: 200, body: FILES } });
    const table = await screen.findByRole("table", { name: "Files" });
    expect(within(table).getByText("rozpocet-2026.xlsx")).toBeInTheDocument();
    expect(within(table).getByText("48 kB")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Pages" })).toBeNull();

    await userEvent.upload(screen.getByLabelText("Choose files to upload"), new File(["a,b\n1,2\n"], "ziadosti.csv", { type: "text/csv" }));
    expect(await screen.findByText("1 file read into 3 passages.")).toBeInTheDocument();
    expect(writes).toEqual([{ path: `${base}?name=ziadosti.csv`, body: "a,b\n1,2\n" }]);

    await userEvent.click(within(table).getByRole("button", { name: "Remove rozpocet-2026.xlsx" }));
    await waitFor(() => expect(writes.at(-1)).toEqual({ path: `${base}/7`, body: null }));
  });

  it("names the file a refusal is about, in the Portal's words", async () => {
    const { writes } = renderAt("/projects/banskabystrica/knowledge/bb-files", {
      sources: { code: 200, body: FILES },
      upload: { code: 415, body: { status: 415, title: "Unsupported Media Type", detail: "this is not a PDF, a DOCX, an XLSX or UTF-8 text" } },
    });
    await userEvent.upload(await screen.findByLabelText("Choose files to upload"), new File(["\u0000\u0001"], "zoznam.csv", { type: "text/csv" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("zoznam.csv was not uploaded: this is not a PDF, a DOCX, an XLSX or UTF-8 text");
    expect(writes).toHaveLength(1);
  });

  it("says what to send when the source holds no file yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL((input as Request).url);
        const body = url.pathname.endsWith("/permissions/me") ? grants(["read", "propose"]) : { items: [] };
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nextProvider i18n={i18n}>
          <UploadedFiles project="banskabystrica" source="bb-files" />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("No file yet")).toBeInTheDocument();
    expect(screen.getByText("Upload a PDF, a spreadsheet or a text file for the assistant to answer from.")).toBeInTheDocument();
    expect(await screen.findByLabelText("Choose files to upload")).toBeInTheDocument();
  });

  it("a viewer's upload button says why it is disabled", async () => {
    renderAt("/projects/banskabystrica/knowledge/bb-files", { sources: { code: 200, body: FILES }, verbs: ["read"] });
    const button = await screen.findByRole("button", { name: "Upload files" });
    await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"));
    expect(screen.queryByLabelText("Choose files to upload")).toBeNull();
  });
});

describe("asking an assistant in the Portal (T-3058, AG-115)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a data round as a table with its chart and links, the chart hidden from a screen reader (T-4198)", async () => {
    const data = {
      endpoint: "ovzdusie-verejne",
      type: "AirQualityObserved",
      columns: ["dateObserved", "pm10"],
      rows: [["2026-10-15T10:00:00Z", 21], ["2026-10-15T09:00:00Z", 18]],
      dataset: "https://data.example.sk/dataset/ovzdusie",
      download: "javascript:alert(1)",
    };
    const body = `event: data\ndata: ${JSON.stringify(data)}\n\nevent: answer\ndata: {"text":"PM10 je 21."}\n\nevent: done\ndata: {"tokens":9}\n\n`;
    renderAt("/projects/banskabystrica/knowledge", { chat: { code: 200, body } });
    const table = await screen.findByRole("table", { name: "Assistants" });
    await userEvent.click(within(table).getByRole("button", { name: "Ask obcania" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask obcania" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Your question" }), "PM10?{Enter}");
    const rows = await within(dialog).findByRole("table", { name: "AirQualityObserved" });
    expect(within(rows).getByRole("cell", { name: "2026-10-15T10:00:00Z" })).toBeInTheDocument();
    const chart = within(dialog).getByTestId("assistant-chart");
    expect(chart).toHaveAttribute("aria-hidden", "true");
    expect(chart.querySelector("polyline")?.getAttribute("points")?.split(" ")).toHaveLength(2);
    expect(within(dialog).getByRole("link", { name: /Open the dataset/ })).toHaveAttribute("href", data.dataset);
    expect(within(dialog).queryByRole("link", { name: /Download the data/ })).toBeNull();
  });

  it("charts one number over time or per name, and nothing else (T-4198, the widget's rule)", () => {
    const table = (columns: string[], rows: unknown[][]) => ({ caption: "", columns, rows });
    expect(dataChart(table(["t", "pm10"], [["2026-10-15T10:00:00Z", 2], ["2026-10-15T09:00:00Z", 1]]))?.points.map((p) => p.value)).toEqual([1, 2]);
    expect(dataChart(table(["name", "pm10"], [["a", 2], ["b", 1]]))?.kind).toBe("bar");
    expect(dataChart(table(["name", "pm10", "pm25"], [["a", 1, 2], ["b", 3, 4]]))).toBeNull();
    expect(dataChart(table(["name", "street"], [["a", "x"], ["b", "y"]]))).toBeNull();
    expect(dataChart(table(["name", "v"], [["a", 1]]))).toBeNull();
    expect(dataChart(table(["name", "v"], Array.from({ length: 51 }, (_, i) => [`s${i}`, i])))?.points).toHaveLength(50);
    expect(dataChart(table(["name", "v"], [["a", 1], ["b", Number.NaN], ["c", "7"], ["d", 2]]))?.points.map((p) => p.label)).toEqual(["a", "d"]);
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
    // The question stays in the box to send again or reword (T-4160 #122).
    expect(box).toHaveValue("Ahoj");
    expect(within(dialog).getByRole("button", { name: "Send" })).not.toHaveAttribute("aria-disabled");
  });

  it("keeps the question when the model does not answer, lists the closest sources and asks again (T-4160 #122)", async () => {
    const failed = [
      'event: citations\ndata: [{"n":1,"url":"https://www.banskabystrica.sk/odpad","title":"Odvoz odpadu"}]',
      'event: error\ndata: {"status":503,"title":"Model Unavailable","detail":"Model asistenta neodpovedal. Skúste to o minútu znova."}',
      'event: done\ndata: {"tokens":0}',
    ].join("\n\n") + "\n\n";
    const { writes } = renderAt("/projects/banskabystrica/knowledge", { chat: { code: 200, body: failed } });
    const table = await screen.findByRole("table", { name: "Assistants" });
    await userEvent.click(within(table).getByRole("button", { name: "Ask obcania" }));
    const dialog = await screen.findByRole("dialog", { name: "Ask obcania" });
    const box = within(dialog).getByRole("textbox", { name: "Your question" });
    await userEvent.type(box, "Kedy vyvážajú odpad?{Enter}");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Model asistenta neodpovedal");
    expect(box).toHaveValue("Kedy vyvážajú odpad?");
    const closest = within(dialog).getByRole("list", { name: "The sources that match your question best" });
    expect(within(closest).getByRole("link", { name: /Odvoz odpadu/ })).toHaveAttribute("href", "https://www.banskabystrica.sk/odpad");
    await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    // A failed turn is not history the model is shown again.
    expect(writes[1].body).toMatchObject({ message: "Kedy vyvážajú odpad?", history: [] });
  });

  it("gives the frame to paste for a public assistant", async () => {
    renderAt("/projects/banskabystrica/knowledge");
    const table = await screen.findByRole("table", { name: "Assistants" });
    await userEvent.click(within(table).getByRole("button", { name: "Embed obcania" }));
    const dialog = await screen.findByRole("dialog", { name: "Embed obcania" });
    expect(within(dialog).getByText(/https:\/\/assistant\.dev\.example\/d\/bb-obcania\/widget/)).toBeInTheDocument();
    expect(within(dialog).getByText(/allowed origins/)).toBeInTheDocument();
  });

  it("gives the one launcher line, copies exactly it, and previews it in a sandboxed frame (T-4196)", async () => {
    renderAt("/projects/banskabystrica/knowledge");
    const writeText = vi.fn(async () => undefined);
    const table = await screen.findByRole("table", { name: "Assistants" });
    await userEvent.click(within(table).getByRole("button", { name: "Embed obcania" }));
    const dialog = await screen.findByRole("dialog", { name: "Embed obcania" });
    const line = '<script src="https://assistant.dev.example/d/bb-obcania/embed.js" data-lang="sk" defer></script>';
    expect(within(dialog).getByLabelText("The launcher line")).toHaveTextContent(line);
    // The line names the public deployment alone: no token, no key, no Portal address.
    expect(line).not.toMatch(/token|key|secret|bearer|\/api\//i);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Copy The launcher line" }));
    expect(writeText).toHaveBeenCalledWith(line);
    const preview = within(dialog).getByTitle("Preview of the launcher on a blank page");
    expect(preview).toHaveAttribute("sandbox", "allow-scripts");
    expect(preview.getAttribute("srcdoc")).toContain(line);
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
