/**
 * The App's server on the shared WASM host, `/apps/{name}/api` (T-3355): the models it has kept of
 * a station, one a day, and a URL for the data a model was trained on, in the App's own storage.
 * A test hands the page its own server (`ServerContext`).
 */
import { createContext, useContext, useMemo } from "react";

export interface Model {
  id: number;
  /** `YYYY-MM-DD`, the day on Helsinki's calendar. */
  trained_on: string;
  trained_at: string;
  hours: number;
  enough: boolean;
  /** Bikes per degree, and with rain; `null` without weather terms. */
  per_degree: number | null;
  rain: number | null;
  sigma: number | null;
  weather_station: string | null;
}

export interface Models {
  models: Model[];
  /** The data could not be read just now: no model today, these are the models as kept. */
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
  models(station: string): Promise<Models>;
  /** A URL the model's training data can be downloaded from for two minutes. */
  snapshotUrl(id: number): Promise<string>;
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
    models: (station) => get<Models>(`${base}/models?station=${encodeURIComponent(station)}`),
    snapshotUrl: async (id) => (await get<{ url: string }>(`${base}/models/${id}/snapshot`)).url,
  };
}

/** The server the page talks to; `null` takes the App's own, from its name. */
export const ServerContext = createContext<Server | null>(null);

export function useServer(appName: string | undefined): Server {
  const given = useContext(ServerContext);
  return useMemo(() => given ?? server(apiBase(appName)), [given, appName]);
}
