import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JcProvider } from "@joinedcontext/sdk";
import type { Row } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import { EVENTS } from "../fixtures/events";

// T-2923, AP-138: the events page draws in colour: a chart per question, the events on the map
// in their register's colour, and a click on a bar picks the list out.
const maps: Array<{ setData: ReturnType<typeof vi.fn>; load?: () => void }> = [];
vi.mock("maplibre-gl", () => {
  class Map {
    setData = vi.fn();
    fitBounds = vi.fn();
    addControl = vi.fn();
    removeControl = vi.fn();
    setPaintProperty = vi.fn();
    addSource = vi.fn();
    addLayer = vi.fn();
    getSource = vi.fn(() => ({ setData: this.setData }));
    remove = vi.fn();
    load?: () => void;
    constructor() {
      maps.push(this);
    }
    on(event: string, handler: unknown) {
      if (event === "load" && typeof handler === "function") this.load = handler as () => void;
    }
  }
  return { Map, setWorkerUrl: vi.fn() };
});
vi.mock("@deck.gl/mapbox", () => ({ MapboxOverlay: class {} }));
vi.mock("@deck.gl/layers", () => ({ ScatterplotLayer: class {} }));
vi.mock("@deck.gl/aggregation-layers", () => ({ HexagonLayer: class {}, GridLayer: class {} }));

type Click = (params: { name?: string }) => void;
const charts: Array<{ element: HTMLElement; setOption: ReturnType<typeof vi.fn>; click?: Click }> = [];
vi.mock("echarts", () => ({
  init: vi.fn((element: HTMLElement) => {
    const chart: (typeof charts)[number] = { element, setOption: vi.fn() };
    const api = {
      setOption: chart.setOption,
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn((event: string, handler: Click) => {
        if (event === "click") chart.click = handler;
      }),
    };
    charts.push(chart);
    return api;
  }),
}));

import { Events } from "./Events";

const READ = {
  permissions: [{ resource: { type: "Event" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" as const }],
  prohibitions: [],
};

function events(entities: Row[] = EVENTS, refuse?: () => { status: number; body: unknown } | null) {
  const client = stubClient({ entities, access: READ, refuse }, { appName: "helsinki-events" });
  render(
    <JcProvider client={client}>
      <Events />
    </JcProvider>,
  );
  return client;
}

const chartOf = (title: string) => {
  const figure = screen.getByText(title).closest("figure") as HTMLElement;
  const chart = charts.filter((c) => figure.contains(c.element)).at(-1);
  expect(chart, title).toBeDefined();
  return chart!;
};
const optionOf = (title: string): Record<string, any> => chartOf(title).setOption.mock.calls.at(-1)![0];
const listed = () => within(screen.getByRole("list", { name: "Upcoming events" })).getAllByRole("heading").map((h) => h.textContent);

describe("the events page", () => {
  beforeEach(() => {
    maps.length = 0;
    charts.length = 0;
    // The page opens on today in Helsinki; the fixtures are in October 2030.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-10-20T06:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("asks the endpoint only for the events that have not ended, and lists the rest soonest first", async () => {
    const client = events();
    await waitFor(() => expect(listed()).toHaveLength(5));
    expect(listed()).toEqual(["Workshop for Families", "Organ concert", "Story hour", "Dance workshop", "Jazz at Stoa"]);
    expect(client.transport.calls.some((call) => decodeURIComponent(call.path).includes("q=endDate>="))).toBe(true);
    expect(screen.getByText("5 of 6 events")).toBeInTheDocument();
  });

  it("charts the events per day for 30 days and per register, each register in its own colour", async () => {
    events();
    await waitFor(() => expect(optionOf("Events per day, next 30 days").series[0].data).toHaveLength(30));
    const perDay = optionOf("Events per day, next 30 days");
    expect(perDay.xAxis.data[0]).toBe("2030-10-20");
    expect(perDay.series[0].data.slice(0, 4)).toEqual([2, 0, 1, 1]);
    const registers = optionOf("Events by register");
    expect(registers.yAxis.data).toEqual(["City of Helsinki", "Culture centres", "City of Espoo"]);
    const colours = registers.series[0].data.map((bar: { itemStyle: { color: string } }) => bar.itemStyle.color);
    expect(new Set(colours).size).toBe(3);
    const legend = screen.getByLabelText("Map colour: the register that publishes the event");
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual(registers.yAxis.data);
  });

  it("puts one feature per located event on the map, coloured by its register", async () => {
    events();
    await waitFor(() => expect(maps.length).toBeGreaterThan(0));
    const map = maps[0];
    map.load?.();
    await waitFor(() => expect(map.setData).toHaveBeenCalled());
    const features = map.setData.mock.calls.at(-1)![0].features;
    // Five are upcoming, and the cancelled jazz evening has no location.
    expect(features).toHaveLength(4);
    const colours = new Set(features.map((f: { properties: { color: string } }) => f.properties.color));
    expect(colours.size).toBe(3);
  });

  it("shows only the day or the register whose bar is clicked, and the chip puts them back", async () => {
    events();
    await waitFor(() => expect(listed()).toHaveLength(5));
    chartOf("Events per day, next 30 days").click?.({ name: "2030-10-22" });
    await waitFor(() => expect(listed()).toEqual(["Story hour"]));
    fireEvent.click(screen.getByRole("button", { name: "Show every day, not only 22 Oct" }));
    await waitFor(() => expect(listed()).toHaveLength(5));
    chartOf("Events by register").click?.({ name: "Culture centres" });
    await waitFor(() => expect(listed()).toEqual(["Dance workshop", "Jazz at Stoa"]));
    // A second click on the same bar is the way back too.
    chartOf("Events by register").click?.({ name: "Culture centres" });
    await waitFor(() => expect(listed()).toHaveLength(5));
  });

  it("searches, narrows by date and says when nothing matches", async () => {
    events();
    await waitFor(() => expect(listed()).toHaveLength(5));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "turunlinnantie" } });
    expect(listed()).toEqual(["Dance workshop", "Jazz at Stoa"]);
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2030-10-31" } });
    expect(listed()).toEqual(["Dance workshop"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "opera" } });
    expect(screen.getByText("No event matches the filters.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(listed()).toHaveLength(5);
  });

  it("marks a cancelled event and links only an https source", async () => {
    events();
    await waitFor(() => expect(listed()).toHaveLength(5));
    const card = (name: string) => screen.getByRole("heading", { name }).closest("li") as HTMLElement;
    expect(within(card("Jazz at Stoa")).getByText("Cancelled")).toBeInTheDocument();
    expect(within(card("Organ concert")).queryByText("Cancelled")).toBeNull();
    expect(within(card("Organ concert")).getByRole("link", { name: "Source" })).toHaveAttribute("href", "https://api.hel.fi/linkedevents/v1/");
    expect(within(card("Story hour")).queryByRole("link")).toBeNull();
  });

  it("says there are no upcoming events when the endpoint has none", async () => {
    events([]);
    expect(await screen.findByText("No upcoming events.")).toBeInTheDocument();
    const registers = screen.getByText("Events by register").closest("figure") as HTMLElement;
    expect(within(registers).getByText("No event matches.")).toBeInTheDocument();
    // The days still show, every one of them empty.
    await waitFor(() => expect(optionOf("Events per day, next 30 days").series[0].data.every((n: number) => n === 0)).toBe(true));
  });

  it("says the events could not be read, with the status, and reads them again on Retry", async () => {
    let fail = true;
    events(EVENTS, () => (fail ? { status: 503, body: { title: "Unavailable" } } : null));
    const alert = await screen.findByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getAllByText("Nothing to chart until the events are read.")).toHaveLength(2);
    expect(alert).toHaveTextContent("The events could not be read (HTTP 503). Try again later.");
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(listed()).toHaveLength(5));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
