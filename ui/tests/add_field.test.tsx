/**
 * "Add field" (T-3098, ADR-N-042 §3.1): each field type is a LinkML range and an NGSI-LD kind, and
 * adding one proposes a DataModel Change; the Smart Data Model of the same name is offered first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { AddFieldDialog } from "../src/components/entities/AddFieldDialog";
import { EMPTY_DRAFT, fieldOperations, problemsOf, suggestedSlots } from "../src/components/entities/fieldTypes";
import { parseModel } from "../src/pages/models/linkml";
import { applyOperations } from "../src/pages/models/operations";

const STATIONS = `id: https://hel.fi/models/stations
name: stations
default_prefix: hel
prefixes:
  hel: https://hel.fi/models/
classes:
  BikeHireDockingStation:
    slots: [name]
  Street:
    slots: [label]
slots:
  name:
    range: string
  label:
    range: string
`;

const OFFICIAL = `id: https://smartdatamodels.org/BikeHireDockingStation
name: BikeHireDockingStation
enums:
  StatusEnum:
    permissible_values:
      working: {}
      outOfService: {}
classes:
  BikeHireDockingStation:
    slots: [name, availableBikeNumber, status, location, refStreet]
slots:
  name: { range: string }
  availableBikeNumber:
    range: integer
    slot_uri: https://smartdatamodels.org/dataModel.Transportation/availableBikeNumber
    description: Number of bikes available
    annotations: { upstream_source: "https://smartdatamodels.org/dataModel.Transportation/BikeHireDockingStation" }
  status: { range: StatusEnum }
  location:
    annotations: { ngsi_ld_kind: GeoProperty }
  refStreet:
    range: Street
    annotations: { ngsi_ld_kind: Relationship }
`;

const model = parseModel(STATIONS);
const TYPE = "BikeHireDockingStation";

function applied(draft: Partial<typeof EMPTY_DRAFT>) {
  const full = { ...EMPTY_DRAFT, ...draft };
  expect(problemsOf(full, model, TYPE)).toEqual({});
  const result = applyOperations(STATIONS, fieldOperations(full, model, TYPE));
  expect(result.refused).toEqual([]);
  return parseModel(result.source);
}

describe("field types", () => {
  it("map onto the LinkML range and NGSI-LD kind the field holds", () => {
    expect(applied({ name: "capacity", type: "integer", required: true }).slots.find((s) => s.name === "capacity")).toMatchObject({
      range: "integer",
      required: true,
      kind: "Property",
    });
    expect(applied({ name: "opened", type: "date" }).slots.find((s) => s.name === "opened")?.range).toBe("date");
    expect(applied({ name: "contact", type: "email" }).slots.find((s) => s.name === "contact")?.pattern).toBeDefined();
    expect(applied({ name: "where", type: "location" }).slots.find((s) => s.name === "where")?.kind).toBe("GeoProperty");
    const after = applied({ name: "attached", type: "multiSelect", values: ["new", "in progress"] });
    const slot = after.slots.find((s) => s.name === "attached")!;
    expect(slot.multivalued).toBe(true);
    expect(after.enums.find((e) => e.name === slot.range)?.permissible_values.map((v) => v.name)).toEqual(["new", "in progress"]);
    expect(after.classes.find((c) => c.name === TYPE)?.slots).toContain("attached");
  });

  it("makes a relationship with its way back on the target", () => {
    const after = applied({ name: "street", type: "relationship", target: "Street", inverse: "stations" });
    expect(after.slots.find((s) => s.name === "street")).toMatchObject({ range: "Street", kind: "Relationship" });
    expect(after.slots.find((s) => s.name === "stations")?.multivalued).toBe(true);
  });

  it("refuses a name the type has, a bad name, an empty choice list and a missing target", () => {
    expect(problemsOf({ ...EMPTY_DRAFT, name: "name" }, model, TYPE).name).toBe("nameTaken");
    expect(problemsOf({ ...EMPTY_DRAFT, name: "kapacita stanice" }, model, TYPE).name).toBe("nameInvalid");
    expect(problemsOf({ ...EMPTY_DRAFT, name: "s", type: "select" }, model, TYPE).values).toBe("valuesMissing");
    expect(problemsOf({ ...EMPTY_DRAFT, name: "s", type: "select", values: ["a", "a"] }, model, TYPE).values).toBe("valueTwice");
    const rel = problemsOf({ ...EMPTY_DRAFT, name: "r", type: "relationship", inverse: "r" }, model, TYPE);
    expect(rel).toEqual({ target: "targetMissing", inverse: "inverseInvalid" });
    expect(problemsOf({ ...EMPTY_DRAFT, name: "r", type: "relationship", target: "Street", inverse: "label" }, model, TYPE).inverse).toBe(
      "inverseTaken",
    );
  });

  it("suggests the official attributes the type lacks and a field can hold", () => {
    expect(suggestedSlots(parseModel(OFFICIAL), model, TYPE).map((s) => s.name)).toEqual(["availableBikeNumber", "status", "location"]);
  });
});

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("AddFieldDialog", () => {
  let originalFetch: typeof global.fetch;
  let sent: { method: string; path: string; body: string }[];

  beforeEach(async () => {
    originalFetch = global.fetch;
    sent = [];
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mount(answer: (path: string) => Response) {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.origin), init);
      const path = new URL(request.url).pathname;
      sent.push({ method: request.method, path, body: request.method === "GET" ? "" : await request.clone().text() });
      return answer(path);
    }) as typeof fetch;
    const onProposed = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <AddFieldDialog project="hel" modelName="stations" source={STATIONS} type={TYPE} open onOpenChange={() => {}} onProposed={onProposed} />
        </QueryClientProvider>
      </I18nextProvider>,
    );
    return onProposed;
  }

  const official = (path: string): Response | undefined => {
    if (path.endsWith("/tools/sdm-catalog")) {
      return respond({ subjects: [{ name: "Transportation", models: [{ id: "dataModel.Transportation/BikeHireDockingStation", name: TYPE }] }] });
    }
    if (path.endsWith("/tools/import-sdm")) return respond({ linkml: OFFICIAL });
    return undefined;
  };

  it("proposes the official attribute as a model change, its IRI and description with it", async () => {
    const onProposed = mount((path) => official(path) ?? respond({ metadata: { name: "chg-1" }, status: { phase: "Proposed" } }, 202));
    const offer = await screen.findByRole("button", { name: en.spaces.fields.proposeOfficial.replace("{name}", "availableBikeNumber") });
    await userEvent.click(offer);

    await waitFor(() => expect(onProposed).toHaveBeenCalledTimes(1));
    const put = sent.find((r) => r.method === "PUT")!;
    expect(put.path).toBe("/api/v1/projects/hel/datamodels/stations/source");
    const proposed = parseModel(put.body);
    expect(proposed.slots.find((s) => s.name === "availableBikeNumber")).toMatchObject({
      range: "integer",
      slot_uri: "https://smartdatamodels.org/dataModel.Transportation/availableBikeNumber",
      description: "Number of bikes available",
      upstream: "https://smartdatamodels.org/dataModel.Transportation/BikeHireDockingStation",
    });
    expect(proposed.classes.find((c) => c.name === TYPE)?.slots).toContain("availableBikeNumber");
  });

  it("says what to correct before anything is sent, and shows the Portal's refusal", async () => {
    mount((path) => official(path) ?? respond({ title: "Conflict", detail: "the model changed since it was read" }, 409));
    await screen.findByRole("button", { name: en.spaces.fields.proposeOfficial.replace("{name}", "status") });
    const dialog = screen.getByRole("dialog");

    await userEvent.click(within(dialog).getByRole("button", { name: en.spaces.fields.propose }));
    expect(within(dialog).getByLabelText(new RegExp(en.spaces.fields.name))).toHaveAccessibleDescription(
      expect.stringContaining(en.spaces.fields.problem.nameInvalid),
    );
    expect(sent.some((r) => r.method === "PUT")).toBe(false);

    await userEvent.type(within(dialog).getByLabelText(new RegExp(en.spaces.fields.name)), "capacity");
    await userEvent.selectOptions(within(dialog).getByLabelText(en.spaces.fields.type), "integer");
    await userEvent.click(within(dialog).getByRole("button", { name: en.spaces.fields.propose }));
    expect(await within(dialog).findByText("the model changed since it was read")).toBeInTheDocument();
  });

  it("still offers an own field when the catalogue cannot be reached", async () => {
    mount((path) => (path.includes("/tools/") ? respond({ title: "Bad Gateway" }, 502) : respond({}, 500)));
    expect(await screen.findByText(en.spaces.fields.sdmUnavailable)).toBeInTheDocument();
    expect(screen.getByLabelText(en.spaces.fields.type)).toBeEnabled();
  });
});
