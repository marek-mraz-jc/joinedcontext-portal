// A person's AI connectors (AG-142..AG-153, API/14, T-5951): each an MCP server at `/c/{id}` that
// reaches only its scope, read again against the person's own rights at every call.
import type { components } from "../../api/schema";

export type AiConnector = components["schemas"]["ConnectorGrant"];
export type AiConnectorCall = components["schemas"]["ConnectorCall"];
export type ConnectorOptions = components["schemas"]["ConnectorOptions"];
export type ScopeItem = components["schemas"]["ConnectorScopeItem"];
export type NewAiConnector = components["schemas"]["NewConnector"];

/** What a tick in the tree names: a whole project, or one space, Endpoint or pipeline of it. */
export type PickKind = "project" | "space" | "endpoint" | "pipeline";
export interface Pick {
  project: string;
  kind: PickKind;
  name?: string;
  access: "read" | "write";
}

export interface AiConnectorForm {
  name: string;
  segments: string[];
  picks: Pick[];
  /** `YYYY-MM-DD`; the connector ends at the end of that day, UTC. */
  expires: string;
  clients: string[];
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const DAY = 24 * 3600_000;

export function pickKey(pick: Pick): string {
  return pick.kind === "project" ? pick.project : `${pick.project}/${pick.kind}/${pick.name ?? ""}`;
}

/** The last day a connector made today may live, as the date input reads it. */
export function lastDay(maxDays: number, now: Date): string {
  return new Date(now.getTime() + (maxDays - 1) * DAY).toISOString().slice(0, 10);
}

export function emptyForm(options: ConnectorOptions | undefined, now: Date): AiConnectorForm {
  return {
    name: "",
    segments: options?.ceiling.segments.slice(0, 1) ?? [],
    picks: [],
    expires: lastDay(options?.ceiling.maxDays ?? 30, now),
    clients: [],
  };
}

/** The form a stored connector fills: the edit starts from what it holds. */
export function toForm(connector: AiConnector): AiConnectorForm {
  return {
    name: connector.name,
    segments: connector.segments,
    picks: scopeLines(connector.scope).map((line) => ({ project: line.where, kind: line.kind, name: line.name, access: line.access === "write" ? "write" : "read" })),
    expires: connector.expiresAt.slice(0, 10),
    clients: connector.allowedClients,
  };
}

/** The request the form asks for; the server checks every item of it again. */
export function toRequest(form: AiConnectorForm): NewAiConnector {
  const scope: ScopeItem[] = form.picks.map((pick) => ({
    project: pick.project,
    ...(pick.kind === "project" ? {} : { [pick.kind]: pick.name }),
    access: pick.access,
  }));
  return {
    name: form.name,
    segments: form.segments,
    scope,
    writes: form.picks.some((pick) => pick.access === "write"),
    expiresAt: `${form.expires}T23:59:59Z`,
    allowedClients: form.clients,
  };
}

/** The form's own refusals, as translation keys per section, before the server is asked. */
export function formProblems(form: AiConnectorForm, options: ConnectorOptions, now: Date): Record<string, string> {
  const problems: Record<string, string> = {};
  if (!DNS_LABEL.test(form.name)) problems.name = "aiConnectors.problem.name";
  if (form.segments.length === 0) problems.segments = "aiConnectors.problem.segments";
  if (form.picks.length === 0) problems.scope = "aiConnectors.problem.scope";
  const today = now.toISOString().slice(0, 10);
  if (!form.expires || form.expires < today || form.expires > lastDay(options.ceiling.maxDays, now)) {
    problems.expiresAt = "aiConnectors.problem.expires";
  }
  return problems;
}

/** The form section a server refusal names: `errors[0]`, or the field a 403's detail starts with. */
export function refusedSection(errors: string[] | undefined, detail: string): string | undefined {
  const field = errors?.[0] ?? /^([A-Za-z]+)(\[\d+\])?[.:]/.exec(detail)?.[1];
  const head = field?.replace(/\[.*$/, "");
  if (head === "writes") return "scope";
  return head && ["name", "segments", "scope", "expiresAt", "allowedClients"].includes(head) ? head : undefined;
}

/** One line per scope item, as the list shows it: `helsinki`, `helsinki / Endpoint air`. */
export function scopeLines(scope: ScopeItem[]): { where: string; kind: PickKind; name?: string; access: string }[] {
  return scope.map((item) => {
    const kind: PickKind = item.space ? "space" : item.endpoint ? "endpoint" : item.pipeline ? "pipeline" : "project";
    return { where: item.project, kind, name: item.space ?? item.endpoint ?? item.pipeline ?? undefined, access: item.access };
  });
}

/** What a person pastes into each AI client (API/14 §4). */
export function setup(name: string, url: string): { claudeCode: string; vscode: string } {
  return {
    claudeCode: `claude mcp add --transport http ${name} ${url}`,
    vscode: JSON.stringify({ servers: { [name]: { type: "http", url } } }, null, 2),
  };
}
