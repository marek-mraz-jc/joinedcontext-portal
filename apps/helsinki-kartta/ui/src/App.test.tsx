/**
 * The Helsinki service map over what the public endpoint of `helsinki` answers (T-2788).
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
const addSource = vi.fn();

vi.mock("maplibre-gl", () => {
  class Map {
    on(event: string, handler: () => void) {
      if (event === "load") handler();
    }
    addSource = addSource;
    addLayer = vi.fn();
    getSource = () => ({ setData });
    remove = vi.fn();
  }
  return { Map };
});
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));

const App = (await import("./App")).default;
const { answer } = await import("./fixtures/helsinki");
const { LOCALES } = await import("./locales");
const s = LOCALES.fi;

const SLUG = "hx5kv2nr7qcm3tbz6wjd4yae2p";

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
    orgDomain: "hel.fi",
    space: withEndpoint ? "helsinki" : "elsewhere",
    transport: "origin",
    appName: "helsinki-kartta",
    language: "fi",
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

const results = () => screen.getByRole("region", { name: /paikka/ });
const names = () => within(results()).queryAllByRole("button").map((button) => button.querySelector(".name")?.textContent);

describe("the Helsinki service map", () => {
  it("lists the services and the water sensors, and draws those with a position", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Keskustakirjasto Oodi"));
    expect(names()).toEqual([
      "Hietaniemen uimaranta",
      "Hietaniemi, vesi",
      "Irrallinen anturi",
      "Kallion ala-asteen koulu",
      "Kallion terveysasema",
      "Keskustakirjasto Oodi",
      "Yrjönkadun uimahalli",
    ]);
    // A service of a category the map does not show is not shown under a wrong one.
    expect(names()).not.toContain("Muu palvelu");
    await waitFor(() => {
      const data = setData.mock.calls.at(-1)?.[0] as { features: unknown[] } | undefined;
      expect(data?.features).toHaveLength(6);
    });
  });

  it("counts each layer and narrows by layer and by search, without diacritics", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Keskustakirjasto Oodi"));
    expect(screen.getByRole("checkbox", { name: `${s.kind.water} (2)` })).toBeChecked();
    await userEvent.click(screen.getByRole("checkbox", { name: `${s.kind.water} (2)` }));
    expect(names()).not.toContain("Hietaniemi, vesi");
    await userEvent.type(screen.getByRole("searchbox", { name: s.search }), "yrjonkadun");
    expect(names()).toEqual(["Yrjönkadun uimahalli"]);
    await userEvent.clear(screen.getByRole("searchbox", { name: s.search }));
    await userEvent.type(screen.getByRole("searchbox", { name: s.search }), "ei mitaan");
    expect(within(results()).getByText(s.noResults)).toBeInTheDocument();
  });

  it("opens a water sensor as a sheet with its temperature and the beach it stands at, and Escape returns", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Hietaniemi, vesi"));
    const item = within(results()).getByRole("button", { name: /Hietaniemi, vesi/ });
    await userEvent.click(item);
    const sheet = screen.getByRole("region", { name: s.detailOf("Hietaniemi, vesi") });
    expect(within(sheet).getByText(/16,4\s°C/)).toBeInTheDocument();
    expect(within(sheet).getByText("Hietaniemen uimaranta")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: /Tiedot:/ })).toBeNull();
    await waitFor(() => expect(item).toHaveFocus());
  });

  it("says what a sensor does not report, never links a script, and links a real site", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Irrallinen anturi"));
    await userEvent.click(within(results()).getByRole("button", { name: /Irrallinen anturi/ }));
    expect(within(screen.getByRole("region", { name: s.detailOf("Irrallinen anturi") })).getAllByText(s.noValue)).toHaveLength(3);
    await userEvent.click(within(results()).getByRole("button", { name: /Kallion ala-asteen koulu/ }));
    expect(within(screen.getByRole("region", { name: s.detailOf("Kallion ala-asteen koulu") })).queryByRole("link")).toBeNull();
    await userEvent.click(within(results()).getByRole("button", { name: /Keskustakirjasto Oodi/ }));
    expect(screen.getByRole("link", { name: s.website })).toHaveAttribute("href", "https://www.oodihelsinki.fi/");
  });

  it("says why a type the endpoint refuses is missing and keeps the other", async () => {
    show("WaterQualityObserved");
    expect(await screen.findByRole("alert")).toHaveTextContent(s.refused(s.type.WaterQualityObserved, "the policy does not grant this type"));
    await waitFor(() => expect(names()).toContain("Keskustakirjasto Oodi"));
  });

  it("says it has nothing to read when the app has no endpoint of the city's space", () => {
    show(undefined, false);
    expect(screen.getByRole("status")).toHaveTextContent(s.noEndpoint);
  });

  it("names its sources and has nothing axe finds", async () => {
    const { container } = show();
    await waitFor(() => expect(names()).toContain("Keskustakirjasto Oodi"));
    expect(screen.getByText(s.attribution)).toBeInTheDocument();
    const found = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(found.violations.map((v) => v.id)).toEqual([]);
  });
});
