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
import { evalCase, filterQuery, msText, usdText } from "../src/pages/knowledge/conversations";

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

function renderAs(verbs: string[]) {
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
        <ConversationsPage project={PROJECT} />
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
});
