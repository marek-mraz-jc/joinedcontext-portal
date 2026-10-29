import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { App } from "../src/App";
import { proposalSentences } from "../src/pages/endpoints/ProposalSummary";
import type { SummaryForm } from "../src/pages/endpoints/ProposalSummary";
import { findFormPage } from "./formPage";

// The Endpoint form asks four plain questions and keeps the manifest behind View source (T-6099).

vi.mock("../src/pages/models/MonacoSourceView", () => ({
  default: ({ value }: { value: string }) => <textarea aria-label="YAML" value={value} readOnly />,
}));

const V = "joinedcontext.com/v1alpha1";
const list = (items: unknown[]) => ({ apiVersion: V, kind: "List", items });

function setup(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      const json = (body: unknown) =>
        Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url.pathname.endsWith("/auth/me")) return json({ subject: "s", username: "jana", name: "Jana", email: "jana@example.org", roles: ["portal-editor"] });
      if (url.pathname.endsWith("/spaces"))
        return json(list([{ apiVersion: V, kind: "ContextSpace", metadata: { name: "doprava", namespace: "zilina" }, spec: {} }]));
      if (url.pathname.endsWith("/ckaninstances"))
        return json(list([{ apiVersion: V, kind: "CkanInstance", metadata: { name: "zilina", namespace: "zilina" }, spec: {} }]));
      return json(list([]));
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

async function openNew(): Promise<HTMLElement> {
  setup();
  await userEvent.click((await screen.findAllByRole("button", { name: en.endpoints.add }))[0]);
  const page = await findFormPage();
  await within(page).findByText("1. What data?");
  return page;
}

describe("endpoint form as four questions (T-6099)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.history.pushState({}, "", "/projects/zilina/endpoints");
  });
  afterEach(() => vi.restoreAllMocks());

  it("asks the four questions in order and folds Advanced shut", async () => {
    const page = await openNew();
    const text = page.textContent ?? "";
    const at = ["1. What data?", "2. Who may read it?", "3. Where is it published?", "4. Which formats?", "Advanced"].map((title) =>
      text.indexOf(title),
    );
    expect(at.every((position) => position >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const advanced = within(page).getByText("Advanced", { selector: "span" }).closest("details");
    expect(advanced).not.toBeNull();
    expect(advanced?.open).toBe(false);
    expect((advanced as HTMLElement).textContent).toContain(en.endpoints.field.rateLimits);
  });

  it("names no manifest key in a label, legend or option", async () => {
    const page = await openNew();
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
    const labels: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest("label, legend, summary, h2, h3, option")) labels.push(node.textContent ?? "");
    }
    expect(labels.length).toBeGreaterThan(10);
    // A camelCase word is a manifest key (contextSpaceRef, enabledRepresentations, instanceRef).
    const keys = labels.filter((label) => /\b[a-z]{2,}[A-Z][A-Za-z]*\b/.test(label) || /\baudience\b|\bslug\b/i.test(label));
    expect(keys).toEqual([]);
  });

  it("preselects the usual formats, each in plain words", async () => {
    const page = await openNew();
    expect(within(page).getByRole("checkbox", { name: "Spreadsheet (CSV)" })).toBeChecked();
    expect(within(page).getByRole("checkbox", { name: "Excel / Power BI (OData)" })).toBeChecked();
    expect(within(page).getByRole("checkbox", { name: "Map layer (OGC)" })).toBeChecked();
    expect(within(page).getByRole("checkbox", { name: "Calendar (iCal)" })).not.toBeChecked();
    expect(within(page).getByRole("checkbox", { name: "AI assistants (MCP)" })).toBeChecked();
  });

  it("says in sentences what the proposal does and shows the source read-only", async () => {
    const page = await openNew();
    expect(within(page).queryByTestId("proposal-summary")).toBeNull();
    await userEvent.type(within(page).getByRole("textbox", { name: en.endpoints.field.name }), "parkoviska");
    const summary = await within(page).findByTestId("proposal-summary");
    expect(summary).toHaveTextContent("Creates the endpoint “parkoviska” over the space doprava.");
    expect(summary).toHaveTextContent(en.endpoints.summary.approval);
    await userEvent.click(within(page).getByText(en.endpoints.section.manifests));
    await waitFor(() => expect(within(page).getByTestId("endpoint-preview")).toHaveTextContent("kind: Endpoint"));
    expect(within(page).getByRole("button", { name: en.endpoints.source.copy })).toBeInTheDocument();
  });
});

describe("proposalSentences (T-6099)", () => {
  const t = (key: string, values?: Record<string, unknown>) =>
    i18n.t(key, values as Record<string, string>);
  const form: SummaryForm = {
    name: "parkoviska",
    title: "Parkoviská",
    contextSpaceRef: "doprava",
    audience: "project-list",
    enabledRepresentations: ["ngsi-ld", "csv"],
    allowedProjects: ["doprava-mesta"],
  };

  it("names readers, formats and the portal of a new endpoint", () => {
    expect(proposalSentences({ ...form, publish: { ckan: { instanceRef: "zilina" } } }, null, t)).toEqual([
      "Creates the endpoint “Parkoviská” over the space doprava.",
      "People of this project and of doprava-mesta can read it.",
      "People read it as: Linked data API (NGSI-LD), Spreadsheet (CSV).",
      "It is listed as a dataset in the open-data portal zilina.",
      en.endpoints.summary.approval,
    ]);
  });

  it("says which formats an edit adds and removes", () => {
    const sentences = proposalSentences({ ...form, audience: "public", enabledRepresentations: ["ngsi-ld", "odata"] }, form, t);
    expect(sentences).toContain("Changes the endpoint “Parkoviská”.");
    expect(sentences).toContain(en.endpoints.summary.public);
    expect(sentences).toContain("Formats added: Excel / Power BI (OData).");
    expect(sentences).toContain("Formats removed: Spreadsheet (CSV).");
    expect(sentences).toContain(en.endpoints.summary.unpublished);
  });
});
