/**
 * T-5218: the Endpoint form's named calendar and feed outputs (API/11 EP-159). Both lists start
 * empty and say what to add; each output has a name, titles, a query that narrows it and one or
 * more model classes whose attributes are dropdowns of the space's model; the deprecated single
 * calendar object reads as the output `events`. T-4900's calendar table lives on per source.
 */
import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import type { FieldProps } from "@rjsf/utils";
import { describe, expect, it } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { queryKeys } from "../src/api/client";
import { FormDataContext } from "../src/components/forms/widgets/EntitySelectorField";
import { RepresentationOutputsField } from "../src/components/forms/widgets/RepresentationOutputsField";
import { FormProjectContext } from "../src/components/forms/widgets/ModelWidgets";
import { AttributeSelect } from "../src/components/forms/widgets/OutputSourceEditors";
import { baseOf, unmappedRequired, withPreset, withSource } from "../src/components/forms/widgets/icalMapping";
import { duplicateNames, freeName, isSlug, outputsOf, unmappedRoles, written } from "../src/components/forms/widgets/representationOutputs";
import { representationSpec } from "../src/routes/EndpointsPage";

const c = en.endpoints.ical;
const o = en.endpoints.outputs;
const LINKML = "id: x\nname: x\nclasses:\n  Event:\n    slots: [name, startDate, title]\nslots:\n  name: { required: true }\n  startDate: { range: datetime, required: true }\n  title: {}\n";
const ON = { contextSpaceRef: "events", enabledRepresentations: ["ngsi-ld", "ical"] };

function Held({ initial, seen }: { initial?: unknown; seen: unknown[] }) {
  const [value, setValue] = useState<unknown>(initial);
  const props = {
    formData: value,
    onChange: (next: unknown) => {
      seen.push(next);
      setValue(next);
    },
    schema: { type: "object", title: "Calendars and news feeds" },
    fieldPathId: { $id: "root_representations", path: ["representations"] },
    registry: {},
  } as unknown as FieldProps;
  return <RepresentationOutputsField {...props} />;
}

function show(initial?: unknown, form: unknown = ON) {
  const seen: unknown[] = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.list("city", "datamodels"), {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "List",
    items: [
      {
        apiVersion: "joinedcontext.com/v1alpha1",
        kind: "DataModel",
        metadata: { name: "events", namespace: "city" },
        spec: { contextSpaceRef: "events", linkml: LINKML, version: "1.0.0" },
      },
    ],
  });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <FormProjectContext.Provider value="city">
          <FormDataContext.Provider value={form}>
            <Held initial={initial} seen={seen} />
          </FormDataContext.Provider>
        </FormProjectContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return seen;
}

const optionsOf = (select: HTMLElement) => [...select.querySelectorAll("option")].map((option) => option.getAttribute("value"));

describe("the calendar and feed outputs", () => {
  it("starts with both lists empty and says what to add", () => {
    show();
    expect(screen.getByText(o.ical.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(o.ical.emptyHint)).toBeInTheDocument();
    expect(screen.getByText(o.feed.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(o.feed.emptyHint)).toBeInTheDocument();
  });

  it("says how to turn calendars on when the Endpoint does not serve iCal, and still offers feeds", () => {
    show(undefined, { contextSpaceRef: "events", enabledRepresentations: ["ngsi-ld"] });
    expect(screen.getByText(o.icalOff)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: o.ical.add })).toBeNull();
    expect(screen.getByRole("button", { name: o.feed.add })).toBeInTheDocument();
  });

  it("adds, names, titles, narrows and removes a calendar", async () => {
    const seen = show();
    await userEvent.click(screen.getByRole("button", { name: o.ical.add }));
    expect(seen.at(-1)).toEqual({ ical: [{ name: "kalendar", sources: [{ type: "Event", preset: "sdm-event" }] }] });
    const name = screen.getByLabelText(new RegExp(`^${o.nameField.label}`));
    await userEvent.clear(name);
    await userEvent.type(name, "sport");
    await userEvent.type(screen.getByLabelText(o.title.sk), "Šport");
    await userEvent.type(screen.getByLabelText(o.filterField.label), 'eventCategory=="sport"');
    expect(seen.at(-1)).toEqual({
      ical: [{ name: "sport", title: { sk: "Šport" }, filter: { q: 'eventCategory=="sport"' }, sources: [{ type: "Event", preset: "sdm-event" }] }],
    });
    expect(screen.getByText(o.nameField.hint.replace("{address}", "ical/v1/sport.ics"))).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: o.removeNamed.replace("{name}", "Šport") }));
    expect(seen.at(-1)).toBeUndefined();
    expect(screen.getByText(o.ical.emptyTitle)).toBeInTheDocument();
  });

  it("offers the model's attributes as a dropdown and writes the picked role", async () => {
    const seen = show();
    await userEvent.click(screen.getByRole("button", { name: o.feed.add }));
    const title = screen.getByLabelText(o.roles.title);
    expect(optionsOf(title)).toEqual(expect.arrayContaining(["", "name", "startDate", "title", "location", "modifiedAt"]));
    await userEvent.selectOptions(title, "title");
    expect(seen.at(-1)).toEqual({ feed: [{ name: "novinky", sources: [{ type: "Event", preset: "event", mapping: { title: "title" } }] }] });
    await userEvent.selectOptions(screen.getByLabelText(c.start), "");
    await userEvent.selectOptions(title, "");
    expect(screen.getByRole("alert")).toHaveTextContent(c.missing.replace("{fields}", "title, updated"));
  });

  it("names a duplicate and a malformed name before the save does", async () => {
    show({ feed: [{ name: "kultura", sources: [{ type: "Event", preset: "event" }] }, { name: "kultura", sources: [{ type: "Event", preset: "event" }] }] });
    expect(screen.getByText(o.duplicate.replace("{names}", "kultura"))).toBeInTheDocument();
    expect(screen.getAllByText(o.duplicateOne)).toHaveLength(2);
    const [first] = screen.getAllByLabelText(new RegExp(`^${o.nameField.label}`));
    await userEvent.type(first!, "_");
    expect(screen.getByText(o.nameField.bad)).toBeInTheDocument();
  });

  it("adds a second model class to one output", async () => {
    const seen = show({ ical: [{ name: "kalendar", sources: [{ type: "Event" }] }] });
    await userEvent.click(screen.getByRole("button", { name: o.sourceAdd.label }));
    expect(seen.at(-1)).toEqual({ ical: [{ name: "kalendar", sources: [{ type: "Event" }, { type: "Event", preset: "sdm-event" }] }] });
    const second = screen.getByText(o.source.replace("{n}", "2").replace("{type}", "Event")).parentElement!.parentElement!;
    await userEvent.click(within(second).getByRole("button", { name: o.removeSource }));
    expect(seen.at(-1)).toEqual({ ical: [{ name: "kalendar", sources: [{ type: "Event" }] }] });
  });

  it("reads the single calendar object as the output `events` and keeps a YAML remap", () => {
    show({ ical: { preset: "sdm-event", mapping: { LOCATION: { join: ["address.streetAddress"], separator: ", " } } } });
    expect(screen.getByDisplayValue("events")).toBeInTheDocument();
    expect(screen.getByText('join: ["address.streetAddress"], separator: ,')).toBeInTheDocument();
    expect(screen.getAllByText(c.requiredBadge)).toHaveLength(4);
  });
});

describe("the attribute dropdown", () => {
  it("keeps a value written before that the model no longer offers, for the save to name", () => {
    render(<AttributeSelect id="a" value="headline" choices={["name", "url"]} empty="From the preset: name" onChange={() => undefined} />);
    expect(optionsOf(screen.getByRole("combobox"))).toEqual(["", "headline", "name", "url"]);
    expect(screen.getByRole("combobox")).toHaveValue("headline");
  });
});

describe("the output helpers", () => {
  it("reads and writes the lists as jc-core does", () => {
    expect(outputsOf(undefined)).toEqual({ ical: [], feed: [] });
    expect(outputsOf({ ical: { type: "Event" } }).ical).toEqual([{ name: "events", sources: [{ type: "Event" }] }]);
    expect(written({ other: 1, ical: {} }, { ical: [], feed: [] })).toEqual({ other: 1 });
    expect(written(undefined, { ical: [], feed: [] })).toBeUndefined();
    expect(freeName(["kalendar", "kalendar-2"], "kalendar")).toBe("kalendar-3");
    expect(isSlug("kultura-2")).toBe(true);
    expect(isSlug("Kultúra")).toBe(false);
    expect(isSlug("-x")).toBe(false);
    expect(duplicateNames([{ name: "a" }, { name: "b" }, { name: "a" }])).toEqual(["a"]);
    expect(unmappedRoles({ type: "Event", preset: "generic" })).toEqual([]);
    expect(unmappedRoles({ type: "Event" })).toEqual(["title", "updated"]);
  });

  it("reads the base preset as jc-core does", () => {
    expect(baseOf({})).toBe("sdm-event");
    expect(baseOf({ mapping: { DTSTART: "startDate" } })).toBeUndefined();
    expect(unmappedRequired({ mapping: { DTSTART: "startDate" } })).toEqual(["SUMMARY"]);
    expect(withSource({}, "URL", "  ")).toBeUndefined();
    expect(withPreset({ mapping: { URL: "url" }, preset: "sdm-event" }, "schema-org")).toEqual({ preset: "schema-org", mapping: { URL: "url" } });
  });

  it("iCalendar is opt-in: checking it writes a list, never a disabled entry", () => {
    expect(representationSpec(["ngsi-ld", "mcp", "csv", "ical"])).toEqual({ enabledRepresentations: ["csv", "ical"] });
    expect(representationSpec(["ngsi-ld", "mcp", "csv"]).disabledRepresentations).not.toContain("ical");
  });
});
