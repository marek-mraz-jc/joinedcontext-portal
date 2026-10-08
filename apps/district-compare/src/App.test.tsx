import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JcProvider, ProblemError } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { ComparerContext } from "./compare";
import type { Comparer } from "./compare";
import type { CompareInput, CompareOutput, Measure } from "./districts";
import { ENTITIES } from "./fixtures/districts";

vi.mock("maplibre-gl", () => {
  class MockMap {
    on(event: string, ...args: unknown[]) {
      const cb = typeof args[0] === "function" ? args[0] : typeof args[1] === "function" ? args[1] : undefined;
      if (cb && event === "load") {
        queueMicrotask(() => cb());
      }
    }
    remove = vi.fn();
    addSource = vi.fn();
    addLayer = vi.fn();
    setPaintProperty = vi.fn();
    getSource = vi.fn(() => ({ setData: vi.fn() }));
    fitBounds = vi.fn();
    getCanvas = vi.fn(() => ({ style: {} }));
  }
  return {
    Map: MockMap,
    setWorkerUrl: vi.fn(),
  };
});

vi.mock("echarts", () => ({
  init: vi.fn(() => ({
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    on: vi.fn(),
  })),
}));

const ACCESS = {
  permissions: [
    { resource: { type: "CityDistrict" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" as const },
    { resource: { type: "Event" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" as const },
    { resource: { type: "BikeHireDockingStation" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" as const },
    { resource: { type: "Alert" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" as const },
    { resource: { type: "AirQualityObserved" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" as const },
  ],
  prohibitions: [],
};

function pointInRing(pt: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(pt: [number, number], rings: [number, number][][]): boolean {
  if (rings.length === 0) return false;
  if (!pointInRing(pt, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(pt, rings[i])) return false;
  }
  return true;
}

function pointInGeometry(pt: [number, number], geom: unknown): boolean {
  if (!geom || typeof geom !== "object") return false;
  const g = geom as { type: string; coordinates: unknown };
  if (g.type === "Polygon") {
    return pointInPolygon(pt, g.coordinates as [number, number][][]);
  }
  if (g.type === "MultiPolygon") {
    return (g.coordinates as [number, number][][][]).some((poly) => pointInPolygon(pt, poly));
  }
  return false;
}

const EARTH_RADIUS_KM = 6371.0088;
function ringAreaKm2(ring: [number, number][]): number {
  const isClosed =
    ring.length >= 2 &&
    Math.abs(ring[0][0] - ring[ring.length - 1][0]) < 1e-12 &&
    Math.abs(ring[0][1] - ring[ring.length - 1][1]) < 1e-12;
  const n = isClosed ? ring.length - 1 : ring.length;
  if (n < 3) return 0;
  const meanLat = ring.slice(0, n).reduce((s, p) => s + p[1], 0) / n;
  const meanLatRad = (meanLat * Math.PI) / 180;
  const cosLat = Math.cos(meanLatRad);
  const degToKm = (EARTH_RADIUS_KM * Math.PI) / 180;
  const kx = degToKm * cosLat;
  const ky = degToKm;
  const meanLon = ring.slice(0, n).reduce((s, p) => s + p[0], 0) / n;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x1 = (ring[i][0] - meanLon) * kx;
    const y1 = (ring[i][1] - meanLat) * ky;
    const x2 = (ring[j][0] - meanLon) * kx;
    const y2 = (ring[j][1] - meanLat) * ky;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) * 0.5;
}

function areaKm2(geom: unknown): number {
  if (!geom || typeof geom !== "object") return 0;
  const g = geom as { type: string; coordinates: unknown };
  if (g.type === "Polygon") {
    const rings = g.coordinates as [number, number][][];
    if (rings.length === 0) return 0;
    const outer = ringAreaKm2(rings[0]);
    const holes = rings.slice(1).reduce((acc, r) => acc + ringAreaKm2(r), 0);
    return Math.max(0, outer - holes);
  }
  if (g.type === "MultiPolygon") {
    const polys = g.coordinates as [number, number][][][];
    return polys.reduce((acc, poly) => {
      const outer = ringAreaKm2(poly[0]);
      const holes = poly.slice(1).reduce((hAcc, r) => hAcc + ringAreaKm2(r), 0);
      return acc + Math.max(0, outer - holes);
    }, 0);
  }
  return 0;
}

function competitionRank(values: (number | null)[]): (number | null)[] {
  const indexed: { val: number; idx: number }[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== null && Number.isFinite(v)) {
      indexed.push({ val: v, idx: i });
    }
  }
  indexed.sort((a, b) => b.val - a.val);
  const ranks: (number | null)[] = new Array(values.length).fill(null);
  let currentRank = 1;
  for (let pos = 0; pos < indexed.length; pos++) {
    if (pos > 0 && Math.abs(indexed[pos].val - indexed[pos - 1].val) > 1e-9) {
      currentRank = pos + 1;
    }
    ranks[indexed[pos].idx] = currentRank;
  }
  return ranks;
}

function simulateCompare(input: CompareInput): CompareOutput {
  const districts = input.districts.map((d) => {
    const area = areaKm2(d.geometry);
    let events = 0;
    let bikes = 0;
    let bikeSlots = 0;
    let alerts = 0;
    const pm25Vals: number[] = [];
    const aqiVals: number[] = [];

    for (const ev of input.events) {
      if (pointInGeometry(ev, d.geometry)) events++;
    }
    for (const bk of input.bikes) {
      if (pointInGeometry(bk.at, d.geometry)) {
        bikes++;
        bikeSlots += bk.slots ?? 0;
      }
    }
    for (const al of input.alerts) {
      if (pointInGeometry(al, d.geometry)) alerts++;
    }
    for (const station of input.air) {
      if (pointInGeometry(station.at, d.geometry)) {
        if (station.pm25 !== null && Number.isFinite(station.pm25)) pm25Vals.push(station.pm25);
        if (station.aqi !== null && Number.isFinite(station.aqi)) aqiVals.push(station.aqi);
      }
    }

    const pm25 = pm25Vals.length > 0 ? pm25Vals.reduce((a, b) => a + b, 0) / pm25Vals.length : null;
    const aqi = aqiVals.length > 0 ? aqiVals.reduce((a, b) => a + b, 0) / aqiVals.length : null;

    return {
      code: d.code,
      name: d.name,
      areaKm2: area,
      events,
      bikes,
      bikeSlots,
      alerts,
      pm25,
      aqi,
      perKm2: {
        events: area > 0 ? events / area : null,
        bikes: area > 0 ? bikes / area : null,
        bikeSlots: area > 0 ? bikeSlots / area : null,
        alerts: area > 0 ? alerts / area : null,
      },
      rank: {} as Record<Measure, number | null>,
    };
  });

  const rEvents = competitionRank(districts.map((d) => d.events));
  const rBikes = competitionRank(districts.map((d) => d.bikes));
  const rBikeSlots = competitionRank(districts.map((d) => d.bikeSlots));
  const rAlerts = competitionRank(districts.map((d) => d.alerts));
  const rPm25 = competitionRank(districts.map((d) => d.pm25));
  const rAqi = competitionRank(districts.map((d) => d.aqi));

  districts.forEach((d, i) => {
    d.rank = {
      events: rEvents[i],
      bikes: rBikes[i],
      bikeSlots: rBikeSlots[i],
      alerts: rAlerts[i],
      pm25: rPm25[i],
      aqi: rAqi[i],
    };
  });

  return {
    districts,
    outside: {
      events: input.events.filter((ev) => !districts.some((d) => pointInGeometry(ev, input.districts.find((x) => x.code === d.code)?.geometry))).length,
      bikes: input.bikes.filter((b) => !districts.some((d) => pointInGeometry(b.at, input.districts.find((x) => x.code === d.code)?.geometry))).length,
      alerts: input.alerts.filter((a) => !districts.some((d) => pointInGeometry(a, input.districts.find((x) => x.code === d.code)?.geometry))).length,
      air: input.air.filter((a) => !districts.some((d) => pointInGeometry(a.at, input.districts.find((x) => x.code === d.code)?.geometry))).length,
    },
  };
}

const defaultComparer: Comparer = async (input) => simulateCompare(input);

function show(
  client = stubClient({ entities: ENTITIES, access: ACCESS }, { appName: "district-compare" }),
  comparer: Comparer = defaultComparer,
) {
  render(
    <JcProvider client={client}>
      <ComparerContext.Provider value={comparer}>
        <App />
      </ComparerContext.Provider>
    </JcProvider>,
  );
  return client;
}

describe("district-compare", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/?lang=en");
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("renders first screen with preselected top two districts by events, table, list and chart", async () => {
    const client = show();

    expect(screen.getByRole("heading", { level: 1, name: "Compare districts" })).toBeInTheDocument();

    const measureSelect = await screen.findByRole("combobox", { name: "Measure" });
    expect(measureSelect).toHaveValue("events");

    // The two districts with the most events (Kamppi: 3, Kallio: 2) are preselected
    const table = await screen.findByRole("table", { name: "Selected districts compared" });
    expect(within(table).getByText("Kamppi ×")).toBeInTheDocument();
    expect(within(table).getByText("Kallio ×")).toBeInTheDocument();

    // Ranked list lists all three districts
    const rankedList = screen.getByRole("list", { name: "Districts ranked" });
    const kamppiCheck = within(rankedList).getByRole("checkbox", { name: "Kamppi" });
    const kallioCheck = within(rankedList).getByRole("checkbox", { name: "Kallio" });
    const tooloCheck = within(rankedList).getByRole("checkbox", { name: "Töölö" });
    expect(kamppiCheck).toBeChecked();
    expect(kallioCheck).toBeChecked();
    expect(tooloCheck).not.toBeChecked();

    // Map application canvas
    expect(screen.getByRole("application", { name: "Map: districts" })).toBeInTheDocument();

    // Notice on unlocated events
    expect(screen.getByText("1 event without a place.")).toBeInTheDocument();

    // Check endpoint calls
    expect(client.transport.calls.every((c) => c.method === "GET" && c.path.includes("/api/endpoint/"))).toBe(true);
  });

  it("toggling a district updates table and URL hash, and removing via button deselects it", async () => {
    show();
    const user = userEvent.setup();

    // Töölö is initially unchecked
    const tooloCheck = await screen.findByRole("checkbox", { name: "Töölö" });
    expect(tooloCheck).not.toBeChecked();

    // Check Töölö
    await user.click(tooloCheck);
    expect(tooloCheck).toBeChecked();

    // Table now has Töölö
    const table = screen.getByRole("table", { name: "Selected districts compared" });
    expect(within(table).getByText("Töölö ×")).toBeInTheDocument();
    expect(decodeURIComponent(window.location.hash)).toContain("103");

    // Deselect Kamppi using the remove button in the table header
    const removeKamppi = within(table).getByRole("button", { name: "Deselect Kamppi" });
    await user.click(removeKamppi);

    expect(within(table).queryByText("Kamppi ×")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Kamppi" })).not.toBeChecked();

    // Clear all selections
    const clearBtn = screen.getByRole("button", { name: "Clear selection" });
    await user.click(clearBtn);

    expect(screen.getByText("Select at least one district to compare.")).toBeInTheDocument();
  });

  it("changing the measure re-ranks the district list and updates chart", async () => {
    show();
    const user = userEvent.setup();

    const measureSelect = await screen.findByRole("combobox", { name: "Measure" });
    // Switch to bikes (Kallio has 2, Kamppi has 1, Töölö has 1)
    await user.selectOptions(measureSelect, "bikes");
    expect(measureSelect).toHaveValue("bikes");
    expect(decodeURIComponent(window.location.hash)).toContain("m=bikes");

    // Verify ranked list displays Kallio as #1 and Kamppi/Töölö tied as #2
    const rankedList = screen.getByRole("list", { name: "Districts ranked" });
    const items = within(rankedList).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Kallio");
    expect(items[0]).toHaveTextContent("#1");
    expect(items[1]).toHaveTextContent("#2");
  });

  it("displays 'no station' for air quality measures where a district has none", async () => {
    show();
    const user = userEvent.setup();

    // Select Töölö so all three are in table
    const tooloCheck = await screen.findByRole("checkbox", { name: "Töölö" });
    await user.click(tooloCheck);

    const measureSelect = screen.getByRole("combobox", { name: "Measure" });
    await user.selectOptions(measureSelect, "pm25");

    // In the ranked list, Töölö shows "no station"
    const rankedList = screen.getByRole("list", { name: "Districts ranked" });
    const tooloItem = within(rankedList).getByText("Töölö").closest("li");
    expect(tooloItem).toHaveTextContent("no station");

    // In the comparison table, Töölö's pm25 cell shows "no station"
    const table = screen.getByRole("table", { name: "Selected districts compared" });
    expect(within(table).getAllByText("no station").length).toBeGreaterThan(0);
  });

  it("renders in Finnish when ?lang=fi is provided, and toggles to English", async () => {
    window.history.replaceState(null, "", "/?lang=fi");
    show();

    expect(await screen.findByRole("heading", { level: 1, name: "Vertaa kaupunginosia" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Valitut kaupunginosat rinnakkain" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Mittari" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Kaupunginosat järjestyksessä" })).toBeInTheDocument();

    const switchBtn = screen.getByRole("button", { name: "In English" });
    await userEvent.setup().click(switchBtn);

    expect(screen.getByRole("heading", { level: 1, name: "Compare districts" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
    expect(new URLSearchParams(window.location.search).get("lang")).toBe("en");
  });

  it("shows loading state when reading districts", async () => {
    const client = stubClient({ entities: ENTITIES, access: ACCESS }, { appName: "district-compare" });
    client.entities.all = (() => new Promise(() => {})) as typeof client.entities.all;
    show(client);

    expect(screen.getByRole("status")).toHaveTextContent(/^Reading data…/);
  });

  it("displays problem alert with retry when district query fails", async () => {
    const client = stubClient({ entities: ENTITIES, access: ACCESS }, { appName: "district-compare" });
    const all = client.entities.all.bind(client.entities);
    let failing = true;
    client.entities.all = (async (type: string, query?: Parameters<typeof all>[1]) => {
      if (failing && type === "CityDistrict") {
        throw new ProblemError(503, { title: "District service unavailable", status: 503 });
      }
      return all(type, query);
    }) as typeof client.entities.all;

    show(client);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("District service unavailable");

    failing = false;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await screen.findByRole("table", { name: "Selected districts compared" })).toBeInTheDocument();
  });

  it("handles partial failure when one non-district type fails, showing warning and unreadable in table", async () => {
    const client = stubClient({ entities: ENTITIES, access: ACCESS }, { appName: "district-compare" });
    const all = client.entities.all.bind(client.entities);
    client.entities.all = (async (type: string, query?: Parameters<typeof all>[1]) => {
      if (type === "AirQualityObserved") {
        throw new ProblemError(500, { title: "Air broker failed", status: 500 });
      }
      return all(type, query);
    }) as typeof client.entities.all;

    show(client);

    // Warning status displayed for partial failure
    expect(await screen.findByText("Some data could not be read: Air quality")).toBeInTheDocument();

    // Table still renders other measures
    const table = await screen.findByRole("table", { name: "Selected districts compared" });
    expect(within(table).getByText("Events")).toBeInTheDocument();

    // Air quality rows show "Data could not be read."
    expect(within(table).getAllByText("Data could not be read.").length).toBeGreaterThan(0);
  });

  it("displays error alert when comparison worker fails", async () => {
    const brokenComparer: Comparer = async () => {
      throw new Error("WASM memory corrupted");
    };
    show(undefined, brokenComparer);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Comparison failed: WASM memory corrupted");
  });

  it("shows empty state when no district boundaries exist", async () => {
    show(stubClient({ entities: [], access: ACCESS }, { appName: "district-compare" }));
    expect(await screen.findByText("No district boundaries readable.")).toBeInTheDocument();
  });
});
