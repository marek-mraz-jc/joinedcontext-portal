import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App, { chooseLanguage } from "./App";
import { STATIONS } from "./fixtures/stations";

/** What MapLibre would call on a click of a drawn station, kept by the double below. */
const map = vi.hoisted(() => ({ click: null as ((event: { features?: Array<{ properties?: Record<string, unknown> }> }) => void) | null }));

vi.mock("maplibre-gl", () => ({
  Map: class {
    on = (event: string, layerOrHandler: unknown, handler?: (event: { features?: Array<{ properties?: Record<string, unknown> }> }) => void) => {
      if (event === "load" && typeof layerOrHandler === "function") (layerOrHandler as () => void)();
      if (event === "click" && handler) map.click = handler;
    };
    addSource = vi.fn();
    addLayer = vi.fn();
    getSource = () => ({ setData: vi.fn() });
    fitBounds = vi.fn();
    remove = vi.fn();
  },
  LngLatBounds: class {
    extend = vi.fn();
  },
  Popup: class {
    setLngLat = () => this;
    setHTML = () => this;
    setDOMContent = () => this;
    addTo = () => this;
    remove = vi.fn();
  },
  setWorkerUrl: vi.fn(),
}));
vi.mock("echarts/core", () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), on: vi.fn() })) }));

const READ = {
  permissions: [{ resource: { type: "BikeHireDockingStation" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" as const }],
  prohibitions: [],
};

/** The App as a signed-in operator of the project sees it: reading only (README). */
function show(language = "en") {
  const client = stubClient(
    { entities: STATIONS, access: READ },
    { appName: "bike-rebalancing", language, user: { id: "u-1", name: "Operaattori" }, portal: "https://portal.hel.fi/projects/helsinki" },
  );
  render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
  return client;
}

const WORDS = {
  en: { route: "Route", close: "Close", portal: "Open in the Portal", edit: "Edit", reset: "Reset choices", start: "Start at", van: "Van capacity (bikes)" },
  fi: { route: "Reitti", close: "Sulje", portal: "Avaa portaalissa", edit: "Muokkaa", reset: "Palauta valinnat", start: "Lähtöpaikka", van: "Auton kapasiteetti (pyörää)" },
} as const;

beforeEach(() => window.history.replaceState(null, "", "/"));
afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("the App in the SDK's shell", () => {
  it("opens a stop of the route in the entity panel, linked to the Portal, with no Edit for a reader", async () => {
    const client = show();
    const route = await screen.findByRole("list", { name: "Route" });
    const name = within(route).getAllByRole("button").find((button) => button.classList.contains("app-open"))!;
    fireEvent.click(name);
    const panel = await screen.findByRole("dialog", { name: name.textContent! });
    expect(await within(panel).findByText("BikeHireDockingStation")).toBeInTheDocument();
    const link = within(panel).getByRole("link", { name: "Open in the Portal" });
    expect(link.getAttribute("href")).toContain("https://portal.hel.fi/projects/helsinki/explore?");
    expect(within(panel).queryByRole("button", { name: "Edit" })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(client.transport.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("takes a station clicked on the map into or out of the route, and opens it", async () => {
    show();
    await screen.findByRole("list", { name: "Route" });
    await waitFor(() => expect(map.click).not.toBeNull());
    map.click!({ features: [{ properties: { id: STATIONS[6].id } }] });
    expect(await screen.findByRole("dialog", { name: "Designmuseo" })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("add")).toBe(STATIONS[6].id);
  });

  it("switches the language through the address and reloads, and ignores a language it does not speak", () => {
    const reload = vi.fn();
    chooseLanguage("en", "en", reload);
    chooseLanguage("sv", "fi", reload);
    expect(reload).not.toHaveBeenCalled();
    chooseLanguage("en", "fi", reload);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(window.location.search).get("lang")).toBe("en");
  });

  // Every control of the page is one an operator uses, in both languages: each station's name opens
  // it, each choice takes it in or out, the van, the start and the reset change the plan.
  it.each(["en", "fi"] as const)("in %s, every control of the page does its part", async (language) => {
    const words = WORDS[language];
    show(language);
    await screen.findByRole("list", { name: words.route });
    await waitFor(() => expect(screen.getAllByRole("button").filter((one) => one.classList.contains("app-open")).length).toBeGreaterThan(5));
    const names = () => screen.getAllByRole("button").filter((one) => one.classList.contains("app-open"));
    for (let at = 0; at < names().length; at += 1) {
      const name = names()[at];
      fireEvent.click(name);
      const panel = await screen.findByRole("dialog");
      const link = within(panel).getByRole("link", { name: words.portal });
      link.addEventListener("click", (event) => event.preventDefault());
      fireEvent.click(link);
      fireEvent.click(within(panel).getByRole("button", { name: words.close }));
    }
    // Each choice button twice: in or out, and back, so the plan ends as it began.
    const choices = () => screen.getAllByRole("button").filter((one) => /: /.test(one.getAttribute("aria-label") ?? ""));
    // A station in the route and in the table carries the same choice twice: one click is the
    // choice, and the station's other choice takes it back. A choice can move other stations in or
    // out of the van's reach, which shows their other choices: those are made while it stands.
    const made = new Set<string>();
    const label = (one: HTMLElement) => one.getAttribute("aria-label") ?? "";
    // The choices in the address, as sets: going back may write the same stations in another order.
    const state = () => {
      const params = new URLSearchParams(window.location.search);
      return ["add", "skip"].map((name) => (params.get(name) ?? "").split(",").filter(Boolean).sort().join(",")).join("|");
    };
    const choose = async (choice: string, depth: number): Promise<void> => {
      made.add(choice);
      const station = choice.slice(choice.indexOf(": ") + 2);
      const before = state();
      fireEvent.click(screen.getAllByRole("button", { name: choice })[0]);
      await waitFor(() => expect(state()).not.toBe(before));
      if (depth > 0) {
        for (const next of [...new Set(choices().map(label))].filter((one) => !made.has(one) && !one.endsWith(`: ${station}`))) {
          if (screen.queryAllByRole("button", { name: next }).length > 0) await choose(next, depth - 1);
        }
      }
      const back = choices().find((one) => label(one).endsWith(`: ${station}`))!;
      made.add(label(back));
      fireEvent.click(back);
      await waitFor(() => expect(state()).toBe(before));
    };
    const walk = async () => {
      for (const choice of [...new Set(choices().map(label))]) {
        if (!made.has(choice)) await choose(choice, 10);
      }
    };
    await walk();
    // A smaller van reaches fewer stations: any choice that offers then is made too.
    fireEvent.change(screen.getByRole("spinbutton", { name: words.van }), { target: { value: "5" } });
    expect(new URLSearchParams(window.location.search).get("van")).toBe("5");

    await walk();
    fireEvent.change(screen.getByRole("combobox", { name: words.start }), { target: { value: STATIONS[0].id } });
    expect(new URLSearchParams(window.location.search).get("start")).toBe(STATIONS[0].id);
    fireEvent.click(screen.getByRole("button", { name: words.reset }));

    expect(window.location.search).toBe("");
    // The language switch reloads the page; jsdom cannot, so its location is stood in for.
    const other = language === "en" ? "fi" : "en";
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, search: "", hash: "", pathname: "/", reload } });
    try {
      fireEvent.change(screen.getByRole("combobox", { name: language === "en" ? "Language" : "Kieli" }), { target: { value: other } });
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  }, 30_000);
});
