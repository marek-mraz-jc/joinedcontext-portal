/**
 * The Žilina records over what the app's three endpoints answer (T-3140). `fetch` is stubbed, so
 * every case goes through the SDK's own endpoint source and grid.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { answer } from "./fixtures/data";
import { LOCALES } from "./locales";

const s = LOCALES.sk;
const ENDPOINTS = [
  { name: "app-zilina-zaznamy", slug: "verejne-slug", space: "zilina-verejne", types: ["PointOfInterest", "GtfsStop", "AirQualityObserved"] },
  { name: "app-zilina-zaznamy-uniza", slug: "uniza-slug", space: "zilina-uniza", types: ["CreativeWork"] },
];

function show() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      calls.push(path);
      const type = new URL(path, "http://portal.test").searchParams.get("type");
      return new Response(JSON.stringify(answer(type)), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  const client = stubClient(undefined, {
    slug: "verejne-slug",
    orgDomain: "zilina.sk",
    space: "zilina-verejne",
    endpoints: ENDPOINTS,
    transport: "origin",
    appName: "zilina-zaznamy",
    language: "sk",
  } as never);
  const view = render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
  return { ...view, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const choose = (name: string) => userEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: new RegExp(name) }));

describe("the Žilina records", () => {
  it("opens on the monuments with the model's columns in Slovak", async () => {
    show();
    const table = await screen.findByRole("grid");
    await waitFor(() => expect(within(table).getByText("Trojičný stĺp")).toBeInTheDocument());
    for (const column of ["Objekt", "Sloh", "Vznik", "Katastrálne územie", "Forma vlastníctva"]) {
      expect(within(table).getByRole("columnheader", { name: new RegExp(column) })).toBeInTheDocument();
    }
    expect(screen.getByText(s.readOnly)).toBeInTheDocument();
  });

  it("reads each dataset through the endpoint of its own space", async () => {
    const { calls } = show();
    await choose(s.name.works);
    await waitFor(() => expect(calls.some((call) => call.includes("/api/endpoint/uniza-slug/") && call.includes("type=CreativeWork"))).toBe(true));
    expect(await screen.findByRole("heading", { level: 2, name: s.name.works })).toBeInTheDocument();
    await choose(s.name.stations);
    await waitFor(() => expect(within(screen.getByRole("grid")).getByText("Brodno")).toBeInTheDocument());
    expect(calls.filter((call) => call.includes("type=GtfsStop")).every((call) => call.includes("/api/endpoint/verejne-slug/"))).toBe(true);
  });

  it("says so where the app has no endpoint of a dataset's space", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
    const client = stubClient(undefined, { slug: "verejne-slug", orgDomain: "zilina.sk", space: "zilina-verejne", endpoints: [ENDPOINTS[0]], transport: "origin", appName: "zilina-zaznamy", language: "sk" } as never);
    render(
      <JcProvider client={client}>
        <App />
      </JcProvider>,
    );
    await choose(s.name.works);
    expect(screen.getByRole("alert")).toHaveTextContent(s.noEndpoint(s.name.works));
    expect(screen.queryByRole("grid")).toBeNull();
  });

  it("downloads the whole dataset and says how many rows", async () => {
    const created = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }));
    show();
    await screen.findByRole("grid");
    await userEvent.click(screen.getByRole("button", { name: s.exportCsv }));
    await waitFor(() => expect(screen.getByText(s.exported(5))).toBeInTheDocument());
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("names whose data each dataset is and has nothing axe finds", async () => {
    const { container } = show();
    await screen.findByRole("grid");
    expect(screen.getByText(s.licence.monuments)).toBeInTheDocument();
    const found = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(found.violations.map((v) => v.id)).toEqual([]);
  });
});
