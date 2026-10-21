// A person's own MCP connectors (UI-98, EP-123, ADR-N-043 §7, T-4531): kept in their preferences,
// served at `/api/mcp/me/{name}` to their token alone, each one narrowing what they may read.
import { useEffect, useSyncExternalStore } from "react";
import { api } from "../../api/client";
import type { components } from "../../api/schema";
import type { Manifest } from "../../api/manifest";
import { mcpOrigin } from "../../components/endpoints/links";

export type Connector = components["schemas"]["Connector"];
export type ConnectorSelect = components["schemas"]["ConnectorSelect"];
type Preferences = components["schemas"]["Preferences"];

export const MAX_CONNECTORS = 10;
export const MAX_SELECT_VALUES = 50;
export const ACCESS_LEVELS = ["public", "organization", "project", "grant"] as const;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** The address of one of the person's connectors; only their own token opens it. */
export function connectorUrl(domain: string | undefined, name: string): string {
  return `${mcpOrigin(domain)}/api/mcp/me/${encodeURIComponent(name)}`;
}

/** What the form holds: the selector's lists as typed, comma-separated. */
export interface ConnectorForm {
  name: string;
  projects: string[];
  spaces: string[];
  domains: string[];
  themes: string[];
  accessLevel: string[];
  endpoints: string[];
}

/** The Smart Data Models domains of jc-core's classification, the only ones the server keeps (MF-55). */
export const DOMAINS = [
  "CPSV-AP",
  "Environment",
  "KeyPerformanceIndicator",
  "Organization",
  "Parking",
  "ParksAndGardens",
  "PointOfInterest",
  "TourismDestinations",
  "Transportation",
  "UrbanMobility",
  "WasteManagement",
  "Weather",
] as const;

export function toForm(connector?: Connector): ConnectorForm {
  const select = connector?.select ?? {};
  return {
    name: connector?.name ?? "",
    projects: select.projects ?? [],
    spaces: select.spaces ?? [],
    domains: select.domains ?? [],
    themes: select.themes ?? [],
    accessLevel: select.accessLevel ?? [],
    endpoints: select.endpoints ?? [],
  };
}

export function fromForm(form: ConnectorForm): Connector {
  const select: ConnectorSelect = {};
  const lists: [keyof ConnectorSelect, string[]][] = [
    ["projects", form.projects],
    ["spaces", form.spaces],
    ["domains", form.domains],
    ["themes", form.themes],
    ["accessLevel", form.accessLevel],
    ["endpoints", form.endpoints],
  ];
  for (const [field, values] of lists) if (values.length > 0) select[field] = values;
  return { name: form.name.trim(), select };
}

/** What is wrong before the server is asked, one key per field; the server checks it again. */
export function connectorProblems(connector: Connector, others: Connector[]): Record<string, string> {
  const problems: Record<string, string> = {};
  const select = connector.select ?? {};
  if (!DNS_LABEL.test(connector.name)) problems.name = "connectors.problem.name";
  else if (others.some((other) => other.name === connector.name)) problems.name = "connectors.problem.taken";
  if ((select.projects ?? []).some((project) => !DNS_LABEL.test(project))) problems.projects = "connectors.problem.projects";
  if ((select.spaces ?? []).some((space) => !/^[a-z0-9][-a-z0-9]*\/[a-z0-9][-a-z0-9]*$/.test(space))) problems.spaces = "connectors.problem.spaces";
  const tooMany = Object.values(select).some((values) => Array.isArray(values) && values.length > MAX_SELECT_VALUES);
  if (tooMany) problems.select = "connectors.problem.tooMany";
  return problems;
}

/** One Endpoint the person may read, as the reach is worked out from it. */
export interface Readable {
  project: string;
  name: string;
  slug: string;
  space: string;
  audience: string;
}

export function asReadable(project: string, endpoint: Manifest): Readable | null {
  const spec = (endpoint.spec ?? {}) as { slug?: unknown; audience?: unknown; contextSpaceRef?: { name?: unknown } };
  if (typeof spec.slug !== "string" || spec.slug === "") return null;
  const space = typeof spec.contextSpaceRef?.name === "string" ? spec.contextSpaceRef.name : "";
  const audience = typeof spec.audience === "string" ? spec.audience : "project-list";
  return { project, name: endpoint.metadata.name, slug: spec.slug, space, audience };
}

/** The access level of an Endpoint's audience; one shared by grant reads as `project` here. */
const levelOf = (audience: string) => (audience === "public" ? "public" : audience === "organization" ? "organization" : "project");

/**
 * The Endpoints a connector reaches among those the person may read: each field given must
 * match. Domains and themes are the gateway's catalogue's to match, so they narrow nothing here
 * and the page says so (ADR-N-043 §7.2).
 */
export function reach(connector: Connector, readable: Readable[]): Readable[] {
  const select = connector.select ?? {};
  const levels = (select.accessLevel ?? []).map((level) => (level === "grant" ? "project" : level));
  return readable.filter(
    (endpoint) =>
      (!select.projects?.length || select.projects.includes(endpoint.project)) &&
      (!select.spaces?.length || select.spaces.includes(`${endpoint.project}/${endpoint.space}`)) &&
      (levels.length === 0 || levels.includes(levelOf(endpoint.audience))) &&
      (!select.endpoints?.length || select.endpoints.includes(endpoint.slug)),
  );
}

/**
 * Adds the Endpoint to the first connector, or to a new `favourites`; takes it out of every one
 * when it is in one. A connector whose last Endpoint goes is dropped: an empty `endpoints` list
 * narrows nothing, so keeping it would widen the connector to everything else it selects (T-5015).
 */
export function toggledStar(connectors: Connector[], slug: string): Connector[] {
  const holds = (connector: Connector) => connector.select?.endpoints?.includes(slug) ?? false;
  if (connectors.some(holds)) {
    return connectors.flatMap((connector) => {
      if (!holds(connector)) return [connector];
      const endpoints = connector.select?.endpoints?.filter((one) => one !== slug) ?? [];
      return endpoints.length === 0 ? [] : [{ ...connector, select: { ...connector.select, endpoints } }];
    });
  }
  const [first, ...rest] = connectors;
  if (!first) return [{ name: "favourites", select: { endpoints: [slug] } }];
  return [{ ...first, select: { ...first.select, endpoints: [...(first.select?.endpoints ?? []), slug] } }, ...rest];
}

// The person's connectors, read once and written back whole with the rest of their preferences
// kept, the way the starred pages are (navigation/places.ts).
let connectors: Connector[] = [];
const listeners = new Set<() => void>();

function publish(next: Connector[]): void {
  connectors = next;
  for (const listener of listeners) listener();
}

async function read(): Promise<Preferences | null> {
  const answer = await api.GET("/api/v1/preferences", {});
  return answer.data ?? null;
}

/** Reads the stored connectors again on every mount: one small GET, never a stale list. */
function load(): Promise<void> {
  return read()
    .then((stored) => publish(stored?.connectors ?? []))
    .catch(() => undefined);
}

/** Saves `change` of the stored connectors; rejects with the server's reason when it refuses. */
/** A refused save: the server's words and the connector fields it names. */
export type ConnectorRefusal = Error & { fields?: string[] };

export async function saveConnectors(change: (current: Connector[]) => Connector[]): Promise<void> {
  const stored = (await read()) ?? {};
  const answer = await api.PUT("/api/v1/preferences", { body: { ...stored, connectors: change(stored.connectors ?? []) } });
  if (!answer.data) {
    const problem = answer.error as { detail?: unknown; errors?: unknown } | undefined;
    const refusal: ConnectorRefusal = new Error(typeof problem?.detail === "string" ? problem.detail : "refused");
    // The field the server names, so the page shows its refusal beside that field (T-4948).
    refusal.fields = Array.isArray(problem?.errors) ? problem.errors.filter((f): f is string => typeof f === "string") : [];
    throw refusal;
  }
  publish(answer.data.connectors ?? []);
}

export function useConnectors(): Connector[] {
  useEffect(() => {
    void load();
  }, []);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => connectors,
  );
}
