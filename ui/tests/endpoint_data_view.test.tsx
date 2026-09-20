/**
 * UI-15, UI-16, EP-07, EP-46 (T-2137, T-1433): what one Endpoint answers, read through the
 * endpoint itself.
 *
 * The columns come from the endpoint's published schema and not from the DataModel, because the
 * schema is already projected to the policy — so an attribute the steward hides is out of the
 * grid as well as out of the schema. That is the case that matters here, together with the two
 * states a person meets before any data (the schema is still being read; the endpoint publishes
 * none) and the comparison door, which only exists when the endpoint serves a space.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { EndpointDataView } from "../src/components/entities/EndpointDataView";
import { expectNoAxeViolations, json, renderPart } from "./page_contract";

const SCHEMA = {
  $defs: {
    AirQualityObserved: {
      properties: { co2: {}, temperature: {}, location: {} },
    },
    WeatherObserved: {
      properties: { temperature: {}, windSpeed: {} },
    },
  },
};

const ENTITIES = [
  {
    id: "urn:ngsi-ld:AirQualityObserved:hel:helsinki:001",
    type: "AirQualityObserved",
    co2: { type: "Property", value: 412 },
    temperature: { type: "Property", value: 19 },
  },
];

/** The endpoint's schema index, its JSON Schema, and one page of entities. */
function answer(url: URL): Response | undefined {
  if (url.pathname.endsWith("/schema/index.json")) {
    return json({ models: [{ name: "air", version: 3 }] });
  }
  if (url.pathname.endsWith("/schema/v3/json-schema")) return json(SCHEMA);
  if (url.pathname.includes("/ngsi-ld/v1/entities")) {
    return new Response(JSON.stringify(ENTITIES), {
      status: 200,
      headers: { "Content-Type": "application/json", "NGSILD-Results-Count": "1" },
    });
  }
  return undefined;
}

function show(props: Partial<React.ComponentProps<typeof EndpointDataView>> = {}, own = answer) {
  return renderPart(<EndpointDataView project="helsinki" slug="air-quality" {...props} />, {
    answer: own,
  });
}

/** Every column header the grid drew. */
const columns = () => screen.getAllByRole("columnheader").map((cell) => cell.textContent ?? "");

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("what an endpoint answers", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("says it is reading the schema before it draws anything", () => {
    show();
    expect(screen.getByRole("status")).toHaveTextContent(en.endpoints.projection.loading);
  });

  it("draws the types the endpoint publishes and reads through the endpoint itself", async () => {
    show();
    const picker = await screen.findByLabelText(en.endpoints.data.type);
    expect([...picker.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "AirQualityObserved",
      "WeatherObserved",
    ]);
    await waitFor(() => expect(screen.getByRole("grid")).toBeInTheDocument());
    const reads = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (call) => String(call[0]),
    );
    expect(reads.some((url) => url.includes("/api/endpoint/air-quality/ngsi-ld/v1/entities"))).toBe(true);
  });

  it("leaves a hidden attribute out of the columns, not only out of the schema", async () => {
    show({ hidden: ["co2"] });
    await waitFor(() => expect(screen.getByRole("grid")).toBeInTheDocument());
    expect(columns().some((header) => header.includes("temperature"))).toBe(true);
    expect(columns().some((header) => header.includes("co2"))).toBe(false);
  });

  it("reads the type a person chooses", async () => {
    const user = userEvent.setup();
    show();
    const picker = await screen.findByLabelText(en.endpoints.data.type);
    await user.selectOptions(picker, "WeatherObserved");
    await waitFor(() => expect(columns().some((header) => header.includes("windSpeed"))).toBe(true));
  });

  it("offers the comparison only where the endpoint serves a space", async () => {
    show();
    await screen.findByLabelText(en.endpoints.data.type);
    expect(screen.queryByRole("button", { name: en.endpoints.data.compare })).not.toBeInTheDocument();

    const user = userEvent.setup();
    show({ space: "ovzdusie" });
    const compare = await screen.findAllByRole("button", { name: en.endpoints.data.compare });
    await user.click(compare[compare.length - 1]);
    expect(
      await screen.findByRole("button", { name: en.endpoints.data.compareClose }),
    ).toBeInTheDocument();
  });

  it("says plainly that an endpoint publishes no schema yet", async () => {
    show({}, (url) =>
      url.pathname.endsWith("/schema/index.json")
        ? json({ models: [] })
        : url.pathname.includes("/json-schema")
          ? json({})
          : answer(url),
    );
    expect(await screen.findByText(en.endpoints.data.noSchema)).toBeInTheDocument();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });

  it("has no axe violation", async () => {
    const { container } = show({ space: "ovzdusie" });
    await waitFor(() => expect(screen.getByRole("grid")).toBeInTheDocument());
    await expectNoAxeViolations(container);
  });
});
