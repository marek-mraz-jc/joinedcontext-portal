// The explorer's map (T-3256): a located type's view drawn as clustered points read through the
// person's endpoint with the view's filters, a popup of text only with a button to the entity,
// and a failed read said with Retry.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import type { MapLayer } from "../src/components/dashboards/MapLibreView";
import { ExploreMap, isLocated, mapFeatures } from "../src/pages/explore/ExploreMap";

const drawn = vi.hoisted(() => ({ layers: [] as MapLayer[] }));
vi.mock("../src/components/dashboards/MapLibreView", async (original) => ({
  ...(await original<typeof import("../src/components/dashboards/MapLibreView")>()),
  MapLibreView: ({ layers, label }: { layers: MapLayer[]; label: string }) => {
    drawn.layers = layers;
    return <div role="application" aria-label={label} />;
  },
}));

const STATIONS = [
  { id: "urn:ngsi-ld:BikeStation:1", type: "BikeStation", name: "Kamppi", bikes: 3, location: { type: "Point", coordinates: [24.93, 60.17] } },
  { id: "urn:ngsi-ld:BikeStation:2", type: "BikeStation", name: "Unplaced", bikes: 0 },
];

function stub(answer: () => Response) {
  const asked: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      asked.push(new URL(input instanceof Request ? input.url : String(input), window.location.origin));
      return answer();
    }),
  );
  return asked;
}

function show(onOpen = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nextProvider i18n={i18n}>
        <ExploreMap
          project="helsinki"
          slug="bikes-ops"
          query={{ type: "BikeStation", q: "bikes>0;name==\"Kamppi\"" }}
          columns={["name", "bikes", "address", "status", "extra"]}
          geo={["location"]}
          onOpen={onOpen}
        />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return onOpen;
}

describe("the explorer's map", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    drawn.layers = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("knows a located type by a GeoProperty or a location slot", () => {
    expect(isLocated([{ name: "position", kind: "GeoProperty" }])).toBe(true);
    expect(isLocated([{ name: "location", kind: "Property" }])).toBe(true);
    expect(isLocated([{ name: "bikes", kind: "Property" }])).toBe(false);
  });

  it("draws the located entities only, each with its id and its plain attributes", () => {
    expect(mapFeatures(STATIONS, ["name", "bikes", "location"]).features).toEqual([
      { type: "Feature", geometry: STATIONS[0].location, properties: { id: STATIONS[0].id, name: "Kamppi", bikes: 3 } },
    ]);
  });

  it("reads the view with its filter and draws it clustered, four attributes in the popup", async () => {
    const asked = stub(() => new Response(JSON.stringify(STATIONS), { headers: { "Content-Type": "application/json", "NGSILD-Results-Count": "2" } }));
    show();
    expect(await screen.findByText("1 of 2 on the map")).toBeInTheDocument();
    expect(asked[0].searchParams.get("q")).toBe('bikes>0;name=="Kamppi"');
    expect(asked[0].searchParams.get("attrs")).toBe("location,name,bikes,address,status");
    expect(drawn.layers[0]).toMatchObject({ style: "circle", cluster: true, popupProperties: ["name", "bikes", "address", "status"] });
  });

  it("opens the entity from the popup", async () => {
    stub(() => new Response(JSON.stringify(STATIONS), { headers: { "Content-Type": "application/json" } }));
    const onOpen = show();
    await screen.findByRole("application", { name: "Map of BikeStation" });
    const { popupNode } = await vi.importActual<typeof import("../src/components/dashboards/MapLibreView")>("../src/components/dashboards/MapLibreView");
    const node = popupNode({ properties: { id: STATIONS[0].id, name: "Kamppi" } }, ["name"], drawn.layers[0].open);
    document.body.append(node);
    await userEvent.click(screen.getByRole("button", { name: en.explore.map.open }));
    expect(onOpen).toHaveBeenCalledWith(STATIONS[0].id);
    node.remove();
  });

  it("keeps an attribute's markup as text in the popup", async () => {
    const { popupNode } = await vi.importActual<typeof import("../src/components/dashboards/MapLibreView")>("../src/components/dashboards/MapLibreView");
    const node = popupNode({ properties: { id: "x", name: '<img src=x onerror="alert(1)">' } }, ["name"]);
    expect(node.querySelector("img")).toBeNull();
    expect(node.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("says why the read failed and reads again on Retry", async () => {
    let calls = 0;
    stub(() => {
      calls += 1;
      return calls === 1
        ? new Response("", { status: 503, statusText: "Service Unavailable" })
        : new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
    });
    show();
    await userEvent.click(await screen.findByRole("button", { name: en.app.error.retry }));
    expect(await screen.findByText(en.explore.map.none)).toBeInTheDocument();
  });
});
