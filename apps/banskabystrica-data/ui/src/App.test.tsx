/** The city's datasets as grids over what the public endpoint answers (T-2782). */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { answer } from "./fixtures/verejne";
import { LOCALES } from "./locales";

const s = LOCALES.sk;
const SLUG = "fq4xw2ztnbe7rcav3ms6kd5ypu";
let asked: URL[];

function show(withEndpoint = true) {
  asked = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      const url = new URL(path, "http://portal.test");
      asked.push(url);
      const rows = answer(url.searchParams.get("type"));
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "content-type": "application/json", "NGSILD-Results-Count": String(rows.length) },
      });
    }),
  );
  const client = stubClient(undefined, {
    slug: withEndpoint ? SLUG : "",
    orgDomain: "banskabystrica.sk",
    space: withEndpoint ? "banskabystrica-verejne" : "elsewhere",
    transport: "origin",
    appName: "banskabystrica-data",
    language: "sk",
  });
  return render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("the city's datasets", () => {
  it("opens on the events, read from the endpoint by type, with the city's column labels", async () => {
    show();
    expect(screen.getByRole("tab", { name: s.dataset.events })).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel", { name: s.dataset.events });
    await waitFor(() => expect(within(panel).getByText("Radvanský jarmok")).toBeInTheDocument());
    expect(within(panel).getByRole("columnheader", { name: new RegExp(s.column.eventCategory) })).toBeInTheDocument();
    expect(asked.some((url) => url.pathname.includes(`/api/endpoint/${SLUG}/`) && url.searchParams.get("type") === "Event")).toBe(true);
  });

  it("moves between datasets with the arrow keys and shows each one's grid and downloads", async () => {
    show();
    screen.getByRole("tab", { name: s.dataset.events }).focus();
    await userEvent.keyboard("{ArrowRight}");
    const schools = screen.getByRole("tab", { name: s.dataset.schools });
    expect(schools).toHaveFocus();
    expect(schools).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel", { name: s.dataset.schools });
    await waitFor(() => expect(within(panel).getByText("Základná škola, Moyzesova 18")).toBeInTheDocument());
    expect(within(panel).getByRole("link", { name: `${s.csv} ${s.dataset.schools}` })).toHaveAttribute(
      "href",
      `/api/endpoint/${SLUG}/file.csv?type=School&humanHeaders=true`,
    );
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: s.dataset.air })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: s.dataset.events })).toHaveFocus();
  });

  it("says it has nothing to read when the app has no endpoint of the public space", () => {
    show(false);
    expect(screen.getByRole("status")).toHaveTextContent(s.noEndpoint);
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("names its sources and has nothing axe finds", async () => {
    const { container } = show();
    await waitFor(() => expect(screen.getByText("Radvanský jarmok")).toBeInTheDocument());
    expect(screen.getByText(s.source)).toBeInTheDocument();
    const found = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(found.violations.map((v) => v.id)).toEqual([]);
  });
});
