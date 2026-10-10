/**
 * The App's server on the shared WASM host, `/apps/{name}/api` (T-3352): the topics of every
 * week it has kept, and a URL for each week's articles as a file in the App's own storage. A
 * test hands the page its own server (`ServerContext`).
 */
import { createContext, useContext, useMemo } from "react";

export interface KeptKeyword {
  term: string;
  weight: number;
}

export interface KeptTopic {
  topic: number;
  share: number;
  articles: number;
  keywords: KeptKeyword[];
}

export interface KeptWeek {
  /** The ISO week, `2026-W41`. */
  week: string;
  articles: number;
  computed_at: string;
  topics: KeptTopic[];
}

export interface Kept {
  weeks: KeptWeek[];
  /** The feed could not be read just now: these are the weeks as last kept. */
  stale: boolean;
}

/** An answer of the server that is not a success, its `detail` as the message. */
export class Problem extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(detail);
  }
}

export interface Server {
  weeks(): Promise<Kept>;
  /** A URL the week's articles can be downloaded from for two minutes. */
  corpusUrl(week: string): Promise<string>;
}

/** Where the server answers: `/apps/{appName}/api`, or `/api` when the name is not an App's. */
export function apiBase(appName: string | undefined): string {
  return appName && /^[a-z0-9-]+$/.test(appName) ? `/apps/${appName}/api` : "/api";
}

async function get<T>(url: string): Promise<T> {
  const answer = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } });
  if (!answer.ok) {
    const problem = (await answer.json().catch(() => ({}))) as { detail?: unknown };
    throw new Problem(answer.status, typeof problem.detail === "string" ? problem.detail : `HTTP ${answer.status}`);
  }
  return (await answer.json()) as T;
}

export function server(base: string): Server {
  return {
    weeks: () => get<Kept>(`${base}/weeks`),
    corpusUrl: async (week) => (await get<{ url: string }>(`${base}/weeks/${encodeURIComponent(week)}/corpus`)).url,
  };
}

/** The server the page talks to; `null` takes the App's own, from its name. */
export const ServerContext = createContext<Server | null>(null);

export function useServer(appName: string | undefined): Server {
  const given = useContext(ServerContext);
  return useMemo(() => given ?? server(apiBase(appName)), [given, appName]);
}
