/**
 * T-4670 (API/01 §34, AG-99): Asistent → Konverzácie. The assistant's administrator reads the
 * stored conversations with their filter, opens one as its turns and steps, copies a turn as an
 * eval case and erases a conversation only with `delete`; a member reads none of it.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { queryKeys } from "../src/api/client";
import { ConversationsPage } from "../src/pages/knowledge/ConversationsPage";
import {
  aligned,
  capped,
  evalCase,
  filterQuery,
  msText,
  totals,
  usdText,
  visible,
  visualChanges,
  wordDiff,
} from "../src/pages/knowledge/conversations";
import type { ConversationStep } from "../src/pages/knowledge/conversations";

const PROJECT = "helsinki";
const ONE = "11111111-1111-4111-8111-111111111111";
const LIST = {
  items: [{
    id: ONE, deployment: "obcan", origin: null, startedAt: "2026-10-18T10:00:00Z", lastAt: "2026-10-18T10:01:00Z",
    firstQuestion: "Aké je PM10?", turns: 1, routes: ["data"], totalMs: 2400, errors: 0, timeouts: 0,
    costUsd: 0.0046, uncosted: 1, thumbsUp: 0, thumbsDown: 1,
  }],
  nextCursor: null,
};
const DETAIL = {
  id: ONE, deployment: "obcan", origin: null,
  turns: [{
    turn: 1, at: "2026-10-18T10:01:00Z", question: "Aké je PM10?", answer: "PM10 je dnes 31 µg/m³.", route: "data",
    firstTokenMs: 800, totalMs: 2400, error: null, timedOut: false, costUsd: 0.0046, uncosted: 1, verdict: "down",
    steps: [
      { kind: "model", name: "data", endpoint: null, input: null, output: null, outputBytes: null, status: "ok", startMs: 0,
        durationMs: 900, error: null, stage: "data", model: "google/gemini-3.8-flash", provider: null, tokensIn: 1000,
        tokensOut: 100, reasoningTokens: null, costUsd: 0.0046 },
      { kind: "tool", name: "query_entities", endpoint: "hronov-air", input: "{\"type\":\"AirQualityObserved\"}",
        output: "[{\"pm10\":31}]", outputBytes: 13, status: "failed", startMs: 900, durationMs: 120, error: "timeout",
        stage: null, model: null, provider: null, tokensIn: null, tokensOut: null, reasoningTokens: null, costUsd: null },
      { kind: "model", name: "answer", endpoint: null, input: null, output: null, outputBytes: null, status: "ok", startMs: 1100,
        durationMs: 700, error: null, stage: "answer", model: "unpriced/model", provider: null, tokensIn: 500,
        tokensOut: 80, reasoningTokens: null, costUsd: null },
    ],
  }],
};

// T-4681: a second run of the same question, its stored text hostile.
const TWO = "22222222-2222-4222-8222-222222222222";
const HOSTILE = [
  "<script>window.pwned = 1</script>",
  "<img src=x onerror=\"window.pwned = 1\">",
  "[x](javascript:window.pwned=1)",
  "<svg onload=\"window.pwned = 1\"></svg>",
  "evil\u202Etxt.exe",
].join(" ");
const step = (kind: ConversationStep["kind"], extra: Partial<ConversationStep> = {}): ConversationStep => ({
  kind, name: kind, endpoint: null, input: null, output: null, outputBytes: null, status: "ok", startMs: 0, durationMs: 100,
  error: null, stage: null, model: null, provider: null, tokensIn: null, tokensOut: null, reasoningTokens: null, costUsd: null,
  ...extra,
});
const OTHER = {
  id: TWO, deployment: "obcan", origin: null,
  turns: [{
    turn: 1, at: "2026-10-19T10:01:00Z", question: "Aké je PM10?", answer: `PM10 je dnes 40 µg/m³. ${HOSTILE}`, route: "data",
    firstTokenMs: 700, totalMs: 3100, error: null, timedOut: false, costUsd: 0.006, uncosted: 0, verdict: null,
    steps: [
      step("model", { model: "google/gemini-3.8-flash", tokensIn: 1000, tokensOut: 90, cachedTokens: 800, costUsd: 0.006,
        reasoning: HOSTILE }),
      step("tool", { name: "query_entities", input: HOSTILE, output: "x".repeat(70 * 1024), rows: 20 }),
      step("visual", { name: "chart", input: "{\"mark\":\"bar\"}", rows: 7 }),
    ],
  }],
};
const SAME = {
  items: [
    { conversation: TWO, turn: 1, at: "2026-10-19T10:01:00Z", deployment: "obcan", totalMs: 3100, costUsd: 0.006, steps: 3 },
    { conversation: ONE, turn: 1, at: "2026-10-18T10:01:00Z", deployment: "obcan", totalMs: 2400, costUsd: 0.0046, steps: 3 },
  ],
};

function renderAs(verbs: string[], link: { open?: string; against?: string } = {}) {
  const calls: { method: string; url: URL }[] = [];
  const permissions = {
    bootstrap: false, project: PROJECT,
    grants: [{ role: "r", binding: "b", scope: PROJECT, space: null, rule: { kinds: ["AssistantDeployment"], verbs } }],
  };
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url, "http://localhost");
    calls.push({ method: request.method, url });
    const body = request.method === "DELETE" ? null
      : url.pathname.endsWith("/permissions/me") ? permissions
      : url.pathname.endsWith("/same") ? SAME
      : url.pathname.endsWith(TWO) ? OTHER
      : url.pathname.endsWith(ONE) ? DETAIL : LIST;
    return Promise.resolve(
      new Response(body === null ? null : JSON.stringify(body), {
        status: body === null ? 204 : 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.permissions(PROJECT), permissions);
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <ConversationsPage project={PROJECT} {...link} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the stored conversations' helpers", () => {
  it("send only the filter values that were set, and q from two characters", () => {
    expect(filterQuery({})).toEqual({});
    expect(filterQuery({ q: " a ", slow: false, sort: "lastAt" })).toEqual({});
    expect(filterQuery({ q: " pm10 ", status: "timeout", slow: true, sort: "costUsd", cursor: "50" }))
      .toEqual({ q: "pm10", status: "timeout", slow: true, sort: "costUsd", cursor: "50" });
    // A day is its whole UTC day: `to` is the start of the next one, exclusive.
    expect(filterQuery({ deployment: " obcan ", from: "2026-10-01", to: "2026-10-31", expensive: true }))
      .toEqual({ deployment: "obcan", from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", minCostUsd: 0.02 });
    expect(filterQuery({ from: "yesterday", to: "" })).toEqual({});
  });

  it("copy a turn as an eval case of the open-data set", () => {
    expect(JSON.parse(evalCase({ question: "Aké je PM10?", route: "data" }, "sk")))
      .toEqual({ id: "od-00", lang: "sk", kind: "value", q: "Aké je PM10?", must: [] });
    expect(JSON.parse(evalCase({ question: "Datasety?", route: "rag" }, "de")).lang).toBe("sk");
  });

  it("write times and prices as a person reads them", () => {
    expect([msText(850), msText(2400), msText(null)]).toEqual(["850 ms", "2.4 s", "–"]);
    expect([usdText(0.0046), usdText(1.5), usdText(null)]).toEqual(["$0.0046", "$1.50", "–"]);
  });
});

describe("the compare view's helpers (T-4681)", () => {
  it("align two timelines by kind, unmatched steps facing an empty cell", () => {
    const left = [step("route"), step("tool"), step("model"), step("answer")];
    const right = [step("route"), step("model"), step("visual"), step("answer")];
    expect(aligned(left, right).map(([a, b]) => [a?.kind ?? null, b?.kind ?? null])).toEqual([
      ["route", "route"],
      ["tool", null],
      ["model", "model"],
      [null, "visual"],
      ["answer", "answer"],
    ]);
    expect(aligned([], [step("tool")])).toEqual([[null, expect.objectContaining({ kind: "tool" })]]);
    expect(aligned([], [])).toEqual([]);
  });

  it("diff two answers word by word", () => {
    expect(wordDiff("PM10 je 31 dnes", "PM10 je 40 dnes")).toEqual([
      { word: "PM10", change: "same" },
      { word: "je", change: "same" },
      { word: "31", change: "removed" },
      { word: "40", change: "added" },
      { word: "dnes", change: "same" },
    ]);
    expect(wordDiff("", "")).toEqual([]);
    // Past the word cap both answers show as wholly changed instead of an O(n·m) table.
    const long = Array.from({ length: 2500 }, (_, i) => `w${i}`).join(" ");
    const diff = wordDiff(long, long);
    expect(diff.filter((w) => w.change === "removed")).toHaveLength(2500);
    expect(diff.filter((w) => w.change === "added")).toHaveLength(2500);
  });

  it("total a turn's steps, calls, time, cost and cached share", () => {
    const turn = OTHER.turns[0];
    expect(totals(turn)).toEqual({ steps: 3, tools: 1, models: 1, totalMs: 3100, costUsd: 0.006, cachedShare: 0.8 });
    expect(totals({ steps: [], totalMs: 0, costUsd: 0 }).cachedShare).toBeNull();
  });

  it("name the visuals' spec changes: another chart type, a missing unit, a different point count", () => {
    const a = [step("visual", { name: "chart", input: JSON.stringify({ mark: { type: "line" }, units: { pm10: "µg/m³" } }), rows: 12 })];
    const b = [step("visual", { name: "chart", input: JSON.stringify({ mark: "bar" }), rows: 7 }), step("visual", { name: "map" })];
    expect(visualChanges(a, b)).toEqual([
      "mark: line → bar",
      "units: {\"pm10\":\"µg/m³\"} → –",
      "rows: 12 → 7",
      "– → map",
    ]);
    // A spec cut at 64 KB no longer parses: the kind and rows still compare.
    expect(visualChanges([step("visual", { name: "table", input: "{\"cut", rows: 3 })], [step("visual", { name: "table", rows: 3 })]))
      .toEqual([]);
  });

  it("show bidi and zero-width characters as markers and cap long text", () => {
    expect(visible("evil\u202Etxt\u200B.exe\uFEFF")).toBe("evil⟦U+202E⟧txt⟦U+200B⟧.exe⟦U+FEFF⟧");
    expect(visible("Banská Bystrica")).toBe("Banská Bystrica");
    expect(capped("abc", 2)).toEqual({ text: "ab", more: true });
    expect(capped("ab", 2)).toEqual({ text: "ab", more: false });
    const huge = capped("x".repeat(10 * 1024 * 1024));
    expect(huge.more).toBe(true);
    expect(huge.text).toHaveLength(64 * 1024);
  });
});

describe("Asistent → Konverzácie", () => {
  it("a member without approve reads nothing and the assistant is never asked", async () => {
    const calls = renderAs(["read"]);
    expect(await screen.findByText(i18n.t("conversations.notAllowed"))).toBeInTheDocument();
    expect(calls.filter((c) => c.url.pathname.includes("/conversations"))).toEqual([]);
  });

  it("the administrator filters, opens a conversation with its steps and copies a turn; erase needs delete", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const calls = renderAs(["read", "approve"]);
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Aké je PM10?")).toBeInTheDocument();
    expect(within(table).getByText("$0.0046")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(i18n.t("conversations.filter.status")), "timeout");
    await waitFor(() => {
      expect(calls.some((c) => c.url.searchParams.get("status") === "timeout")).toBe(true);
    });

    await user.click(within(screen.getByRole("table")).getByRole("button", { name: "Aké je PM10?" }));
    expect(await screen.findByText("PM10 je dnes 31 µg/m³.")).toBeInTheDocument();
    expect(screen.getByText(/google\/gemini-3.8-flash/)).toBeInTheDocument();
    expect(screen.getByText(/hronov-air/)).toBeInTheDocument();
    // A call with no price says so, never $0 (T-4178).
    expect(screen.getByText(/unpriced\/model/).textContent).toContain(i18n.t("conversations.unknownPrice"));
    expect(screen.queryByText(/\$0\.0000/)).toBeNull();
    expect(screen.queryByRole("button", { name: i18n.t("conversations.erase") })).toBeNull();

    await user.click(screen.getByRole("button", { name: i18n.t("conversations.copyAsTest") }));
    expect(writeText).toHaveBeenCalledOnce();
    expect(JSON.parse((writeText.mock.calls[0] as unknown as [string])[0]).q).toBe("Aké je PM10?");
  });

  it("one who may delete erases a conversation after confirming", async () => {
    const user = userEvent.setup();
    const calls = renderAs(["read", "approve", "delete"]);
    await user.click(await screen.findByRole("button", { name: "Aké je PM10?" }));
    await user.click(await screen.findByRole("button", { name: i18n.t("conversations.erase") }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: i18n.t("conversations.erase") }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === "DELETE" && c.url.pathname.endsWith(`/conversations/${ONE}`))).toBe(true);
    });
  });

  it("lists the same question's turns and compares two side by side, every stored text inert", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const calls = renderAs(["read", "approve"]);
    await user.click(await screen.findByRole("button", { name: "Aké je PM10?" }));
    await user.click(await screen.findByRole("button", { name: i18n.t("conversations.same") }));
    const same = await screen.findByRole("list", { name: i18n.t("conversations.same") });
    // The turn itself is not offered against itself.
    expect(within(same).getAllByRole("button", { name: i18n.t("conversations.compare") })).toHaveLength(1);
    expect(calls.some((c) => c.url.pathname.endsWith(`/conversations/${ONE}/turns/1/same`))).toBe(true);

    await user.click(within(same).getByRole("button", { name: i18n.t("conversations.compare") }));
    const view = await screen.findByRole("region", { name: i18n.t("conversations.compareTitle") });
    expect(await within(view).findByTestId("compare-right-totals")).toHaveTextContent("3 steps · 1 tools · 1 model calls · 3.1 s · $0.0060 · cached 80 %");
    expect(within(view).getByTestId("compare-left-totals")).toHaveTextContent("3 steps · 1 tools · 2 model calls · 2.4 s · $0.0046 · cached 0 %");
    expect(within(view).getByRole("list", { name: i18n.t("conversations.changes") })).toHaveTextContent("– → chart");
    const diff = within(view).getByTestId("answer-diff");
    expect(diff.querySelector("del")).toHaveTextContent("31");
    expect(diff.querySelector("ins")).toHaveTextContent("40");

    // Hostile stored text stays text: no element, no handler, no link, the bidi override marked.
    for (const node of [view, ...Array.from(view.querySelectorAll("details"))]) {
      if (node instanceof HTMLDetailsElement) node.open = true;
    }
    expect(view.querySelector("script, img, svg[onload], a[href^='javascript']")).toBeNull();
    expect(view.textContent).toContain("<script>window.pwned = 1</script>");
    expect(view.textContent).toContain("evil⟦U+202E⟧txt.exe");
    expect(view.textContent).not.toContain("\u202E");
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    // A 70 KB result shows its first 64 KB until "Zobraziť viac".
    const more = within(view).getByRole("button", { name: i18n.t("conversations.showMore", { size: 70 }) });
    await user.click(more);
    expect(within(view).queryByRole("button", { name: i18n.t("conversations.showMore", { size: 70 }) })).toBeNull();

    await user.click(within(view).getByRole("button", { name: i18n.t("conversations.copyPair") }));
    const pair = JSON.parse((writeText.mock.calls[0] as unknown as [string])[0]) as { question: string }[];
    expect(pair.map((turn) => turn.question)).toEqual(["Aké je PM10?", "Aké je PM10?"]);
  });

  it("an eval run's link opens its conversation against the previous run's last turn", async () => {
    renderAs(["read", "approve"], { open: ONE, against: TWO });
    const view = await screen.findByRole("region", { name: i18n.t("conversations.compareTitle") });
    expect(await within(view).findByTestId("compare-right-totals")).toHaveTextContent("cached 80 %");
    await userEvent.setup().click(within(view).getByRole("button", { name: i18n.t("conversations.compareClose") }));
    expect(screen.queryByRole("region", { name: i18n.t("conversations.compareTitle") })).toBeNull();
  });
});
