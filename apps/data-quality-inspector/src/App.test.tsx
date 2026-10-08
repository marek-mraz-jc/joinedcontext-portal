import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JcProvider, ProblemError } from "@joinedcontext/sdk";
import type { Schema } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { InspectorContext, parseAnswer, type Inspector } from "./inspect";
import { ENTITIES, NOW, SCHEMA_WITH_VEHICLE } from "./fixtures/quality";
import wasm from "../wasm/pkg/data_quality_inspector_bg.wasm?url&inline";
import { initSync, inspect } from "../wasm/pkg/data_quality_inspector.js";

const base64 = wasm.slice(wasm.indexOf(",") + 1);
initSync({ module: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)) });

const runInspector: Inspector = async (input) => parseAnswer(inspect(JSON.stringify(input)));

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
    { resource: { type: "BikeHireDockingStation" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" as const },
    { resource: { type: "CityDistrict" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" as const },
    { resource: { type: "Event" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" as const },
    { resource: { type: "Vehicle" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" as const },
  ],
  prohibitions: [],
};

// The stub serves the schema document as given; the SDK types it as `Schema`, which names only the
// keywords its forms read, while the published document (and this fixture) carries every keyword the
// validator checks. One cast, here, where the fixture meets the stub.
const STUB_SCHEMA = SCHEMA_WITH_VEHICLE as unknown as Schema;

function show(
  client = stubClient(
    { entities: ENTITIES, schema: STUB_SCHEMA, access: ACCESS },
    { appName: "data-quality-inspector" },
  ),
  inspector: Inspector = runInspector,
) {
  render(
    <JcProvider client={client}>
      <InspectorContext.Provider value={inspector}>
        <App />
      </InspectorContext.Provider>
    </JcProvider>,
  );
  return client;
}

describe("data-quality-inspector", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW * 1000));
    window.history.replaceState(null, "", "/?lang=en");
  });

  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
  });

  it("renders first screen with tiles sorted worst valid first and completeness chart", async () => {
    show();

    expect(screen.getByRole("heading", { level: 1, name: "Helsinki data quality" })).toBeInTheDocument();

    // Type buttons bar contains all 4 types
    const typeList = await screen.findByRole("list", { name: "Entity types" });
    expect(within(typeList).getByRole("button", { name: "BikeHireDockingStation" })).toBeInTheDocument();
    expect(within(typeList).getByRole("button", { name: "CityDistrict" })).toBeInTheDocument();
    expect(within(typeList).getByRole("button", { name: "Event" })).toBeInTheDocument();
    expect(within(typeList).getByRole("button", { name: "Vehicle" })).toBeInTheDocument();

    // Wait for overview tiles to render
    const bikeTile = await screen.findByRole("button", { name: /^BikeHireDockingStation: 6 entities/i });
    expect(bikeTile).toBeInTheDocument();
    expect(within(bikeTile).getByText("33 %")).toBeInTheDocument(); // valid 2/6
    expect(within(bikeTile).getByText("5 min")).toBeInTheDocument(); // median age

    const districtTile = screen.getByRole("button", { name: /^CityDistrict: 2 entities/i });
    expect(within(districtTile).getByText("50 %")).toBeInTheDocument(); // valid 1/2
    expect(within(districtTile).getByText("no timestamp")).toBeInTheDocument();

    const eventTile = screen.getByRole("button", { name: /^Event: 2 entities/i });
    expect(within(eventTile).getByText("50 %")).toBeInTheDocument(); // valid 1/2
    expect(within(eventTile).getByText("3 h")).toBeInTheDocument();

    const vehicleTile = screen.getByRole("button", { name: /^Vehicle: 2 entities/i });
    expect(within(vehicleTile).getByText("no published schema")).toBeInTheDocument();

    // Verify ordering: BikeHireDockingStation (33%) is first tile, Vehicle (null) is last
    const tiles = screen.getAllByRole("button", { name: /entities$/i });
    expect(tiles[0]).toHaveTextContent("BikeHireDockingStation");
    expect(tiles[3]).toHaveTextContent("Vehicle");

    // Completeness bar chart canvas
    expect(screen.getByRole("img", { name: "Completeness by type" })).toBeInTheDocument();
  });

  it("chooses BikeHireDockingStation by button, updating aria-pressed, hash, and tables", async () => {
    show();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    const bikeButton = await screen.findByRole("button", { name: "BikeHireDockingStation" });
    expect(bikeButton).toHaveAttribute("aria-pressed", "false");

    await user.click(bikeButton);
    expect(bikeButton).toHaveAttribute("aria-pressed", "true");
    expect(decodeURIComponent(window.location.hash)).toContain("#quality?type=BikeHireDockingStation");

    // Freshness details
    expect(await screen.findByRole("table", { name: "Attributes of BikeHireDockingStation" })).toBeInTheDocument();
    expect(screen.getByText("5 min")).toBeInTheDocument();

    // Attributes table
    const attrTable = screen.getByRole("table", { name: "Attributes of BikeHireDockingStation" });
    expect(within(attrTable).getByText("availableBikeNumber")).toBeInTheDocument();
    expect(within(attrTable).getByText("dateModified")).toBeInTheDocument();
    expect(within(attrTable).getByText("location")).toBeInTheDocument();
    expect(within(attrTable).getByText("name")).toBeInTheDocument();
    expect(within(attrTable).getByText("status")).toBeInTheDocument();

    // Failing entities table with plain words
    const failTable = screen.getByRole("table", { name: "Failing entities" });
    const failRows = within(failTable).getAllByRole("row");
    // Header row + 4 failing rows = 5 rows
    expect(failRows).toHaveLength(5);

    expect(within(failTable).getByText("fail-neg")).toBeInTheDocument();
    expect(within(failTable).getByText("below the minimum 0")).toBeInTheDocument();

    expect(within(failTable).getByText("fail-float")).toBeInTheDocument();
    expect(within(failTable).getByText("not of type integer")).toBeInTheDocument();

    expect(within(failTable).getByText("fail-date")).toBeInTheDocument();
    expect(within(failTable).getByText("not a date-time")).toBeInTheDocument();

    // Through the SDK a geometry without coordinates arrives as its `type` string ("Point"): the
    // steward reads that the value is not a geometry. wasm.test.ts covers the `required` path.
    expect(within(failTable).getByText("fail-loc")).toBeInTheDocument();
    expect(within(failTable).getByText("not of type object")).toBeInTheDocument();
  });

  it("displays 'no published schema' for Vehicle in tile and detail screen", async () => {
    show();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    const vehicleBtn = await screen.findByRole("button", { name: "Vehicle" });
    await user.click(vehicleBtn);

    expect(decodeURIComponent(window.location.hash)).toContain("#quality?type=Vehicle");
    expect(await screen.findByText("No published schema; validity could not be checked.")).toBeInTheDocument();
    expect(screen.getByText("All entities pass validation.")).toBeInTheDocument();
  });

  it("handles one refused type, displaying error tile while others remain", async () => {
    const client = stubClient(
      { entities: ENTITIES, schema: STUB_SCHEMA, access: ACCESS },
      { appName: "data-quality-inspector" },
    );
    const all = client.entities.all.bind(client.entities);
    client.entities.all = (async (type: string, query?: Parameters<typeof all>[1]) => {
      if (type === "Event") {
        throw new ProblemError(500, { title: "Event service unavailable", status: 500 });
      }
      return all(type, query);
    }) as typeof client.entities.all;

    show(client);

    // Event tile displays error message
    const errorMsg = await screen.findByText("Data could not be read.");
    expect(errorMsg).toBeInTheDocument();
    expect(errorMsg.closest(".app-tile-error")).toHaveTextContent("Event");

    // Other tiles remain functional
    expect(await screen.findByRole("button", { name: /^BikeHireDockingStation: 6 entities/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^CityDistrict: 2 entities/i })).toBeInTheDocument();
  });

  it("handles refused schema, showing notice that validity is not checked", async () => {
    const client = stubClient(
      { entities: ENTITIES, access: ACCESS },
      { appName: "data-quality-inspector" },
    );
    client.schema = vi.fn().mockRejectedValue(new ProblemError(503, { title: "Schema broker down" }));

    show(client);

    expect(
      await screen.findByText("The published schema could not be read; validity is not checked."),
    ).toBeInTheDocument();
  });

  it("supports Finnish with ?lang=fi and toggles language", async () => {
    window.history.replaceState(null, "", "/?lang=fi");
    show();

    expect(await screen.findByRole("heading", { level: 1, name: "Helsingin datan laatu" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Tietotyyppien kattavuus" })).toBeInTheDocument();

    const switchBtn = screen.getByRole("button", { name: "In English" });
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(switchBtn);

    expect(screen.getByRole("heading", { level: 1, name: "Helsinki data quality" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("lang")).toBe("en");
    });
  });
});
