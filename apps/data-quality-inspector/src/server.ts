/**
 * The App's server on the shared WASM host, `/apps/{name}/api` (T-3354): every quality run it has
 * kept with its scores, a run now, and a URL for a run's full per-entity report in the App's own
 * storage. A test hands the page its own server (`ServerContext`).
 */
import { createContext, useContext, useMemo } from "react";

export interface RunType {
  type: string;
  entities: number;
  completeness: number;
  /** `null` for a type without a published schema. */
  valid: number | null;
  findings: number;
  freshness_median_seconds: number | null;
}

export interface Run {
  id: number;
  ran_at: string;
  types: RunType[];
  entities: number;
  findings: number;
  completeness: number;
  valid: number | null;
}

export interface Runs {
  runs: Run[];
  /** The data could not be read just now: no new run, these are the runs as kept. */
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
  runs(): Promise<Runs>;
  /** A run now; the server refuses one within ten minutes of the last. */
  runNow(): Promise<number>;
  /** A URL the run's full report can be downloaded from for two minutes. */
  reportUrl(id: number): Promise<string>;
}

/** Where the server answers: `/apps/{appName}/api`, or `/api` when the name is not an App's. */
export function apiBase(appName: string | undefined): string {
  return appName && /^[a-z0-9-]+$/.test(appName) ? `/apps/${appName}/api` : "/api";
}

async function call<T>(url: string, method = "GET"): Promise<T> {
  const answer = await fetch(url, { method, credentials: "same-origin", headers: { Accept: "application/json" } });
  if (!answer.ok) {
    const problem = (await answer.json().catch(() => ({}))) as { detail?: unknown };
    throw new Problem(answer.status, typeof problem.detail === "string" ? problem.detail : `HTTP ${answer.status}`);
  }
  return (await answer.json()) as T;
}

export function server(base: string): Server {
  return {
    runs: () => call<Runs>(`${base}/runs`),
    runNow: async () => (await call<{ id: number }>(`${base}/runs`, "POST")).id,
    reportUrl: async (id) => (await call<{ url: string }>(`${base}/runs/${id}/report`)).url,
  };
}

/** The server the page talks to; `null` takes the App's own, from its name. */
export const ServerContext = createContext<Server | null>(null);

export function useServer(appName: string | undefined): Server {
  const given = useContext(ServerContext);
  return useMemo(() => given ?? server(apiBase(appName)), [given, appName]);
}
