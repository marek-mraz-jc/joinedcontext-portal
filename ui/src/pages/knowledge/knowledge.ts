// The knowledge assistant's administration routes (API/01 §34, T-3057): what a project's
// sources hold once crawled. The answers are jc-assistant's; the shapes below are API/05 §3.
import { api, ApiError, readCsrfToken, unwrap } from "../../api/client";
import type { ProblemDetails } from "../../api/client";

export interface SourceJob {
  state: "queued" | "running" | "done" | "failed";
  attempts: number;
  error: string | null;
}

export interface KnowledgeSourceRow {
  source: string;
  type: "website" | "ckan" | "catalogue" | "guide";
  state: "crawled" | "not-crawled";
  startUrls: string[];
  ckanInstanceRef: string | null;
  /** The spaces a `catalogue` source reads; empty is every space of the project (AG-116). */
  contextSpaces?: string[];
  schedule: string | null;
  visibility: "public" | "internal";
  lastCrawl?: string | null;
  pages?: number;
  pagesIncluded?: number;
  documents?: number;
  passages?: number;
  embedded?: number;
  job?: SourceJob | null;
}

export interface PageRow {
  id: number;
  url: string;
  depth: number;
  parentId: number | null;
  status: "pending" | "fetched" | "failed" | "skipped";
  included: boolean;
  excludedBy: "pattern" | "administrator" | null;
  language: string | null;
  fetchedAt: string | null;
  children: number;
  documents: number;
  passages: number;
}

export interface DocumentRow {
  id: number;
  url: string;
  pageId: number | null;
  mime: string | null;
  bytes: number | null;
  pages: number | null;
  offDomain: boolean;
  status: PageRow["status"];
  included: boolean;
  excludedBy: PageRow["excludedBy"];
  passages: number;
}

export interface Passage {
  ordinal: number;
  text: string;
  lang: string | null;
  url: string;
}

export interface LinkRow {
  url: string;
  kind: "page" | "document" | "external";
}

export interface InclusionChange {
  pages: number[];
  documents: number[];
  subtree: boolean;
  included: boolean;
}

export interface InclusionCounts {
  pages: number;
  documents: number;
  passagesRemoved: number;
}

interface Items<T> {
  items: T[];
}

/** The `items` of an answer whose schema the Portal declares as an open object. */
function items<T>(answer: unknown): T[] {
  const list = (answer as Partial<Items<T>> | null)?.items;
  return Array.isArray(list) ? list : [];
}

export const knowledgeKeys = {
  sources: (project: string) => ["projects", project, "knowledge", "sources"] as const,
  pages: (project: string, source: string, parent: number | null) =>
    ["projects", project, "knowledge", "sources", source, "pages", parent] as const,
  documents: (project: string, source: string) => ["projects", project, "knowledge", "sources", source, "documents"] as const,
  passages: (project: string, source: string, owner: { page?: number; document?: number }) =>
    ["projects", project, "knowledge", "sources", source, "passages", owner.page ?? null, owner.document ?? null] as const,
  links: (project: string, source: string, page: number) =>
    ["projects", project, "knowledge", "sources", source, "links", page] as const,
};

export async function listSources(project: string): Promise<KnowledgeSourceRow[]> {
  return items<KnowledgeSourceRow>(
    await unwrap(await api.GET("/api/v1/projects/{project}/knowledge/sources", { params: { path: { project } } })),
  );
}

export async function listPages(project: string, source: string, parent: number | null): Promise<PageRow[]> {
  return items<PageRow>(
    await unwrap(
      await api.GET("/api/v1/projects/{project}/knowledge/sources/{source}/pages", {
        params: { path: { project, source }, query: parent === null ? {} : { parent } },
      }),
    ),
  );
}

export async function listDocuments(project: string, source: string): Promise<DocumentRow[]> {
  return items<DocumentRow>(
    await unwrap(
      await api.GET("/api/v1/projects/{project}/knowledge/sources/{source}/documents", {
        params: { path: { project, source } },
      }),
    ),
  );
}

export async function listPassages(
  project: string,
  source: string,
  owner: { page?: number; document?: number },
): Promise<Passage[]> {
  return items<Passage>(
    await unwrap(
      await api.GET("/api/v1/projects/{project}/knowledge/sources/{source}/passages", {
        params: { path: { project, source }, query: owner },
      }),
    ),
  );
}

export async function listLinks(project: string, source: string, page: number): Promise<LinkRow[]> {
  return items<LinkRow>(
    await unwrap(
      await api.GET("/api/v1/projects/{project}/knowledge/sources/{source}/pages/{page}/links", {
        params: { path: { project, source, page } },
      }),
    ),
  );
}

export async function setInclusion(project: string, source: string, change: InclusionChange): Promise<InclusionCounts> {
  const answer = await unwrap(
    await api.POST("/api/v1/projects/{project}/knowledge/sources/{source}/inclusion", {
      params: { path: { project, source } },
      body: change,
    }),
  );
  const counts = answer as Partial<InclusionCounts> | null;
  return { pages: counts?.pages ?? 0, documents: counts?.documents ?? 0, passagesRemoved: counts?.passagesRemoved ?? 0 };
}

export async function recrawl(project: string, source: string): Promise<void> {
  await unwrap(
    await api.POST("/api/v1/projects/{project}/knowledge/sources/{source}/recrawl", {
      params: { path: { project, source } },
    }),
  );
}

export interface UsageDay {
  day: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
}

export async function listUsage(project: string, deployment: string): Promise<UsageDay[]> {
  return items<UsageDay>(
    await unwrap(
      await api.GET("/api/v1/projects/{project}/knowledge/deployments/{deployment}/usage", {
        params: { path: { project, deployment } },
      }),
    ),
  );
}

/** A byte count in the person's units: 1.2 MB, 340 kB. */
export function bytesText(bytes: number | null | undefined, language: string): string {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return new Intl.NumberFormat(language, {
    style: "unit",
    unit: units[unit],
    unitDisplay: "short",
    maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0,
  }).format(value);
}

/** A time the assistant reported, in the person's locale; a dash when there is none. */
export function timeText(iso: string | null | undefined, language: string): string {
  if (!iso) return "—";
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? "—"
    : new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(at);
}

/** One turn of a chat, as API/05 §1.1 sends it back. */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface Citation {
  n: number;
  url?: string;
  tool?: string;
  endpoint?: string;
  /** The cited page's title, which the person reads instead of its address (AG-117). */
  title?: string;
}

/** The events of API/05 §1.3, as the chat panel reads them. */
export type ChatEvent =
  | { name: "conversation"; id: string }
  | { name: "tool"; tool: string; endpoint?: string; status: "started" | "done" | "failed" }
  | { name: "script"; code: string; output?: string; error?: string }
  | { name: "answer"; text: string }
  | { name: "citations"; citations: Citation[] }
  | { name: "error"; detail: string }
  | { name: "done"; tokens: number };

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One event block's name and data as a `ChatEvent`; `null` for one this panel does not show. */
function chatEvent(name: string, data: unknown): ChatEvent | null {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (name) {
    case "conversation":
      return { name, id: text(d.id) };
    case "tool": {
      const status = d.status === "done" || d.status === "failed" ? d.status : "started";
      return { name, tool: text(d.name), endpoint: typeof d.endpoint === "string" ? d.endpoint : undefined, status };
    }
    case "script":
      return {
        name,
        code: text(d.code),
        output: typeof d.output === "string" ? d.output : undefined,
        error: typeof d.error === "string" ? d.error : undefined,
      };
    case "answer":
      return { name, text: text(d.text) };
    case "citations":
      return {
        name,
        citations: (Array.isArray(data) ? data : [])
          .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null && typeof c.n === "number")
          .map((c) => ({
            n: c.n as number,
            url: typeof c.url === "string" && /^https?:\/\//.test(c.url) ? c.url : undefined,
            tool: typeof c.tool === "string" ? c.tool : undefined,
            endpoint: typeof c.endpoint === "string" ? c.endpoint : undefined,
            title: typeof c.title === "string" ? c.title : undefined,
          })),
      };
    case "error":
      return { name, detail: text(d.detail) };
    case "done":
      return { name, tokens: typeof d.tokens === "number" ? d.tokens : 0 };
    default:
      return null;
  }
}

/**
 * The complete Server-Sent Events in `buffer`, and what is left of an event still arriving. A
 * block whose data is not JSON is skipped: the stream goes on.
 */
export function readEvents(buffer: string): { events: ChatEvent[]; rest: string } {
  const events: ChatEvent[] = [];
  const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let name = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!name) continue;
    try {
      const event = chatEvent(name, JSON.parse(data));
      if (event) events.push(event);
    } catch {
      // A malformed block is skipped; the next one may be whole.
    }
  }
  return { events, rest };
}

export interface ChatQuestion {
  conversation?: string;
  message: string;
  history: ChatTurn[];
  connectors?: string[];
}

/**
 * Asks `deployment` as the signed-in person (API/01 §34, AG-115) and hands each event to
 * `onEvent` as it arrives. A refusal before the stream starts throws an `ApiError` with the
 * Portal's sentence.
 */
export async function askAssistant(
  project: string,
  deployment: string,
  question: ChatQuestion,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
  const csrf = readCsrfToken();
  if (csrf) headers["x-csrf-token"] = csrf;
  const response = await globalThis.fetch(
    new Request(
      `${window.location.origin}/api/v1/projects/${encodeURIComponent(project)}/knowledge/deployments/${encodeURIComponent(deployment)}/chat`,
      { method: "POST", credentials: "same-origin", headers, body: JSON.stringify(question), signal },
    ),
  );
  if (!response.ok || !response.body) {
    const problem = (await response.json().catch(() => null)) as ProblemDetails | null;
    const detail = typeof problem?.detail === "string" ? problem.detail : `HTTP ${response.status}`;
    throw new ApiError(response.status, detail, problem ?? undefined, response.headers.get("x-request-id") ?? undefined);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const { events, rest } = readEvents(buffer);
    buffer = rest;
    events.forEach(onEvent);
  }
  readEvents(`${buffer}${decoder.decode()}\n\n`).events.forEach(onEvent);
}

/** The iframe a site pastes to place a public assistant (API/05 §1.6). */
export function embedSnippet(domain: string, publicId: string, title: string): string {
  const escapedTitle = title.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<iframe src="https://assistant.${domain}/d/${publicId}/widget" title="${escapedTitle}" width="400" height="600" loading="lazy"></iframe>`;
}
