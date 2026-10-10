/**
 * The App's server on the shared WASM host, `/apps/{name}/api` (T-3351): the repeat places of
 * every week it has kept, and the hotspot reports readers save, each with a snapshot of the map.
 * A snapshot goes from the browser to the store through the URL the server hands out, never
 * through the server itself. A test hands the page its own server (`ServerContext`).
 */
import { createContext, useContext, useMemo } from "react";

/** One repeat place as a week or a report keeps it. */
export interface Spot {
  name: string;
  lon: number;
  lat: number;
  count: number;
}

export interface Week {
  /** Monday of the week on Helsinki's calendar, `YYYY-MM-DD`. */
  week: string;
  alerts: number;
  places: Spot[];
  computed_at: string;
}

export interface Weeks {
  weeks: Week[];
  /** The feed could not be read just now: these are the weeks as last kept. */
  stale: boolean;
}

export interface Report {
  id: number;
  title: string;
  /** The page's address after `?`. */
  view: string;
  kept: number;
  places: Spot[];
  has_snapshot: boolean;
  created_at: string;
}

export interface NewReport {
  title: string;
  view: string;
  kept: number;
  places: Spot[];
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
  weeks(): Promise<Weeks>;
  reports(): Promise<Report[]>;
  save(report: NewReport): Promise<Report>;
  /** Asks for the report's upload URL, then puts the PNG there itself. */
  attach(id: number, png: Blob): Promise<void>;
  /** A URL the snapshot can be downloaded from for two minutes. */
  snapshotUrl(id: number): Promise<string>;
}

/** Where the server answers: `/apps/{appName}/api`, or `/api` when the name is not an App's. */
export function apiBase(appName: string | undefined): string {
  return appName && /^[a-z0-9-]+$/.test(appName) ? `/apps/${appName}/api` : "/api";
}

async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  const answer = await fetch(`${base}${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!answer.ok) {
    const problem = (await answer.json().catch(() => ({}))) as { detail?: unknown };
    throw new Problem(answer.status, typeof problem.detail === "string" ? problem.detail : `HTTP ${answer.status}`);
  }
  return (await answer.json()) as T;
}

export function server(base: string): Server {
  return {
    weeks: () => call<Weeks>(base, "GET", "/weeks"),
    reports: () => call<Report[]>(base, "GET", "/reports"),
    save: (report) => call<Report>(base, "POST", "/reports", report),
    attach: async (id, png) => {
      const { url } = await call<{ url: string }>(base, "POST", `/reports/${id}/snapshot`, {});
      const put = await fetch(url, { method: "PUT", body: png, headers: { "Content-Type": "image/png" } });
      if (!put.ok) throw new Problem(put.status, `HTTP ${put.status}`);
    },
    snapshotUrl: async (id) => (await call<{ url: string }>(base, "GET", `/reports/${id}/snapshot`)).url,
  };
}

/** The server the page talks to; `null` takes the App's own, from its name. */
export const ServerContext = createContext<Server | null>(null);

export function useServer(appName: string | undefined): Server {
  const given = useContext(ServerContext);
  return useMemo(() => given ?? server(apiBase(appName)), [given, appName]);
}
