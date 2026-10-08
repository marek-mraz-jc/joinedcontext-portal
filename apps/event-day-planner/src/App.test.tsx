import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { EVENTS } from "./fixtures/events";

/** What a click on a stop of the map hands the page, as MapLibre would; the last map built's. */
let clickStop: (event: { features?: Array<{ properties?: { id?: string } }> }) => void = () => undefined;
vi.mock("maplibre-gl", () => ({
  Map: class {
    on(event: string, layer: unknown, handler?: unknown) {
      if (event === "load" && typeof layer === "function") (layer as () => void)();
      if (event === "click" && layer === "app-points") clickStop = handler as typeof clickStop;
    }
    addSource = vi.fn();
    addLayer = vi.fn();
    getSource = () => ({ setData: vi.fn() });
    fitBounds = vi.fn();
    remove = vi.fn();
  },
  LngLatBounds: class {
    extend = vi.fn();
  },
  setWorkerUrl: vi.fn(),
}));
vi.mock("echarts/core", () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), on: vi.fn() })) }));

const READ = {
  permissions: [{ resource: { type: "Event" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" as const }],
  prohibitions: [],
};

function app(language = "en") {
  // `portal`: where the entity panel links an event (SDK-40); shown, never followed.
  const client = stubClient({ entities: EVENTS, access: READ }, { appName: "event-day-planner", language, portal: "https://portal.test/projects/helsinki" });
  render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-10-20T05:00:00Z"));
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("event-day-planner", () => {
  // SDK-39, SDK-40: the shell carries the title; an event in the plan, in the list or on the map
  // opens in the entity panel, linked to the Portal, with no Edit: a public App writes nothing.
  it("opens an event from the plan, the list and the map in the entity panel, without Edit", async () => {
    const client = app();
    expect(screen.getByRole("heading", { level: 1, name: "My day of events" })).toBeInTheDocument();
    const plan = await screen.findByRole("list", { name: "The plan" });
    fireEvent.click(within(plan).getByRole("button", { name: "Workshop for Families" }));
    const panel = await screen.findByRole("dialog", { name: "Workshop for Families" });
    const portal = await within(panel).findByRole("link", { name: "Open in the Portal" });
    expect(portal).toHaveAttribute("rel", "noopener noreferrer");
    fireEvent.click(portal);
    expect(within(panel).queryByRole("button", { name: "Edit" })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const list = screen.getByRole("list", { name: "Events of the day" });
    fireEvent.click(within(list).getByRole("button", { name: "Organ concert" }));
    expect(await screen.findByRole("dialog", { name: "Organ concert" })).toBeInTheDocument();

    // A stop the map no longer holds opens nothing; one it holds opens its event.
    act(() => clickStop({ features: [{ properties: { id: "gone" } }] }));
    act(() => clickStop({ features: [{ properties: { id: "helsinki-agf1" } }] }));
    expect(await screen.findByRole("dialog", { name: "Workshop for Families" })).toBeInTheDocument();
    expect(client.transport.calls.every((call) => call.method === "GET")).toBe(true);
  });

  // The language: from the Portal at first, then the visitor's, kept in the address.
  it("switches to Finnish and back, and keeps the language in the address", async () => {
    app();
    await screen.findByRole("list", { name: "The plan" });
    fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "fi" } });
    expect(await screen.findByRole("heading", { level: 1, name: "Tapahtumapäiväni" })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("lang")).toBe("fi");
    fireEvent.change(screen.getByRole("combobox", { name: "Kieli" }), { target: { value: "en" } });
    expect(await screen.findByRole("heading", { level: 1, name: "My day of events" })).toBeInTheDocument();
  });
});
