// The knowledge assistant's administration routes (API/01 §34, T-3057): what a project's
// sources hold once crawled. The answers are jc-assistant's; the shapes below are API/05 §3.
import { api, unwrap } from "../../api/client";

export interface SourceJob {
  state: "queued" | "running" | "done" | "failed";
  attempts: number;
  error: string | null;
}

export interface KnowledgeSourceRow {
  source: string;
  type: "website" | "ckan";
  state: "crawled" | "not-crawled";
  startUrls: string[];
  ckanInstanceRef: string | null;
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
