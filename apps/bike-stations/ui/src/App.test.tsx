/**
 * The mobility project's station map over what the shared `helsinki-bikes` endpoint answers (T-3185).
 *
 * `fetch` is what is stubbed, so every case goes through the SDK's own endpoint source. MapLibre
 * needs WebGL, which jsdom does not have, so the library is a double recording what it was given.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";

const setData = vi.fn();

vi.mock("maplibre-gl", () => {
  class Map {
    on(event: string, handler: () => void) {
      if (event === "load") handler();
    }
    addSource = vi.fn();
    addLayer = vi.fn();
    getSource = () => ({ setData });
    remove = vi.fn();
  }
  return { Map };
});
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));

const App = (await import("./App")).default;
const { answer } = await import("./fixtures/bikes");
const { LOCALES } = await import("./locales");
const s = LOCALES.en;

/** The App's own endpoint over its project's space, and the shared one of the helsinki project. */
const OWN = { name: "app-bike-stations", slug: "own7kq3zr5mx2vwt6nbc4pjd7fgs3mob", space: "mobility", types: ["BikeHireDockingStation"] };
const SHARED = { name: "helsinki-bikes", slug: "scsd2eehkx42n53z2zyd6vshfh7s7irf", space: "helsinki", types: [] };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function show({ refuse = false, endpoints = [OWN, SHARED], language = "en" } = {}) {
  const fetch = vi.fn(async (path: string) => {
    if (refuse) {
      return new Response(JSON.stringify({ title: "Forbidden", status: 403, detail: "the policy does not grant this type" }), {
        status: 403,
        headers: { "content-type": "application/problem+json" },
      });
    }
    return json(answer(new URL(path, "http://portal.test").searchParams.get("type")));
  });
  vi.stubGlobal("fetch", fetch);
  const client = stubClient(undefined, {
    slug: OWN.slug,
    orgDomain: "hel.fi",
    space: "mobility",
    transport: "origin",
    appName: "bike-stations",
    language,
    endpoints,
  });
  return {
    fetch,
    ...render(
      <JcProvider client={client}>
        <App />
      </JcProvider>,
    ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const results = () => screen.getByRole("region", { name: /station/ });
const names = () => within(results()).queryAllByRole("button").map((button) => button.querySelector(".name")?.textContent);

describe("the city bike stations of the mobility project", () => {
  it("reads the stations through the shared endpoint, never the App's own, and counts what is free", async () => {
    const { fetch } = show();
    await waitFor(() => expect(names()).toContain("Kaivopuisto"));
    const asked = fetch.mock.calls.map(([path]) => String(path));
    expect(asked.every((path) => path.includes(`/api/endpoint/${SHARED.slug}/`))).toBe(true);
    expect(names()).toEqual(["Kaivopuisto", "Kalasatama (metro)", "Rautatientori", "Sompasaari", "Töölönlahdenkatu"]);
    // 7 + 0 + 24 + 3 bikes and 23 + 16 + 0 + 9 docks; a station that reports neither adds nothing.
    expect(screen.getByText(s.totals(5, 34, 48))).toBeInTheDocument();
    await waitFor(() => {
      const data = setData.mock.calls.at(-1)?.[0] as { features: unknown[] } | undefined;
      expect(data?.features).toHaveLength(4);
    });
  });

  it("tells an empty, a full and an unreported station apart in words, and marks one with no position", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Töölönlahdenkatu"));
    expect(within(results()).getByRole("button", { name: /Töölönlahdenkatu/ })).toHaveTextContent(s.standing.empty);
    expect(within(results()).getByRole("button", { name: /Rautatientori/ })).toHaveTextContent(s.standing.full);
    expect(within(results()).getByRole("button", { name: /Sompasaari/ })).toHaveTextContent(s.standing.unknown);
    expect(within(results()).getByRole("button", { name: /Kalasatama/ })).toHaveTextContent(s.notOnMap);
  });

  it("searches without diacritics and says when nothing matches", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Kaivopuisto"));
    await userEvent.type(screen.getByRole("searchbox", { name: s.search }), "toolon");
    expect(names()).toEqual(["Töölönlahdenkatu"]);
    await userEvent.clear(screen.getByRole("searchbox", { name: s.search }));
    await userEvent.type(screen.getByRole("searchbox", { name: s.search }), "nowhere");
    expect(within(results()).getByText(s.noResults)).toBeInTheDocument();
  });

  it("opens a station as a sheet, says what it does not report, and Escape returns to the list", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Sompasaari"));
    const item = within(results()).getByRole("button", { name: /Sompasaari/ });
    await userEvent.click(item);
    const sheet = screen.getByRole("region", { name: s.detailOf("Sompasaari") });
    expect(within(sheet).getByText("closed")).toBeInTheDocument();
    expect(within(sheet).getAllByText(s.noValue)).toHaveLength(4);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: s.detailOf("Sompasaari") })).toBeNull();
    await waitFor(() => expect(item).toHaveFocus());
  });

  it("says why the stations could not be read", async () => {
    show({ refuse: true });
    expect(await screen.findByRole("alert")).toHaveTextContent(s.refused("the policy does not grant this type"));
  });

  it("says it has nothing to read when the shared endpoint is not among its endpoints", () => {
    const { fetch } = show({ endpoints: [OWN] });
    expect(screen.getByRole("status")).toHaveTextContent(s.noEndpoint);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("speaks Finnish to a Finnish reader", async () => {
    show({ language: "fi-FI" });
    expect(await screen.findByRole("heading", { level: 1, name: LOCALES.fi.title })).toBeInTheDocument();
  });

  it("names its source and has nothing axe finds", async () => {
    const { container } = show();
    await waitFor(() => expect(names()).toContain("Kaivopuisto"));
    expect(screen.getByText(s.attribution)).toBeInTheDocument();
    const found = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(found.violations.map((v) => v.id)).toEqual([]);
  });
});
