import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { App } from "../src/App";
import { inTurn } from "../src/pages/spaces/SpaceInside";
import { entityTypesOf, parseResultsCount, pickReadEndpoint, spaceOf } from "../src/pages/spaces/spaceFacts";
import type { Manifest } from "../src/api/manifest";
import { ApiError } from "../src/api/client";
import { spaceUsageQuery, usageRefusal } from "../src/api/spaceUsage";
import { readLayout, writeLayout } from "../src/components/entities/viewLayout";

const IDENTITY = {
  subject: "b7c1e0f4",
  username: "jana.kovacova",
  name: "Jana Kováčová",
  email: "jana.kovacova@banskabystrica.sk",
  roles: ["portal-editor"],
};

/** Opens one tab of the space's page (T-4825: the page lands on the rows). */
async function openTab(name: string) {
  await userEvent.click(await screen.findByRole("tab", { name }));
}

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
      publish: { ckan: { instanceRef: { kind: "CkanInstance", name: "bb-open-data" } } },
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

/** The catalogue `public-air` publishes to: its link is this site, not one guessed (T-3018). */
const CATALOGUES = list([
  manifest("CkanInstance", "bb-open-data", {
    url: "https://data.city.example/",
    secretRef: { name: "ckan-token" },
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
  surface: { status: number; rows?: unknown[]; answer?: (url: URL) => unknown[]; holdProbe?: boolean } = { status: 200 },
  seed: {
    space?: unknown;
    models?: unknown;
    endpoints?: unknown;
    usage?: { status: number; body: unknown };
    /** The model's committed LinkML source, which the space's data reads for its field rules. */
    source?: string;
    /** The saved data views of the space (API/01 §30). */
    views?: unknown[];
    /** What the endpoint's gateway answers for the caller's grants (EP-55). */
    access?: unknown;
  } = {},
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
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
    if (path === `/api/endpoint/${SLUG}/access`) {
      return json(seed.access ?? { permissions: [] });
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
      if (surface.holdProbe && url.searchParams.get("limit") === "1") {
        return new Promise<Response>(() => undefined);
      }
      if (surface.status !== 200) {
        return json({ title: "Not Found" }, surface.status);
      }
      const answered = surface.answer?.(url) ?? surface.rows ?? SPACE_ROWS;
      return json(answered, 200, { "NGSILD-Results-Count": String(answered.length) });
    }
    if (path.endsWith("/spaces/ovzdusie/usage")) {
      const usage = seed.usage ?? { status: 200, body: { entities: 0, broker: "main", observedAt: "2026-09-25T11:40:00Z" } };
      return json(usage.body, usage.status);
    }
    if (path.endsWith("/spaces/ovzdusie")) {
      return json(seed.space ?? SPACE);
    }
    if (path.endsWith("/spaces/ovzdusie/views")) {
      return json({ items: seed.views ?? [] });
    }
    if (path.endsWith("/datamodels/bb-air-quality/source") && seed.source !== undefined) {
      return Promise.resolve(new Response(seed.source, { status: 200, headers: { "Content-Type": "text/yaml" } }));
    }
    if (path.endsWith("/datamodels")) {
      return json(seed.models ?? MODELS);
    }
    if (path.endsWith("/endpoints")) {
      return json(seed.endpoints ?? ENDPOINTS);
    }
    if (path.endsWith("/ckaninstances")) {
      return json(CATALOGUES);
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

  it("reads through the space's own endpoint before an App's (T-5604)", () => {
    const app = {
      ...manifest("Endpoint", "app-air-quality", { audience: "project-list", callerRole: true }),
      metadata: { name: "app-air-quality", namespace: "banskabystrica", annotations: { "joinedcontext.com/generated-by": "portal/app-reconciler" } },
    } as Manifest;
    const own = manifest("Endpoint", "air-quality", { audience: "public", policyRef: "urn:x" });
    expect(pickReadEndpoint([app, own], ["banskabystrica"], "banskabystrica")?.metadata.name).toBe("air-quality");
    expect(pickReadEndpoint([app, own])?.metadata.name).toBe("air-quality");
    // An App's endpoint is still read when the space offers the person nothing else.
    expect(pickReadEndpoint([app], ["banskabystrica"], "banskabystrica")?.metadata.name).toBe("app-air-quality");
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
    await openTab(en.spaces.inside.model);
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

  // T-5598: the probe of the space surface no longer stands in front of the grid's own read, one
  // round trip on a phone's network; a refusal still replaces the grid (the tests below).
  it("reads and draws the rows while the probe of the space surface is still on its way", async () => {
    const fetchMock = renderInside({ status: 200, count: 42 }, { status: 200, holdProbe: true });
    expect(await screen.findByRole("button", { name: /^Open: / })).toBeInTheDocument();
    const surfaceReads = fetchMock.mock.calls
      .map((call) => urlOf(call[0]))
      .filter((url) => url.pathname.startsWith("/cs/ovzdusie/ngsi-ld/v1/entities"));
    expect(surfaceReads.map((url) => url.searchParams.get("limit"))).toEqual(expect.arrayContaining(["1", "100"]));
  });

  // T-2889: the whole space's count, the broker's, under the per-type breakdown on the model tab (T-4885).
  it("says how many entities the whole space holds, and why when it cannot", async () => {
    renderInside({ status: 200, count: 42 }, { status: 200 }, {
      usage: { status: 200, body: { entities: 14232, broker: "canary", observedAt: "2026-09-25T11:40:00Z" } },
    });
    await openTab(en.spaces.inside.model);
    expect(await screen.findByTestId("space-total")).toHaveTextContent("The space holds 14,232 entities.");
    // PF-116: the space's page names the broker it lives on.
    expect(screen.getByTestId("space-broker")).toHaveTextContent("It lives on the context broker canary.");
  });

  // T-2890: the size the broker measured, whole and per type, in binary units; none without it.
  it("says what the space takes in the store and each type's share, and no size when unmeasured", async () => {
    renderInside({ status: 200, count: 42 }, { status: 200 }, {
      usage: {
        status: 200,
        body: {
          entities: 42,
          broker: "main",
          observedAt: "2026-09-25T11:40:00Z",
          bytes: {
            entities: 3 * 1024 * 1024,
            attrInstances: 1024 * 1024,
            byType: { "https://smartdatamodels.org/dataModel.Environment/AirQualityObserved": 3 * 1024 * 1024 },
          },
        },
      },
    });
    await openTab(en.spaces.inside.model);
    const size = await screen.findByTestId("space-size");
    expect(size).toHaveTextContent(i18n.t("spaces.inside.totalSize", { size: "4 MiB", history: "1 MiB" }));
    expect(size).toHaveAttribute("title", "4,194,304 B");
    const table = await screen.findByRole("table", { name: en.spaces.inside.types });
    const row = within(table).getByText("AirQualityObserved").closest("tr") as HTMLElement;
    expect(within(row).getByTitle("3,145,728 B")).toHaveTextContent("3 MiB");
  });

  it("shows no size, never a zero, when the broker did not measure one", async () => {
    renderInside({ status: 200, count: 42 }, { status: 200 }, {
      usage: { status: 200, body: { entities: 42, broker: "main", observedAt: "2026-09-25T11:40:00Z" } },
    });
    await openTab(en.spaces.inside.model);
    expect(await screen.findByTestId("space-total")).toBeInTheDocument();
    expect(screen.queryByTestId("space-size")).toBeNull();
    const table = await screen.findByRole("table", { name: en.spaces.inside.types });
    const row = within(table).getByText("AirQualityObserved").closest("tr") as HTMLElement;
    expect(row.textContent).not.toMatch(/\d B|KiB|MiB/);
  });

  it("names the reason instead of a count the broker could not give", async () => {
    renderInside({ status: 200, count: 42 }, { status: 200 }, {
      usage: { status: 503, body: { title: "Service Unavailable", status: 503, detail: "the broker answered 500" } },
    });
    await openTab(en.spaces.inside.model);
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

    await openTab(en.spaces.inside.model);
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

    await openTab(en.spaces.inside.model);
    const table = await screen.findByRole("table", { name: en.spaces.inside.types });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("AirQualityObserved");
    expect(rows.map((row) => row.textContent)).toHaveLength(2);
  });

  it("says an endpoint that publishes to no catalogue is not published, and links nowhere", async () => {
    const unpublished = {
      ...manifest("Endpoint", "public-air", {
        contextSpaceRef: "ovzdusie",
        slug: SLUG,
        audience: "public",
        enabledRepresentations: ["ngsi-ld"],
      }),
      status: { phase: "Live" },
    };
    renderInside({ status: 200, count: 1 }, { status: 200 }, { endpoints: list([unpublished]) });

    await openTab(en.endpoints.title);
    const endpointRow = (await screen.findByText("public-air")).closest("tr") as HTMLElement;
    expect(within(endpointRow).getByText(en.spaces.inside.notPublished)).toBeInTheDocument();
    expect(
      within(endpointRow).queryByRole("link", { name: en.spaces.inside.catalogueLink }),
    ).not.toBeInTheDocument();
  });

  it("lists only the endpoints and policies of this space, with a catalogue link per published endpoint", async () => {
    renderInside({ status: 200, count: 1 });

    await openTab(en.endpoints.title);
    const endpointRow = (await screen.findByText("public-air")).closest("tr") as HTMLElement;
    expect(within(endpointRow).getByText(en.endpoints.audience.public)).toBeInTheDocument();
    expect(within(endpointRow).getByRole("link", { name: "ngsi-ld" })).toHaveAttribute(
      "href",
      `${window.location.origin}/api/endpoint/${SLUG}/ngsi-ld/v1/types`,
    );
    // The dataset on its CkanInstance's own site (T-3018).
    expect(
      await within(endpointRow).findByRole("link", { name: en.spaces.inside.catalogueLink }),
    ).toHaveAttribute("href", "https://data.city.example/dataset/public-air");
    expect(screen.queryByText("other-space")).not.toBeInTheDocument();

    await openTab(en.spaces.inside.policies);
    const policyRow = (await screen.findByText("public-air-quality")).closest("tr") as HTMLElement;
    expect(within(policyRow).getByText("role:public")).toBeInTheDocument();
    expect(within(policyRow).getByText("queryEntity, retrieveEntity")).toBeInTheDocument();
  });

  it("says a type's read met the endpoint's rate limit, with a retry, and not that it is unreadable (T-3161)", async () => {
    const fetchMock = renderInside({ status: 429 });
    await openTab(en.spaces.inside.model);
    const table = await screen.findByRole("table", { name: en.spaces.inside.types });
    const row = within(table).getByText("AirQualityObserved").closest("tr") as HTMLElement;
    expect(await within(row).findByText(en.spaces.inside.tooMany)).toBeInTheDocument();
    const before = fetchMock.mock.calls.length;
    await userEvent.click(within(row).getByRole("button", { name: en.app.error.retry }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });

  it("asks one endpoint one question at a time, so its rate limit is not met at once (T-3161)", async () => {
    let open = 0;
    let most = 0;
    const read = () =>
      inTurn("slug-a", async () => {
        open += 1;
        most = Math.max(most, open);
        await new Promise((resolve) => setTimeout(resolve, 5));
        open -= 1;
      });
    await Promise.all([read(), read(), read(), inTurn("slug-a", () => Promise.reject(new Error("x"))).catch(() => undefined), read()]);
    expect(most).toBe(1);
  });

  it("says a type is not readable anonymously when the gateway refuses", async () => {
    renderInside({ status: 403 });

    await openTab(en.spaces.inside.model);
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

    const list = await screen.findByRole("navigation", { name: en.spaces.inside.types });
    const types = within(list).getAllByRole("button").filter((button) => button.title !== "");
    expect(types.map((button) => button.title)).toEqual(["AirQualityObserved", "AirQualityStation"]);
    expect(await screen.findByText("12 µg/m³")).toBeInTheDocument();

    const reads = fetchMock.mock.calls
      .map((call) => urlOf(call[0]))
      .filter((url) => url.pathname.includes("/ngsi-ld/v1/entities"));
    const surface = reads.filter((url) => url.pathname.startsWith("/cs/ovzdusie/"));
    expect(surface).not.toHaveLength(0);
    expect(surface.every((url) => url.searchParams.get("type") === "AirQualityObserved")).toBe(true);
  });

  it("offers the types as a picker above the grid for a phone, and picking one reads that type (T-4992)", async () => {
    const fetchMock = renderInside({ status: 200, count: 1 });

    const picker = await screen.findByRole("combobox", { name: en.spaces.inside.type });
    expect(picker).toHaveAccessibleDescription(en.spaces.inside.typeHint);
    expect(within(picker).getAllByRole("option").map((option) => (option as HTMLOptionElement).value)).toEqual([
      "AirQualityObserved",
      "AirQualityStation",
    ]);
    expect(picker).toHaveValue("AirQualityObserved");

    fetchMock.mockClear();
    await userEvent.selectOptions(picker, "AirQualityStation");
    expect(picker).toHaveValue("AirQualityStation");
    await waitFor(() =>
      expect(
        fetchMock.mock.calls
          .map((call) => urlOf(call[0]))
          .some((url) => url.pathname.startsWith("/cs/ovzdusie/") && url.searchParams.get("type") === "AirQualityStation"),
      ).toBe(true),
    );
    // The list beside the grid follows the picker, for the width that shows it.
    const list = screen.getByRole("navigation", { name: en.spaces.inside.types });
    expect(within(list).getByTitle("AirQualityStation")).toHaveAttribute("aria-current", "true");
  });

  it("shows the same entities as cards, read through the space surface (T-3100)", async () => {
    const fetchMock = renderInside({ status: 200, count: 1 });
    await userEvent.click(await screen.findByRole("tab", { name: en.spaces.views.kind.gallery }));
    const gallery = await screen.findByTestId("view-gallery");
    expect(within(gallery).getByRole("button", { name: SPACE_ROWS[0].id })).toBeInTheDocument();
    const reads = fetchMock.mock.calls
      .map((call) => urlOf(call[0]))
      .filter((url) => url.pathname.startsWith("/cs/ovzdusie/ngsi-ld/v1/entities"));
    expect(reads.some((url) => url.searchParams.get("limit") === "500")).toBe(true);
  });

  // T-5093: every view keeps one toolbar row; the type's actions sit in its More, not stacked above the view.
  it("keeps a non-grid view's actions in the one toolbar row", async () => {
    renderInside({ status: 200, count: 1 }, { status: 200 }, {
      source: "name: bb-air-quality\nclasses:\n  AirQualityObserved:\n    attributes:\n      no2: { range: float }\n",
    });
    await userEvent.click(await screen.findByRole("tab", { name: en.spaces.views.kind.gallery }));
    await screen.findByTestId("view-gallery");
    const toolbar = screen.getByTestId("grid-toolbar");
    const add = screen.getByRole("button", { name: en.spaces.fields.add });
    expect(toolbar).toContainElement(add);
    expect(within(toolbar).getByText(en.spaces.toolbar.more)).toBeInTheDocument();
    // The grid's own tools stay with the grid.
    expect(within(toolbar).queryByRole("button", { name: en.spaces.toolbar.query })).toBeNull();
  });

  it("folds the grid's query behind the toolbar's Query toggle (T-5093)", async () => {
    renderInside({ status: 200, count: 1 });
    expect(await screen.findByText("12 µg/m³")).toBeInTheDocument();
    expect(screen.queryByLabelText(en.entityGrid.editAsText)).toBeNull();
    const toggle = screen.getByRole("button", { name: en.spaces.toolbar.query });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByLabelText(en.entityGrid.editAsText)).toBeInTheDocument();
  });

  it("reads a view's rows again when the space says entities of its type changed (T-3105)", async () => {
    const opened: FakeEventSource[] = [];
    class FakeEventSource {
      listeners: Record<string, ((event: MessageEvent<string>) => void)[]> = {};
      closed = false;
      constructor(readonly url: string) {
        opened.push(this);
      }
      addEventListener(name: string, listener: (event: MessageEvent<string>) => void) {
        (this.listeners[name] ??= []).push(listener);
      }
      removeEventListener() {}
      close() {
        this.closed = true;
      }
      emit(name: string, data: unknown) {
        for (const listener of this.listeners[name] ?? []) listener(new MessageEvent(name, { data: JSON.stringify(data) }));
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = renderInside({ status: 200, count: 1 });
    await userEvent.click(await screen.findByRole("tab", { name: en.spaces.views.kind.gallery }));
    await screen.findByTestId("view-gallery");
    const reads = () =>
      fetchMock.mock.calls.map((call) => urlOf(call[0])).filter((url) => url.pathname.startsWith("/cs/ovzdusie/ngsi-ld/v1/entities") && url.searchParams.get("limit") === "500").length;
    const before = reads();
    // The grid listens too (T-5186) and closes its stream when the gallery opens: the gallery's is the open one.
    const stream = opened.find((source) => !source.closed && source.url.includes("/spaces/ovzdusie/live?type=AirQualityObserved"));
    expect(stream).toBeDefined();
    act(() => stream?.emit("changed", { type: "AirQualityObserved" }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(screen.getByTestId("view-live")).toHaveTextContent(/^Entities of this type changed at .+; shown as they are now\.$/);
    // Back to the grid, the stream is closed.
    await userEvent.click(screen.getByRole("tab", { name: en.spaces.views.kind.grid }));
    expect(stream?.closed).toBe(true);
    vi.unstubAllGlobals();
  });

  // T-5093: a 502 behind the gateway is a failure to retry, not a space read only through its endpoints.
  it("names a failed surface read with its status and a retry", async () => {
    renderInside({ status: 200, count: 1 }, { status: 502 });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(en.spaces.inside.dataFailed);
    expect(alert).toHaveTextContent("HTTP 502");
    expect(within(alert).getByRole("button", { name: en.app.error.retry })).toBeInTheDocument();
    expect(screen.queryByText(en.spaces.inside.dataThroughEndpoints)).toBeNull();
  });

  it("points at the endpoints when the surface answers this person nothing", async () => {
    renderInside({ status: 200, count: 1 }, { status: 404 });

    expect(await screen.findByText(en.spaces.inside.dataThroughEndpoints)).toBeInTheDocument();
    // The endpoints of this space, and not the one of another space.
    const links = screen.getAllByRole("link", { name: "public-air" });
    expect(links[0]).toHaveAttribute("href", `${window.location.origin}/api/endpoint/${SLUG}`);
    expect(screen.queryByText(en.spaces.inside.dataEmpty)).toBeNull();
  });

  it("offers to add a field to a type its model declares, as a model change (T-3098)", async () => {
    renderInside({ status: 200, count: 1 }, { status: 200 }, {
      source: "name: bb-air-quality\nclasses:\n  AirQualityObserved:\n    attributes:\n      no2: { range: float }\n",
    });

    const add = await screen.findByRole("button", { name: en.spaces.fields.add });
    await userEvent.click(add);
    expect(await screen.findByRole("dialog", { name: en.spaces.fields.title.replace("{type}", "AirQualityObserved") })).toBeInTheDocument();
  });

  // T-4828: a row opens as a dialog named in the address, with its comments as a tab.
  it("opens the row a link names as a dialog with Fields, History, Metadata and Comments, and closing drops it from the address", async () => {
    const urn = SPACE_ROWS[0].id;
    window.history.pushState({}, "", `/projects/banskabystrica/spaces/ovzdusie?row=${encodeURIComponent(urn)}`);
    renderInside({ status: 200, count: 1 });
    const dialog = await screen.findByRole("dialog", { name: `${en.entityGrid.rowDetail}: ${urn.split(":").at(-1)}` });
    expect(within(dialog).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      en.entityGrid.rowFields,
      en.entityGrid.history,
      en.entityGrid.metadata,
      en.spaces.comments.title,
    ]);
    await userEvent.click(within(dialog).getByRole("button", { name: en.entityGrid.close }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(new URLSearchParams(window.location.search).get("row")).toBeNull();
  });

  it("puts the row opened from the grid into the address, and ignores a row parameter that is no URN", async () => {
    window.history.pushState({}, "", "/projects/banskabystrica/spaces/ovzdusie?row=javascript%3Aalert(1)");
    renderInside({ status: 200, count: 1 });
    const urn = SPACE_ROWS[0].id;
    await userEvent.click(await screen.findByRole("button", { name: `${en.entityGrid.openRow}: ${urn.split(":").at(-1)}` }));
    expect(await screen.findByRole("dialog", { name: `${en.entityGrid.rowDetail}: ${urn.split(":").at(-1)}` })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("row")).toBe(urn);
  });

  it("opens the type's form from Add row and creates through the space surface", async () => {
    const fetchMock = renderInside({ status: 200, count: 1 }, { status: 200 }, {
      source: "name: bb-air-quality\nclasses:\n  AirQualityObserved:\n    attributes:\n      no2: { range: float }\n",
    });
    await userEvent.click(await screen.findByRole("button", { name: en.spaces.inside.addRow }));
    const dialog = await screen.findByRole("dialog", { name: en.spaces.inside.addRowTitle.replace("{type}", "AirQualityObserved") });
    expect(within(dialog).getByRole("button", { name: en.spaces.form.submit })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((call) => urlOf(call[0]).pathname.includes("/temporal/"))).toBe(false);
  });

  it("offers no entity write inside a copy, whose rows are the live space, and points at Try it (T-4868)", async () => {
    window.history.pushState({}, "", "/projects/banskabystrica/spaces/ovzdusie?workspace=air-v2");
    const fetchMock = renderInside({ status: 200, count: 1 }, { status: 200 }, {
      source: "name: bb-air-quality\nclasses:\n  AirQualityObserved:\n    attributes:\n      no2: { range: float }\n",
    });
    const note = (await screen.findByText(en.spaces.inside.copyLive)).closest("[role=status]") as HTMLElement;
    expect(within(note).getByRole("link", { name: en.workspaces.bar.tryIt })).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/projects\/banskabystrica\/workspaces\/air-v2\/try-it(\?|$)/),
    );
    expect(await screen.findByRole("button", { name: en.spaces.inside.addRow })).toHaveAttribute("aria-disabled", "true");
    expect(await screen.findByText("12 µg/m³")).toBeInTheDocument();
    const writes = fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method && (call[1] as RequestInit).method !== "GET");
    expect(writes.filter((call) => urlOf(call[0]).pathname.includes("/ngsi-ld/"))).toHaveLength(0);
  });

  it("offers no field to add while the model's source does not declare the type", async () => {
    renderInside({ status: 200, count: 1 });

    expect(await screen.findByText("12 µg/m³")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.spaces.fields.add })).toBeNull();
  });

  it("applies a saved view: its query is what the space surface is asked (T-3104)", async () => {
    const view = {
      id: "7f1c2a9e-4b1d-4a57-9a0e-2f6d1c3b8e01",
      type: "AirQualityObserved",
      kind: "grid",
      mode: "collaborative",
      title: "High NO2",
      owner: "jana.kovacova",
      config: { q: "no2>40" },
      version: 1,
      createdAt: "2026-10-06T19:00:00Z",
      updatedAt: "2026-10-06T19:00:00Z",
    };
    const fetchMock = renderInside({ status: 200, count: 1 }, { status: 200 }, { views: [view] });

    const picker = await screen.findByLabelText(en.spaces.saved.view);
    await waitFor(() => expect(within(picker).getAllByRole("option")).toHaveLength(2));
    await userEvent.selectOptions(picker, view.id);

    await waitFor(() => {
      const asked = fetchMock.mock.calls
        .map((call) => urlOf(call[0]))
        .filter((url) => url.pathname.startsWith("/cs/ovzdusie/ngsi-ld/v1/entities"));
      expect(asked.some((url) => url.searchParams.get("q") === "no2>40")).toBe(true);
    });
  });

  it("marks the rows a view's colour rule matches, and hides the fields it hides (T-3099)", async () => {
    const rows = [
      { id: "urn:ngsi-ld:AirQualityObserved:banskabystrica.sk:ovzdusie:1", type: "AirQualityObserved", pm10: { type: "Property", value: 52 }, no2: { type: "Property", value: 9 } },
      { id: "urn:ngsi-ld:AirQualityObserved:banskabystrica.sk:ovzdusie:2", type: "AirQualityObserved", pm10: { type: "Property", value: 12 }, no2: { type: "Property", value: 7 } },
    ];
    const view = {
      id: "7f1c2a9e-4b1d-4a57-9a0e-2f6d1c3b8e02",
      type: "AirQualityObserved",
      kind: "grid",
      mode: "personal",
      title: "Dusty",
      owner: "jana.kovacova",
      config: { hidden: ["no2"], colour: [{ when: "pm10>50", colour: "danger" }] },
      version: 1,
      createdAt: "2026-10-06T19:00:00Z",
      updatedAt: "2026-10-06T19:00:00Z",
    };
    renderInside({ status: 200, count: 1 }, { status: 200, rows }, { views: [view] });

    const picker = await screen.findByLabelText(en.spaces.saved.view);
    await waitFor(() => expect(within(picker).getAllByRole("option")).toHaveLength(2));
    expect(await screen.findByRole("columnheader", { name: /NO₂/ })).toBeInTheDocument();
    await userEvent.selectOptions(picker, view.id);

    const marked = await screen.findAllByRole("img", { name: en.spaces.saved.toneLabel.replace("{when}", "pm10>50") });
    expect(marked).toHaveLength(1);
    expect(marked[0].closest("tr")).toHaveTextContent("52");
    expect(screen.queryByRole("columnheader", { name: /NO₂/ })).toBeNull();
  });

  // T-4827: values by what they hold, the model's order and labels, on the caller's own answer.
  const KPI_MODEL = [
    "name: bb-air-quality",
    "classes:",
    "  AirQualityObserved:",
    "    attributes:",
    "      secretNote: { range: string }",
    "      refStation: { range: string, annotations: { ngsi_ld_kind: Relationship } }",
    "      calculationPeriod: { range: string }",
    "      pm10: { range: float, annotations: { label: { en: Particulates } } }",
    "      name: { range: string, rank: 1 }",
    "",
  ].join("\n");
  const KPI_ROWS = [
    {
      id: "urn:ngsi-ld:AirQualityObserved:banskabystrica.sk:ovzdusie:1",
      type: "AirQualityObserved",
      name: { type: "Property", value: "Námestie SNP" },
      pm10: { type: "Property", value: 12.5, unitCode: "GQ" },
      calculationPeriod: { type: "Property", value: { start: "2026-10-01", end: "2026-10-31" } },
      refStation: { type: "Relationship", object: "urn:ngsi-ld:Station:banskabystrica.sk:ovzdusie:7" },
      "ngsi-ld:status": { type: "Property", value: "ok" },
    },
  ];
  const headerNames = () =>
    screen.getAllByRole("columnheader").map((th) => within(th).queryAllByRole("button")[0]?.textContent ?? "").filter(Boolean);

  it("shows no raw JSON, URN or IRI, keeps the model's order and labels, and only what the answer carries", async () => {
    renderInside({ status: 200, count: 1 }, { status: 200, rows: KPI_ROWS }, { source: KPI_MODEL });

    expect(await screen.findByRole("columnheader", { name: /Particulates/ })).toBeInTheDocument();
    await waitFor(() => expect(headerNames().slice(0, 5)).toEqual(["Name", "Ref station", "Calculation period", "Particulates (µg/m³)", "Status"]));
    // DM-102: the model declares secretNote, the caller's answer does not carry it.
    expect(screen.queryByRole("columnheader", { name: /secret/i })).toBeNull();
    const grid = screen.getByRole("grid");
    const cells = within(grid).getAllByRole("gridcell").map((cell) => cell.textContent ?? "");
    expect(cells.join(" ")).not.toMatch(/[{}]|urn:|ngsi-ld:/);
    expect(cells.join(" ")).toContain("start: Oct 1, 2026 · end: Oct 31, 2026");
    expect(cells.join(" ")).toContain("12.5 µg/m³");
    expect(screen.getByRole("button", { name: "Open: Station · 7" })).toHaveAttribute("title", "urn:ngsi-ld:Station:banskabystrica.sk:ovzdusie:7");
  });

  it("opens with the layout kept in this browser, even though the type arrives after the first render", async () => {
    window.localStorage.clear();
    writeLayout("banskabystrica", "ovzdusie", "AirQualityObserved", { labels: { "ngsi-ld:status": "State" }, hidden: ["calculationPeriod"] });
    renderInside({ status: 200, count: 1 }, { status: 200, rows: KPI_ROWS }, { source: KPI_MODEL });
    expect(await screen.findByRole("button", { name: `${en.entityGrid.columnMenu}: State` })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /Calculation period/ })).toBeNull();
    // Opening wrote nothing over it.
    expect(readLayout("banskabystrica", "ovzdusie", "AirQualityObserved")).toMatchObject({ labels: { "ngsi-ld:status": "State" } });
  });

  it("keeps a renamed, moved and hidden column across a reload, and saves them with a view", async () => {
    window.localStorage.clear();
    const fetchMock = renderInside({ status: 200, count: 1 }, { status: 200, rows: KPI_ROWS }, { source: KPI_MODEL });
    await screen.findByRole("columnheader", { name: /Particulates/ });
    await userEvent.click(screen.getByRole("button", { name: `${en.entityGrid.columnMenu}: Status` }));
    const field = screen.getByLabelText(en.entityGrid.renameColumn);
    await userEvent.clear(field);
    await userEvent.type(field, "State{Enter}");
    await userEvent.click(screen.getByRole("button", { name: `${en.entityGrid.columnMenu}: State` }));
    await userEvent.click(screen.getByRole("button", { name: en.entityGrid.hideColumn }));
    await userEvent.click(screen.getByRole("button", { name: `${en.entityGrid.columnMenu}: Ref station` }));
    await userEvent.click(screen.getByRole("button", { name: en.entityGrid.moveRight }));
    await waitFor(() => expect(headerNames().slice(0, 3)).toEqual(["Name", "Calculation period", "Ref station"]));
    expect(screen.queryByRole("columnheader", { name: /State/ })).toBeNull();

    // "All rows" keeps them in this browser: a reload reads them back (viewLayout.readLayout).
    const keptKey = Object.keys(window.localStorage).find((key) => key.endsWith(".ovzdusie.AirQualityObserved") && key.startsWith("jc.space-columns."));
    expect(keptKey).toBeDefined();
    const [, , project] = keptKey!.split(".");
    expect(readLayout(project, "ovzdusie", "AirQualityObserved")).toMatchObject({ labels: { "ngsi-ld:status": "State" }, hidden: ["ngsi-ld:status"] });

    await userEvent.click(screen.getByRole("button", { name: en.spaces.saved.saveNew }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox", { name: new RegExp(en.spaces.saved.title) }), "Mine");
    await userEvent.click(within(dialog).getByRole("button", { name: en.spaces.saved.confirm }));
    const posted = await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input]) => input instanceof Request && input.method === "POST" && urlOf(input).pathname.endsWith("/spaces/ovzdusie/views"),
      );
      expect(call).toBeDefined();
      return call![0] as Request;
    });
    const body = (await posted.clone().json()) as { config: Record<string, unknown> };
    expect(body.config.labels).toEqual({ "ngsi-ld:status": "State" });
    expect(body.config.hidden).toEqual(["ngsi-ld:status"]);
    expect((body.config.order as string[]).indexOf("refStation")).toBeGreaterThan((body.config.order as string[]).indexOf("calculationPeriod"));
  });

  // T-4264, T-4160 #6: the grid leads with the entity's name, its URN the button's tooltip, and the
  // headers and the alerts button say what the model titles them.
  it("leads the data with each entity's name and the model's titles, not the URN and the keys", async () => {
    const rows = [
      {
        id: "urn:ngsi-ld:AirQualityObserved:banskabystrica.sk:ovzdusie:1",
        type: "AirQualityObserved",
        name: { type: "Property", value: "Námestie SNP" },
        pm10: { type: "Property", value: 12 },
      },
    ];
    const source = [
      "id: https://banskabystrica.sk/models/air",
      "name: bb-air-quality",
      "classes:",
      "  AirQualityObserved:",
      "    title: { en: Air quality reading }",
      "    slots: [name, pm10]",
      "slots:",
      "  name: { range: string, title: { en: Station } }",
      "  pm10: { range: float, title: { en: Particles PM10 } }",
      "",
    ].join("\n");
    renderInside({ status: 200, count: 1 }, { status: 200, rows }, { source });

    const station = await screen.findByRole("columnheader", { name: /Station/ });
    // First in the grid's own header row, where the URN used to lead; only the row-number column
    // with its select-all checkbox comes before it (T-4883).
    const row = station.closest("tr") as HTMLTableRowElement;
    const headers = within(row).getAllByRole("columnheader");
    expect(within(headers[0]!).getByRole("checkbox", { name: "Select all loaded rows" })).toBeInTheDocument();
    expect(headers[1]).toBe(station);
    expect(within(row).getByRole("columnheader", { name: /Particles PM10/ })).toBeInTheDocument();
    expect(within(row).queryByRole("columnheader", { name: /^(pm10|ID)$/ })).toBeNull();
    const open = screen.getByRole("button", { name: `${en.entityGrid.openRow}: Námestie SNP` });
    expect(open).toHaveAttribute("title", rows[0].id);
    expect(screen.getByRole("button", { name: en.alerts.forType.replace("{type}", "Air quality reading") })).toBeInTheDocument();
  });

  // T-4826: the grid edits only where the gateway's grant names a write on the type, and the write
  // goes through that endpoint with the person's reason; a viewer gets no editor at all.
  describe("editing in the grid", () => {
    const rows = [
      {
        id: "urn:ngsi-ld:AirQualityObserved:banskabystrica.sk:ovzdusie:1",
        type: "AirQualityObserved",
        name: { type: "Property", value: "Námestie SNP" },
        pm10: { type: "Property", value: 12, unitCode: "GQ" },
      },
    ];
    const source = [
      "id: https://banskabystrica.sk/models/air",
      "name: bb-air-quality",
      "classes:",
      "  AirQualityObserved:",
      "    slots: [name, pm10]",
      "slots:",
      "  name: { range: string }",
      "  pm10: { range: float }",
      "",
    ].join("\n");
    const steward = {
      permissions: [
        { resource: { type: "AirQualityObserved" }, actions: ["queryEntity"], attributes: "*" },
        { resource: { type: "AirQualityObserved" }, actions: ["updateAttrs"], attributes: ["pm10"] },
      ],
    };

    it("offers an editor for the attributes the grant lets the steward write, and sends the reason", async () => {
      const fetchMock = renderInside({ status: 200, count: 1 }, { status: 200, rows }, { source, access: steward });
      // The grid names the column "PM10 (µg/m³)" once the rows are in (T-5598: it no longer waits for the probe).
      const cell = await screen.findByRole("spinbutton", { name: /pm10/i });
      // The grant names pm10 only: the name stays text, with no editor.
      expect(screen.queryByDisplayValue("Námestie SNP")).toBeNull();
      await userEvent.clear(cell);
      await userEvent.type(cell, "14");
      await userEvent.click(screen.getByRole("button", { name: en.entityGrid.review }));
      await userEvent.click(screen.getByRole("button", { name: en.entityGrid.apply }));

      await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
      const [path, init] = fetchMock.mock.calls.find(([, each]) => each?.method === "PATCH")!;
      // Written through the endpoint that granted it, never the read-only space surface.
      expect(String(path)).toBe(`/api/endpoint/${SLUG}/ngsi-ld/v1/entities/${encodeURIComponent(rows[0].id)}/attrs`);
      expect((init!.headers as Record<string, string>)["JC-Reason"]).toBe(encodeURIComponent(en.entityGrid.reasonDefault));
      expect(JSON.parse(String(init!.body))).toEqual({ pm10: { type: "Property", value: 14, unitCode: "GQ" } });
      expect(await screen.findByRole("button", { name: en.entityGrid.undo })).toBeInTheDocument();
    });

    it("gives a viewer, whose grant names no write, no editor", async () => {
      renderInside({ status: 200, count: 1 }, { status: 200, rows }, {
        source,
        access: { permissions: [{ resource: { type: "AirQualityObserved" }, actions: ["queryEntity"], attributes: "*" }] },
      });
      // The columns follow the answer (DM-102): the open button settles in the Name column once rows arrive.
      await screen.findByRole("button", { name: /: Name$/ });
      expect(screen.getByRole("button", { name: `${en.entityGrid.openRow}: Námestie SNP` })).toBeInTheDocument();
      // In the grid: the toolbar's Share view panel holds an "Endpoint name" box of its own (T-5186).
      const grid = screen.getByRole("grid");
      expect(within(grid).queryByRole("spinbutton")).toBeNull();
      expect(within(grid).queryByRole("textbox", { name: /pm10|name/ })).toBeNull();
    });
  });

  // T-5600: a search that matched nothing said nothing had been written to the space.
  it("searches a name in any language, never a number, and says a search matched no row", async () => {
    const named = [{ ...SPACE_ROWS[0], name: { type: "LanguageProperty", languageMap: { fi: "Helsinki Herttoniemi 2" } } }];
    const asked: string[] = [];
    renderInside({ status: 200, count: 1 }, {
      status: 200,
      answer: (url) => {
        const q = url.searchParams.get("q");
        if (q) asked.push(q);
        return q?.includes("Nowhere") ? [] : named;
      },
    });
    await screen.findByRole("button", { name: `${en.entityGrid.openRow}: Helsinki Herttoniemi 2` });

    await userEvent.type(screen.getByRole("searchbox", { name: en.spaces.toolbar.search }), "Nowhere");
    const status = await screen.findByText(
      en.spaces.inside.searchNoMatch.replace("{type}", "AirQualityObserved").replace("{text}", "Nowhere"),
    );
    expect(screen.queryByText(en.spaces.inside.dataEmpty)).toBeNull();
    // Every search asked the name through its languages and left the number out, the empty page included.
    const searches = asked.filter((q) => q.includes("Nowhere"));
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((q) => q.includes('name[*]~="(?i)Nowhere"') && !q.includes("pm10"))).toBe(true);

    await userEvent.click(within(status.closest("[role=status]") as HTMLElement).getByRole("button", { name: en.spaces.inside.clearSearch }));
    expect(await screen.findByRole("button", { name: `${en.entityGrid.openRow}: Helsinki Herttoniemi 2` })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: en.spaces.toolbar.search })).toHaveValue("");
  });

  it("says nothing has been written to an empty space", async () => {
    renderInside({ status: 200, count: 0 }, { status: 200, rows: [] });

    expect(await screen.findByText(en.spaces.inside.dataEmpty)).toBeInTheDocument();
  });

  it("folds an endpoint's representations into one line with a true count (T-2280)", async () => {
    renderInside({ status: 200, count: 1 });

    await openTab(en.endpoints.title);
    const endpointRow = (await screen.findByText("public-air")).closest("tr") as HTMLElement;
    const folded = within(endpointRow).getByText(/ngsi-ld, csv/);
    // Eleven listed, eight served (the three retired files are not, T-4600), two named: the count is
    // what is left, never a fixed number.
    expect(within(endpointRow).getByText("+6 more")).toBeInTheDocument();
    // One line, and everything still reachable: a `details` is closed but its content is in the page
    // and its summary takes the keyboard on its own.
    const disclosure = folded.closest("details") as HTMLDetailsElement;
    expect(disclosure).toBeTruthy();
    expect(disclosure.open).toBe(false);
    expect(within(endpointRow).getByRole("link", { name: "csv" })).toBeInTheDocument();
    expect(within(endpointRow).getByRole("link", { name: en.endpoints.link.access })).toBeInTheDocument();

    // The count is arithmetic, not a constant: eight served minus the two named. An endpoint with
    // two or fewer therefore shows no count at all, which is the same branch (`rest > 0`).
    expect(within(endpointRow).getByText("ngsi-ld, csv")).toBeInTheDocument();
    expect(within(endpointRow).queryByText("+8 more")).toBeNull();
  });
});
