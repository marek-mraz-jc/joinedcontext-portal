import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JcProvider, ProblemError } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { AnalyserContext } from "./analysis";
import { NETWORK_ROWS } from "./fixtures/network";
import { HISTORY } from "./fixtures/vehicles";
import { inProcess } from "./test-analyser";

vi.mock("maplibre-gl", () => ({
  Map: class {
    on = vi.fn();
    remove = vi.fn();
  },
  Popup: class {},
  setWorkerUrl: vi.fn(),
}));

const READ = { permissions: [{ resource: { type: "Vehicle" }, actions: ["retrieveTemporal"], attributes: "*" as const }], prohibitions: [] };

function client(temporal: unknown[] = HISTORY, entities: NonNullable<Parameters<typeof stubClient>[0]>["entities"] = []) {
  return stubClient({ entities, temporal: temporal as { id: string; type: string }[], access: READ }, { appName: "transit-reach" });
}

function show(c = client()) {
  render(
    <JcProvider client={c}>
      <AnalyserContext.Provider value={inProcess}>
        <App />
      </AnalyserContext.Provider>
    </JcProvider>,
  );
  return c;
}

const FI_SUMMARY = /^Saavutettava alue tästä pisteestä: 10 min \d+,\d km², 20 min \d+,\d km², 30 min \d+,\d km²\. Pysäkkejä 30 minuutissa: 4\/4\.$/;

describe("transit-reach", () => {
  beforeEach(() => window.history.replaceState(null, "", "/?lang=fi"));
  afterEach(() => window.history.replaceState(null, "", "/"));

  // AP-04: read through the app's own endpoint only, never written to; the first screen answers
  // how far one gets from Rautatientori without a click.
  it("answers how far one gets from Rautatientori on arrival, in Finnish, read only through the app's endpoint", async () => {
    const c = show();
    expect(screen.getByRole("heading", { level: 1, name: "Kuinka pitkälle pääsen joukkoliikenteellä" })).toBeInTheDocument();
    expect(await screen.findByText(FI_SUMMARY)).toBeInTheDocument();
    expect(screen.getByText(/^Pysäkit on päätelty paikoista, joissa 5 ajoneuvoa seisoi 7\.10\.2030 klo 09\.00–7\.10\.2030 klo 09\.\d\d\./)).toBeInTheDocument();
    const reached = screen.getByRole("list", { name: "Pysäkit 30 minuutissa" });
    expect(within(reached).getAllByRole("listitem").map((li) => li.querySelector("span")?.textContent)).toEqual([
      "0,0 min lähtöpisteestä",
      "9,0 min lähtöpisteestä",
      "13,0 min lähtöpisteestä",
      "22,0 min lähtöpisteestä",
    ]);
    expect(screen.getByRole("application", { name: /^Kartta: saavutettava alue\./ })).toBeInTheDocument();
    expect(c.transport.calls.every((call) => call.method === "GET" && call.path.includes("/api/endpoint/"))).toBe(true);
    // HSL's stops and lines are read first; this space has none, so the vehicles' history follows.
    expect(c.transport.calls.filter((call) => /type=(GtfsStop|TransitRoute)/.test(call.path))).toHaveLength(2);
    const temporal = c.transport.calls.find((call) => call.path.includes("/temporal/entities"));
    expect(temporal?.path).toContain("attrs=location%2Cspeed%2Croute");
  });

  it("starts from a stop picked in the list or from the reached stops, and the address carries the point", async () => {
    show();
    await screen.findByText(FI_SUMMARY);
    const user = userEvent.setup();
    const select = screen.getByRole("combobox", { name: "Lähde pysäkiltä" });
    const options = within(select).getAllByRole("option");
    const north = options.find((o) => o.textContent?.includes("4570") && !o.textContent.includes("550"));
    await user.selectOptions(select, north!);
    expect(window.location.search).toMatch(/at=25\.01\d+%2C60\.19\d+/);
    expect(await screen.findByText(/Pysäkkejä 30 minuutissa: 1\/4\.$/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Takaisin Rautatientorille" }));
    expect(await screen.findByText(FI_SUMMARY)).toBeInTheDocument();
    expect(window.location.search).toBe("?lang=fi");
    await user.click(screen.getAllByRole("button", { name: /: lähde tästä$/ })[1]);
    expect(window.location.search).toContain("at=");
  });

  it("reads the history window the address names and asks again for another", async () => {
    window.history.replaceState(null, "", "/?lang=en&hours=6");
    const c = show();
    await screen.findByText(/^Reachable from this point: /);
    expect(screen.getByRole("combobox", { name: "Vehicle history" })).toHaveValue("6");
    await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "Vehicle history" }), "1");
    expect(window.location.search).toContain("hours=1");
    expect(c.transport.calls.filter((call) => call.path.includes("/temporal/entities"))).toHaveLength(2);
  });

  it("answers with walking alone, and says why, when the history is refused", async () => {
    const c = client();
    c.temporal.list = async () => {
      throw new ProblemError(403, { title: "Forbidden", status: 403 });
    };
    show(c);
    expect(await screen.findByRole("alert")).toHaveTextContent("Ajoneuvojen historiaa ei voitu lukea (HTTP 403)");
    expect(await screen.findByText(/Pysäkkejä 30 minuutissa: 0\/0\.$/)).toBeInTheDocument();
    expect(screen.getByText("Ajoneuvoista ei ole historiaa: alue on pelkkä kävelymatka.")).toBeInTheDocument();
    expect(screen.getByText("Ei pysäkkejä 30 minuutin sisällä.")).toBeInTheDocument();
  });

  it("switches to English and keeps the language in the address", async () => {
    show();
    await screen.findByText(FI_SUMMARY);
    await userEvent.setup().click(screen.getByRole("button", { name: "In English" }));
    expect(screen.getByRole("heading", { level: 1, name: "How far can I get by transit" })).toBeInTheDocument();
    expect(await screen.findByText(/^Reachable from this point: 10 min \d+\.\d km², /)).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
  });

  // T-3356: with HSL's stops and lines in the space, the answer rides the whole network and names
  // the stops; the vehicles' history is not read at all.
  it("rides HSL's network when the space holds it, names the stops, and reads no vehicle history", async () => {
    const c = show(client(HISTORY, NETWORK_ROWS));
    expect(await screen.findByText(/^Pysäkit ja linjat HSL:n rekistereistä \(4 pysäkkiä, 2 linjaversiota\)\./)).toBeInTheDocument();
    const reached = screen.getByRole("list", { name: "Pysäkit 30 minuutissa" });
    expect(within(reached).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Rautatientori (H0019): linjat M1",
      "Kaisaniemi (H0012): linjat 550, M1",
      "Hakaniemi (H0026): linjat M1",
      "Kaisaniemenranta: linjat 550",
    ]);
    expect(screen.queryByRole("combobox", { name: "Ajoneuvojen historia" })).toBeNull();
    expect(c.transport.calls.some((call) => call.path.includes("/temporal/entities"))).toBe(false);
  });

  it("says HSL's stops could not be read, and answers from the vehicles instead", async () => {
    const c = client(HISTORY, NETWORK_ROWS);
    const list = c.entities.list.bind(c.entities);
    c.entities.list = (async (type: string, query?: Parameters<typeof list>[1]) => {
      if (type === "GtfsStop") throw new ProblemError(502, { title: "Bad Gateway", status: 502 });
      return list(type, query);
    }) as typeof c.entities.list;
    show(c);
    expect(await screen.findByText(/HSL:n pysäkkejä ja linjoja ei voitu lukea \(HTTP 502\)/)).toBeInTheDocument();
    expect(await screen.findByText(FI_SUMMARY)).toBeInTheDocument();
  });
});
