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
import { filtersFromQ } from "../src/components/entities/presetFilters";
import type { FilterColumn } from "@joinedcontext/sdk";
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
    expect(columns().some((header) => header.includes("Temperature"))).toBe(true);
    expect(columns().some((header) => header.includes("Co2"))).toBe(false);
  });

  it("reads the type a person chooses", async () => {
    const user = userEvent.setup();
    show();
    const picker = await screen.findByLabelText(en.endpoints.data.type);
    await user.selectOptions(picker, "WeatherObserved");
    await waitFor(() => expect(columns().some((header) => header.includes("Wind speed"))).toBe(true));
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
    await waitFor(() => expect(columns().some((header) => header.includes("Wind speed"))).toBe(true));
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
    const header = await screen.findByRole("button", { name: `${en.entityGrid.sortAll} Temperature` });
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

// T-5192: the catalogue's events table, named and ordered by the published model.
const EVENT_SCHEMA = {
  definitions: {
    Event: {
      properties: {
        dataProvider: { type: "string" },
        location: { type: "object" },
        name: { type: "string" },
        startDate: { type: "string" },
        url: { type: "string", format: "uri" },
      },
    },
  },
};
// As Model Tools publishes it: class attributes with ranks, labels as JSON text in the annotation.
const EVENT_MODEL = `
id: https://example.test/events
name: events
classes:
  Event:
    annotations:
      view_order_by: {tag: view_order_by, value: startDate}
      view_upcoming: {tag: view_upcoming, value: startDate}
    attributes:
      dataProvider:
        range: string
      location:
        rank: 3
        annotations:
          ngsi_ld_kind: {tag: ngsi_ld_kind, value: GeoProperty}
      name:
        rank: 1
        annotations:
          label: {tag: label, value: '{"sk": "Názov", "en": "Name"}'}
      startDate:
        rank: 2
        annotations:
          label: {tag: label, value: '{"sk": "Začiatok", "en": "Start"}'}
      url:
        rank: 4
        annotations:
          label: {tag: label, value: '{"sk": "Web", "en": "Web page"}'}
`;
const EVENTS = [
  { id: "urn:ngsi-ld:Event:a", type: "Event", name: { type: "Property", value: "Koncert" }, startDate: { type: "Property", value: "2026-11-14T19:00:00+01:00" }, url: { type: "Property", value: "https://example.test/koncert" }, dataProvider: { type: "Property", value: "Mesto (licencia neuvedená)" } },
  { id: "urn:ngsi-ld:Event:b", type: "Event", name: { type: "Property", value: "Zlý odkaz" }, url: { type: "Property", value: "javascript:alert(1)" } },
];

function eventAnswer(asked: URL[]) {
  return (url: URL): Response | undefined => {
    asked.push(url);
    if (url.pathname.endsWith("/schema/index.json")) return json({ models: [{ name: "events", version: 1 }] });
    if (url.pathname.endsWith("/schema/v1/json-schema")) return json(EVENT_SCHEMA);
    if (url.pathname.endsWith("/schema/v1/model.linkml.yaml")) return new Response(EVENT_MODEL, { status: 200, headers: { "Content-Type": "text/yaml" } });
    if (url.pathname.includes("/ngsi-ld/v1/entities")) {
      return new Response(JSON.stringify(EVENTS), { status: 200, headers: { "Content-Type": "application/json", "NGSILD-Results-Count": "2" } });
    }
    return undefined;
  };
}

describe("the Event column model (T-5192)", () => {
  it("orders by rank, labels from the model, shows the ranked slots and leaves the GeoProperty to the map", async () => {
    const { parseModel, classSlots } = await import("../src/pages/models/linkml");
    const { columnModel } = await import("../src/components/entities/EndpointDataView");
    const model = parseModel(EVENT_MODEL);
    const slots = classSlots(model, model.classes[0]);
    const attrs = Object.keys(EVENT_SCHEMA.definitions.Event.properties);
    const sk = columnModel(slots, attrs, "sk");
    expect(sk.order.slice(0, 4)).toEqual(["name", "startDate", "location", "url"]);
    expect(sk.shown).toEqual(["name", "startDate", "url"]);
    expect(sk.labels).toMatchObject({ name: "Názov", startDate: "Začiatok", url: "Web" });
    expect(columnModel(slots, attrs, "en").labels.startDate).toBe("Start");
    // Without a model nothing is reordered or hidden; titles come from field-order.json, else the name.
    expect(columnModel([], ["url", "fooBar"], "sk")).toEqual({ order: ["url", "fooBar"], shown: ["url", "fooBar"], labels: { url: "Odkaz", fooBar: "Foo bar" }, widths: {} });
  });

  it("DM-133: opens where the class's model says, for any type, and ignores what the endpoint does not answer", async () => {
    const { modelView } = await import("../src/components/entities/EndpointDataView");
    expect(modelView({ upcoming: "startDate" }, ["name", "startDate"], "2026-10-22")).toEqual({
      filterText: '!startDate|startDate>="2026-10-22"',
      sort: { attr: "startDate", dir: "asc" },
    });
    expect(modelView({ orderBy: "pm10;desc" }, ["pm10"], "2026-10-22")).toEqual({ filterText: null, sort: { attr: "pm10", dir: "desc" } });
    expect(modelView({ orderBy: "x;drop table", upcoming: "gone" }, ["pm10"], "2026-10-22")).toBeNull();
    expect(modelView(undefined, ["startDate"], "2026-10-22")).toBeNull();
  });

  it("draws the model's labels, asks for upcoming events and links only an http(s) address", async () => {
    await i18n.changeLanguage("sk");
    const asked: URL[] = [];
    show({ slug: "events", project: "catalogue" }, eventAnswer(asked));
    await waitFor(() => expect(columns().some((header) => header.includes("Začiatok"))).toBe(true));
    const headers = columns();
    expect(headers.some((header) => header.includes("dataProvider"))).toBe(false);
    expect(headers.findIndex((h) => h.includes("Názov"))).toBeLessThan(headers.findIndex((h) => h.includes("Začiatok")));
    await waitFor(() => expect(asked.some((url) => url.searchParams.get("orderBy") === "startDate")).toBe(true));
    const read = asked.find((url) => url.searchParams.get("orderBy") === "startDate");
    expect(read?.searchParams.get("q")).toMatch(/^!startDate\|startDate>="\d{4}-\d{2}-\d{2}"$/);
    const links = await screen.findAllByRole("link", { name: "Otvoriť stránku" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://example.test/koncert");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("javascript:alert(1)").closest("a")).toBeNull();
    await i18n.changeLanguage("en");
  });

  it("puts a column back from the Columns list", async () => {
    await i18n.changeLanguage("en");
    const user = userEvent.setup();
    show({ slug: "events", project: "catalogue" }, eventAnswer([]));
    await user.click(await screen.findByText(en.endpoints.data.fields, { selector: "summary" }));
    const box = await screen.findByRole("checkbox", { name: "Provider" });
    expect(box).not.toBeChecked();
    await user.click(box);
    await waitFor(() => expect(columns().some((header) => header.includes("Provider"))).toBe(true));
  });
});

// Owner 2026-10-22T08:05Z: one generic viewer; no type's name decides anything in its code.
describe("the data view names no type (T-5192)", () => {
  it("has no type-name literal in the view, the grid or the explorer entry", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["src/components/entities/EndpointDataView.tsx", "src/explorer/main.tsx", "../sdk/src/grid/EntityGrid.tsx"]) {
      const code = readFileSync(file, "utf8");
      expect(code).not.toMatch(/["'`](Event|AirQualityObserved|Vehicle|BikeHireDockingStation|OffStreetParking|startDate)["'`]/);
    }
  });
});

// DM-134 (T-5196): the presentation of a table comes from the model's annotations, never from code.
const PRESENTED_MODEL = EVENT_MODEL.replace(
  "      view_upcoming: {tag: view_upcoming, value: startDate}",
  [
    "      view_filter: {tag: view_filter, value: startDate>=today}",
    "      view_page_length: {tag: view_page_length, value: 10}",
    "      view_columns: {tag: view_columns, value: 'startDate, name, dataProvider'}",
  ].join("\n"),
).replace(
  "          label: {tag: label, value: '{\"sk\": \"Web\", \"en\": \"Web page\"}'}",
  "          label: {tag: label, value: '{\"sk\": \"Web\", \"en\": \"Web page\"}'}\n          view_width: {tag: view_width, value: 16}\n          view_role: {tag: view_role, value: link}",
).replace(
  "      dataProvider:\n        range: string",
  "      dataProvider:\n        range: string\n        annotations:\n          view_hidden: {tag: view_hidden, value: 'true'}\n          view_role: {tag: view_role, value: title}",
);
const PRESENTED_SCHEMA = {
  definitions: { Event: { properties: { ...EVENT_SCHEMA.definitions.Event.properties, startDate: { type: "string", format: "date-time" } } } },
};

function presentedAnswer(asked: URL[]) {
  const events = eventAnswer(asked);
  return (url: URL): Response | undefined => {
    if (url.pathname.endsWith("/schema/v1/json-schema")) return json(PRESENTED_SCHEMA);
    if (url.pathname.endsWith("/schema/v1/model.linkml.yaml")) return new Response(PRESENTED_MODEL, { status: 200, headers: { "Content-Type": "text/yaml" } });
    return events(url);
  };
}

describe("the presentation chain (DM-134, T-5196)", () => {
  it("DM-134: the presentation resolves from the model's annotations, then labels, then field-order.json, then the name", async () => {
    const { parseModel, classSlots } = await import("../src/pages/models/linkml");
    const { columnModel } = await import("../src/components/entities/EndpointDataView");
    const model = parseModel(PRESENTED_MODEL);
    const klass = model.classes[0];
    expect(klass.view).toEqual({ orderBy: "startDate", filter: "startDate>=today", pageLength: 10, columns: ["startDate", "name", "dataProvider"] });
    const slots = classSlots(model, klass);
    const attrs = Object.keys(EVENT_SCHEMA.definitions.Event.properties);
    const shape = columnModel(slots, attrs, "sk", klass.view?.columns);
    // view_columns orders and picks; view_hidden wins over it; the rest follows in rank order.
    expect(shape.shown).toEqual(["startDate", "name"]);
    expect(shape.order.slice(0, 3)).toEqual(["startDate", "name", "dataProvider"]);
    expect(shape.widths).toEqual({ url: 16 * 8 + 24 });
    expect(shape.title).toBe("dataProvider");
    // 1 model label, 3 field-order.json (`url` has no model label without the annotation), 4 the name made readable.
    expect(shape.labels.startDate).toBe("Začiatok");
    expect(columnModel([], ["url", "fooBar"], "sk").labels).toEqual({ url: "Odkaz", fooBar: "Foo bar" });
    // 2 the model's title when it has no label annotation.
    const titled = parseModel("classes:\n  T:\n    attributes:\n      speed:\n        rank: 1\n        title: {sk: Rýchlosť, en: Speed}\n");
    expect(columnModel(classSlots(titled, titled.classes[0]), ["speed"], "sk").labels.speed).toBe("Rýchlosť");
    // A value out of range is no presentation at all.
    const wrong = parseModel(
      "classes:\n  T:\n    annotations:\n      view_page_length: 7\n    attributes:\n      a:\n        annotations:\n          view_width: 500\n          view_role: script\n",
    );
    expect(wrong.classes[0].view).toBeUndefined();
    expect(classSlots(wrong, wrong.classes[0])[0]).not.toHaveProperty("width");
    expect(classSlots(wrong, wrong.classes[0])[0]).not.toHaveProperty("role");
  });

  it("resolves today in the reader's calendar and keeps only a default filter that names the type's columns", async () => {
    const { presetView, relativeDates } = await import("../src/components/entities/EndpointDataView");
    const day = new Date(2026, 9, 31, 23, 30);
    expect(relativeDates('startDate>=today;endDate<="today+1d";x>today-31d', day)).toBe('startDate>=2026-10-31;endDate<="2026-11-01";x>2026-09-30');
    const columns = [{ attr: "startDate", format: "date" as const }, { attr: "name", format: "text" as const }];
    expect(presetView({ filter: "startDate>=today", orderBy: "startDate" }, columns, {}, day)).toEqual({
      filterText: null,
      filters: { startDate: { op: "gte", value: "2026-10-31" } },
      sort: { attr: "startDate", dir: "asc" },
    });
    // An OR has no one-input-per-column form: it opens as text the reader can clear.
    expect(presetView({ filter: 'name=="a"|name=="b"' }, columns, {}, day)).toEqual({ filterText: 'name=="a"|name=="b"', sort: null });
    // A column the endpoint does not answer, or a q the parser refuses, is ignored.
    expect(presetView({ filter: "secret==1" }, columns, {}, day)).toBeNull();
    expect(presetView({ filter: "name==(" }, columns, {}, day)).toBeNull();
  });

  it("pre-fills the inputs from the default filter, narrows the rows, and reset clears them", async () => {
    await i18n.changeLanguage("sk");
    const user = userEvent.setup();
    const asked: URL[] = [];
    show({ slug: "events", project: "catalogue" }, presentedAnswer(asked));
    const op = await screen.findByRole("combobox", { name: /^Filter.*: Začiatok$/ });
    await waitFor(() => expect(op).toHaveValue("gte"));
    await waitFor(() => expect(asked.some((url) => /^startDate>=\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("q") ?? ""))).toBe(true));
    expect(asked.find((url) => url.searchParams.get("q"))?.searchParams.get("limit")).toBe("10");
    expect(screen.getByRole("combobox", { name: "Záznamov na stranu" })).toHaveValue("10");
    const before = asked.length;
    await user.click(screen.getByRole("button", { name: "Zrušiť filtre" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: /^Filter.*: Začiatok$/ })).toHaveValue(""));
    await waitFor(() => expect(asked.slice(before).some((url) => url.pathname.includes("/entities") && !url.searchParams.get("q"))).toBe(true));
    expect(screen.queryByRole("button", { name: "Zrušiť filtre" })).toBeNull();
    await i18n.changeLanguage("en");
  });
});

describe("filtersFromQ: a default filter as the filter row's inputs (DM-134)", () => {
  const columns: FilterColumn[] = [
    { key: "startDate", attr: "startDate", kind: "date" },
    { key: "name", attr: "name", kind: "text" },
    { key: "category", attr: "category", kind: "enum", options: [] },
  ];
  it("fills one input per column, a range on one column as between, an enum as its picked values", () => {
    expect(filtersFromQ('startDate>=2026-10-22;startDate<=2026-10-31;name=="Koncert";category=="a","b"', columns)).toEqual({
      startDate: { op: "between", value: "2026-10-22", value2: "2026-10-31" },
      name: { op: "equals", value: "Koncert" },
      category: { op: "anyOf", value: "", values: ["a", "b"] },
    });
    expect(filtersFromQ("name", columns)).toEqual({ name: { op: "present", value: "" } });
  });
  it("answers null for what one input per column cannot hold", () => {
    for (const q of ["name==\"a\"|name==\"b\"", "startDate.observedAt>2026-01-01", "missing==1", 'name~="a"', "startDate>=2026-01-01;startDate>=2026-02-01", "(name)", "name>\"a\""]) {
      expect(filtersFromQ(q, columns), q).toBeNull();
    }
  });
});
