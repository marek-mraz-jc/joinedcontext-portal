import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JcProvider } from "@joinedcontext/sdk";
import type { Row } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "../App";
import { ROWS } from "../fixtures";

vi.mock("maplibre-gl", () => ({ Map: class {}, setWorkerUrl: vi.fn() }));

function app(entities: Row[] = ROWS) {
  const client = stubClient({ entities }, { appName: "alerts-desk", orgDomain: "example.org", space: "demo" });
  render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
  return client;
}

/** The table, once the page has read its rows: the loading state comes first (T-3016). */
async function table() {
  return screen.findByRole("table", { name: "Traffic alerts" });
}

const names = (grid: HTMLElement) => within(grid).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent);

describe("alerts-desk", () => {
  it("lists every alert, the latest end first, under one heading", async () => {
    app();
    const grid = await table();
    expect(screen.getByRole("heading", { level: 1, name: "Alerts desk" })).toBeInTheDocument();
    expect(names(grid)).toEqual(["Ring I lane closure", "Marathon closes the centre", "Mannerheimintie resurfacing", "Bridge weight limit"]);
  });

  it("sorts by any column, both ways", async () => {
    app();
    const grid = await table();
    fireEvent.click(within(grid).getByRole("button", { name: "Alert" }));
    expect(names(grid)[0]).toBe("Bridge weight limit");
    fireEvent.click(within(grid).getByRole("button", { name: /^Alert/ }));
    expect(names(grid)[0]).toBe("Ring I lane closure");
  });

  it("narrows by category and by search, and says when nothing matches", async () => {
    app();
    const grid = await table();
    fireEvent.change(screen.getByRole("combobox", { name: "Category" }), { target: { value: "event" } });
    expect(names(await table())).toEqual(["Marathon closes the centre"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "no such alert" } });
    expect(await screen.findByText("No alert matches these filters.")).toBeInTheDocument();
    expect(grid).not.toBeInTheDocument();
  });

  it("opens the chosen alert's every attribute and writes nothing", async () => {
    const client = app();
    const grid = await table();
    fireEvent.click(within(grid).getByText("Mannerheimintie resurfacing"));
    expect(await screen.findByText("One lane closed northbound.")).toBeInTheDocument();
    const detail = screen.getByRole("heading", { level: 2, name: "Mannerheimintie resurfacing" }).closest("section") as HTMLElement;
    expect(within(detail).getAllByRole("term").map((term) => term.textContent)).toEqual([
      "Alert", "Category", "Subcategory", "Address", "Valid from", "Valid to", "Issued", "Description", "Published by",
    ]);
    expect(screen.queryByRole("button", { name: /edit|new|delete|save/i })).toBeNull();
    expect(client.transport.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("says so when the endpoint holds no alerts", async () => {
    app([]);
    expect(await screen.findByText("The endpoint holds no alerts right now.")).toBeInTheDocument();
  });
});
