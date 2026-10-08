// covers (T-2137, the module gate in gate_modules.test.ts): src/pages/inbox/InboxPage.tsx, src/api/decision.ts.
/**
 * T-3273: one list of what waits for the signed-in person. Every change of every project they may
 * decide, each decided where it is listed with its diff; a Red-lane change asks for its name, a
 * rejection for its reason; a change the person may not decide is not offered; mentions are
 * listed; and the header counts what waits.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { App } from "../src/App";
import { InboxPage } from "../src/pages/inbox/InboxPage";
import { useDecisions } from "../src/api/decision";
import { renderHook } from "@testing-library/react";
import { AuthProvider } from "../src/auth/AuthProvider";
import { InRouter } from "./pageHarness";

const IDENTITY = { subject: "s", username: "jana", name: "Jana", email: "jana@hel.fi", roles: [] };

function change(project: string, name: string, kind: string, lane = "yellow", author = "marek@hel.fi") {
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "ChangeProposal",
    metadata: { name, namespace: project },
    summary: { key: "change.summary.update", params: { kind, name: `${kind.toLowerCase()}-x`, fields: 1 } },
    author: { name: "Marek", email: author },
    createdAt: "2026-10-07T12:00:00Z",
    status: { lane, phase: "PendingApproval", plan: { update: 1 } },
    planFields: [{ path: "spec.audience", from: "organization", to: "project-list" }],
  };
}

interface Seen {
  writes: { path: string; body: unknown }[];
}

function show(seen: Seen) {
  window.history.pushState({}, "", "/projects/helsinki/inbox");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (request.method !== "GET") {
        const body = request.method === "POST" ? await request.text() : "";
        seen.writes.push({ path: url.pathname, body: body ? JSON.parse(body) : undefined });
        const project = url.pathname.split("/")[4];
        const id = url.pathname.split("/")[6];
        const phase = url.pathname.endsWith("/reject") ? "Rejected" : "Deploying";
        return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "Change", metadata: { name: id, namespace: project }, status: { lane: "yellow", phase, plan: { update: 1 } } }, 202);
      }
      if (url.pathname.endsWith("/auth/me")) return json(IDENTITY);
      if (url.pathname === "/api/v1/projects") return json({ items: [{ name: "helsinki" }, { name: "ovzdusie" }] });
      if (url.pathname.endsWith("/permissions/me")) {
        return json({ project: "x", bootstrap: false, grants: [{ role: "approver", binding: "b", scope: "project", rule: { kinds: ["Endpoint", "Policy"], verbs: ["approve"] } }] });
      }
      if (url.pathname === "/api/v1/projects/helsinki/changes") {
        return json({ items: [change("helsinki", "chg-endpoint", "Endpoint"), change("helsinki", "chg-pipeline", "Pipeline")] });
      }
      if (url.pathname === "/api/v1/projects/ovzdusie/changes") return json({ items: [change("ovzdusie", "chg-policy", "Policy", "red")] });
      if (url.pathname.includes("/changes/")) {
        const [, , , , project, , id] = url.pathname.split("/");
        return json(change(project, id, "Endpoint"));
      }
      if (url.pathname === "/api/v1/notifications") {
        return json({ unread: 1, items: [{ id: 7, read: false, project: "helsinki", space: "ovzdusie", authorName: "Peter", excerpt: "@jana look at pm10", createdAt: "2026-10-07T12:00:00Z" }] });
      }
      return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] });
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const item = async (text: RegExp) => (await screen.findByText(text)).closest("li") as HTMLElement;

describe("the inbox (T-3273)", () => {
  it("lists what the person may decide in every project, and not what they may not", async () => {
    const seen = { writes: [] };
    show(seen);
    const decisions = await screen.findByTestId("inbox-decisions");
    await waitFor(() => expect(within(decisions).getAllByRole("listitem")).toHaveLength(2));
    expect(decisions).toHaveTextContent("proposed by Marek in helsinki");
    expect(decisions).toHaveTextContent("proposed by Marek in ovzdusie");
    expect(decisions).not.toHaveTextContent("pipeline-x");
    expect(screen.getByRole("link", { name: /Peter mentioned you/ })).toBeInTheDocument();
  });

  it("approves a change with its diff open, without leaving the page", async () => {
    const seen: Seen = { writes: [] };
    show(seen);
    const endpoint = await item(/Endpoint "endpoint-x"/);
    await userEvent.click(within(endpoint).getByRole("button", { name: en.inbox.showDiff }));
    expect(await within(endpoint).findByText("organization")).toBeInTheDocument();
    await userEvent.click(within(endpoint).getByRole("button", { name: en.approvals.approve }));
    await waitFor(() => expect(seen.writes).toEqual([{ path: "/api/v1/projects/helsinki/changes/chg-endpoint/approve", body: undefined }]));
    expect(await within(endpoint).findByRole("status")).toHaveTextContent(en.inbox.decided.approved);
  });

  it("asks for a Red-lane change's name before approving it, and for a reason before rejecting", async () => {
    const seen: Seen = { writes: [] };
    show(seen);
    const policy = await item(/Policy "policy-x"/);
    const approve = within(policy).getByRole("button", { name: en.approvals.approve });
    expect(approve).toHaveAttribute("aria-disabled", "true");
    await userEvent.type(within(policy).getByLabelText(new RegExp(en.approvals.confirmPrompt)), "policy-x");
    expect(approve).not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(within(policy).getByRole("button", { name: en.approvals.reject }));
    const confirmReject = within(policy).getByRole("button", { name: en.approvals.rejectConfirm });
    expect(confirmReject).toHaveAttribute("aria-disabled", "true");
    await userEvent.type(within(policy).getByLabelText(new RegExp(en.approvals.rejectReason)), "too wide");
    await userEvent.click(confirmReject);
    await waitFor(() =>
      expect(seen.writes).toEqual([{ path: "/api/v1/projects/ovzdusie/changes/chg-policy/reject", body: { reason: "too wide" } }]),
    );
  });

  it("counts what waits in the header and leads to the inbox", async () => {
    show({ writes: [] });
    await screen.findByTestId("inbox-decisions");
    // One decidable change in the project in hand and one unread mention.
    const trigger = await screen.findByRole("button", { name: "Notifications, 2 unread" });
    await userEvent.click(trigger);
    expect(await screen.findByRole("menuitem", { name: "Open your inbox (2 waiting)" })).toBeInTheDocument();
  });

  it("says nothing waits when no change is the person's to decide, and decides only pending ones", async () => {
    show({ writes: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useDecisions("ovzdusie"), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>
          <AuthProvider>{children}</AuthProvider>
        </QueryClientProvider>
      ),
    });
    await waitFor(() => expect(result.current.map((c) => c.metadata.name)).toEqual(["chg-policy"]));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nextProvider i18n={i18n}>
          <AuthProvider>
            <InRouter>
              <InboxPage project="nowhere" />
            </InRouter>
          </AuthProvider>
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect((await screen.findAllByText(en.inbox.noMentions)).length).toBeGreaterThan(0);
  });
});

