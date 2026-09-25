/**
 * The screen over the rows the praha pipelines write (T-2917). `fetch` is what is stubbed and
 * nothing below it, so every case goes through the SDK's own endpoint source.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import bikes from "./fixtures/bikes.json";
import parking from "./fixtures/parking.json";
import air from "./fixtures/air.json";
import { LOCALES } from "./locales";
import { drawn } from "../test-setup";

const SLUG = "k3pq7vwyxz2a4b5c6d7e8f9g0h1j2m3n";
const ENDPOINTS = [{ name: "app-praha-mesto", slug: SLUG, space: "praha-mesto", types: ["BikeHireDockingStation"] }];

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const BY_TYPE: Record<string, unknown[]> = {
  BikeHireDockingStation: bikes,
  OffStreetParking: parking,
  AirQualityObserved: air,
};

/** Answers each type with its rows; `override` replaces one type's answer. */
function serving(override: Record<string, () => Response> = {}) {
  return vi.fn(async (path: string) => {
    const url = new URL(path, "https://portal.example");
    const type = url.searchParams.get("type") ?? "";
    if (!url.pathname.includes(`/api/endpoint/${SLUG}/`)) throw new Error(`no stub for ${path}`);
    if (override[type]) return override[type]();
    return answer(BY_TYPE[type] ?? []);
  });
}

function show(options: { override?: Record<string, () => Response>; language?: string; endpoints?: typeof ENDPOINTS; basemap?: string } = {}) {
  const fetch = serving(options.override);
  vi.stubGlobal("fetch", fetch);
  const client = stubClient(undefined, {
    slug: SLUG,
    orgDomain: "praha.cz",
    space: "praha-mesto",
    transport: "origin",
    appName: "praha-mesto",
    language: options.language ?? "cs",
    endpoints: options.endpoints ?? ENDPOINTS,
    basemap: options.basemap,
  });
  render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
  return fetch;
}

const section = (name: string) => screen.getByRole("region", { name });
const cs = LOCALES.cs;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Prague right now", () => {
  it("draws the stations on the served basemap in the ramp's colours, with a legend and a chart", async () => {
    drawn.data.length = 0;
    drawn.style.length = 0;
    const located = bikes.map((entity, i) => ({
      ...entity,
      location: { type: "GeoProperty", value: { type: "Point", coordinates: [14.4 + i / 100, 50.07] } },
    }));
    show({ basemap: "https://tiles.example/style.json", override: { BikeHireDockingStation: () => answer(located) } });
    const bikesSection = section(cs.bikes.title);
    await waitFor(() => expect(drawn.data.length).toBeGreaterThan(0));
    expect(drawn.style).toEqual(["https://tiles.example/style.json"]);
    const last = drawn.data.at(-1) as { features: { geometry: { coordinates: number[] }; properties: { colour: string } }[] };
    // Three named stations in service, each at its own point, coloured by its step.
    expect(last.features).toHaveLength(3);
    expect(new Set(last.features.map((feature) => feature.properties.colour)).size).toBe(2);
    expect(within(bikesSection).getAllByRole("listitem").filter((item) => item.closest(".legend"))).toHaveLength(5);
    expect(within(bikesSection).getByRole("img", { name: /0: 2, 1–2: 1/ })).toBeInTheDocument();
    await waitFor(() => expect(within(section(cs.parking.title)).getByRole("img", { name: cs.parking.chart(2) })).toBeInTheDocument());
    await waitFor(() => expect(within(section(cs.air.title)).getByRole("img", { name: cs.air.chart(2) })).toBeInTheDocument());
  });

  it("shows the bikes, the car parks and the air from the space, each under its own heading", async () => {
    show();
    const bikesSection = section(cs.bikes.title);
    await waitFor(() => expect(within(bikesSection).getByRole("rowheader", { name: "P10-Čechovo náměstí" })).toBeInTheDocument());
    // Three named stations in service: one bike to rent, 29 free docks.
    expect(within(bikesSection).getByText("29").closest("li")).toHaveTextContent(cs.bikes.docks);
    const parks = section(cs.parking.title);
    await waitFor(() => expect(within(parks).getByRole("rowheader", { name: "P+R Běchovice" })).toBeInTheDocument());
    const counted = within(parks).getByRole("rowheader", { name: "P+R Běchovice" }).closest("tr");
    expect(counted).toHaveTextContent("92");
    expect(counted).toHaveTextContent("23");
    expect(within(parks).getByRole("rowheader", { name: "P+R Černý Most II" }).closest("tr")).toHaveTextContent(cs.parking.noLive);
    const airSection = section(cs.air.title);
    await waitFor(() => expect(within(airSection).getByRole("rowheader", { name: "Praha 4-Libuš" })).toBeInTheDocument());
    expect(within(airSection).getByRole("rowheader", { name: "Praha 4-Libuš" }).closest("tr")).toHaveTextContent("4,9");
  });

  it("narrows the stations by a search typed without diacritics", async () => {
    show();
    const bikesSection = section(cs.bikes.title);
    await waitFor(() => expect(within(bikesSection).getAllByRole("row")).toHaveLength(4));
    fireEvent.change(within(bikesSection).getByLabelText(cs.search), { target: { value: "vrsovicke" } });
    expect(within(bikesSection).getAllByRole("row")).toHaveLength(2);
    expect(within(bikesSection).getByText(cs.shown(1, 3))).toBeInTheDocument();
  });

  it("keeps the other sections when one type is refused, and says what failed in its place", async () => {
    show({
      override: {
        OffStreetParking: () =>
          new Response(JSON.stringify({ title: "Forbidden", status: 403, detail: "the endpoint does not serve OffStreetParking" }), {
            status: 403,
            headers: { "content-type": "application/problem+json" },
          }),
      },
    });
    const parks = section(cs.parking.title);
    await waitFor(() => expect(within(parks).getByRole("alert")).toHaveTextContent(cs.unavailable));
    await waitFor(() => expect(within(section(cs.air.title)).getByText("Praha 4-Libuš")).toBeInTheDocument());
  });

  it("says so when the space is empty and when the app has no endpoint for it", async () => {
    show({ override: { AirQualityObserved: () => answer([]) } });
    await waitFor(() => expect(within(section(cs.air.title)).getByText(cs.empty)).toBeInTheDocument());
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    const fetch = show({ endpoints: [] });
    await waitFor(() => expect(screen.getAllByText(cs.noEndpoint)).toHaveLength(3));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads every page of a type the endpoint pages", async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ ...bikes[0], id: `${bikes[0].id}${i}` }));
    const fetch = show({
      override: {
        BikeHireDockingStation: (() => {
          let call = 0;
          return () => answer(call++ === 0 ? many.slice(0, 500) : many.slice(500));
        })(),
      },
    });
    await waitFor(() => expect(within(section(cs.bikes.title)).getByText(cs.shown(50, 501))).toBeInTheDocument());
    const asked = fetch.mock.calls.map(([path]) => new URL(path, "https://portal.example")).filter((url) => url.searchParams.get("type") === "BikeHireDockingStation");
    expect(asked.map((url) => Number(url.searchParams.get("offset") ?? 0))).toEqual([0, 500]);
  });

  it("speaks English when the Portal does, and has no accessibility violation", async () => {
    show({ language: "en" });
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: LOCALES.en.title })).toBeInTheDocument());
    await waitFor(() => expect(within(section(LOCALES.en.air.title)).getByText("Praha 4-Libuš")).toBeInTheDocument());
    const result = await axe.run(document.body);
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });
});
