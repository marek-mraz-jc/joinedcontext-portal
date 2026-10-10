/**
 * The App's server, `/apps/kpi-forecast/api` (T-3350): each indicator's forecast kept with the day
 * it was made, and monthly reports of the forecasts against what was measured, downloaded from the
 * store through a short-lived URL the server hands out.
 */
import { ServerProblem } from "./problem";

export { ServerProblem };

export interface KeptPoint {
  t: number;
  v: number;
  lo: number;
  hi: number;
}

export interface KeptForecast {
  madeOn: string;
  days: number;
  /** The model's step, milliseconds. */
  step: number;
  latestT: number;
  latestV: number;
  direction: "up" | "down" | "flat" | null;
  points: KeptPoint[];
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
  return `/apps/${name && /^[a-z0-9-]+$/.test(name) ? name : "kpi-forecast"}/api`;
}

async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  let answer: Response;
  try {
    answer = await fetch(`${base}${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ServerProblem(0, "");
  }
  if (!answer.ok) {
    const problem = (await answer.json().catch(() => ({}))) as { detail?: unknown };
    throw new ServerProblem(answer.status, typeof problem.detail === "string" ? problem.detail : "");
  }
  return (await answer.json()) as T;
}

export function kpiApi(base: string) {
  return {
    /** Records the day's forecasts of the period, once a day; a later call that day does nothing. */
    record: (days: number) => call<{ recorded: number; already: boolean }>(base, "POST", "/forecasts", { days }),
    list: (kpi: string) => call<KeptForecast[]>(base, "GET", `/forecasts?${new URLSearchParams({ kpi }).toString()}`),
    reportUrl: async (month: string) => (await call<{ url: string }>(base, "POST", "/reports", { month })).url,
  };
}

export type KpiApi = ReturnType<typeof kpiApi>;
