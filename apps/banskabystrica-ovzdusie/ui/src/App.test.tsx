/**
 * The screen, over what the `public-air` endpoint answers (T-2435).
 *
 * `fetch` is what is stubbed and nothing below it, so every case goes through the SDK's own
 * endpoint source: the same URL building, the same NGSI-LD parsing and the same refusal handling
 * the published bundle uses. MapLibre needs WebGL, which jsdom does not have, so the library is
 * replaced by a double that records what the app asked it to draw.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";

const setData = vi.fn();
const addSource = vi.fn();
const addLayer = vi.fn();
const remove = vi.fn();

vi.mock("maplibre-gl", () => {
  class Map {
    constructor(public options: unknown) {}
    on(event: string, handler: () => void) {
      // The app adds its source and layer on `load`; firing it at once is what the browser does
      // before anybody looks at the page.
      if (event === "load") handler();
    }
    addSource = addSource;
    addLayer = addLayer;
    getSource = () => ({ setData });
    remove = remove;
  }
  // Named, not default: maplibre-gl 6 has no default export.
  return { Map };
});
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));

const App = (await import("./App")).default;
const { answer, history } = await import("./fixtures/ovzdusie");
const { LOCALES } = await import("./locales");

const SLUG = "mluyob4nz52lok3ssk7pgn5vwt";
const NOW = new Date("2026-09-20T09:00:00Z");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ title: "Refused", status, detail }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });

let calls: Array<{ path: string; init?: RequestInit }>;

/** Answers the entity query and the temporal read; anything else is a test that asked wrongly. */
function serving(options: { entities?: () => Response; temporal?: () => Response } = {}) {
  return vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path.includes("/temporal/entities/")) {
      return options.temporal ? options.temporal() : json(history(`${path}`, NOW));
    }
    if (path.includes("/entities")) {
      return options.entities ? options.entities() : json(answer(NOW));
    }
    throw new Error(`no stub for ${path}`);
  });
}

function show(options: Parameters<typeof serving>[0] = {}, language = "sk") {
  vi.stubGlobal("fetch", serving(options));
  const client = stubClient(undefined, {
    slug: SLUG,
    orgDomain: "banskabystrica.sk",
    space: "ovzdusie",
    transport: "origin",
    appName: "banskabystrica-ovzdusie",
    language,
  });
  return render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
}

beforeEach(() => {
  calls = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const stations = () => screen.getByRole("region", { name: LOCALES.sk.stationsLabel });

describe("the stations of the city", () => {
  it("draws one point per station that publishes a place, and lists every station", async () => {
    show();
    await waitFor(() => expect(addSource).toHaveBeenCalled());

    const [, source] = addSource.mock.calls[0] as [string, { data: { features: unknown[] } }];
    // Four stations answered; the fourth publishes no location, so it is on the list and not on
    // the map — leaving it off the list would hide a station that exists.
    expect(source.data.features).toHaveLength(3);
    expect(within(stations()).getAllByRole("article")).toHaveLength(4);
    expect(within(stations()).getByRole("heading", { name: "Stanica 4" })).toBeInTheDocument();
    expect(within(stations()).getByText(LOCALES.sk.noLocation)).toBeInTheDocument();
  });

  it("marks a station that stopped reporting as old, not as clean air", async () => {
    show();
    const card = await waitFor(() =>
      within(stations()).getByRole("heading", { name: "Stanica 3" }).closest("article"),
    );
    // Its last number is 9.1 µg/m³, which would be the cleanest reading on the screen.
    expect(within(card as HTMLElement).getByText(/9,1|9\.1/)).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText(new RegExp(LOCALES.sk.band.stale))).toBeInTheDocument();
    expect(within(card as HTMLElement).queryByText(new RegExp(LOCALES.sk.band.low))).toBeNull();
  });

  it("says a station is over the limit when it is", async () => {
    show();
    const card = await waitFor(() =>
      within(stations()).getByRole("heading", { name: "Stanica 2" }).closest("article"),
    );
    expect(within(card as HTMLElement).getByText(new RegExp(LOCALES.sk.band.high))).toBeInTheDocument();
  });

  it("says there is no station rather than drawing an empty map", async () => {
    show({ entities: () => json([]) });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(LOCALES.sk.empty));
    expect(screen.queryByRole("region", { name: LOCALES.sk.stationsLabel })).toBeNull();
    expect(addSource).not.toHaveBeenCalled();
  });

  it("shows a refusal from the endpoint as itself, in the endpoint's own words", async () => {
    show({ entities: () => problem(503, "Broker je nedostupný.") });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Broker je nedostupný.");
  });
});

describe("the picked station", () => {
  it("opens on the freshest station and reads one day of it through queryTemporal", async () => {
    show();
    await waitFor(() => expect(screen.getByRole("region", { name: /Stanica 4/ })).toBeInTheDocument());
    await waitFor(() =>
      expect(calls.some((call) => call.path.includes("/temporal/entities/"))).toBe(true),
    );
    const temporal = calls.find((call) => call.path.includes("/temporal/entities/"))!;
    expect(temporal.path).toContain("attrs=pm10");
    expect(temporal.path).toContain("timerel=");
  });

  it("changes to the station a person picks", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    show();
    const card = await waitFor(() =>
      within(stations()).getByRole("heading", { name: "Stanica 2" }).closest("article"),
    );
    await user.click(within(card as HTMLElement).getByRole("button", { name: LOCALES.sk.pick }));
    expect(screen.getByRole("region", { name: /Stanica 2/ })).toBeInTheDocument();
  });
});

describe("what the screen says about itself", () => {
  it("is Slovak by default and English when the configuration asks", async () => {
    const { unmount } = show();
    expect(await screen.findByRole("heading", { name: LOCALES.sk.title, level: 1 })).toBeInTheDocument();
    unmount();

    show({}, "en");
    expect(await screen.findByRole("heading", { name: LOCALES.en.title, level: 1 })).toBeInTheDocument();
  });

  it("never sends a credential: the endpoint is public and the bundle holds no token (AP-28)", async () => {
    show();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    for (const call of calls) {
      const headers = (call.init?.headers ?? {}) as Record<string, string>;
      expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain("authorization");
      expect(call.init?.credentials).toBe("same-origin");
    }
  });

  it("has no axe violation with the stations on screen", async () => {
    const { container } = show();
    await waitFor(() => expect(screen.getByRole("region", { name: LOCALES.sk.stationsLabel })).toBeInTheDocument());
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});
