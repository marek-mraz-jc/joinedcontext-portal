import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import { AIR_STATIONS, HISTORY, NOW, WEATHER_STATIONS } from "../fixtures/stations";
import { choiceOf, Explore, PERIODS, sentence } from "./Explore";

vi.mock("maplibre-gl", () => ({
  Map: class {
    on = vi.fn();
    remove = vi.fn();
  },
  LngLatBounds: class {
    extend = vi.fn();
  },
  Popup: class {},
  setWorkerUrl: vi.fn(),
}));
vi.mock("echarts/core", () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), on: vi.fn() })) }));

const READ = {
  permissions: [
    { resource: { type: "AirQualityObserved" }, actions: ["queryEntity", "retrieveEntity", "retrieveTemporal"], attributes: "*" as const },
    { resource: { type: "WeatherObserved" }, actions: ["queryEntity", "retrieveEntity", "retrieveTemporal"], attributes: "*" as const },
  ],
  prohibitions: [],
};

function show(language = "en", fixture: Parameters<typeof stubClient>[0] = {}) {
  const client = stubClient({ entities: [...AIR_STATIONS, ...WEATHER_STATIONS], temporal: HISTORY, access: READ, ...fixture }, { appName: "air-weather-explorer", language });
  render(
    <JcProvider client={client}>
      <Explore />
    </JcProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

// T-3330: the first screen answers "how does the weather move the air here" without a click.
describe("Explore", () => {
  it("compares the first station with the nearest weather station and says what moves it", async () => {
    const client = show();
    const answer = screen.getByRole("region", { name: "The answer" });
    await waitFor(() => expect(answer).toHaveTextContent("Kallio 2: PM2.5 (µg/m³) falls as wind speed (m/s) rises, strongly."));
    expect(answer).toHaveTextContent(/Spearman −\d,\d\d, Pearson −\d,\d\d, over 72 common hours/);
    expect(screen.getByRole("combobox", { name: "Weather station" })).toHaveDisplayValue(/Helsinki Kaisaniemi \(1,\d km\)/);
    expect(client.transport.calls.some((call) => call.path.includes("/ngsi-ld/v1/temporal/entities"))).toBe(true);
    expect(client.transport.calls.every((call) => call.method === "GET" && call.path.includes("/api/endpoint/"))).toBe(true);
  });

  it("lists every pair, marks the outlying reading, and keeps a chosen pair in the address", async () => {
    show();
    const table = await screen.findByRole("table", { name: "Every pair" });
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 3 * 3);
    expect(screen.getByText(/1 outlying readings \(PM2.5/)).toBeInTheDocument();
    fireEvent.click(within(table).getByRole("button", { name: "PM10 (µg/m³) · temperature (°C)" }));
    expect(new URLSearchParams(window.location.search).get("air")).toBe("pm10");
    expect(new URLSearchParams(window.location.search).get("w")).toBe("temperature");
    await waitFor(() => expect(screen.getByRole("region", { name: "The answer" })).toHaveTextContent("PM10 (µg/m³)"));
  });

  it("says there is nothing to compare for a station with no history", async () => {
    window.history.replaceState(null, "", "/?station=vartiokyla");
    show();
    expect(await screen.findByText("No measurements in the chosen period.", { selector: ".app-answer *" })).toBeInTheDocument();
  });

  it("speaks Finnish when the Portal does", async () => {
    show("fi");
    await waitFor(() => expect(screen.getByRole("region", { name: "Vastaus" })).toHaveTextContent("PM2.5 (µg/m³) laskee, kun tuulen nopeus (m/s) nousee, voimakkaasti."));
  });

  it("says so when there is no station", async () => {
    show("en", { entities: [], temporal: [] });
    expect(await screen.findByText("No air quality station was found.")).toBeInTheDocument();
  });

  it("says in words when the history cannot be read, and offers to try again", async () => {
    show("en", { refuse: (request) => (request.path.includes("/temporal/") ? { status: 503, body: { title: "Unavailable" } } : null) });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The measurements could not be read (HTTP 503). Try again later.");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("the page's pure parts", () => {
  it("takes a period only from the allowed ones", () => {
    expect(choiceOf("7", PERIODS, 3)).toBe(7);
    for (const wrong of ["", "2", "30", "x"]) expect(choiceOf(wrong, PERIODS, 3)).toBe(3);
  });

  it("says nothing of a pair without a correlation, and hardly of a weak one", () => {
    expect(sentence({ air: "pm10", weather: "windSpeed", n: 3, pearson: null, spearman: null }, "en")).toBeNull();
    expect(sentence({ air: "pm10", weather: "windSpeed", n: 30, pearson: 0.05, spearman: 0.1 }, "en")?.claim).toBe("PM10 (µg/m³) hardly moves with wind speed (m/s)");
  });
});
