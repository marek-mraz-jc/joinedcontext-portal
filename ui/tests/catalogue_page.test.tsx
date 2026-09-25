// covers (T-2137, the module gate in gate_modules.test.ts): the cases in this file drive
// src/pages/catalogue/CataloguePage.tsx, DatasetPage.tsx, search.ts and snippets.ts through the
// router, signed in and anonymous (EP-81, EP-82, T-2726).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { App } from "../src/App";
import { catalogueKey } from "../src/pages/catalogue/CataloguePage";
import { datasetKey } from "../src/pages/catalogue/DatasetPage";
import { narrowed, parseCatalogueSearch, toggled } from "../src/pages/catalogue/search";
import { snippets } from "../src/pages/catalogue/snippets";

const IDENTITY = { subject: "b7c1e0f4", username: "jana.kovacova", name: "Jana Kováčová", roles: ["portal-viewer"] };
const LIST = "joinedcontext.com/v1alpha1";
const SLUG = "k7m2qz4tv6xh3n5jb2ryd3wcfa";
const ENDPOINT = `https://dev.joinedcontext.com/api/endpoint/${SLUG}/`;

function facet(value: string, label: string, count: number) {
  return { value, label, count };
}

const PAGE = {
  total: 2,
  page: 1,
  pageSize: 20,
  datasets: [
    {
      name: "bbsk-kpi",
      title: "Ukazovatele kraja",
      notes: "Ukazovatele Banskobystrického samosprávneho kraja.",
      publisher: { name: "bbsk", title: "Banskobystrický samosprávny kraj" },
      licence: { id: "cc-by", title: "Creative Commons Attribution" },
      formats: ["CSV", "NGSI-LD"],
      themes: ["ECON"],
      modified: "2026-09-21T05:52:34Z",
    },
    {
      name: "helsinki-bikes",
      title: "City bikes",
      publisher: { name: "helsinki", title: "Helsinki" },
      formats: ["GeoJSON"],
      themes: ["TRAN"],
    },
  ],
  facets: {
    publisher: [facet("bbsk", "Banskobystrický samosprávny kraj", 1), facet("helsinki", "Helsinki", 1)],
    theme: [facet("ECON", "Economy and finance", 1), facet("TRAN", "Transport", 1)],
    format: [facet("CSV", "CSV", 1)],
    licence: [facet("cc-by", "Creative Commons Attribution", 1)],
    spatial: [],
    year: [],
  },
  unavailable: [],
};

const DETAIL = {
  name: "bbsk-kpi",
  title: "Ukazovatele kraja",
  notes: "Ukazovatele Banskobystrického samosprávneho kraja.",
  keywords: ["ukazovatele", "kraj"],
  publisher: { name: "bbsk", title: "Banskobystrický samosprávny kraj" },
  licence: { id: "cc-by", title: "Creative Commons Attribution", url: "https://creativecommons.org/licenses/by/4.0/" },
  frequency: "http://publications.europa.eu/resource/authority/frequency/MONTHLY",
  themes: [{ code: "ECON", label: "Economy and finance" }],
  spatial: ["SK032"],
  temporal: { start: "2020-01-01", end: null },
  catalogueUrl: "https://data.dev.joinedcontext.com/dataset/bbsk-kpi",
  resources: [
    {
      name: "CSV",
      format: "CSV",
      url: `${ENDPOINT}file.csv`,
      previewUrl: "https://data.dev.joinedcontext.com/dataset/bbsk-kpi/resource/r1",
    },
    { name: "Hostile", format: "HTML", url: "javascript:alert(1)" },
  ],
  endpoint: { url: ENDPOINT, representations: ["ngsi-ld", "csv", "mcp"] },
  model: {
    name: "key-performance-indicator",
    classes: [{ name: "KeyPerformanceIndicator", description: "A measured indicator of the region." }],
    docsUrl: `${ENDPOINT}schema/1/key-performance-indicator.v1.md`,
  },
};

const SAMPLE = {
  type: "KeyPerformanceIndicator",
  columns: ["id", "type", "value"],
  rows: [["urn:ngsi-ld:KeyPerformanceIndicator:bbsk:kpi:1", "KeyPerformanceIndicator", "12"]],
};

type Answer = { status: number; body: unknown };

describe("the catalogue (EP-81, EP-82)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let answers: Record<string, Answer>;
  let signedIn: boolean;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    signedIn = true;
    answers = {
      "/api/v1/projects": { status: 200, body: { apiVersion: LIST, kind: "List", items: [{ name: "helsinki" }] } },
      "/api/v1/catalogue": { status: 200, body: PAGE },
      "/api/v1/catalogue/datasets/bbsk-kpi": { status: 200, body: DETAIL },
      "/api/v1/catalogue/datasets/bbsk-kpi/sample": { status: 200, body: SAMPLE },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderAt(path: string) {
    window.history.pushState({}, "", path);
    fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const answer: Answer = url.pathname.includes("/auth/me")
        ? signedIn
          ? { status: 200, body: IDENTITY }
          : { status: 401, body: { title: "Unauthorized", status: 401 } }
        : (answers[url.pathname] ?? { status: 200, body: { apiVersion: LIST, kind: "List", items: [] } });
      return Promise.resolve(
        new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { "Content-Type": answer.status >= 400 ? "application/problem+json" : "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nextProvider i18n={i18n}>
          <App />
        </I18nextProvider>
      </QueryClientProvider>,
    );
  }

  function catalogueCalls(): URL[] {
    return fetchMock.mock.calls
      .map((call) => new URL((call[0] as Request).url))
      .filter((url) => url.pathname === "/api/v1/catalogue");
  }

  it("lists the datasets with their publisher, themes and formats, and counts them", async () => {
    renderAt("/catalogue");
    expect(await screen.findByRole("heading", { level: 1, name: "Catalogue" })).toBeInTheDocument();
    const results = await screen.findByRole("region", { name: "Datasets" });
    expect(await within(results).findByText("2 datasets")).toBeInTheDocument();
    const link = within(results).getByRole("link", { name: "Ukazovatele kraja" });
    expect(link).toHaveAttribute("href", "/catalogue/bbsk-kpi");
    expect(within(results).getByText("Economy and finance")).toBeInTheDocument();
    expect(within(results).getByText("Transport")).toBeInTheDocument();
    expect(within(results).getByText("NGSI-LD")).toBeInTheDocument();
    // Signed in, the page sits in the Portal's shell and its sidebar marks it.
    expect(screen.getByRole("link", { name: "Catalogue", current: "page" })).toBeInTheDocument();
  });

  it("filters by a facet through the address, and a second value of the same facet is an alternative", async () => {
    renderAt("/catalogue");
    const filters = await screen.findByRole("complementary", { name: "Filters" });
    fireEvent.click(await within(filters).findByRole("checkbox", { name: /Banskobystrický samosprávny kraj/ }));
    await waitFor(() => {
      expect(catalogueCalls().at(-1)?.searchParams.getAll("publisher")).toEqual(["bbsk"]);
    });
    fireEvent.click(within(filters).getByRole("checkbox", { name: /Helsinki/ }));
    await waitFor(() => {
      expect(catalogueCalls().at(-1)?.searchParams.getAll("publisher")).toEqual(["bbsk", "helsinki"]);
    });
    expect(within(filters).getByRole("checkbox", { name: /Helsinki/ })).toBeChecked();
  });

  it("sends the search text and offers to clear it when nothing matches", async () => {
    renderAt("/catalogue");
    const box = await screen.findByRole("searchbox", { name: "Search datasets" });
    answers["/api/v1/catalogue"] = {
      status: 200,
      body: { ...PAGE, total: 0, datasets: [], facets: { ...PAGE.facets, publisher: [], theme: [], format: [], licence: [] } },
    };
    fireEvent.change(box, { target: { value: "  bicykle  " } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      expect(catalogueCalls().at(-1)?.searchParams.get("q")).toBe("bicykle");
    });
    expect(await screen.findByText("No dataset matches")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Clear search and filters" })[0]);
    await waitFor(() => {
      expect(catalogueCalls().at(-1)?.searchParams.has("q")).toBe(false);
    });
  });

  it("names the catalogues that did not answer and still lists the others", async () => {
    answers["/api/v1/catalogue"] = { status: 200, body: { ...PAGE, unavailable: ["https://data.example.org"] } };
    renderAt("/catalogue");
    expect(await screen.findByText(/https:\/\/data\.example\.org/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ukazovatele kraja" })).toBeInTheDocument();
  });

  it("says what the API said when no catalogue answers", async () => {
    answers["/api/v1/catalogue"] = {
      status: 503,
      body: { title: "Service Unavailable", status: 503, detail: "no open-data catalogue answered; try again in a minute" },
    };
    renderAt("/catalogue");
    expect(await screen.findByText(/no open-data catalogue answered/)).toBeInTheDocument();
  });

  it("opens for somebody who is not signed in, with a way to sign in and no project shell", async () => {
    signedIn = false;
    renderAt("/catalogue");
    expect(await screen.findByRole("link", { name: "Ukazovatele kraja" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/catalogue");
    const paths = fetchMock.mock.calls.map((call) => new URL((call[0] as Request).url).pathname);
    expect(paths).not.toContain("/api/v1/projects");
  });

  it("shows a dataset with its facts, resources, model, sample and the ways to use it", async () => {
    renderAt("/catalogue/bbsk-kpi");
    expect(await screen.findByRole("heading", { level: 1, name: "Ukazovatele kraja" })).toBeInTheDocument();
    expect(screen.getByText("monthly")).toBeInTheDocument();
    expect(screen.getByText("SK032")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Creative Commons Attribution/ })).toHaveAttribute(
      "href",
      "https://creativecommons.org/licenses/by/4.0/",
    );

    const resources = screen.getByRole("table", { name: "Resources" });
    expect(within(resources).getByRole("link", { name: /Preview/ })).toHaveAttribute(
      "href",
      "https://data.dev.joinedcontext.com/dataset/bbsk-kpi/resource/r1",
    );
    // A resource URL the catalogue holds is checked before it becomes a link.
    const hostile = within(resources).getByText("Hostile").closest("tr") as HTMLTableRowElement;
    expect(within(hostile).queryByRole("link")).toBeNull();

    expect(screen.getByText("A measured indicator of the region.")).toBeInTheDocument();
    const sample = await screen.findByRole("table", { name: /Up to ten KeyPerformanceIndicator/ });
    expect(within(sample).getByText("12")).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "From a shell (NGSI-LD)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Download as CSV" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "In an MCP client" })).toBeInTheDocument();
    expect(screen.getByText(/useEntities\("KeyPerformanceIndicator"\)/)).toBeInTheDocument();
  });

  it("tells an unknown or private dataset apart from a failure, and offers the way back", async () => {
    answers["/api/v1/catalogue/datasets/gone"] = {
      status: 404,
      body: { title: "Not Found", status: 404, detail: "dataset 'gone' is not in the catalogue" },
    };
    renderAt("/catalogue/gone");
    expect(await screen.findByText("No public dataset has this name")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All datasets" })).toHaveAttribute("href", "/catalogue");
  });

  it("keeps the dataset page when its endpoint does not answer the sample, and says why", async () => {
    answers["/api/v1/catalogue/datasets/bbsk-kpi/sample"] = {
      status: 503,
      body: { title: "Service Unavailable", status: 503, detail: "the endpoint of dataset 'bbsk-kpi' did not answer; try again in a minute" },
    };
    renderAt("/catalogue/bbsk-kpi");
    expect(await screen.findByRole("alert")).toHaveTextContent("did not answer");
    expect(screen.getByRole("table", { name: "Resources" })).toBeInTheDocument();
  });

  it("shows no sample and no snippets for a dataset of no endpoint here", async () => {
    answers["/api/v1/catalogue/datasets/bbsk-kpi"] = {
      status: 200,
      body: { ...DETAIL, endpoint: undefined, model: undefined },
    };
    renderAt("/catalogue/bbsk-kpi");
    expect(await screen.findByRole("heading", { level: 1, name: "Ukazovatele kraja" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sample" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Use this data" })).toBeNull();
    const paths = fetchMock.mock.calls.map((call) => new URL((call[0] as Request).url).pathname);
    expect(paths).not.toContain("/api/v1/catalogue/datasets/bbsk-kpi/sample");
  });
});

describe("the catalogue's search in the address", () => {
  it("keeps what it knows and drops the rest", () => {
    expect(
      parseCatalogueSearch({ q: "  ", publisher: ["bbsk", "bbsk", ""], theme: "ECON", page: "0", other: "x" }),
    ).toEqual({ publisher: ["bbsk"], theme: ["ECON"] });
    expect(parseCatalogueSearch({ q: "x".repeat(300), page: 3 })).toEqual({ q: "x".repeat(200), page: 3 });
    expect(parseCatalogueSearch({ page: "2.5", year: [2024] })).toEqual({});
  });

  it("turns a value on and off and starts again at page one", () => {
    const on = toggled({ page: 3 }, "format", "CSV");
    expect(on).toEqual({ format: ["CSV"], page: undefined });
    expect(toggled(on, "format", "CSV")).toEqual({ format: undefined, page: undefined });
    expect(narrowed({})).toBe(false);
    expect(narrowed({ year: ["2025"] })).toBe(true);
  });
});

describe("the catalogue's cache", () => {
  it("keeps one answer per search and one per dataset, all under the catalogue", () => {
    expect(catalogueKey({ q: "a" })).not.toEqual(catalogueKey({ q: "b" }));
    expect(catalogueKey({})[0]).toBe("catalogue");
    expect(datasetKey("bbsk-kpi")).toEqual(["catalogue", "datasets", "bbsk-kpi"]);
  });
});

describe("use this data", () => {
  it("offers only what the endpoint serves, and quotes what a shell would split", () => {
    const all = snippets(ENDPOINT, ["ngsi-ld", "csv", "mcp"], "Bike Station", "helsinki bikes");
    expect(all.map((s) => s.key)).toEqual(["curl", "sdk", "csv", "mcp"]);
    expect(all[0].code).toBe(
      `curl -H 'Accept: application/json' '${ENDPOINT}ngsi-ld/v1/entities?type=Bike+Station&limit=10&options=keyValues'`,
    );
    expect(JSON.parse(all[3].code)).toEqual({
      mcpServers: { "helsinki-bikes": { type: "http", url: `${ENDPOINT}mcp` } },
    });
    expect(snippets(ENDPOINT, ["geojson"], "T", "d")).toEqual([]);
    // NGSI-LD without a known class has nothing to name in a query.
    expect(snippets(ENDPOINT, ["ngsi-ld"], undefined, "d")).toEqual([]);
    expect(snippets("https://h/api/endpoint/x", ["csv"], undefined, "d")[0].code).toBe(
      "curl -o data.csv 'https://h/api/endpoint/x/file.csv'",
    );
    expect(snippets("https://h/it's/", ["csv"], undefined, "d")[0].code).toBe(
      `curl -o data.csv 'https://h/it'"'"'s/file.csv'`,
    );
  });
});
