import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { STATIONS } from "./fixtures/stations";

vi.mock("maplibre-gl", () => ({
  Map: class {
    on = vi.fn();
    remove = vi.fn();
  },
  setWorkerUrl: vi.fn(),
}));
vi.mock("@deck.gl/mapbox", () => ({ MapboxOverlay: class {} }));
vi.mock("@deck.gl/layers", () => ({ ScatterplotLayer: class {} }));
vi.mock("@deck.gl/aggregation-layers", () => ({ HexagonLayer: class {}, GridLayer: class {} }));
// jsdom has no canvas; the charts themselves are tested in pages/Overview.test.tsx.
vi.mock("echarts", () => ({ init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), on: vi.fn() })) }));

const READ = {
  permissions: [{ resource: { type: "BikeHireDockingStation" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" as const }],
  prohibitions: [],
};

function app(entities = STATIONS) {
  const client = stubClient({ entities, access: READ }, { appName: "helsinki-bikes" });
  render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
  return client;
}

describe("helsinki-bikes", () => {
  // The shell keeps the page in the address, so each case starts on the overview.
  beforeEach(() => {
    window.location.hash = "";
  });

  // AP-07, SDK-01: the overview is three numbers for the city, read through the app's endpoint.
  it("opens on the overview with stations, bikes available and stations empty", async () => {
    const client = app();
    const overview = await screen.findByRole("region", { name: "Overview" });
    const tile = (label: string) => within(overview).getByText(label).closest(".jc-tile") as HTMLElement;
    await waitFor(() => expect(within(tile("Stations")).getByText("5")).toBeInTheDocument());
    expect(within(tile("Bikes available")).getByText("15")).toBeInTheDocument();
    expect(within(tile("Stations empty")).getByText("2")).toBeInTheDocument();
    // AP-04: every read went to the app's own endpoint and nowhere else.
    expect(client.transport.calls.length).toBeGreaterThan(0);
    expect(client.transport.calls.every((call) => call.path.includes("/api/endpoint/"))).toBe(true);
    expect(client.transport.calls.every((call) => call.method === "GET")).toBe(true);
  });

  // AP-07: the stations page lists every station, and the filter hides the ones with no bike.
  it("lists the stations, filters to those with bikes and searches by name", async () => {
    app();
    fireEvent.click(await screen.findByRole("button", { name: "Stations" }));
    const page = screen.getByRole("region", { name: "Stations" });
    const table = await within(page).findByRole("table");
    for (const station of STATIONS) expect(await within(table).findByText(String(station.name))).toBeInTheDocument();
    expect(within(page).getByTestId("jc-map")).toBeInTheDocument();

    fireEvent.click(within(page).getByRole("checkbox", { name: "Only stations with bikes" }));
    await waitFor(() => expect(within(table).queryByText("Laivasillankatu")).not.toBeInTheDocument());
    expect(within(table).queryByText("Viiskulma")).not.toBeInTheDocument();
    expect(within(table).getByText("Kaivopuisto")).toBeInTheDocument();
    expect(within(table).getByText("Kapteeninpuistikko")).toBeInTheDocument();

    fireEvent.change(within(page).getByRole("searchbox", { name: "Station" }), { target: { value: "kaivo" } });
    await waitFor(() => expect(within(table).queryByText("Kapteeninpuistikko")).not.toBeInTheDocument());
    expect(within(table).getByText("Kaivopuisto")).toBeInTheDocument();

    fireEvent.click(within(table).getByText("Kaivopuisto"));
    expect(within(page).getByRole("heading", { name: "Kaivopuisto" })).toBeInTheDocument();
  });

  it("says so when the endpoint has no station at all", async () => {
    app([]);
    const overview = await screen.findByRole("region", { name: "Overview" });
    const tile = within(overview).getByText("Stations").closest(".jc-tile") as HTMLElement;
    await waitFor(() => expect(within(tile).getByText("0")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Stations" }));
    const page = screen.getByRole("region", { name: "Stations" });
    expect(await within(page).findByText("No station matches.")).toBeInTheDocument();
  });
});
