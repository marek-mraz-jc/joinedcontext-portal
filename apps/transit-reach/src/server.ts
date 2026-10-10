/**
 * The App's server, `/apps/transit-reach/api` (T-3349): HSL's network kept by version, and from a
 * stop the area reached in each band, computed once per version and kept with its GeoJSON, which
 * the browser downloads from the store through a short-lived URL the server hands out.
 */
import { ServerProblem } from "./problem";

export { ServerProblem };

export interface KeptBand {
  minutes: number;
  areaKm2: number;
  stops: number;
}

export interface KeptReach {
  version: string;
  stop: string;
  bands: KeptBand[];
  /** Whether it was computed before, on this version of the network. */
  cached: boolean;
  /** Whether the network is due to be read again. */
  stale: boolean;
  url: string;
}

/** Where the server answers: `/apps/{appName}/api`, the App's name from `#jc-config`. */
export function apiBase(doc: Document = document): string {
  const text = doc.getElementById("jc-config")?.textContent ?? "";
  let name = "";
  try {
    name = String((JSON.parse(text || "{}") as { appName?: unknown }).appName ?? "");
  } catch {
    name = "";
  }
  return `/apps/${name && /^[a-z0-9-]+$/.test(name) ? name : "transit-reach"}/api`;
}

async function call<T>(base: string, method: string, path: string): Promise<T> {
  let answer: Response;
  try {
    answer = await fetch(`${base}${path}`, { method, credentials: "same-origin", headers: { Accept: "application/json" } });
  } catch {
    throw new ServerProblem(0, "");
  }
  if (!answer.ok) {
    const problem = (await answer.json().catch(() => ({}))) as { detail?: unknown };
    throw new ServerProblem(answer.status, typeof problem.detail === "string" ? problem.detail : "");
  }
  return (await answer.json()) as T;
}

export function reachApi(base: string) {
  return {
    reach: (stop: string) => call<KeptReach>(base, "GET", `/reach?${new URLSearchParams({ stop }).toString()}`),
    refresh: () => call<{ version: string; stops: number; routes: number; changed: boolean }>(base, "POST", "/network"),
  };
}

export type ReachApi = ReturnType<typeof reachApi>;

/**
 * The kept areas from `stop`: when the server has not read HSL's network yet (409) it is asked to,
 * once, and then for the areas again; a network due to be read again is read in the background.
 */
export async function keptReach(api: ReachApi, stop: string): Promise<KeptReach> {
  let kept: KeptReach;
  try {
    kept = await api.reach(stop);
  } catch (error) {
    if (!(error instanceof ServerProblem) || error.status !== 409) throw error;
    await api.refresh();
    kept = await api.reach(stop);
  }
  if (kept.stale) api.refresh().catch(() => undefined);
  return kept;
}
