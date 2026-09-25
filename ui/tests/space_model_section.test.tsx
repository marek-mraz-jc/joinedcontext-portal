/**
 * T-2762 (DM-61, DM-62, UI-84): inside a Context Space the data model is one click away. The
 * space page links the model, shows its diagram, form and YAML read-only, and a space with no
 * model offers Create and Import prefilled for it.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../src/locales/en.json";
import { jsonResponse, list, renderRoute } from "./pageHarness";
import type { Manifest } from "../src/api/manifest";

const manifest = (kind: string, name: string, spec: Record<string, unknown>, metadata: Record<string, unknown> = {}) =>
  ({ apiVersion: "joinedcontext.com/v1alpha1", kind, metadata: { name, namespace: "helsinki", ...metadata }, spec }) as Manifest;

const AIR = `id: https://hel.fi/models/air
name: air
classes:
  AirQualityObserved:
    slots: [pm10, refStation]
  Station:
    slots: [name]
slots:
  pm10: { range: float }
  refStation: { range: Station }
  name: { range: string }
`;

const MODEL = manifest(
  "DataModel",
  "air",
  { contextSpaceRef: "ilma", linkml: AIR, version: "1.2.0", classes: ["AirQualityObserved", "Station"] },
  { title: "Air quality" },
);

function answer(models: Manifest[]) {
  return (path: string): Response | undefined => {
    if (path === "/api/v1/projects/helsinki/spaces/ilma") {
      return jsonResponse(manifest("ContextSpace", "ilma", {}));
    }
    if (path === "/api/v1/projects/helsinki/datamodels") {
      return jsonResponse(list(models));
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
  };
}

/** A viewer: may read everything, may propose nothing. */
const READER = { project: "helsinki", bootstrap: false, grants: [{ rule: { kinds: ["*"], verbs: ["read"] } }] };

async function section(): Promise<ReturnType<typeof within>> {
  const heading = await screen.findByRole("heading", { level: 2, name: en.spaces.inside.model });
  return within(heading.closest("section") as HTMLElement);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the space's data model", () => {
  it("links the model and shows its diagram, form and YAML", async () => {
    await renderRoute({ path: "/projects/helsinki/spaces/ilma", answer: answer([MODEL]) });
    const model = await section();
    expect(model.getByRole("link", { name: "Air quality" })).toHaveAttribute("href", "/projects/helsinki/models/air");
    expect(model.getByText("v1.2.0")).toBeInTheDocument();
    expect(model.getByRole("link", { name: en.models.page.edit })).toHaveAttribute("href", "/projects/helsinki/models?edit=air");
    // The model's name in the entity types line opens the model too.
    expect(screen.getByRole("link", { name: "air" })).toHaveAttribute("href", "/projects/helsinki/models/air");

    expect(await model.findByRole("group", { name: en.models.graph.title })).toBeInTheDocument();
    await userEvent.click(model.getByRole("tab", { name: en.models.page.view.form }));
    expect(await model.findByDisplayValue("31.4")).toBeInTheDocument();
    await userEvent.click(model.getByRole("tab", { name: en.models.page.view.yaml }));
    expect(model.getByLabelText(en.models.page.yaml)).toHaveTextContent("refStation: { range: Station }");
  });

  it("offers Create and Import for this space when it has no model", async () => {
    await renderRoute({ path: "/projects/helsinki/spaces/ilma", answer: answer([]) });
    const model = await section();
    expect(await model.findByText(en.spaces.inside.modelEmpty)).toBeInTheDocument();
    expect(model.getByRole("link", { name: en.spaces.inside.modelCreate })).toHaveAttribute(
      "href",
      "/projects/helsinki/models?new=blank&space=ilma",
    );
    expect(model.getByRole("link", { name: en.spaces.inside.modelImport })).toHaveAttribute(
      "href",
      "/projects/helsinki/models?new=sdm&space=ilma",
    );
  });

  it("shows a viewer Edit, Create and Import disabled with the reason", async () => {
    await renderRoute({ path: "/projects/helsinki/spaces/ilma", answer: answer([MODEL]), permissions: READER });
    const model = await section();
    expect(await model.findByRole("button", { name: en.models.page.edit })).toHaveAttribute("aria-disabled", "true");
    expect(model.queryByRole("link", { name: en.models.page.edit })).toBeNull();
    expect(model.getByRole("link", { name: "Air quality" })).toBeInTheDocument();
  });

  it("shows a viewer of an empty space the ways as disabled", async () => {
    await renderRoute({ path: "/projects/helsinki/spaces/ilma", answer: answer([]), permissions: READER });
    const model = await section();
    expect(await model.findByRole("button", { name: en.spaces.inside.modelCreate })).toHaveAttribute("aria-disabled", "true");
    expect(model.getByRole("button", { name: en.spaces.inside.modelImport })).toHaveAttribute("aria-disabled", "true");
  });
});
