/**
 * The Žilina map over what the public endpoint of `zilina-verejne` answers (T-3140).
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
const { answer } = await import("./fixtures/verejne");
const { LOCALES } = await import("./locales");
const s = LOCALES.sk;

const SLUG = "zhu42lbyivllciy7pluenlhxmqn5hi7c";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function show(refuse?: string, withEndpoint = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      const type = new URL(path, "http://portal.test").searchParams.get("type");
      if (type === refuse) {
        return new Response(JSON.stringify({ title: "Forbidden", status: 403, detail: "the policy does not grant this type" }), {
          status: 403,
          headers: { "content-type": "application/problem+json" },
        });
      }
      return json(answer(type));
    }),
  );
  const client = stubClient(undefined, {
    slug: withEndpoint ? SLUG : "",
    orgDomain: "zilina.sk",
    space: withEndpoint ? "zilina-verejne" : "elsewhere",
    transport: "origin",
    appName: "zilina-mapa",
    language: "sk",
  });
  return render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const results = () => screen.getByRole("region", { name: /miest/ });
const names = () => within(results()).queryAllByRole("button").map((button) => button.querySelector(".name")?.textContent);

describe("the Žilina map", () => {
  it("lists the monuments, the stations busiest first and the air station, and draws those with a position", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Stanica SK0020A, mestské pozadie"));
    expect(names()).toHaveLength(11);
    expect(names().slice(5, 7)).toEqual(["Žilina", "Brodno"]);
    expect(within(results()).getByText("166 odchodov dnes")).toBeInTheDocument();
    // The column on a square has no address: listed and said so, not drawn.
    expect(within(results()).getByText(new RegExp(s.notOnMap))).toBeInTheDocument();
    await waitFor(() => {
      const data = setData.mock.calls.at(-1)?.[0] as { features: unknown[] } | undefined;
      expect(data?.features).toHaveLength(10);
    });
  });

  it("shows one kind at a time and searches without diacritics", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Žilina"));
    await userEvent.click(screen.getByRole("radio", { name: new RegExp(`^${s.kind.monument}`) }));
    expect(names()).not.toContain("Žilina");
    expect(names()).toHaveLength(5);
    await userEvent.type(screen.getByRole("searchbox", { name: s.search }), "kastiel");
    expect(names()).toEqual(["Kaštieľ", "Kaštieľ Bytčica"]);
    await userEvent.clear(screen.getByRole("searchbox", { name: s.search }));
    await userEvent.type(screen.getByRole("searchbox", { name: s.search }), "nic take");
    expect(within(results()).getByText(s.noResults)).toBeInTheDocument();
  });

  it("opens the air station with each pollutant in its own unit and hour, and Escape returns to the list", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Stanica SK0020A, mestské pozadie"));
    const item = within(results()).getByRole("button", { name: /Stanica SK0020A/ });
    await userEvent.click(item);
    const sheet = screen.getByRole("region", { name: s.detailOf("Stanica SK0020A, mestské pozadie") });
    expect(within(sheet).getByText(/0,63 mg\/m³/)).toBeInTheDocument();
    expect(within(sheet).getByText(/32,3 µg\/m³/)).toBeInTheDocument();
    // Ozone's latest valid hour is a day older than the rest, and the sheet says which hour.
    expect(within(sheet).getByText(/5\. 10\. 2026/)).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: /Detail:/ })).toBeNull();
    await waitFor(() => expect(item).toHaveFocus());
  });

  it("opens a monument with its register entries and says what is missing", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Trojičný stĺp"));
    await userEvent.click(within(results()).getByRole("button", { name: /Trojičný stĺp/ }));
    const sheet = screen.getByRole("region", { name: s.detailOf("Trojičný stĺp") });
    expect(within(sheet).getByText("SÚSOŠIE")).toBeInTheDocument();
    expect(within(sheet).getByText("1317/2")).toBeInTheDocument();
    expect(within(sheet).getAllByText(s.noValue).length).toBeGreaterThan(0);
  });

  it("says why a kind the endpoint refuses is missing and keeps the others", async () => {
    show("GtfsStop");
    expect(await screen.findByRole("alert")).toHaveTextContent(s.refused(s.kind.station, "the policy does not grant this type"));
    await waitFor(() => expect(names()).toContain("Trojičný stĺp"));
    expect(names()).not.toContain("Brodno");
  });

  it("says it has nothing to read when the app has no endpoint of the public space", () => {
    show(undefined, false);
    expect(screen.getByRole("status")).toHaveTextContent(s.noEndpoint);
  });

  it("names its sources and has nothing axe finds", async () => {
    const { container } = show();
    await waitFor(() => expect(names()).toContain("Žilina"));
    expect(screen.getByText(s.attribution)).toBeInTheDocument();
    const found = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(found.violations.map((v) => v.id)).toEqual([]);
  });
});
