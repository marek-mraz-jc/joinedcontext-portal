/** Prague's open data as grids over what the public endpoint answers (T-2786). */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { answer } from "./fixtures/praha";
import { LOCALES } from "./locales";

const s = LOCALES.cs;
const SLUG = "zd6qa2wmx7kc3nbr5tyhj4pve2";
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
    orgDomain: "praha.eu",
    space: withEndpoint ? "praha-mesto" : "elsewhere",
    transport: "origin",
    appName: "praha-data",
    language: "cs",
  });
  return render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("Prague's datasets", () => {
  it("opens on the places, read from the endpoint by type, with the city's column labels", async () => {
    show();
    expect(screen.getByRole("tab", { name: s.dataset.places })).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel", { name: s.dataset.places });
    await waitFor(() => expect(within(panel).getByText("Národní divadlo")).toBeInTheDocument());
    expect(within(panel).getByRole("columnheader", { name: new RegExp(s.column.serviceCategory) })).toBeInTheDocument();
    expect(asked.some((url) => url.pathname.includes(`/api/endpoint/${SLUG}/`) && url.searchParams.get("type") === "PointOfInterest")).toBe(true);
  });

  it("moves between datasets with the arrow keys, a nameless type opened by its code", async () => {
    show();
    screen.getByRole("tab", { name: s.dataset.places }).focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    const containers = screen.getByRole("tab", { name: s.dataset.containers });
    expect(containers).toHaveFocus();
    const panel = screen.getByRole("tabpanel", { name: s.dataset.containers });
    await waitFor(() => expect(within(panel).getByText("0001-001-PAP")).toBeInTheDocument());
    expect(within(panel).getByRole("link", { name: `${s.csv} ${s.dataset.containers}` })).toHaveAttribute(
      "href",
      `/api/endpoint/${SLUG}/file.csv?type=WasteContainer&humanHeaders=true`,
    );
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: s.dataset.budget })).toHaveFocus();
    await waitFor(() => expect(within(screen.getByRole("tabpanel", { name: s.dataset.budget })).getByText("Údržba komunikací")).toBeInTheDocument());
  });

  it("says it has nothing to read when the app has no endpoint of the city's space", () => {
    show(false);
    expect(screen.getByRole("status")).toHaveTextContent(s.noEndpoint);
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("names its sources and has nothing axe finds", async () => {
    const { container } = show();
    await waitFor(() => expect(screen.getByText("Národní divadlo")).toBeInTheDocument());
    expect(screen.getByText(s.source)).toBeInTheDocument();
    const found = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(found.violations.map((v) => v.id)).toEqual([]);
  });
});
