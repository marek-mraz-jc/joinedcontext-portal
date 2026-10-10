/**
 * The App's server on the shared WASM host, `/apps/{name}/api` (T-3353): the figures it keeps of
 * every district for every day, and URLs for the district boundaries it compared against and
 * their licence, as files in the App's own storage. A test hands the page its own server
 * (`ServerContext`).
 */
import { createContext, useContext, useMemo } from "react";

/** One district's figures on one day on Helsinki's calendar. */
export interface DayMetric {
  /** `YYYY-MM-DD`. */
  day: string;
  code: string;
  name: string;
  area_km2: number;
  events: number;
  bikes: number;
  bike_slots: number;
  alerts: number;
  pm25: number | null;
  aqi: number | null;
}

export interface History {
  days: DayMetric[];
  /** The feeds could not be read just now: today is missing, these are the days as last kept. */
  stale: boolean;
}

export interface Files {
  geojson: string;
  licence: string;
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
  /** The kept days of up to six districts, the newest first. */
  history(codes: string[]): Promise<History>;
  /** URLs the boundaries and their licence can be downloaded from for two minutes. */
  files(): Promise<Files>;
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
    history: (codes) => get<History>(`${base}/metrics?codes=${encodeURIComponent(codes.join(","))}`),
    files: () => get<Files>(`${base}/boundaries`),
  };
}

/** The server the page talks to; `null` takes the App's own, from its name. */
export const ServerContext = createContext<Server | null>(null);

export function useServer(appName: string | undefined): Server {
  const given = useContext(ServerContext);
  return useMemo(() => given ?? server(apiBase(appName)), [given, appName]);
}
