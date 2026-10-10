/**
 * The App's server, `/apps/event-day-planner/api` (T-3347): a day shared under a short code a
 * link carries, and its calendar file, which the browser downloads from the store through a
 * short-lived URL the server hands out.
 */
import type { Lang } from "./i18n";
import type { Item } from "./planner";

export interface SharedDay {
  code: string;
  day: string;
  lang: string;
  /** The events picked, by the end of their id, as `?pick=` keeps them. */
  picks: string[];
  items: Item[];
  conflicts: [string, string][];
  walkKm: number;
  walkMinutes: number;
}

/** A problem+json answer as an error whose message is its `detail`. */
export class ServerProblem extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(detail);
  }
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
  return `/apps/${name && /^[a-z0-9-]+$/.test(name) ? name : "event-day-planner"}/api`;
}

/** A share's code as the server makes them: 12 lowercase letters or digits. */
export function isCode(code: string): boolean {
  return /^[a-z0-9]{12}$/.test(code);
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

export function shareApi(base: string) {
  return {
    share: (day: string, ids: string[], lang: Lang) => call<SharedDay>(base, "POST", "/itineraries", { day, ids, lang }),
    get: (code: string) => call<SharedDay>(base, "GET", `/itineraries/${encodeURIComponent(code)}`),
    icsUrl: async (code: string) => (await call<{ url: string }>(base, "GET", `/itineraries/${encodeURIComponent(code)}/ics`)).url,
  };
}

export type ShareApi = ReturnType<typeof shareApi>;

/** The address that opens the shared day: this page with `?share=` and nothing else. */
export function shareLink(code: string, location: Pick<Location, "origin" | "pathname"> = window.location): string {
  return `${location.origin}${location.pathname}?share=${code}`;
}
