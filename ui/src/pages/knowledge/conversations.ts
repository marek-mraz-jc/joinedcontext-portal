// The stored conversations of a project's assistants (API/01 §34, API/05 §3.1, AG-99, T-4670):
// the list, one conversation with its steps, the erasure, and a turn as an eval case.
import { api, unwrap } from "../../api/client";

export interface ConversationRow {
  id: string;
  deployment: string;
  origin: string | null;
  startedAt: string;
  lastAt: string;
  firstQuestion: string;
  turns: number;
  routes: string[];
  totalMs: number;
  errors: number;
  timeouts: number;
  costUsd: number;
  uncosted: number;
  thumbsUp: number;
  thumbsDown: number;
}

export interface ConversationStep {
  kind: "route" | "search" | "tool" | "model" | "answer";
  name: string;
  endpoint: string | null;
  input: string | null;
  output: string | null;
  outputBytes: number | null;
  status: "ok" | "failed";
  startMs: number;
  durationMs: number;
  error: string | null;
  stage: string | null;
  model: string | null;
  provider: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
}

export interface ConversationTurn {
  turn: number;
  at: string;
  question: string;
  answer: string;
  route: string;
  firstTokenMs: number | null;
  totalMs: number;
  error: { status?: number; title?: string; detail?: string } | null;
  timedOut: boolean;
  costUsd: number;
  uncosted: number;
  verdict: string | null;
  steps: ConversationStep[];
}

export interface Conversation {
  id: string;
  deployment: string;
  origin: string | null;
  turns: ConversationTurn[];
}

export interface ConversationFilter {
  deployment?: string;
  /** A day (YYYY-MM-DD), from its start; `to` up to the end of its day. */
  from?: string;
  to?: string;
  status?: "error" | "timeout" | "ok";
  feedback?: "up" | "down" | "none";
  slow?: boolean;
  /** Only conversations that cost more than $0.02. */
  expensive?: boolean;
  q?: string;
  sort?: "lastAt" | "costUsd";
  cursor?: string;
}

export const conversationKeys = {
  list: (project: string, filter: ConversationFilter) => ["projects", project, "knowledge", "conversations", filter] as const,
  one: (project: string, id: string) => ["projects", project, "knowledge", "conversations", id] as const,
};

/** What the route takes (API/05 §3.1). */
export interface ConversationQuery {
  deployment?: string;
  from?: string;
  to?: string;
  status?: string;
  feedback?: string;
  slow?: boolean;
  minCostUsd?: number;
  q?: string;
  sort?: string;
  cursor?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day after `day` (YYYY-MM-DD), so `to` holds the whole of its own day. */
function dayAfter(day: string): string {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** The filter as the route takes it: empty values left out, `q` trimmed, days as UTC times. */
export function filterQuery(filter: ConversationFilter): ConversationQuery {
  const query: ConversationQuery = {};
  const deployment = filter.deployment?.trim();
  if (deployment) query.deployment = deployment;
  if (filter.from && DAY.test(filter.from)) query.from = `${filter.from}T00:00:00Z`;
  if (filter.to && DAY.test(filter.to)) query.to = `${dayAfter(filter.to)}T00:00:00Z`;
  if (filter.expensive) query.minCostUsd = 0.02;
  if (filter.status) query.status = filter.status;
  if (filter.feedback) query.feedback = filter.feedback;
  if (filter.slow) query.slow = true;
  const q = filter.q?.trim();
  if (q && q.length >= 2) query.q = q;
  if (filter.sort === "costUsd") query.sort = "costUsd";
  if (filter.cursor) query.cursor = filter.cursor;
  return query;
}

export async function listConversations(
  project: string,
  filter: ConversationFilter,
): Promise<{ items: ConversationRow[]; nextCursor: string | null }> {
  const answer = (await unwrap(
    await api.GET("/api/v1/projects/{project}/knowledge/conversations", {
      params: { path: { project }, query: filterQuery(filter) },
    }),
  )) as { items?: ConversationRow[]; nextCursor?: string | null } | null;
  return { items: Array.isArray(answer?.items) ? answer.items : [], nextCursor: answer?.nextCursor ?? null };
}

export async function getConversation(project: string, conversation: string): Promise<Conversation> {
  return (await unwrap(
    await api.GET("/api/v1/projects/{project}/knowledge/conversations/{conversation}", {
      params: { path: { project, conversation } },
    }),
  )) as Conversation;
}

export async function eraseConversation(project: string, conversation: string): Promise<void> {
  await unwrap(
    await api.DELETE("/api/v1/projects/{project}/knowledge/conversations/{conversation}", {
      params: { path: { project, conversation } },
    }),
  );
}

/**
 * A turn as a case of the assistant's eval set (conformance tests/assistant/opendata_questions.json,
 * T-4656): the question, the kind its route suggests and an empty `must` the person fills in; the
 * id is a placeholder to number.
 */
export function evalCase(turn: Pick<ConversationTurn, "question" | "route">, lang: string): string {
  const kind = turn.route === "data" ? "value" : turn.route === "declined" ? "scope" : "catalogue";
  const language = ["sk", "en", "cs"].includes(lang) ? lang : "sk";
  return JSON.stringify({ id: "od-00", lang: language, kind, q: turn.question, must: [] }, null, 2);
}

/** Milliseconds as a person reads them: 850 ms, 2.4 s. */
export function msText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Dollars of model calls: $0.0046; "–" when nothing was priced. */
export function usdText(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "–";
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}
