/**
 * The city map over what the public endpoint of `banskabystrica-verejne` answers (T-2782).
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
const { answer } = await import("./fixtures/verejne");
const { LOCALES } = await import("./locales");
const s = LOCALES.sk;

const SLUG = "kz3c7bq2mxa6wdr4tnyh5pje7f";
const TODAY = "2026-10-06";

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
    orgDomain: "banskabystrica.sk",
    space: withEndpoint ? "banskabystrica-verejne" : "elsewhere",
    transport: "origin",
    appName: "banskabystrica-mapa",
    language: "sk",
  });
  return render(
    <JcProvider client={client}>
      <App today={TODAY} />
    </JcProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const results = () => screen.getByRole("region", { name: /miest/ });
const names = () => within(results()).queryAllByRole("button").map((button) => button.querySelector(".name")?.textContent);

describe("the city map", () => {
  it("lists the upcoming events, the schools and the air station, and draws those with a position", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Radvanský jarmok"));
    expect(names()).toEqual([
      "Radvanský jarmok",
      "Výstava fotografií",
      "Banská Bystrica, Štefánikovo nábrežie",
      "Gymnázium Jozefa Gregora Tajovského",
      "Základná škola, Moyzesova 18",
    ]);
    // The past concert is not shown until the person asks for past events too.
    expect(names()).not.toContain("Koncert v parku");
    await userEvent.click(screen.getByRole("checkbox", { name: s.upcomingOnly }));
    expect(names()).toContain("Koncert v parku");
    // The exhibition has no position: listed and said so, not drawn.
    expect(within(results()).getByText(new RegExp(s.notOnMap))).toBeInTheDocument();
    await waitFor(() => {
      const data = setData.mock.calls.at(-1)?.[0] as { features: unknown[] } | undefined;
      expect(data?.features).toHaveLength(5);
    });
  });

  it("narrows by layer and by search, without diacritics", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Radvanský jarmok"));
    await userEvent.click(screen.getByRole("checkbox", { name: new RegExp(`^${s.kind.event}`) }));
    expect(names()).not.toContain("Radvanský jarmok");
    await userEvent.type(screen.getByRole("searchbox", { name: s.search }), "zakladna skola");
    expect(names()).toEqual(["Základná škola, Moyzesova 18"]);
    await userEvent.clear(screen.getByRole("searchbox", { name: s.search }));
    await userEvent.type(screen.getByRole("searchbox", { name: s.search }), "nic take");
    expect(within(results()).getByText(s.noResults)).toBeInTheDocument();
  });

  it("opens a place as a sheet that says what is missing, and Escape returns to the list", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Gymnázium Jozefa Gregora Tajovského"));
    const item = within(results()).getByRole("button", { name: /Gymnázium/ });
    await userEvent.click(item);
    const sheet = screen.getByRole("region", { name: s.detailOf("Gymnázium Jozefa Gregora Tajovského") });
    expect(within(sheet).getAllByText(s.noValue)).toHaveLength(2);
    expect(within(sheet).getByText("Tajovského 25, Banská Bystrica")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: /Detail:/ })).toBeNull();
    await waitFor(() => expect(item).toHaveFocus());
  });

  it("never links a script: an event whose url is javascript: gets no link", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Radvanský jarmok"));
    await userEvent.click(screen.getByRole("checkbox", { name: s.upcomingOnly }));
    await userEvent.click(within(results()).getByRole("button", { name: /Koncert/ }));
    const sheet = screen.getByRole("region", { name: s.detailOf("Koncert v parku") });
    expect(within(sheet).queryByRole("link")).toBeNull();
    await userEvent.click(within(sheet).getByRole("button", { name: s.close }));
    await userEvent.click(within(results()).getByRole("button", { name: /Radvanský/ }));
    expect(screen.getByRole("link", { name: s.website })).toHaveAttribute("href", "https://www.banskabystrica.sk/podujatia/radvansky-jarmok");
  });

  it("says why a kind the endpoint refuses is missing and keeps the others", async () => {
    show("School");
    expect(await screen.findByRole("alert")).toHaveTextContent(s.refused(s.kind.school, "the policy does not grant this type"));
    await waitFor(() => expect(names()).toContain("Radvanský jarmok"));
    expect(names()).not.toContain("Základná škola, Moyzesova 18");
  });

  it("says it has nothing to read when the app has no endpoint of the public space", () => {
    show(undefined, false);
    expect(screen.getByRole("status")).toHaveTextContent(s.noEndpoint);
  });

  it("names its sources and has nothing axe finds", async () => {
    const { container } = show();
    await waitFor(() => expect(names()).toContain("Radvanský jarmok"));
    expect(screen.getByText(s.attribution)).toBeInTheDocument();
    const found = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(found.violations.map((v) => v.id)).toEqual([]);
  });
});
