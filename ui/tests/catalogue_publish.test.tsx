// covers (T-2137, the module gate in gate_modules.test.ts): the cases in this file drive
// src/pages/catalogue/PublishDataset.tsx and publish.ts: the one-step publish flow (EP-83, T-2726).
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { App } from "../src/App";
import { catalogOf, formOf, problems } from "../src/pages/catalogue/publish";
import { PublishDatasetDialog } from "../src/pages/catalogue/PublishDataset";

const LIST = "joinedcontext.com/v1alpha1";
const IDENTITY = { subject: "b7c1e0f4", username: "jana.kovacova", name: "Jana Kováčová", roles: ["portal-editor"] };

const ENDPOINT = {
  apiVersion: LIST,
  kind: "Endpoint",
  metadata: { name: "bbsk-kpi", namespace: "bbsk", title: { sk: "Ukazovatele kraja" } },
  spec: { contextSpaceRef: "kpi", slug: "k7m2qz4tv6xh3n5jb2ryd3wcfa", audience: "organization", enabledRepresentations: ["ngsi-ld"] },
  status: { phase: "Live" },
};

const DRAFT = {
  endpoint: "bbsk-kpi",
  makesPublic: true,
  catalog: {
    license: "CC_BY_4_0",
    themes: ["ECON"],
    keywords: { sk: ["ukazovateľ", "hodnota"] },
    publisher: { name: { sk: "Banskobystrický samosprávny kraj" } },
    contactPoint: { name: "Open data desk", email: "opendata@example.org" },
    attribution: { sk: "Zdroj: BBSK" },
  },
  publish: { ckan: { instanceRef: { kind: "CkanInstance", name: "bbsk" } } },
  missing: ["spatial", "temporal", "frequency"],
};

const CHANGE = {
  apiVersion: LIST,
  kind: "Change",
  metadata: { name: "chg-0000a1b2", namespace: "bbsk" },
  status: { lane: "red", phase: "PendingApproval", plan: { update: 1 } },
};

const PAGE = {
  total: 0,
  page: 1,
  pageSize: 20,
  datasets: [],
  facets: { publisher: [], theme: [], format: [], licence: [], spatial: [], year: [] },
  unavailable: [],
};

type Sent = { method: string; url: URL; body: unknown };

describe("publish a dataset in one step (EP-83)", () => {
  let sent: Sent[];
  let draftAnswer: { status: number; body: unknown };

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    sent = [];
    draftAnswer = { status: 200, body: DRAFT };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stub() {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      const text = request.method === "GET" ? "" : await request.text();
      sent.push({ method: request.method, url, body: text ? JSON.parse(text) : undefined });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json" },
        });
      const path = url.pathname;
      if (path.includes("/auth/me")) return json(IDENTITY);
      if (path === "/api/v1/projects") return json({ apiVersion: LIST, kind: "List", items: [{ name: "bbsk" }] });
      if (path.endsWith("/permissions/me")) return json({ project: "bbsk", bootstrap: true, grants: [] });
      if (path === "/api/v1/catalogue") return json(PAGE);
      if (path === "/api/v1/projects/bbsk/catalogue/drafts") return json(draftAnswer.body, draftAnswer.status);
      if (path === "/api/v1/projects/bbsk/endpoints" && request.method === "GET") {
        return json({ apiVersion: LIST, kind: "List", items: [ENDPOINT] });
      }
      if (path === "/api/v1/projects/bbsk/endpoints/bbsk-kpi" && request.method === "GET") return json(ENDPOINT);
      if (path === "/api/v1/projects/bbsk/endpoints/bbsk-kpi" && request.method === "PUT") {
        return url.searchParams.get("dryRun") === "All" ? json({ valid: true }) : json(CHANGE, 202);
      }
      return json({ apiVersion: LIST, kind: "List", items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  function client() {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } });
  }

  it("drafts, lets the person correct it, previews and proposes one Change that makes the endpoint public", async () => {
    const user = userEvent.setup();
    stub();
    window.history.pushState({}, "", "/catalogue");
    render(
      <QueryClientProvider client={client()}>
        <I18nextProvider i18n={i18n}>
          <App />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "Publish a dataset" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish a dataset" });

    await user.click(within(dialog).getByRole("combobox", { name: "Endpoint" }));
    await user.click(await within(dialog).findByRole("option", { name: /Ukazovatele kraja/ }));
    await user.click(within(dialog).getByRole("button", { name: "Draft the description" }));

    expect(await within(dialog).findByDisplayValue("Banskobystrický samosprávny kraj")).toBeInTheDocument();
    const drafts = sent.find((s) => s.url.pathname.endsWith("/catalogue/drafts"));
    expect(drafts?.body).toEqual({ endpoint: "bbsk-kpi" });
    expect(within(dialog).getAllByText(/not public yet/).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/area, period, update frequency/)).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "Economy and finance" })).toBeChecked();

    // A licence is required: the flow says so on the field rather than proposing without one.
    await user.selectOptions(within(dialog).getByRole("combobox", { name: /Licence/ }), "");
    await user.click(within(dialog).getByRole("button", { name: "Preview the entry" }));
    expect(await within(dialog).findByText("Choose a licence.")).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByRole("combobox", { name: /Licence/ }), "CC0");
    await user.click(within(dialog).getByRole("checkbox", { name: "Environment" }));
    fireEvent.change(within(dialog).getByLabelText("Area"), { target: { value: "SK032, SK032 ," } });
    fireEvent.change(within(dialog).getByLabelText("Covers data from"), { target: { value: "2020-01-01" } });
    await user.click(within(dialog).getByRole("button", { name: "Preview the entry" }));

    const preview = await within(dialog).findByRole("region", { name: "3. Preview" });
    expect(within(preview).getByRole("heading", { name: "Ukazovatele kraja" })).toBeInTheDocument();
    expect(within(preview).getByText("Creative Commons Zero 1.0")).toBeInTheDocument();
    expect(within(preview).getByText("Environment")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Make public and propose publication" }));
    await within(dialog).findByText(/next reconcile/);

    const puts = sent.filter((s) => s.method === "PUT");
    expect(puts.map((p) => p.url.searchParams.get("dryRun"))).toEqual(["All", null]);
    const body = puts[1].body as { spec: Record<string, unknown>; status?: unknown };
    expect(body.status).toBeUndefined();
    expect(body.spec.audience).toBe("public");
    expect(body.spec.publish).toEqual(DRAFT.publish);
    expect(body.spec.contextSpaceRef).toBe("kpi");
    expect(body.spec.catalog).toEqual({
      license: "CC0",
      themes: ["ECON", "ENVI"],
      keywords: { sk: ["ukazovateľ", "hodnota"] },
      publisher: { name: { sk: "Banskobystrický samosprávny kraj" } },
      contactPoint: { name: "Open data desk", email: "opendata@example.org" },
      attribution: { sk: "Zdroj: BBSK" },
      spatial: ["SK032"],
      temporal: { start: "2020-01-01" },
    });
  });

  it("says what the API said when the project has no catalogue to publish to", async () => {
    const user = userEvent.setup();
    draftAnswer = {
      status: 409,
      body: { title: "Conflict", status: 409, detail: "project 'bbsk' has no CkanInstance to publish to; add one on its Open data page first" },
    };
    stub();
    window.history.pushState({}, "", "/catalogue");
    render(
      <QueryClientProvider client={client()}>
        <I18nextProvider i18n={i18n}>
          <App />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "Publish a dataset" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "Endpoint" }));
    await user.click(await within(dialog).findByRole("option", { name: /Ukazovatele kraja/ }));
    await user.click(within(dialog).getByRole("button", { name: "Draft the description" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("has no CkanInstance");
    expect(sent.some((s) => s.method === "PUT")).toBe(false);
  });

  it("proposes an already public endpoint without changing its audience", async () => {
    const user = userEvent.setup();
    draftAnswer = { status: 200, body: { ...DRAFT, makesPublic: false } };
    stub();
    window.history.pushState({}, "", "/catalogue");
    render(
      <QueryClientProvider client={client()}>
        <I18nextProvider i18n={i18n}>
          <App />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "Publish a dataset" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "Endpoint" }));
    await user.click(await within(dialog).findByRole("option", { name: /Ukazovatele kraja/ }));
    await user.click(within(dialog).getByRole("button", { name: "Draft the description" }));
    await user.click(await within(dialog).findByRole("button", { name: "Preview the entry" }));
    expect(within(dialog).queryByText(/not public yet/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Propose publication" }));
    await within(dialog).findByText(/next reconcile/);
    const put = sent.filter((s) => s.method === "PUT")[1].body as { spec: Record<string, unknown> };
    expect(put.spec.audience).toBe("organization");
  });

  it("opens nothing while closed", () => {
    stub();
    render(
      <QueryClientProvider client={client()}>
        <I18nextProvider i18n={i18n}>
          <PublishDatasetDialog project="bbsk" open={false} onOpenChange={() => undefined} />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sent).toEqual([]);
  });
});

describe("the publish form", () => {
  const draft = DRAFT.catalog;

  it("reads the draft in its own language and writes back only what changed", () => {
    const form = formOf(draft, "en");
    expect(form.language).toBe("sk");
    expect(form.keywords).toBe("ukazovateľ, hodnota");
    expect(catalogOf(draft, form)).toEqual(draft);
  });

  it("drops a member the person emptied and keeps the other languages", () => {
    const both = { ...draft, keywords: { sk: ["a"], en: ["b"] } };
    const form = { ...formOf(both, "en"), keywords: " , ", publisher: "", contactName: "", contactEmail: "" };
    const out = catalogOf(both, form);
    expect(out.keywords).toEqual({ en: ["b"] });
    expect(out.publisher).toBeUndefined();
    expect(out.contactPoint).toBeUndefined();
    expect(out.attribution).toEqual({ sk: "Zdroj: BBSK" });
  });

  it("refuses a missing licence, half a contact, a bad address and a period that ends before it starts", () => {
    const form = formOf(draft, "en");
    expect(problems(form)).toEqual({});
    expect(problems({ ...form, license: "" })).toEqual({ license: "catalogue.publish.error.licence" });
    expect(problems({ ...form, contactEmail: "" })).toEqual({ contactEmail: "catalogue.publish.error.contactBoth" });
    expect(problems({ ...form, contactName: "" })).toEqual({ contactName: "catalogue.publish.error.contactBoth" });
    expect(problems({ ...form, contactEmail: "desk@" })).toEqual({ contactEmail: "catalogue.publish.error.email" });
    expect(problems({ ...form, temporalStart: "2025-02-01", temporalEnd: "2025-01-01" })).toEqual({
      temporalEnd: "catalogue.publish.error.period",
    });
  });

  it("a draft with nothing in it is a form with nothing in it", () => {
    const form = formOf({}, "de");
    expect(form.language).toBe("de");
    expect(catalogOf({}, form)).toEqual({});
  });
});
