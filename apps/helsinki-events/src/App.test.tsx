import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { EVENTS } from "./fixtures/events";

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
// jsdom has no canvas; the charts themselves are tested in pages/Events.test.tsx.
vi.mock("echarts", () => ({ init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), on: vi.fn() })) }));

const READ = {
  permissions: [{ resource: { type: "Event" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" as const }],
  prohibitions: [],
};

describe("helsinki-events", () => {
  // AP-04, AP-138: one page, read through the app's own endpoint only, never written to.
  it("opens on the events, read only through the app's endpoint", async () => {
    const client = stubClient({ entities: EVENTS, access: READ }, { appName: "helsinki-events" });
    render(
      <JcProvider client={client}>
        <App />
      </JcProvider>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Helsinki events" })).toBeInTheDocument();
    const events = await screen.findByRole("region", { name: "Events" });
    await waitFor(() => expect(within(events).getByRole("heading", { name: "Organ concert" })).toBeInTheDocument());
    expect(client.transport.calls.length).toBeGreaterThan(0);
    expect(client.transport.calls.every((call) => call.path.includes("/api/endpoint/"))).toBe(true);
    expect(client.transport.calls.every((call) => call.method === "GET")).toBe(true);
  });
});
