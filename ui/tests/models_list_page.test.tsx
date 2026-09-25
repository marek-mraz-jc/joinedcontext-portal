/**
 * T-2765 (DM-61, DM-62, UI-84): the Data models page opens on the project's models, a row opens
 * the model's own page, and that page shows the model six ways without editing it.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../src/locales/en.json";
import { jsonResponse, list, renderRoute } from "./pageHarness";
import { usesOfModel } from "../src/pages/models/modelUsage";
import { yamlParts } from "../src/pages/models/ModelViews";
import { lastChangeOf } from "../src/pages/models/ModelsList";
import { organizationImportName } from "../src/pages/models/OrganizationModels";
import type { Manifest } from "../src/api/manifest";

const manifest = (kind: string, name: string, spec: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ apiVersion: "joinedcontext.com/v1alpha1", kind, metadata: { name, namespace: "helsinki" }, spec, ...extra }) as Manifest;

const AIR = `# the city's air
id: https://hel.fi/models/air
name: air
classes:
  AirQualityObserved:
    slots: [pm10, level, refStation]
  Station:
    slots: [name]
slots:
  pm10: { range: float, required: true }
  level: { range: AirLevel }
  refStation: { range: Station }
  name: { range: string }
enums:
  AirLevel:
    permissible_values:
      good: { title: { en: Good } }
      bad: {}
`;

const MODELS = [
  manifest(
    "DataModel",
    "air",
    { contextSpaceRef: "ilma", linkml: AIR, version: "1.2.0", lifecycle: "published", classes: ["AirQualityObserved", "Station"] },
    { metadata: { name: "air", title: "Air quality" }, status: { conditions: [{ lastTransitionTime: "2026-09-20T08:00:00Z" }] } },
  ),
  manifest("DataModel", "bikes", { contextSpaceRef: "mobility", linkml: "./bikes.linkml.yaml", version: "1.0.0", classes: ["BikeHireDockingStation"] }),
  manifest("DataModel", "events", { contextSpaceRef: "culture", linkml: "./events.linkml.yaml", version: "0.1.0", lifecycle: "draft", classes: [] }),
];

const PROJECT_LISTS: Record<string, Manifest[]> = {
  datamodels: MODELS,
  spaces: [manifest("ContextSpace", "ilma", {}), manifest("ContextSpace", "mobility", {}), manifest("ContextSpace", "culture", {})],
  endpoints: [
    manifest("Endpoint", "air-public", { contextSpaceRef: "ilma", slug: "a" }),
    manifest("Endpoint", "air-internal", { contextSpaceRef: "ilma", slug: "b" }),
    manifest("Endpoint", "bikes-public", { contextSpaceRef: "mobility", slug: "c" }),
  ],
  pipelines: [manifest("Pipeline", "air-ingest", { output: { type: "AirQualityObserved", mode: "upsert" } })],
  apps: [manifest("App", "air-map", { dataNeeds: [{ contextSpaceRef: "ilma", types: ["AirQualityObserved"] }] })],
  dashboards: [manifest("Dashboard", "city", { title: "City", pages: [{ layers: ["air-layer"] }] })],
  layers: [manifest("Layer", "air-layer", { sourceEndpointRef: "air-public", entityType: "AirQualityObserved" })],
  mappings: [manifest("Mapping", "air-to-sdm", { source: { name: "air", version: "1" }, target: { name: "sdm-air", version: "1" } })],
  subscriptions: [manifest("Subscription", "air-alerts", { contextSpaceRef: "ilma" })],
};

function answer(path: string): Response | undefined {
  const plural = /^\/api\/v1\/projects\/helsinki\/([a-z]+)$/.exec(path)?.[1];
  if (plural && PROJECT_LISTS[plural]) {
    return jsonResponse(list(PROJECT_LISTS[plural]));
  }
  if (path === "/api/v1/tools/generate") {
    return jsonResponse({
      jsonSchema: {
        definitions: {
          AirQualityObserved: { type: "object", properties: { pm10: { type: "number", title: "pm10" } } },
          Station: { type: "object", properties: { name: { type: "string", title: "name" } } },
        },
      },
      example: { type: "AirQualityObserved", pm10: 31.4 },
    });
  }
  return undefined;
}

/** A viewer: may read models, may not propose one. */
const READER = { project: "helsinki", bootstrap: false, grants: [{ rule: { kinds: ["*"], verbs: ["read"] } }] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the list of data models", () => {
  it("lists every model with its space, version, lifecycle, classes, last change and users", async () => {
    await renderRoute({ path: "/projects/helsinki/models", answer });
    const table = await screen.findByRole("table", { name: en.models.page.listCaption });
    const air = within(table).getByRole("link", { name: "Air quality" }).closest("tr") as HTMLElement;
    expect(within(table).getByRole("link", { name: "Air quality" })).toHaveAttribute("href", "/projects/helsinki/models/air");
    expect(within(air).getByRole("link", { name: "ilma" })).toHaveAttribute("href", "/projects/helsinki/spaces/ilma");
    expect(air).toHaveTextContent("1.2.0");
    expect(air).toHaveTextContent(en.models.lifecycleOption.published);
    expect(air).toHaveTextContent("AirQualityObserved, Station");
    expect(air).toHaveTextContent("2 endpoints, 1 pipeline, 1 app, 1 dashboard");
    const events = within(table).getByRole("link", { name: "events" }).closest("tr") as HTMLElement;
    expect(events).toHaveTextContent(en.models.page.unused);
    expect(within(table).getAllByRole("row")).toHaveLength(4);
  });

  it("narrows by the search and by the space", async () => {
    await renderRoute({ path: "/projects/helsinki/models", answer });
    const table = await screen.findByRole("table", { name: en.models.page.listCaption });
    await userEvent.type(screen.getByLabelText(en.models.page.search), "bikehire");
    expect(within(table).getAllByRole("link").map((link) => link.textContent)).toEqual(["bikes", "mobility", "BikeHireDockingStation"]);
    await userEvent.clear(screen.getByLabelText(en.models.page.search));
    await userEvent.selectOptions(screen.getByLabelText(en.models.field.space), "culture");
    expect(within(table).getAllByRole("link").map((link) => link.textContent)).toEqual(["events", "culture"]);
  });

  it("offers the three ways to a new model when there is none", async () => {
    await renderRoute({ path: "/projects/helsinki/models", answer: (path) => (path.endsWith("/datamodels") ? jsonResponse(list([])) : answer(path)) });
    expect(await screen.findByText(en.models.page.emptyTitle)).toBeInTheDocument();
    for (const way of ["blank", "file", "sdm"] as const) {
      const links = screen.getAllByRole("link", { name: en.models.page.new[way] });
      expect(links[0]).toHaveAttribute("href", `/projects/helsinki/models?new=${way}`);
    }
  });

  it("gives a person who may not propose a model the reason instead of the way", async () => {
    await renderRoute({ path: "/projects/helsinki/models", answer, permissions: READER });
    await screen.findByRole("table", { name: en.models.page.listCaption });
    const blank = await screen.findByRole("button", { name: en.models.page.new.blank });
    expect(blank).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("link", { name: en.models.page.new.blank })).toBeNull();
  });

  it("opens the editor when the address asks for one", async () => {
    await renderRoute({ path: "/projects/helsinki/models?new=blank", answer });
    expect(await screen.findByRole("tab", { name: en.models.view.editor, selected: true })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: en.models.page.listCaption })).toBeNull();
  });
});

/** The organization's list (DM-63, DM-79): one organization model and one of this project. */
const ORGANIZATION = {
  items: [
    { name: "stations", level: "organization", project: "org", version: "2.1.0", lifecycle: "published", classes: ["Station", "Dock"] },
    { name: "air", level: "project", project: "helsinki", space: "ilma", version: "1.2.0", lifecycle: "published", classes: ["Station"] },
  ],
  smartDataModels: [],
};

const withOrganization =
  (organization: unknown) =>
  (path: string): Response | undefined =>
    path === "/api/v1/organization/datamodels" ? jsonResponse(organization) : answer(path);

describe("organization models beside the project's (T-2883, DM-75, DM-79)", () => {
  it("shows two sections, the organization's read-only with the name a model imports it by", async () => {
    await renderRoute({ path: "/projects/helsinki/models", answer: withOrganization(ORGANIZATION) });
    expect(await screen.findByRole("heading", { level: 2, name: en.models.page.projectSection })).toBeInTheDocument();
    const section = await screen.findByRole("region", { name: en.models.page.organizationSection });
    const table = await within(section).findByRole("table", { name: en.models.page.organizationCaption });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("stations");
    expect(rows[0]).toHaveTextContent("Station, Dock");
    expect(rows[0]).toHaveTextContent("org.stations.v2");
    expect(within(section).queryByRole("button")).toBeNull();
    expect(within(section).getByRole("link", { name: en.models.page.organizationOpen })).toHaveAttribute(
      "href",
      "/organization/models",
    );
  });

  it("says the organization shares none when the list holds no organization model", async () => {
    await renderRoute({ path: "/projects/helsinki/models", answer: withOrganization({ ...ORGANIZATION, items: [ORGANIZATION.items[1]] }) });
    const section = await screen.findByRole("region", { name: en.models.page.organizationSection });
    expect(await within(section).findByText(en.models.page.organizationEmpty)).toBeInTheDocument();
    expect(within(section).queryByRole("table")).toBeNull();
  });

  it("gives the reason and a retry when the organization's list cannot be read", async () => {
    await renderRoute({
      path: "/projects/helsinki/models",
      answer: (path) =>
        path === "/api/v1/organization/datamodels"
          ? jsonResponse({ title: "Unavailable", status: 503, detail: "the mirror is loading" }, 503)
          : answer(path),
    });
    const section = await screen.findByRole("region", { name: en.models.page.organizationSection });
    expect(await within(section).findByText(/the mirror is loading/)).toBeInTheDocument();
    // The project's own models are unaffected.
    expect(await screen.findByRole("table", { name: en.models.page.listCaption })).toBeInTheDocument();
  });

  it("names the import by the major version alone", () => {
    expect(organizationImportName("stations", "2.1.0")).toBe("org.stations.v2");
    expect(organizationImportName("air", "0.3.1")).toBe("org.air.v0");
  });

  it("lists them on the Organization page's Data models tab", async () => {
    await renderRoute({ path: "/organization/models", answer: withOrganization(ORGANIZATION) });
    expect(await screen.findByRole("tab", { name: en.organization.tab.models, selected: true })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: en.models.page.organizationCaption });
    expect(table).toHaveTextContent("org.stations.v2");
    expect(screen.queryByRole("link", { name: en.models.page.organizationOpen })).toBeNull();
  });
});

describe("a model's own page", () => {
  it("shows the overview: the diagram, the classes with what each slot is, and the enums", async () => {
    await renderRoute({ path: "/projects/helsinki/models/air", answer });
    expect(await screen.findByRole("heading", { name: "Air quality", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: en.models.graph.title })).toBeInTheDocument();
    const classes = screen.getByRole("table", { name: en.models.classes });
    const station = within(classes).getByText("refStation").closest("li") as HTMLElement;
    expect(station).toHaveTextContent(`refStation: Station${en.models.page.relationship}`);
    expect(within(classes).getByText("level").closest("li")).toHaveTextContent(en.models.page.enum);
    expect(screen.getByText(/good \(Good\), bad/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: en.models.page.back })).toHaveAttribute("href", "/projects/helsinki/models");
    expect(screen.getByRole("link", { name: en.models.page.edit })).toHaveAttribute("href", "/projects/helsinki/models?edit=air");
  });

  it("shows the form a class generates, filled with the example", async () => {
    await renderRoute({ path: "/projects/helsinki/models/air", answer });
    await userEvent.click(await screen.findByRole("tab", { name: en.models.page.view.form }));
    expect(await screen.findByDisplayValue("31.4")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(en.models.page.formClass), "Station");
    expect(await screen.findByLabelText(/name/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("31.4")).toBeNull();
  });

  it("shows the YAML as text, with copy and download", async () => {
    await renderRoute({
      path: "/projects/helsinki/models/air",
      answer: (path) =>
        path.endsWith("/datamodels")
          ? jsonResponse(list([{ ...MODELS[0], spec: { ...MODELS[0].spec, linkml: `${AIR}# <b>not markup</b>\n` } }]))
          : answer(path),
    });
    await userEvent.click(await screen.findByRole("tab", { name: en.models.page.view.yaml }));
    const yaml = screen.getByLabelText(en.models.page.yaml);
    expect(yaml).toHaveTextContent("# <b>not markup</b>");
    expect(yaml.querySelector("b")).toBeNull();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await userEvent.click(screen.getByRole("button", { name: en.models.page.copyYaml }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("name: air"));
    expect(await screen.findByText(en.models.page.copied)).toBeInTheDocument();
  });

  it("lists where the model is used, each a link", async () => {
    await renderRoute({ path: "/projects/helsinki/models/air", answer });
    await userEvent.click(await screen.findByRole("tab", { name: en.models.page.view.used }));
    const used = within(screen.getByRole("tabpanel"));
    expect(used.getByRole("link", { name: "ilma" })).toHaveAttribute("href", "/projects/helsinki/spaces/ilma");
    expect(used.getByRole("link", { name: "air-public" })).toHaveAttribute("href", "/projects/helsinki/endpoints/air-public");
    expect(used.getByRole("link", { name: "air-ingest" })).toHaveAttribute("href", "/projects/helsinki/pipelines/air-ingest/edit");
    expect(used.getByRole("link", { name: "city" })).toHaveAttribute("href", "/projects/helsinki/dashboards/city/edit");
    expect(used.queryByRole("link", { name: "bikes-public" })).toBeNull();
  });

  it("reads its history as the activity of the model", async () => {
    const { calls, fetchMock } = await renderRoute({ path: "/projects/helsinki/models/air", answer });
    await userEvent.click(await screen.findByRole("tab", { name: en.models.page.view.history }));
    await waitFor(() => expect(calls()).toContain("GET /api/v1/projects/helsinki/activity"));
    const activity = fetchMock.mock.calls
      .map((call) => (call[0] as Request).url)
      .find((url) => url.includes("/activity"));
    expect(new URL(activity ?? "").searchParams.get("object")).toBe("datamodels/air");
  });

  it("says so for a model the project does not have", async () => {
    await renderRoute({ path: "/projects/helsinki/models/nope", answer });
    expect(await screen.findByText(en.models.page.notFound.replace("{name}", "nope"))).toBeInTheDocument();
  });

  it("disables Edit, with the reason, for a person who may not propose a model", async () => {
    await renderRoute({ path: "/projects/helsinki/models/air", answer, permissions: READER });
    const edit = await screen.findByRole("button", { name: en.models.page.edit });
    expect(edit).toHaveAttribute("aria-disabled", "true");
  });
});

describe("what uses a model", () => {
  it("follows the space to its endpoints, and the endpoints and types to the rest", () => {
    const uses = usesOfModel(MODELS[0], PROJECT_LISTS).map((use) => `${use.kind}/${use.name}`);
    expect(uses).toEqual([
      "ContextSpace/ilma",
      "Endpoint/air-internal",
      "Endpoint/air-public",
      "Pipeline/air-ingest",
      "Subscription/air-alerts",
      "App/air-map",
      "Dashboard/city",
      "Mapping/air-to-sdm",
    ]);
    expect(usesOfModel(MODELS[2], PROJECT_LISTS).map((use) => use.kind)).toEqual(["ContextSpace"]);
    // A model whose space the person may not read counts nothing through it.
    expect(usesOfModel(MODELS[0], {})).toEqual([]);
  });

  it("finds the newest change among the model's conditions", () => {
    expect(lastChangeOf(MODELS[0])).toBe("2026-09-20T08:00:00Z");
    expect(lastChangeOf(MODELS[1])).toBeUndefined();
  });

  it("splits a YAML line into key, value and comment", () => {
    expect(yamlParts("  pm10: { range: float } # measured")).toEqual({
      indent: "  ",
      key: "pm10:",
      rest: " { range: float }",
      comment: " # measured",
    });
    expect(yamlParts("    - linkml:types")).toEqual({ indent: "    - ", key: undefined, rest: "linkml:types" });
    expect(yamlParts("# only a comment")).toEqual({ indent: "", rest: "", comment: "# only a comment" });
  });
});

describe("a link to a user of the model", () => {
  it("opens a kind with a page of its own there, and anything else on its edit form", async () => {
    const { UseLink } = await import("../src/pages/models/ModelPage");
    const { createRootRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
    const { render } = await import("@testing-library/react");
    const root = createRootRoute({
      component: () => (
        <>
          <UseLink project="helsinki" use={{ plural: "apps", name: "air-map" }} />
          <UseLink project="helsinki" use={{ plural: "subscriptions", name: "air-alerts" }} />
        </>
      ),
    });
    render(<RouterProvider router={createRouter({ routeTree: root })} />);
    expect(await screen.findByRole("link", { name: "air-map" })).toHaveAttribute("href", "/projects/helsinki/apps/air-map");
    expect(screen.getByRole("link", { name: "air-alerts" })).toHaveAttribute("href", "/projects/helsinki/subscriptions/air-alerts/edit");
  });
});
