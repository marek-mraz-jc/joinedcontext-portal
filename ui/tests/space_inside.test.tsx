import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { App } from "../src/App";
import {
  entityTypesOf,
  parseResultsCount,
  pickReadEndpoint,
  spaceOf,
} from "../src/pages/spaces/SpaceInside";
import type { Manifest } from "../src/api/manifest";
import { ApiError } from "../src/api/client";
import { spaceUsageQuery, usageRefusal } from "../src/api/spaceUsage";

const IDENTITY = {
  subject: "b7c1e0f4",
  username: "jana.kovacova",
  name: "Jana Kováčová",
  email: "jana.kovacova@banskabystrica.sk",
  roles: ["portal-editor"],
};

const SLUG = "k7m2qz4tv6xh3n5jb2ryd3wcfa";

function list(items: unknown[]) {
  return { apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items };
}

function manifest(kind: string, name: string, spec: Record<string, unknown>): Manifest {
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind,
    metadata: { name, namespace: "banskabystrica" },
    spec,
  } as Manifest;
}

const SPACE = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "ContextSpace",
  metadata: {
    name: "ovzdusie",
    namespace: "banskabystrica",
    title: { sk: "Ovzdušie", en: "Air quality" },
  },
  spec: { dataModelRef: "bb-air-quality" },
  status: { phase: "Live" },
};

const MODELS = list([
  manifest("DataModel", "bb-air-quality", {
    linkml: "./bb-air-quality.linkml.yaml",
    version: "2.1.0",
    classes: ["AirQualityObserved", "AirQualityStation"],
  }),
]);

const ENDPOINTS = list([
  {
    ...manifest("Endpoint", "public-air", {
      contextSpaceRef: "ovzdusie",
      slug: SLUG,
      audience: "public",
      enabledRepresentations: [
        "ngsi-ld",
        "geojson",
        "csv",
        "xlsx",
        "zip",
        "mcp",
        "linkml",
        "jsonschema",
        "sensorthings",
        "ogc-features",
        "dcat",
      ],
      policyRef: "urn:ngsi-ld:Policy:banskabystrica.sk:ovzdusie:public-air-quality",
    }),
    status: { phase: "Live" },
  },
  manifest("Endpoint", "other-space", {
    contextSpaceRef: "doprava",
    slug: "zzzzzzzzzzzzzzzzzzzzzzzzzz",
    audience: "public",
    enabledRepresentations: ["ngsi-ld"],
  }),
]);

const POLICIES = list([
  manifest("Policy", "public-air-quality", {
    contextSpaceRef: { kind: "ContextSpace", name: "ovzdusie" },
    assignee: { kind: "role", id: "public" },
    operations: ["queryEntity", "retrieveEntity"],
    information: [{ entities: [{ type: "AirQualityObserved" }] }],
  }),
]);

const SAMPLES = [
  {
    id: "urn:ngsi-ld:AirQualityObserved:banskabystrica.sk:ovzdusie:1",
    type: "AirQualityObserved",
    pm10: 12,
    name: { languageMap: { sk: "Námestie SNP", en: "SNP Square" } },
    location: { type: "Point", coordinates: [19.14606, 48.73562] },
  },
  { id: "urn:ngsi-ld:AirQualityObserved:banskabystrica.sk:ovzdusie:2", type: "AirQualityObserved", pm10: 9 },
];

/** One call, whichever way it was made: the page sends a `Request`, the SDK grid a path (T-1434). */
function urlOf(input: unknown): URL {
  const raw = input instanceof Request ? input.url : String(input);
  return new URL(raw, window.location.origin);
}

/** The entities of the space surface, as `/cs/{space}/…` answers them for this caller (SP-06). */
const SPACE_ROWS = [
  {
    id: "urn:ngsi-ld:AirQualityObserved:banskabystrica.sk:ovzdusie:1",
    type: "AirQualityObserved",
    pm10: { type: "Property", value: 12, unitCode: "GQ" },
  },
];

function renderInside(
  gateway: { status: number; count?: number },
  surface: { status: number; rows?: unknown[] } = { status: 200 },
  seed: { space?: unknown; models?: unknown; usage?: { status: number; body: unknown } } = {},
) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = urlOf(input);
    const path = url.pathname;
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json", ...headers },
        }),
      );

    if (path.endsWith("/auth/me")) {
      return json(IDENTITY);
    }
    if (path.startsWith(`/api/endpoint/${SLUG}/ngsi-ld/v1/entities`)) {
      if (gateway.status !== 200) {
        return json({ title: "Forbidden" }, gateway.status);
      }
      if (url.searchParams.get("count") === "true") {
        return json([SAMPLES[0]], 200, { "NGSILD-Results-Count": String(gateway.count ?? 0) });
      }
      return json(SAMPLES);
    }
    // The space's own surface: the whole space, by the caller's grants (T-1434).
    if (path.startsWith("/cs/ovzdusie/ngsi-ld/v1/entities")) {
      if (surface.status !== 200) {
        return json({ title: "Not Found" }, surface.status);
      }
      return json(surface.rows ?? SPACE_ROWS, 200, {
        "NGSILD-Results-Count": String((surface.rows ?? SPACE_ROWS).length),
      });
    }
    if (path.endsWith("/spaces/ovzdusie/usage")) {
      const usage = seed.usage ?? { status: 200, body: { entities: 0, observedAt: "2026-09-25T11:40:00Z" } };
      return json(usage.body, usage.status);
    }
    if (path.endsWith("/spaces/ovzdusie")) {
      return json(seed.space ?? SPACE);
    }
    if (path.endsWith("/datamodels")) {
      return json(seed.models ?? MODELS);
    }
    if (path.endsWith("/endpoints")) {
      return json(ENDPOINTS);
    }
    if (path.endsWith("/policies")) {
      return json(POLICIES);
    }
    return json(list([]));
  });
  vi.stubGlobal("fetch", fetchMock);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

describe("a space's usage (T-2889)", () => {
  it("is kept as long as the Portal keeps it and a refusal is not retried", () => {
    const query = spaceUsageQuery("banskabystrica", "ovzdusie");
    expect(query.queryKey).toEqual(["space-usage", "banskabystrica", "ovzdusie"]);
    expect(query.staleTime).toBe(5 * 60 * 1000);
    expect(query.retry).toBe(false);
  });

  it("gives the server's reason, then the error's own words", () => {
    const refused = new ApiError(503, "Service Unavailable", {
      type: "about:blank",
      title: "Service Unavailable",
      status: 503,
      detail: "the broker answered 500",
    });
    expect(usageRefusal(refused)).toBe("the broker answered 500");
    expect(usageRefusal(new Error("offline"))).toBe("offline");
    expect(usageRefusal("nothing")).toBe("");
  });
});

describe("count header parsing", () => {
  it("reads NGSILD-Results-Count as a number, case-insensitively", () => {
    expect(parseResultsCount(new Headers({ "NGSILD-Results-Count": "42" }))).toBe(42);
    expect(parseResultsCount(new Headers({ "ngsild-results-count": " 7 " }))).toBe(7);
    expect(parseResultsCount(new Headers({ "NGSILD-Results-Count": "0" }))).toBe(0);
  });

  it("answers undefined for a missing, empty or non-numeric header", () => {
    expect(parseResultsCount(new Headers())).toBeUndefined();
    expect(parseResultsCount(new Headers({ "NGSILD-Results-Count": "" }))).toBeUndefined();
    expect(parseResultsCount(new Headers({ "NGSILD-Results-Count": "many" }))).toBeUndefined();
    expect(parseResultsCount(new Headers({ "NGSILD-Results-Count": "-1" }))).toBeUndefined();
  });
});

describe("space helpers", () => {
  it("prefers the endpoint without a policy, then the first public one", () => {
    const narrowed = manifest("Endpoint", "a", { audience: "public", policyRef: "urn:x" });
    const open = manifest("Endpoint", "b", { audience: "organization" });
    const secondPublic = manifest("Endpoint", "c", { audience: "public", policyRef: "urn:y" });
    expect(pickReadEndpoint([narrowed, open])?.metadata.name).toBe("b");
    expect(pickReadEndpoint([narrowed, secondPublic])?.metadata.name).toBe("a");
    expect(pickReadEndpoint([manifest("Endpoint", "d", { audience: "organization", policyRef: "urn:z" })])).toBeUndefined();
    expect(pickReadEndpoint([])).toBeUndefined();
  });

  it("names the space from a string ref, an object ref or the space label", () => {
    expect(spaceOf(manifest("Policy", "p", { contextSpaceRef: "ovzdusie" }))).toBe("ovzdusie");
    expect(
      spaceOf(manifest("Policy", "p", { contextSpaceRef: { kind: "ContextSpace", name: "doprava" } })),
    ).toBe("doprava");
    const labelled = manifest("Endpoint", "e", {});
    labelled.metadata.labels = { "joinedcontext.com/space": "voda" };
    expect(spaceOf(labelled)).toBe("voda");
    expect(spaceOf(manifest("Policy", "p", {}))).toBeUndefined();
  });

  it("reads entity types from spec.classes only; an inline LinkML source is not parsed (DM-56)", () => {
    expect(entityTypesOf(manifest("DataModel", "m", { classes: ["A", "B"] }))).toEqual(["A", "B"]);
    expect(
      entityTypesOf(
        manifest("DataModel", "m", {
          linkml: "id: https://x/air\nname: air\nclasses:\n  AirQualityObserved:\n    slots: []\n",
        }),
      ),
    ).toEqual([]);
    expect(entityTypesOf(manifest("DataModel", "m", { linkml: "./air.linkml.yaml" }))).toEqual([]);
  });
});

describe("space inside view", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.history.pushState({}, "", "/projects/banskabystrica/spaces/ovzdusie");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows each entity type with its live count and sample entities read through the gateway", async () => {
    const fetchMock = renderInside({ status: 200, count: 42 });

    expect(await screen.findByRole("heading", { name: "Air quality" })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: en.spaces.inside.types });
    const row = within(table).getByText("AirQualityObserved").closest("tr") as HTMLElement;
    expect(await within(row).findByText("42")).toBeInTheDocument();
    // T-2760: the entity's own name with the URN in its title and a copy button, and values a
    // person reads — not `location={"coordinates":…}` or `name={"languageMap":…}`.
    const first = within(row).getByTitle(SAMPLES[0].id);
    expect(first).toHaveTextContent(/^1$/);
    expect(within(row).getByTitle(SAMPLES[1].id)).toHaveTextContent(/^2$/);
    expect(
      within(row).getByRole("button", { name: en.spaces.inside.copyId.replace("{id}", SAMPLES[0].id) }),
    ).toBeInTheDocument();
    expect(within(row).getByText("pm10: 12 · name: SNP Square · location: Point [19.1461, 48.7356]")).toBeInTheDocument();
    expect(row.textContent).not.toMatch(/languageMap|coordinates|\{/);

    const gatewayCalls = fetchMock.mock.calls
      .map((call) => urlOf(call[0]))
      .filter((url) => url.pathname.startsWith("/api/endpoint/"));
    expect(gatewayCalls.some((url) => url.searchParams.get("count") === "true" && url.searchParams.get("limit") === "1")).toBe(true);
    expect(gatewayCalls.some((url) => url.searchParams.get("options") === "keyValues" && url.searchParams.get("limit") === "3")).toBe(true);
    expect(gatewayCalls.every((url) => url.origin === window.location.origin)).toBe(true);
  });

  // T-2889: the whole space's count, the broker's, above the per-type breakdown.
  it("says how many entities the whole space holds, and why when it cannot", async () => {
    renderInside({ status: 200, count: 42 }, { status: 200 }, {
      usage: { status: 200, body: { entities: 14232, observedAt: "2026-09-25T11:40:00Z" } },
    });
    expect(await screen.findByTestId("space-total")).toHaveTextContent("The space holds 14,232 entities.");
  });

  it("names the reason instead of a count the broker could not give", async () => {
    renderInside({ status: 200, count: 42 }, { status: 200 }, {
      usage: { status: 503, body: { title: "Service Unavailable", status: 503, detail: "the broker answered 500" } },
    });
    expect(await screen.findByTestId("space-total")).toHaveTextContent(
      i18n.t("spaces.entitiesUnknown", { reason: "the broker answered 500" }),
    );
  });

  it("takes the space's types from the model that names it, with no dataModelRef on the space", async () => {
    // How every seeded space is written: `DataModel.spec.contextSpaceRef` is required and names
    // the space, while the space's own `dataModelRef` is an optional pointer at the primary
    // model and no seed sets it. Reading only the pointer left this table empty on dev for
    // every space there is, each of them holding hundreds of entities (T-2450).
    const { dataModelRef: _pointer, ...spec } = SPACE.spec as Record<string, unknown>;
    renderInside(
      { status: 200, count: 532 },
      { status: 200 },
      {
        space: { ...SPACE, spec },
        models: list([
          manifest("DataModel", "statistical-observation", {
            contextSpaceRef: "ovzdusie",
            linkml: "./statistical-observation.linkml.yaml",
            version: "1.1.0",
            classes: ["StatisticalObservation"],
          }),
        ]),
      },
    );

    const table = await screen.findByRole("table", { name: en.spaces.inside.types });
    const row = within(table).getByText("StatisticalObservation").closest("tr") as HTMLElement;
    expect(await within(row).findByText("532")).toBeInTheDocument();
  });

  it("puts the model the space points at first, so the grid opens on it", async () => {
    renderInside(
      { status: 200, count: 1 },
      { status: 200 },
      {
        models: list([
          manifest("DataModel", "other", {
            contextSpaceRef: "ovzdusie",
            classes: ["Something"],
          }),
          manifest("DataModel", "bb-air-quality", {
            contextSpaceRef: "ovzdusie",
            classes: ["AirQualityObserved"],
          }),
        ]),
      },
    );

    const table = await screen.findByRole("table", { name: en.spaces.inside.types });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("AirQualityObserved");
    expect(rows.map((row) => row.textContent)).toHaveLength(2);
  });

  it("lists only the endpoints and policies of this space, with a catalogue link per endpoint", async () => {
    renderInside({ status: 200, count: 1 });

    const endpointRow = (await screen.findByText("public-air")).closest("tr") as HTMLElement;
    expect(within(endpointRow).getByText(en.endpoints.audience.public)).toBeInTheDocument();
    expect(within(endpointRow).getByRole("link", { name: "ngsi-ld" })).toHaveAttribute(
      "href",
      `${window.location.origin}/api/endpoint/${SLUG}/ngsi-ld/v1/types`,
    );
    expect(
      within(endpointRow).getByRole("link", { name: en.spaces.inside.catalogueLink }),
    ).toHaveAttribute("href", `https://data.${window.location.host}/dataset/public-air`);
    expect(screen.queryByText("other-space")).not.toBeInTheDocument();

    const policyRow = (await screen.findByText("public-air-quality")).closest("tr") as HTMLElement;
    expect(within(policyRow).getByText("role:public")).toBeInTheDocument();
    expect(within(policyRow).getByText("queryEntity, retrieveEntity")).toBeInTheDocument();
  });

  it("says a type is not readable anonymously when the gateway refuses", async () => {
    renderInside({ status: 403 });

    const table = await screen.findByRole("table", { name: en.spaces.inside.types });
    const row = within(table).getByText("AirQualityObserved").closest("tr") as HTMLElement;
    expect(await within(row).findByText(en.spaces.inside.notReadable)).toBeInTheDocument();
  });
});

/**
 * T-1434, SP-04, SP-06: the space itself in the grid, not one endpoint's view of it. The surface
 * answers by the caller's own grants, and a caller with none gets a 404 that says nothing about
 * whether the space exists — which is where the page points at the endpoints instead.
 */
describe("the space's own data", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.history.pushState({}, "", "/projects/banskabystrica/spaces/ovzdusie");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists the model's types and reads the space surface, never an endpoint", async () => {
    const fetchMock = renderInside({ status: 200, count: 1 });

    const chooser = await screen.findByLabelText(en.spaces.inside.dataType);
    expect(Array.from((chooser as HTMLSelectElement).options).map((option) => option.value)).toEqual([
      "AirQualityObserved",
      "AirQualityStation",
    ]);
    expect(await screen.findByText("12 µg/m³")).toBeInTheDocument();

    const reads = fetchMock.mock.calls
      .map((call) => urlOf(call[0]))
      .filter((url) => url.pathname.includes("/ngsi-ld/v1/entities"));
    const surface = reads.filter((url) => url.pathname.startsWith("/cs/ovzdusie/"));
    expect(surface).not.toHaveLength(0);
    expect(surface.every((url) => url.searchParams.get("type") === "AirQualityObserved")).toBe(true);
  });

  it("points at the endpoints when the surface answers this person nothing", async () => {
    renderInside({ status: 200, count: 1 }, { status: 404 });

    expect(await screen.findByText(en.spaces.inside.dataThroughEndpoints)).toBeInTheDocument();
    // The endpoints of this space, and not the one of another space.
    const links = screen.getAllByRole("link", { name: "public-air" });
    expect(links[0]).toHaveAttribute("href", `${window.location.origin}/api/endpoint/${SLUG}`);
    expect(screen.queryByText(en.spaces.inside.dataEmpty)).toBeNull();
  });

  it("says nothing has been written to an empty space", async () => {
    renderInside({ status: 200, count: 0 }, { status: 200, rows: [] });

    expect(await screen.findByText(en.spaces.inside.dataEmpty)).toBeInTheDocument();
  });

  it("folds an endpoint's representations into one line with a true count (T-2280)", async () => {
    renderInside({ status: 200, count: 1 });

    const endpointRow = (await screen.findByText("public-air")).closest("tr") as HTMLElement;
    const folded = within(endpointRow).getByText(/ngsi-ld, geojson/);
    // Eleven served, two named: the count is what is left, never a fixed number.
    expect(within(endpointRow).getByText("+9 more")).toBeInTheDocument();
    // One line, and everything still reachable: a `details` is closed but its content is in the page
    // and its summary takes the keyboard on its own.
    const disclosure = folded.closest("details") as HTMLDetailsElement;
    expect(disclosure).toBeTruthy();
    expect(disclosure.open).toBe(false);
    expect(within(endpointRow).getByRole("link", { name: "csv" })).toBeInTheDocument();
    expect(within(endpointRow).getByRole("link", { name: en.endpoints.link.access })).toBeInTheDocument();

    // The count is arithmetic, not a constant: eleven served minus the two named. An endpoint with
    // two or fewer therefore shows no count at all, which is the same branch (`rest > 0`).
    expect(within(endpointRow).getByText("ngsi-ld, geojson")).toBeInTheDocument();
    expect(within(endpointRow).queryByText("+11 more")).toBeNull();
  });
});
