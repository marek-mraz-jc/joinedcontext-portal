/**
 * The region map over what the public endpoint of `bbsk-registre` answers (T-2784).
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
const { answer } = await import("./fixtures/registre");
const { LOCALES } = await import("./locales");
const s = LOCALES.sk;

const SLUG = "rv5cn2kxq7bmt3wza6hjd4ype2";

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
    orgDomain: "bbsk.sk",
    space: withEndpoint ? "bbsk-registre" : "elsewhere",
    transport: "origin",
    appName: "bbsk-mapa",
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

describe("the region map", () => {
  it("lists the hospitals, social services and organizations, and draws those with a position", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Nemocnica Zvolen"));
    expect(names()).toEqual([
      "Domov sociálnych služieb Tisovec",
      "Fakultná nemocnica s poliklinikou F. D. Roosevelta",
      "Nemocnica Zvolen",
      "Spojená škola Detva",
      "Stredoslovenské múzeum",
      "Terénna opatrovateľská služba",
    ]);
    // Social services publish no position: listed and said so, not drawn.
    expect(within(results()).getAllByText(new RegExp(s.notOnMap)).length).toBe(3);
    await waitFor(() => {
      const data = setData.mock.calls.at(-1)?.[0] as { features: unknown[] } | undefined;
      expect(data?.features).toHaveLength(3);
    });
  });

  it("narrows by layer and by search, without diacritics", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Nemocnica Zvolen"));
    await userEvent.click(screen.getByRole("checkbox", { name: new RegExp(`^${s.kind.hospital}`) }));
    expect(names()).not.toContain("Nemocnica Zvolen");
    await userEvent.type(screen.getByRole("searchbox", { name: s.search }), "rimavska");
    expect(names()).toEqual(["Domov sociálnych služieb Tisovec"]);
    await userEvent.clear(screen.getByRole("searchbox", { name: s.search }));
    await userEvent.type(screen.getByRole("searchbox", { name: s.search }), "nic take");
    expect(within(results()).getByText(s.noResults)).toBeInTheDocument();
  });

  it("opens a social service as a sheet with its form, capacity and provider in words, and Escape returns", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Domov sociálnych služieb Tisovec"));
    const item = within(results()).getByRole("button", { name: /Tisovec/ });
    await userEvent.click(item);
    const sheet = screen.getByRole("region", { name: s.detailOf("Domov sociálnych služieb Tisovec") });
    expect(within(sheet).getByText(s.values.residentialYearRound)).toBeInTheDocument();
    expect(within(sheet).getByText("48")).toBeInTheDocument();
    expect(within(sheet).getByText(s.values.regionFounded)).toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: s.website })).toHaveAttribute("href", "https://www.dsstisovec.sk/");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: /Detail:/ })).toBeNull();
    await waitFor(() => expect(item).toHaveFocus());
  });

  it("never links a script, and says what a service does not publish", async () => {
    show();
    await waitFor(() => expect(names()).toContain("Terénna opatrovateľská služba"));
    await userEvent.click(within(results()).getByRole("button", { name: /Terénna/ }));
    const sheet = screen.getByRole("region", { name: s.detailOf("Terénna opatrovateľská služba") });
    expect(within(sheet).queryByRole("link")).toBeNull();
    expect(within(sheet).getAllByText(s.noValue).length).toBeGreaterThanOrEqual(4);
  });

  it("says why a kind the endpoint refuses is missing and keeps the others", async () => {
    show("Hospital");
    expect(await screen.findByRole("alert")).toHaveTextContent(s.refused(s.kind.hospital, "the policy does not grant this type"));
    await waitFor(() => expect(names()).toContain("Stredoslovenské múzeum"));
    expect(names()).not.toContain("Nemocnica Zvolen");
  });

  it("says it has nothing to read when the app has no endpoint of the register space", () => {
    show(undefined, false);
    expect(screen.getByRole("status")).toHaveTextContent(s.noEndpoint);
  });

  it("names its source and has nothing axe finds", async () => {
    const { container } = show();
    await waitFor(() => expect(names()).toContain("Nemocnica Zvolen"));
    expect(screen.getByText(s.attribution)).toBeInTheDocument();
    const found = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(found.violations.map((v) => v.id)).toEqual([]);
  });
});
