/**
 * T-3111: the AI field of a data view asks the assistant to fill one attribute of the rows on
 * screen from a prompt, with what it costs said first; the assistant prepares a write_entities
 * preview the person applies with their own rights (AG-78), within the daily caps (AG-97).
 */
// covers (T-2137, the module gate in gate_modules.test.ts): src/pages/spaces/AiField.tsx.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toRichRow } from "@joinedcontext/sdk";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { AI_ROWS, AiFieldPanel, aiFieldRequest, estimateTokens } from "../src/pages/spaces/AiField";
import { expectNoViolations } from "./checks";
import { InRouter } from "./pageHarness";

/** The project's events model: Event has a text `description`, a `summary` to fill and a relationship. */
const MODEL = `id: https://example.org/events
name: events
classes:
  Event:
    slots: [description, summary, organizer]
slots:
  description:
    range: string
  summary:
    range: string
  organizer:
    range: Organization
    annotations:
      ngsi_ld_kind: Relationship
`;

function serveModels() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL((input as Request).url ?? String(input), "http://localhost");
      if (url.pathname === "/api/v1/organization/datamodels") {
        const items = [{ project: "city", name: "events", space: "events", classes: ["Event"], level: "project", lifecycle: "published", version: "1.0.0" }];
        return new Response(JSON.stringify({ apiVersion: "v1", kind: "OrganizationModels", items, smartDataModels: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/api/v1/projects/city/datamodels/events/source") {
        return new Response(MODEL, { status: 200, headers: { "Content-Type": "text/yaml" } });
      }
      return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
    }),
  );
}

const event = (n: number) =>
  toRichRow(
    {
      id: `urn:ngsi-ld:Event:hel.fi:events:${n}`,
      type: "Event",
      description: { type: "Property", value: "A long description of the event ".repeat(4) },
    },
    "en",
  );

describe("the request", () => {
  it("costs what the model reads, about four characters a token, and forty tokens a row it writes", () => {
    const rows = [event(1), event(2)];
    const read = rows.reduce((n, row) => n + row.id.length + "description".length + 128, "Summarise".length);
    expect(estimateTokens("Summarise", rows)).toBe(Math.ceil(read / 4) + 80);
    expect(estimateTokens("", [])).toBe(0);
  });

  it("names the attribute, the endpoint, the provenance and every entity, and changes nothing else", () => {
    const text = aiFieldRequest("events", "Event", "events-public", "summary", "Summarise it.", [event(1)], "2026-10-06T20:00:00Z");
    expect(text).toContain('Fill the attribute "summary" of 1 Event entities of the space events, through the Endpoint events-public.');
    expect(text).toContain("answer this prompt: Summarise it.");
    expect(text).toContain('"generatedAt" (a Property holding "2026-10-06T20:00:00Z")');
    expect(text).toContain("Change no other attribute.");
    expect(text).toContain("- urn:ngsi-ld:Event:hel.fi:events:1");
  });
});

describe("the panel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const show = (rows = [event(1), event(2)], endpoints = ["events-public"]) => {
    serveModels();
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nextProvider i18n={i18n}>
          <InRouter>
            <AiFieldPanel project="city" space="events" type="Event" endpoints={endpoints} rows={rows} />
          </InRouter>
        </I18nextProvider>
      </QueryClientProvider>,
    );
  };

  it("says the cost before anything runs and hands the assistant the request to send", async () => {
    const asked: string[] = [];
    window.addEventListener("jc:assistant-ask", (e) => asked.push((e as CustomEvent<string>).detail));
    show();
    const panel = await screen.findByTestId("view-ai");
    await userEvent.click(within(panel).getByText(en.spaces.ai.title));
    const ask = within(panel).getByRole("button", { name: en.spaces.ai.ask });
    expect(ask).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(within(panel).getByRole("combobox", { name: en.spaces.ai.attribute }));
    await userEvent.click(await within(panel).findByRole("option", { name: /summary/ }));
    await userEvent.type(within(panel).getByLabelText(new RegExp(`^${en.spaces.ai.prompt}`)), "Summarise it.");
    expect(within(panel).getByTestId("ai-budget")).toHaveTextContent(/^2 entities, about \d+ tokens\.$/);
    await expectNoViolations(panel);
    await userEvent.click(ask);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Fill the attribute "summary" of 2 Event entities');
  });

  it("offers the model's properties alone, never a relationship, and says how many rows one request covers", async () => {
    show(Array.from({ length: AI_ROWS + 5 }, (_, n) => event(n)));
    const panel = await screen.findByTestId("view-ai");
    await userEvent.click(within(panel).getByText(en.spaces.ai.title));
    await userEvent.click(within(panel).getByRole("combobox", { name: en.spaces.ai.attribute }));
    expect(await within(panel).findByRole("option", { name: /description/ })).toBeInTheDocument();
    expect(within(panel).queryByRole("option", { name: /organizer/ })).not.toBeInTheDocument();
    expect(within(panel).getByTestId("ai-budget")).toHaveTextContent(`The first ${AI_ROWS} on screen`);
  });

  it("offers nothing to write through where no Endpoint serves the space", async () => {
    show([event(1)], []);
    const panel = await screen.findByTestId("view-ai");
    await userEvent.click(within(panel).getByText(en.spaces.ai.title));
    expect(within(panel).getByRole("button", { name: en.spaces.ai.ask })).toHaveAttribute("aria-disabled", "true");
  });
});
