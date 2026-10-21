// covers (T-2137, the module gate in gate_modules.test.ts): src/pages/pipelines/AccessRequests.tsx.
/**
 * T-4863, PL-90…PL-93: a pipeline asks another space's owner for access, naming every type and
 * attribute; the owner approves, declines with a reason, or revokes, each a call of the owning
 * project, and approving shows the Change it proposed.
 */
import type { JSX } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { AccessRequestInbox, attrList, PipelineAccessRequests, requestBody } from "../src/pages/pipelines/AccessRequests";
import type { AccessRequestView } from "../src/pages/pipelines/AccessRequests";
import { InRouter } from "./pageHarness";

const L = en.pipelines.access;

const request = (state: AccessRequestView["state"]): AccessRequestView => ({
  id: "ar-0a1b2c3d4e5f",
  pipeline: { project: "city-kpis", name: "air-index" },
  account: "city-kpis/pl-air-index",
  endpoint: { project: "helsinki", name: "air-quality" },
  space: "air",
  operations: "read",
  types: [{ type: "AirQualityObserved", attrs: ["pm10", "pm25"] }],
  until: "2027-01-31T23:59:59Z",
  reason: "air index for the city dashboard",
  state,
  requestedBy: "jana",
  requestedAt: "2026-10-20T19:40:00Z",
  decidedBy: state === "pending" ? null : "olli",
  decidedAt: null,
  decisionReason: state === "declined" ? "use the open endpoint" : null,
  change: null,
});

describe("the request a form builds (PL-90)", () => {
  it("splits attributes and asks for what is missing first", () => {
    expect(attrList(" pm10, pm25  no2,,")).toEqual(["pm10", "pm25", "no2"]);
    const form = { project: "helsinki", endpoint: "air-quality", operations: "read" as const, rows: [{ type: "AirQualityObserved", attrs: "pm10" }], until: "", reason: "why" };
    expect(requestBody(form)).toEqual({
      body: { endpoint: { project: "helsinki", name: "air-quality" }, operations: "read", types: [{ type: "AirQualityObserved", attrs: ["pm10"] }], reason: "why" },
    });
    expect(requestBody({ ...form, endpoint: " " })).toEqual({ missing: "endpoint" });
    expect(requestBody({ ...form, rows: [{ type: "AirQualityObserved", attrs: "" }] })).toEqual({ missing: "types" });
    expect(requestBody({ ...form, rows: [{ type: "", attrs: "" }] })).toEqual({ missing: "types" });
    expect(requestBody({ ...form, reason: "" })).toEqual({ missing: "reason" });
    expect((requestBody({ ...form, until: "2027-01-31" }) as { body: { until: string } }).body.until).toMatch(/^2027-0[12]-/);
  });
});

describe("access requests on the pages (PL-90, PL-91, PL-93)", () => {
  let sent: { path: string; body: unknown }[];
  function serve(items: AccessRequestView[]) {
    sent = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const req = input as Request;
        const url = new URL(req.url);
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
        if (req.method === "POST") {
          const text = await req.text();
          sent.push({ path: url.pathname, body: text ? JSON.parse(text) : null });
          if (url.pathname.endsWith("/approve") || url.pathname.endsWith("/revoke")) {
            return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "Change", metadata: { name: "chg-00000042", namespace: "helsinki" }, status: { lane: "red", phase: "PendingApproval", plan: { create: 1, update: 1, delete: 0 } } }, 202);
          }
          return json(request("pending"), 201);
        }
        if (url.pathname.endsWith("/access-requests")) return json({ items });
        return json({ items: [] });
      }),
    );
  }
  const wrap = (node: JSX.Element) =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nextProvider i18n={i18n}>
          <InRouter>{node}</InRouter>
        </I18nextProvider>
      </QueryClientProvider>,
    );

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("files a request naming every type and attribute, and refuses an empty one in place", async () => {
    serve([]);
    wrap(<PipelineAccessRequests project="city-kpis" name="air-index" />);
    expect(await screen.findByText(L.none)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: L.request }));
    await userEvent.click(screen.getByRole("button", { name: L.send }));
    expect(await screen.findByRole("alert")).toHaveTextContent(L.missing.endpoint);
    expect(sent).toHaveLength(0);
    await userEvent.type(screen.getByLabelText(new RegExp(L.project)), "helsinki");
    await userEvent.type(screen.getByLabelText(new RegExp(`^${L.endpoint}`)), "air-quality");
    await userEvent.type(screen.getByLabelText(L.type), "AirQualityObserved");
    await userEvent.type(screen.getByLabelText(L.attrs), "pm10, pm25");
    await userEvent.type(screen.getByLabelText(new RegExp(L.reason)), "air index");
    await userEvent.click(screen.getByRole("button", { name: L.send }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].path).toBe("/api/v1/projects/city-kpis/pipelines/air-index/access-requests");
    expect(sent[0].body).toEqual({
      endpoint: { project: "helsinki", name: "air-quality" },
      operations: "read",
      types: [{ type: "AirQualityObserved", attrs: ["pm10", "pm25"] }],
      reason: "air index",
    });
    expect(await screen.findByText(L.sent)).toBeInTheDocument();
  });

  it("shows the requester where each request stands and the owner's reason", async () => {
    serve([request("declined")]);
    wrap(<PipelineAccessRequests project="city-kpis" name="air-index" />);
    const row = (await screen.findByText("helsinki/air-quality")).closest("li") as HTMLElement;
    expect(row).toHaveTextContent(L.state.declined);
    expect(row).toHaveTextContent("olli: use the open endpoint");
    expect(row).toHaveTextContent("AirQualityObserved (pm10, pm25)");
  });

  it("lets the owner approve a pending request and shows the Change, and declines only with a reason", async () => {
    serve([request("pending")]);
    wrap(<AccessRequestInbox project="helsinki" space="air" />);
    const row = (await screen.findByText("city-kpis/pl-air-index")).closest("li") as HTMLElement;
    expect(within(row).getByRole("button", { name: "Decline access for city-kpis/pl-air-index" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(within(row).getByRole("button", { name: "Approve access for city-kpis/pl-air-index" }));
    await waitFor(() => expect(sent.map((s) => s.path)).toEqual(["/api/v1/projects/helsinki/access-requests/ar-0a1b2c3d4e5f/approve"]));
    expect(await screen.findByText("chg-00000042")).toBeInTheDocument();
  });

  it("revokes an approved request with the owner's reason and lists nothing of another space", async () => {
    serve([request("approved"), { ...request("pending"), id: "ar-111111111111", space: "traffic", account: "x/pl-y" }]);
    wrap(<AccessRequestInbox project="helsinki" space="air" />);
    const row = (await screen.findByText("city-kpis/pl-air-index")).closest("li") as HTMLElement;
    expect(screen.queryByText("x/pl-y")).not.toBeInTheDocument();
    await userEvent.type(within(row).getByLabelText(L.decisionReason), "the index moved");
    await userEvent.click(within(row).getByRole("button", { name: "Revoke access of city-kpis/pl-air-index" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ path: "/api/v1/projects/helsinki/access-requests/ar-0a1b2c3d4e5f/revoke", body: { reason: "the index moved" } });
  });
});
