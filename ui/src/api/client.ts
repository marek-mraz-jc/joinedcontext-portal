// UI-06, UI-07: every call to the Portal API goes through this client, typed by the paths
// openapi-typescript generated from ui/openapi.json (tests/api_contract.test.ts holds both).
import createClient from "openapi-fetch";
import { workspaceMiddleware } from "../components/layout/WorkspaceContext";
import type { Middleware } from "openapi-fetch";
import type { components, paths } from "./schema";
import { announceSessionEnded } from "./sessionEnded";

export type ProblemDetails = components["schemas"]["ProblemDetails"];

/**
 * One requirement or decision reference as the server's texts cite them: `AP-44`, `T-2636`,
 * `ADR-N-028 §5`. The prefixes are the requirement families of docs/Requirements.
 */
const REF = String.raw`(?:(?:AP|PF|CC|AG|UI|EP|DM|PL|OPS|MF|SDK|TS|SP|DS|MP)-\d+[a-z]?|T-\d{3,5}|ADR-N-\d{3}(?:\s*§\s*\d+)?)`;
const REFS = new RegExp(String.raw`\s*\(${REF}(?:\s*,\s*${REF})*\)`, "g");

/**
 * A server's sentence as a person reads it: without the "(AP-44)" it cites for engineers
 * (T-2756). The code keeps the ids, which is how the compliance matrix finds a requirement built;
 * the screen does not. Only a parenthesis made of references alone goes, "(see AP-44)" stays.
 */
export function forPeople(text: string): string {
  return text.replace(REFS, "");
}

export class ApiError extends Error {
  readonly status: number;
  readonly problem?: ProblemDetails;
  /** The edge's `X-Request-Id` of the answer, the reference a failure page shows (T-2747). */
  readonly requestId?: string;

  constructor(status: number, message: string, problem?: ProblemDetails, requestId?: string) {
    // Every refusal a page shows is one of these, read as `message` or as `problem.detail`.
    super(forPeople(message));
    this.name = "ApiError";
    this.status = status;
    this.requestId = requestId;
    // A problem is the server's answer, read as it came: a field it left out stays out.
    this.problem = problem && {
      ...problem,
      ...(typeof problem.title === "string" ? { title: forPeople(problem.title) } : {}),
      ...(typeof problem.detail === "string" ? { detail: forPeople(problem.detail) } : {}),
      ...(Array.isArray(problem.errors)
        ? { errors: problem.errors.map((error) => (typeof error === "string" ? forPeople(error) : error)) }
        : {}),
    };
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function readCsrfToken(): string | undefined {
  if (typeof document === "undefined" || !document.cookie) {
    return undefined;
  }
  const cookies = document.cookie.split("; ");
  for (const cookie of cookies) {
    const eqIdx = cookie.indexOf("=");
    if (eqIdx === -1) {
      continue;
    }
    const name = cookie.slice(0, eqIdx);
    if (name === "jc_csrf") {
      const rawValue = cookie.slice(eqIdx + 1);
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return rawValue;
      }
    }
  }
  return undefined;
}

// openapi-fetch builds a `Request`, which needs an absolute URL outside the browser's
// document context (jsdom included). The paths in `schema.d.ts` already carry `/api/v1`.
export const api = createClient<paths>({
  baseUrl: window.location.origin,
  credentials: "same-origin",
  // Resolve the global at call time. openapi-fetch would otherwise capture whatever
  // `globalThis.fetch` was when this module first loaded, which no test can substitute.
  fetch: (request) => globalThis.fetch(request),
});

/** Echoes the double-submit cookie the backend sets non-HttpOnly for exactly this purpose. */
export const csrfMiddleware: Middleware = {
  onRequest({ request }) {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const token = readCsrfToken();
      if (token) {
        request.headers.set("x-csrf-token", token);
      }
    }
    return request;
  },
};

api.use(csrfMiddleware);

/** The login page with the interrupted location to come back to; same shape as the server's. */
export function loginRedirectUrl(pathAndSearch: string): string {
  return `/login?redirect_to=${encodeURIComponent(pathAndSearch)}`;
}

/**
 * A 401 on any API call means the session is over (the server refreshes a live one itself):
 * `ended` gets the login address with the current location, and the Portal asks the person to
 * sign in again without leaving the page (T-2747). `/auth/me` is exempt — a 401 there is the
 * normal anonymous answer the AuthProvider turns into the login redirect through the router.
 * A 403 passes through untouched and the page shows its forbidden state.
 */
export function createSessionMiddleware(ended: (loginUrl: string) => void): Middleware {
  return {
    onResponse({ request, response }) {
      if (response.status !== 401) {
        return response;
      }
      const path = new URL(request.url, window.location.origin).pathname;
      if (path === "/api/v1/auth/me" || window.location.pathname === "/login") {
        return response;
      }
      ended(loginRedirectUrl(`${window.location.pathname}${window.location.search}`));
      return response;
    },
  };
}

export const sessionMiddleware = createSessionMiddleware(announceSessionEnded);

api.use(sessionMiddleware);
// Inside a workspace, resource reads and writes go to its branch (API/01 §22).
api.use(workspaceMiddleware);

export async function unwrap<T>(result: {
  data?: T;
  error?: unknown;
  response: Response;
}): Promise<T> {
  if (result.data !== undefined) {
    return result.data;
  }

  // A route that answers `204 No Content` has nothing to hand back and has not failed: an
  // answer accepted, a message sent. Reading the empty body as an error is what put
  // "No Content" on the run page in red.
  if (result.error === undefined && result.response.ok) {
    return undefined as T;
  }

  let problem: ProblemDetails | undefined;
  if (
    typeof result.error === "object" &&
    result.error !== null &&
    ("title" in result.error ||
      "detail" in result.error ||
      "status" in result.error ||
      "type" in result.error)
  ) {
    problem = result.error as ProblemDetails;
  }

  const status =
    typeof problem?.status === "number" ? problem.status : result.response.status;
  const message =
    problem?.detail ?? problem?.title ?? (result.response.statusText || `HTTP ${status}`);

  throw new ApiError(
    status,
    message,
    problem,
    result.response.headers.get("x-request-id") ?? undefined,
  );
}

/** Phases a resource leaves by itself, without anyone acting. */
const MOVING = new Set(["Pending", "Deploying"]);

/**
 * `refetchInterval` for a list query: every 10 s while any item is Pending or Deploying, so a
 * change on its way shows up without a reload, and not at all once every item has settled.
 */
export function whilePending(query: { state: { data?: unknown } }): number | false {
  const items = (query.state.data as { items?: unknown[] } | undefined)?.items ?? [];
  const moving = items.some((item) =>
    MOVING.has(String((item as { status?: { phase?: unknown } } | null)?.status?.phase)),
  );
  return moving ? 10_000 : false;
}

export const queryKeys = {
  session: () => ["session"] as const,
  // Not a prefix of `list`: invalidating one project's lists must not refetch the project list.
  projects: () => ["projectList"] as const,
  list: (project: string, plural: string) => ["projects", project, plural] as const,
  // Every Endpoint of every project the caller may read, which is one organization-level
  // request, not one per project (PF-60).
  allEndpoints: () => ["allEndpoints"] as const,
  // Blueprints are organization-level, so they are not under a project key (CC-30).
  blueprints: () => ["blueprints"] as const,
  // Form arrangements are organization-level too, and one fetch serves every dialog (UI-02).
  forms: () => ["forms"] as const,
  preferences: () => ["preferences"] as const,
  resource: (project: string, plural: string, name: string) =>
    ["projects", project, plural, name] as const,
  changes: (project: string) => ["projects", project, "changes"] as const,
  permissions: (project: string) => ["projects", project, "permissions"] as const,
  change: (project: string, id: string) => ["projects", project, "changes", id] as const,
  // The realm's people are not manifests of any project (ADR-N-031).
  people: () => ["people"] as const,
  peoplePage: (search: string, first: number) => ["people", "page", search, first] as const,
  person: (id: string) => ["people", "person", id] as const,
};
