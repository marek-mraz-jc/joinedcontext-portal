import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JcProvider, ProblemError } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { EstimaterContext } from "./estimate";
import type { Estimater } from "./estimate";
import type { EstimateOutput } from "./bikes";
import { estimate, initSync } from "../wasm/pkg/bike_weather_demand.js";
import wasm from "../wasm/pkg/bike_weather_demand_bg.wasm?url&inline";
import {
  ENTITIES,
  NOW,
  STATION_1,
  STATION_2,
  STATION_3,
  TEMPORAL,
  WEATHER_1,
} from "./fixtures/bikes";

vi.mock("maplibre-gl", () => {
  class MockMap {
    on(event: string, ...args: unknown[]) {
      const cb = typeof args[0] === "function" ? args[0] : typeof args[1] === "function" ? args[1] : undefined;
      if (cb && event === "load") {
        queueMicrotask(() => cb());
      }
    }
    once = vi.fn();
    remove = vi.fn();
    addSource = vi.fn();
    addLayer = vi.fn();
    setPaintProperty = vi.fn();
    getSource = vi.fn(() => ({ setData: vi.fn() }));
    fitBounds = vi.fn();
    getCanvas = vi.fn(() => ({ style: {} }));
    resize = vi.fn();
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
    { resource: { type: "BikeHireDockingStation" }, actions: ["queryEntity", "retrieveEntity", "retrieveTemporal"], attributes: "*" as const },
    { resource: { type: "WeatherObserved" }, actions: ["queryEntity", "retrieveEntity", "retrieveTemporal"], attributes: "*" as const },
  ],
  prohibitions: [],
};

// The page runs the real module, in-process instead of in its worker: what is on screen is what
// the model computes from the fixtures.
initSync({ module: Uint8Array.from(atob(wasm.slice(wasm.indexOf(",") + 1)), (c) => c.charCodeAt(0)) });
const defaultEstimater: Estimater = async (input) => JSON.parse(estimate(JSON.stringify(input))) as EstimateOutput;

function show(
  client = stubClient({ entities: ENTITIES, temporal: TEMPORAL, access: ACCESS }, { appName: "bike-weather-demand" }),
  estimater: Estimater = defaultEstimater,
) {
  render(
    <JcProvider client={client}>
      <EstimaterContext.Provider value={estimater}>
        <App />
      </EstimaterContext.Provider>
    </JcProvider>,
  );
  return client;
}

describe("bike-weather-demand App", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date(NOW * 1000));
    window.history.replaceState(null, "", "/?lang=en");
    window.location.hash = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
    window.location.hash = "";
  });

  it("first screen chooses the station with most slots, combobox, tiles, profile table and weather effect in words", async () => {
    show();

    expect(screen.getByRole("heading", { level: 1, name: "Bikes and the weather" })).toBeInTheDocument();

    const combobox = await screen.findByRole("combobox", { name: "Station" });
    expect(combobox).toHaveValue(STATION_1.id);

    const tiles = await screen.findAllByText(/Bikes now|Free slots|Total slots/);
    expect(tiles).toHaveLength(3);
    expect(screen.getByText("30")).toBeInTheDocument();

    const table = await screen.findByRole("table", { name: "Availability by hour of the week" });
    expect(table).toBeInTheDocument();

    expect(
      await screen.findByText(/1 °C warmer: \+0\.5 bikes; rain: −2\.0 bikes; from 168 hours with weather/),
    ).toBeInTheDocument();

    expect(
      screen.getByText(new RegExp(`Nearest weather station: ${WEATHER_1.name} \\(1(\\.0)? km\\)`)),
    ).toBeInTheDocument();
  });

  it("choosing another station by the combobox updates hash and requests that station's id only", async () => {
    const client = stubClient({ entities: ENTITIES, temporal: TEMPORAL, access: ACCESS }, { appName: "bike-weather-demand" });
    const originalList = client.temporal.list.bind(client.temporal);
    const temporalCalls: { type: string; id?: string[] }[] = [];
    client.temporal.list = vi.fn(async (type, query) => {
      temporalCalls.push({ type, id: query.id });
      return originalList(type, query);
    });

    show(client);
    const user = userEvent.setup();

    const combobox = await screen.findByRole("combobox", { name: "Station" });
    await user.selectOptions(combobox, STATION_3.id);

    expect(combobox).toHaveValue(STATION_3.id);
    expect(decodeURIComponent(window.location.hash)).toContain(STATION_3.id);

    await waitFor(() => {
      const stationCalls = temporalCalls.filter((c) => c.type === "BikeHireDockingStation" && c.id?.includes(STATION_3.id));
      expect(stationCalls.length).toBeGreaterThan(0);
      expect(stationCalls[0].id).toEqual([STATION_3.id]);
    });
  });

  it("selecting a station with no history displays empty history message", async () => {
    show();
    const user = userEvent.setup();

    const combobox = await screen.findByRole("combobox", { name: "Station" });
    await user.selectOptions(combobox, STATION_2.id);

    expect(combobox).toHaveValue(STATION_2.id);
    const noHistoryNotices = await screen.findAllByText("No history available for this station.");
    expect(noHistoryNotices.length).toBeGreaterThanOrEqual(1);
  });

  it("handles weather temporal read failure by showing estimate without weather terms and warning once", async () => {
    const client = stubClient({ entities: ENTITIES, temporal: TEMPORAL, access: ACCESS }, { appName: "bike-weather-demand" });
    const originalList = client.temporal.list.bind(client.temporal);
    client.temporal.list = vi.fn(async (type, query) => {
      if (type === "WeatherObserved") {
        throw new ProblemError(500, { title: "Weather service unavailable" });
      }
      return originalList(type, query);
    });

    show(client);

    expect(await screen.findByText("Weather data could not be read.")).toBeInTheDocument();
    expect(screen.getAllByText("Weather data could not be read.")).toHaveLength(1);

    expect(await screen.findByRole("table", { name: "Availability by hour of the week" })).toBeInTheDocument();
    expect(screen.queryByText(/warmer:/)).toBeNull();
  });

  it("renders in Finnish when ?lang=fi is provided, and toggles to English", async () => {
    window.history.replaceState(null, "", "/?lang=fi");
    show();

    expect(await screen.findByRole("heading", { level: 1, name: "Pyörät ja sää" })).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "Asema" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Saatavuus viikon tunneittain" })).toBeInTheDocument();

    expect(
      await screen.findByText(/1 °C lämpimämpi: \+0,5 pyörää; sade: −2,0 pyörää; 168 tunnista sään kanssa/),
    ).toBeInTheDocument();

    const switchBtn = screen.getByRole("button", { name: "In English" });
    await userEvent.setup().click(switchBtn);

    expect(screen.getByRole("heading", { level: 1, name: "Bikes and the weather" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
    expect(new URLSearchParams(window.location.search).get("lang")).toBe("en");
  });

  it("shows loading state when reading stations", async () => {
    const client = stubClient({ entities: ENTITIES, temporal: TEMPORAL, access: ACCESS }, { appName: "bike-weather-demand" });
    client.entities.list = (() => new Promise(() => {})) as typeof client.entities.list;
    show(client);

    expect(screen.getByRole("status")).toHaveTextContent(/^Reading data…/);
  });

  it("shows error alert with retry when station query fails", async () => {
    const client = stubClient({ entities: ENTITIES, temporal: TEMPORAL, access: ACCESS }, { appName: "bike-weather-demand" });
    const originalList = client.entities.list.bind(client.entities);
    let failing = true;
    client.entities.list = (async (type: string, query?: Parameters<typeof originalList>[1]) => {
      if (failing && type === "BikeHireDockingStation") {
        throw new ProblemError(503, { title: "Station service unavailable", status: 503 });
      }
      return originalList(type, query);
    }) as typeof client.entities.list;

    show(client);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Station service unavailable");

    failing = false;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await screen.findByRole("combobox", { name: "Station" })).toBeInTheDocument();
  });

  it("shows empty state when no bike stations readable", async () => {
    show(stubClient({ entities: [], access: ACCESS }, { appName: "bike-weather-demand" }));
    expect(await screen.findByText("No bike stations readable.")).toBeInTheDocument();
  });
});
