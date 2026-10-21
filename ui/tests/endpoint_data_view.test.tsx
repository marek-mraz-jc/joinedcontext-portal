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
import { EndpointDataView, fieldsOf, sortOfLink } from "../src/components/entities/EndpointDataView";
import { expectNoAxeViolations, json, renderPart } from "./page_contract";
import type { PageHarness } from "./page_contract";

const SCHEMA = {
  $defs: {
    AirQualityObserved: {
      properties: {
        co2: {},
        temperature: { type: "number", description: "Air temperature in degrees Celsius" },
        location: {},
      },
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

function show(props: Partial<React.ComponentProps<typeof EndpointDataView>> = {}, own: PageHarness["answer"] = answer) {
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

  it("says why when the endpoint refuses its schema, instead of loading for ever", async () => {
    show({}, (url) =>
      url.pathname.endsWith("/schema/index.json")
        ? new Response(JSON.stringify({ detail: "no grant on this endpoint" }), { status: 403, headers: { "Content-Type": "application/problem+json" } })
        : answer(url),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("no grant on this endpoint");
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });

  it("has no axe violation", async () => {
    const { container } = show({ space: "ovzdusie" });
    await waitFor(() => expect(screen.getByRole("grid")).toBeInTheDocument());
    await expectNoAxeViolations(container);
  });
});

/** Every entities read the grid sent, as URLs. */
const entityReads = () =>
  (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((call) => new URL(String(call[0] instanceof Request ? call[0].url : call[0]), "http://portal.test"))
    .filter((url) => url.pathname.includes("/ngsi-ld/v1/entities"));

// T-5082: the Endpoint page's Data section. The endpoint orders the whole answer, the address holds
// what is shown, the Fields say what each column is, and the rows leave as CSV under the endpoint's
// own limits.
describe("the data section of an endpoint", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("opens a link's type, query and order, and asks the endpoint for that order", async () => {
    const links: unknown[] = [];
    show({ link: { type: "WeatherObserved", q: "temperature>20", sort: "temperature;desc" }, onLink: (next) => links.push(next) });
    await waitFor(() => expect(columns().some((header) => header.includes("windSpeed"))).toBe(true));
    await waitFor(() => expect(entityReads().some((url) => url.searchParams.get("orderBy") === "temperature;desc")).toBe(true));
    const read = entityReads().find((url) => url.searchParams.get("orderBy") === "temperature;desc");
    expect(read?.searchParams.get("q")).toBe("temperature>20");
    expect(read?.searchParams.get("type")).toBe("WeatherObserved");
    expect(links).toContainEqual({ type: "WeatherObserved", q: "temperature>20", sort: "temperature;desc" });
  });

  it("sorts every row through the endpoint and writes the order into the link", async () => {
    const user = userEvent.setup();
    const links: { sort?: string }[] = [];
    show({ onLink: (next) => links.push(next) });
    const header = await screen.findByRole("button", { name: `${en.entityGrid.sortAll} temperature` });
    await user.click(header);
    await waitFor(() => expect(entityReads().at(-1)?.searchParams.get("orderBy")).toBe("temperature"));
    expect(entityReads().at(-1)?.searchParams.has("offset")).toBe(false);
    await waitFor(() => expect(links.at(-1)?.sort).toBe("temperature"));
  });

  it("keeps an order a link names only for a column of the type", () => {
    expect(sortOfLink("temperature;desc", ["temperature"])).toEqual({ attr: "temperature", dir: "desc" });
    expect(sortOfLink("id", ["temperature"])).toEqual({ attr: "id", dir: "asc" });
    expect(sortOfLink("secret", ["temperature"])).toBeNull();
    expect(sortOfLink("temperature;sideways", ["temperature"])).toBeNull();
    expect(sortOfLink("temperature;desc;x", ["temperature"])).toBeNull();
    expect(sortOfLink(undefined, ["temperature"])).toBeNull();
  });

  it("names each field's type and description from the schema", async () => {
    expect(fieldsOf(SCHEMA.$defs.AirQualityObserved, ["co2", "temperature"])).toEqual([
      { name: "co2", kind: "", description: "" },
      { name: "temperature", kind: "number", description: "Air temperature in degrees Celsius" },
    ]);
    expect(fieldsOf({ properties: { at: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] } } }, ["at"])).toEqual([
      { name: "at", kind: "date-time", description: "" },
    ]);
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByText(en.endpoints.data.fields, { selector: "summary" }));
    expect(await screen.findByText("Air temperature in degrees Celsius")).toBeVisible();
    expect(screen.getAllByText(en.endpoints.data.noDescription).length).toBeGreaterThan(0);
  });

  it("downloads the rows of the current query and order, only where the endpoint serves CSV", async () => {
    show({ link: { q: "co2>400", sort: "co2;desc" } });
    await waitFor(() => expect(screen.getByRole("grid")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: en.endpoints.data.csv })).not.toBeInTheDocument();

    show({ link: { q: "co2>400", sort: "co2;desc" }, csv: true });
    const link = await screen.findByRole("link", { name: en.endpoints.data.csv });
    const href = new URL(link.getAttribute("href") ?? "", "http://portal.test");
    expect(href.pathname).toBe("/api/endpoint/air-quality/file.csv");
    expect(Object.fromEntries(href.searchParams)).toEqual({ type: "AirQualityObserved", q: "co2>400", orderBy: "co2;desc" });
  });

  it("opens and leaves the full window, by the button and by Escape", async () => {
    const user = userEvent.setup();
    show();
    const full = await screen.findByRole("button", { name: en.endpoints.data.full });
    expect(full).toHaveAttribute("aria-pressed", "false");
    await user.click(full);
    expect(screen.getByRole("dialog", { name: en.endpoints.data.title })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.endpoints.data.fullLeave })).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reads another origin without a cookie or token when the catalogue hosts it (T-5082)", async () => {
    const asked: Request[] = [];
    show({ origin: "https://api.example.test", csv: true }, (url, request) => {
      asked.push(request);
      return answer(url);
    });
    await waitFor(() => expect(screen.getByRole("grid")).toBeInTheDocument());
    await waitFor(() => expect(asked.some((each) => each.url.includes("/ngsi-ld/v1/entities"))).toBe(true));
    for (const request of asked) {
      expect(new URL(request.url).origin).toBe("https://api.example.test");
      expect(request.url).toContain("/api/endpoint/air-quality/");
      expect(request.credentials).not.toBe("include");
      expect(request.headers.get("authorization")).toBeNull();
    }
    const link = await screen.findByRole("link", { name: en.endpoints.data.csv });
    expect(new URL(link.getAttribute("href") ?? "").origin).toBe("https://api.example.test");
  });
});
