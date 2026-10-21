/**
 * T-4900: the Endpoint form's calendar mapping (EP-125). A row per RFC 5545 field, the preset's
 * attribute shown where none is written, the model's attributes offered, UID and DTSTAMP fixed, a
 * remap written in YAML kept as it is, and nothing written while the mapping is the default.
 */
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import type { FieldProps } from "@rjsf/utils";
import { describe, expect, it } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { queryKeys } from "../src/api/client";
import { FormDataContext } from "../src/components/forms/widgets/EntitySelectorField";
import { IcalMappingField } from "../src/components/forms/widgets/IcalMappingField";
import { FormProjectContext } from "../src/components/forms/widgets/ModelWidgets";
import { baseOf, unmappedRequired, withPreset, withSource } from "../src/components/forms/widgets/icalMapping";
import { representationSpec } from "../src/routes/EndpointsPage";

const c = en.endpoints.ical;
const LINKML = "id: x\nname: x\nclasses:\n  Event:\n    slots: [name, startDate, title]\nslots:\n  name: { required: true }\n  startDate: { range: datetime, required: true }\n  title: {}\n";

function Held({ initial, seen }: { initial?: unknown; seen: unknown[] }) {
  const [value, setValue] = useState<unknown>(initial);
  const props = {
    formData: value,
    onChange: (next: unknown) => {
      seen.push(next);
      setValue(next);
    },
    schema: { type: "object", title: "Calendar mapping" },
    fieldPathId: { $id: "root_representations", path: ["representations"] },
    registry: {},
  } as unknown as FieldProps;
  return <IcalMappingField {...props} />;
}

function show(initial?: unknown, form: unknown = { contextSpaceRef: "events", enabledRepresentations: ["ngsi-ld", "ical"] }) {
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

describe("the calendar mapping table", () => {
  it("shows the default preset's attributes and the fixed fields while nothing is written", () => {
    show();
    expect(screen.getByLabelText("DTSTART")).toHaveAttribute("placeholder", "startDate");
    expect(screen.getByLabelText("SUMMARY")).toHaveAttribute("placeholder", "name");
    expect(screen.getByText(c.fixed.replace("{attribute}", "id"))).toBeInTheDocument();
    expect(screen.getByText(c.fixed.replace("{attribute}", "modifiedAt"))).toBeInTheDocument();
    // UID, DTSTAMP, DTSTART and SUMMARY.
    expect(screen.getAllByText(c.requiredBadge)).toHaveLength(4);
    expect(screen.queryByRole("alert")).toBeNull();
    // The model's attributes and the NGSI-LD core ones are offered.
    const offered = [...document.querySelectorAll("datalist option")].map((o) => o.getAttribute("value"));
    expect(offered).toEqual(expect.arrayContaining(["name", "startDate", "title", "location", "modifiedAt"]));
  });

  it("writes an override on the preset and nothing once it is cleared", async () => {
    const seen = show();
    await userEvent.type(screen.getByLabelText("SUMMARY"), "title");
    expect(seen.at(-1)).toEqual({ ical: { preset: "sdm-event", mapping: { SUMMARY: "title" } } });
    await userEvent.clear(screen.getByLabelText("SUMMARY"));
    expect(seen.at(-1)).toBeUndefined();
  });

  it("an own mapping writes the required fields out and says which are left", async () => {
    const seen = show();
    await userEvent.selectOptions(screen.getByLabelText(c.start), c.presetOwn);
    expect(seen.at(-1)).toEqual({ ical: { mapping: { DTSTART: "startDate", SUMMARY: "name" } } });
    await userEvent.clear(screen.getByLabelText("DTSTART"));
    expect(screen.getByRole("alert")).toHaveTextContent(c.missing.replace("{fields}", "DTSTART"));
  });

  it("keeps a remap written in YAML as it is", () => {
    show({ ical: { preset: "sdm-event", mapping: { LOCATION: { join: ["address.streetAddress"], separator: ", " } } } });
    expect(screen.getByText('join: ["address.streetAddress"], separator: ,')).toBeInTheDocument();
    expect(screen.queryByLabelText("LOCATION", { selector: "input" })).toBeNull();
  });

  it("says how to turn the feed on when the Endpoint does not serve it", () => {
    show(undefined, { contextSpaceRef: "events", enabledRepresentations: ["ngsi-ld"] });
    expect(screen.getByText(c.off)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("the mapping helpers", () => {
  it("reads the base preset as jc-core does", () => {
    expect(baseOf({})).toBe("sdm-event");
    expect(baseOf({ mapping: { DTSTART: "startDate" } })).toBeUndefined();
    expect(baseOf({ preset: "schema-org", mapping: { URL: "url" } })).toBe("schema-org");
    expect(unmappedRequired({ mapping: { DTSTART: "startDate" } })).toEqual(["SUMMARY"]);
    expect(withSource({}, "URL", "  ")).toBeUndefined();
    expect(withPreset({ mapping: { URL: "url" }, preset: "sdm-event" }, "schema-org")).toEqual({ preset: "schema-org", mapping: { URL: "url" } });
  });

  it("iCalendar is opt-in: checking it writes a list, never a disabled entry", () => {
    expect(representationSpec(["ngsi-ld", "mcp", "csv", "ical"])).toEqual({ enabledRepresentations: ["csv", "ical"] });
    expect(representationSpec(["ngsi-ld", "mcp", "csv"]).disabledRepresentations).not.toContain("ical");
  });
});
