import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JcProvider, ProblemError } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { AnalyserContext } from "./analysis";
import { ALERTS } from "./fixtures/alerts";
import { inProcess } from "./test-analyser";

vi.mock("maplibre-gl", () => ({
  Map: class {
    on = vi.fn();
    remove = vi.fn();
  },
  Popup: class {},
  setWorkerUrl: vi.fn(),
}));
// jsdom has no canvas: the chart's option is tested on its own.
vi.mock("echarts", () => ({ init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), on: vi.fn() })) }));

const READ = {
  permissions: [{ resource: { type: "Alert" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" as const }],
  prohibitions: [],
};

function show(client = stubClient({ entities: ALERTS, access: READ }, { appName: "alerts-heatmap" })) {
  render(
    <JcProvider client={client}>
      <AnalyserContext.Provider value={inProcess}>
        <App />
      </AnalyserContext.Provider>
    </JcProvider>,
  );
  return client;
}

describe("alerts-heatmap", () => {
  beforeEach(() => window.history.replaceState(null, "", "/?lang=fi"));
  afterEach(() => window.history.replaceState(null, "", "/"));

  // AP-04: read through the app's own endpoint only, never written to; the first screen answers
  // where and when without a click.
  it("answers where and when on arrival, in Finnish, read only through the app's endpoint", async () => {
    const client = show();
    expect(screen.getByRole("heading", { level: 1, name: "Missä ja milloin häiriöitä on" })).toBeInTheDocument();
    expect(
      await screen.findByText(
        "8 tiedotetta 7.10.2030–21.10.2030. Eniten kuusikulmiossa: 4 tiedotetta. Vilkkain alkamistunti: maanantai klo 8–9.",
      ),
    ).toBeInTheDocument();
    const places = screen.getByRole("list", { name: "Toistuvat paikat" });
    expect(within(places).getByText("Mannerheimintie, Helsinki. Tietyö.")).toBeInTheDocument();
    expect(within(places).getByText(/^4 tiedotetta, \d+ m säteellä$/)).toBeInTheDocument();
    expect(screen.getByRole("application", { name: "Kartta: tiedotteet kuusikulmioittain" })).toBeInTheDocument();
    expect(client.transport.calls.every((call) => call.method === "GET" && call.path.includes("/api/endpoint/"))).toBe(true);
    expect(client.transport.calls[0].path).toContain("attrs=name%2CsubCategory%2Caddress%2CdateIssued%2CvalidFrom%2Clocation");
  });

  it("filters by kind over the whole set, and the address carries the choice", async () => {
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Liikennetiedote (3)" }));
    expect(await screen.findByText(/^3 tiedotetta /)).toBeInTheDocument();
    expect(window.location.search).toContain("kind=TRAFFIC_ANNOUNCEMENT");
    // The other kind stays offered, with its count.
    expect(screen.getByRole("checkbox", { name: "Tietyö (5)" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Tyhjennä valinnat" }));
    expect(await screen.findByText(/^8 tiedotetta /)).toBeInTheDocument();
    expect(window.location.search).toBe("?lang=fi");
  });

  it("opens on the view its address names", async () => {
    window.history.replaceState(null, "", "/?lang=en&kind=ROAD_WORK&day=0&hour=8");
    show();
    expect(await screen.findByText(/^4 alerts from 7 Oct 2030 to 21 Oct 2030\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show every hour, not only Monday 08:00–09:00" })).toBeInTheDocument();
  });

  it("switches to English and keeps the language in the address", async () => {
    show();
    await screen.findByText(/^8 tiedotetta/);
    await userEvent.setup().click(screen.getByRole("button", { name: "In English" }));
    expect(screen.getByRole("heading", { level: 1, name: "Where and when alerts happen" })).toBeInTheDocument();
    expect(await screen.findByText(/^8 alerts from 7 Oct 2030 to 21 Oct 2030\./)).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
    expect(new URLSearchParams(window.location.search).get("lang")).toBe("en");
  });

  it("says when there are no alerts at all", async () => {
    show(stubClient({ entities: [], access: READ }, { appName: "alerts-heatmap" }));
    expect(await screen.findByText("Ei tiedotteita.")).toBeInTheDocument();
  });

  it("says the endpoint failed, with its status, and reads again on Retry", async () => {
    const client = stubClient({ entities: ALERTS, access: READ }, { appName: "alerts-heatmap" });
    const all = client.entities.all.bind(client.entities);
    let failing = true;
    client.entities.all = (async (type: string, query?: Parameters<typeof all>[1]) => {
      if (failing) throw new ProblemError(503, { title: "Service Unavailable", status: 503 });
      return all(type, query);
    }) as typeof client.entities.all;
    show(client);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Tiedotteita ei voitu lukea (HTTP 503). Yritä myöhemmin uudelleen.");
    failing = false;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Yritä uudelleen" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await screen.findByText(/^8 tiedotetta /)).toBeInTheDocument();
  });
});
