import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { EntityGrid, moveTo } from "../src/grid/EntityGrid";
import { parseGridConfig } from "../src/grid/config";
import { fixtureSource } from "../src/grid/source";
import { readableName } from "../src/grid/useEntityGrid";
import type { ColumnLayout } from "../src/grid/useEntityGrid";

const entities = [
  { id: "urn:ngsi-ld:Stop:a", type: "Stop", name: { type: "Property", value: "Alpha" }, count: { type: "Property", value: 2 }, "ngsi-ld:status": { type: "Property", value: "open" } },
  { id: "urn:ngsi-ld:Stop:b", type: "Stop", name: { type: "Property", value: "Beta" }, count: { type: "Property", value: 9 }, "ngsi-ld:status": { type: "Property", value: "shut" } },
  { id: "urn:ngsi-ld:Stop:c", type: "Stop", name: { type: "Property", value: "Gamma" }, count: { type: "Property", value: 5 }, "ngsi-ld:status": { type: "Property", value: "open" } },
];
const config = parseGridConfig({
  source: { kind: "fixture", name: "t" },
  type: "Stop",
  columns: [{ attr: "name", label: "Name", pinned: true }, { attr: "count", label: "Count" }, { attr: "ngsi-ld:status" }],
}).config!;

const headers = () => screen.getAllByRole("columnheader").slice(0, 3).map((th) => within(th).getAllByRole("button")[0].textContent?.replace(/ [↑↓]$/, ""));
const names = () => screen.getAllByRole("button", { name: /^Open: / }).map((b) => b.textContent);
const openMenu = (label: string) => fireEvent.click(screen.getByRole("button", { name: `Column options: ${label}` }));

/** A host that keeps the layout, as the Portal keeps it in a saved view. */
function Kept({ initial, onLayout }: { initial?: ColumnLayout; onLayout?: (next: ColumnLayout) => void }) {
  const [layout, setLayout] = useState<ColumnLayout>(initial ?? {});
  return (
    <EntityGrid
      config={config}
      source={fixtureSource(entities)}
      layout={layout}
      onLayout={(next) => {
        setLayout(next);
        onLayout?.(next);
      }}
    />
  );
}

describe("the column header menu (T-4827)", () => {
  it("names a compact IRI by its local name and shows what each column holds", async () => {
    render(<EntityGrid config={config} source={fixtureSource(entities)} />);
    await screen.findByText("Alpha");
    expect(headers()).toEqual(["Name", "Count", "status"]);
    expect(readableName("https://smartdatamodels.org/dataModel.Transportation/vocab#routeColor")).toBe("routeColor");
    const count = screen.getAllByRole("columnheader")[1];
    expect(within(count).getByRole("img", { name: "Number" })).toBeInTheDocument();
  });

  it("sorts ascending and descending", async () => {
    render(<EntityGrid config={config} source={fixtureSource(entities)} />);
    await screen.findByText("Alpha");
    openMenu("Count");
    fireEvent.click(screen.getByRole("button", { name: "Sort descending" }));
    await waitFor(() => expect(names()).toEqual(["Beta", "Gamma", "Alpha"]));
    openMenu("Count");
    fireEvent.click(screen.getByRole("button", { name: "Sort ascending" }));
    await waitFor(() => expect(names()).toEqual(["Alpha", "Gamma", "Beta"]));
  });

  it("Filter puts the focus on the column's filter", async () => {
    render(<EntityGrid config={config} source={fixtureSource(entities)} />);
    await screen.findByText("Alpha");
    openMenu("Count");
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Filter: Count" }));
  });

  it("hides a field, by the host where it holds hidden, else by itself; the primary is never hidden", async () => {
    const onHide = vi.fn();
    const { unmount } = render(<EntityGrid config={config} source={fixtureSource(entities)} onHide={onHide} />);
    await screen.findByText("Alpha");
    openMenu("Count");
    fireEvent.click(screen.getByRole("button", { name: "Hide field" }));
    expect(onHide).toHaveBeenCalledWith("count");
    openMenu("Name");
    expect(screen.queryByRole("button", { name: "Hide field" })).toBeNull();
    unmount();
    render(<EntityGrid config={config} source={fixtureSource(entities)} />);
    await screen.findByText("Alpha");
    openMenu("Count");
    fireEvent.click(screen.getByRole("button", { name: "Hide field" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Column options: Count" })).toBeNull());
  });

  it("renames a column for this view and goes back to the model's label", async () => {
    const onLayout = vi.fn();
    render(<Kept onLayout={onLayout} />);
    await screen.findByText("Alpha");
    openMenu("status");
    const field = screen.getByLabelText("Label in this view");
    fireEvent.change(field, { target: { value: "State" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onLayout).toHaveBeenLastCalledWith({ labels: { "ngsi-ld:status": "State" } });
    await waitFor(() => expect(headers()[2]).toBe("State"));
    fireEvent.click(screen.getByRole("button", { name: "Use the model's label" }));
    await waitFor(() => expect(headers()[2]).toBe("status"));
  });

  it("widens and narrows a column within the store's bounds", async () => {
    const onLayout = vi.fn();
    render(<Kept onLayout={onLayout} initial={{ width: { count: 60 } }} />);
    await screen.findByText("Alpha");
    openMenu("Count");
    fireEvent.click(screen.getByRole("button", { name: "Wider" }));
    expect(onLayout).toHaveBeenLastCalledWith({ width: { count: 100 } });
    fireEvent.click(screen.getByRole("button", { name: "Narrower" }));
    fireEvent.click(screen.getByRole("button", { name: "Narrower" }));
    expect(onLayout).toHaveBeenLastCalledWith({ width: { count: 40 } });
    expect(screen.getAllByRole("columnheader")[1]).toHaveStyle({ width: "40px" });
  });

  it("moves a column by the menu and by dragging its header; nothing moves before the primary", async () => {
    const onLayout = vi.fn();
    render(<Kept onLayout={onLayout} />);
    await screen.findByText("Alpha");
    openMenu("Count");
    expect(screen.getByRole("button", { name: "Move left" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Move right" }));
    expect(onLayout).toHaveBeenLastCalledWith({ order: ["name", "ngsi-ld:status", "count"] });
    await waitFor(() => expect(headers()).toEqual(["Name", "status", "Count"]));
    const store = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => store.set(k, v), getData: (k: string) => store.get(k) ?? "", types: ["application/x-jc-grid-column"], effectAllowed: "" };
    const [, status, count] = screen.getAllByRole("columnheader");
    fireEvent.dragStart(count, { dataTransfer });
    fireEvent.dragOver(status, { dataTransfer });
    fireEvent.drop(status, { dataTransfer });
    await waitFor(() => expect(headers()).toEqual(["Name", "Count", "status"]));
    expect(moveTo(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
  });

  it("keeps the metadata under Details, and Escape closes the menu back to its button", async () => {
    render(<EntityGrid config={config} source={fixtureSource(entities)} />);
    await screen.findByText("Alpha");
    openMenu("Count");
    const menu = screen.getByRole("dialog", { name: "Column options: Count" });
    expect(within(menu).getByText("Details").tagName).toBe("SUMMARY");
    expect(within(menu).getByLabelText("Observed")).toBeInTheDocument();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Column options: Count" }));
    // A touch screen has no Escape: the menu's own Close does the same.
    openMenu("Count");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Column options: Count" }));
  });

  // The grid clips what overflows it: the menu is placed in the window, below its header cell
  // or above it when it does not fit below (T-4924).
  it("places the menu inside the window, above the header when the room below is too short", async () => {
    render(<EntityGrid config={config} source={fixtureSource(entities)} />);
    await screen.findByText("Alpha");
    const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(400);
    const rect = (top: number) => ({ top, bottom: top + 30, left: 0, right: 300, width: 300, height: 30, x: 0, y: top, toJSON: () => ({}) });
    const cell = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect(70) as DOMRect);
    try {
      openMenu("Count");
      const below = screen.getByRole("dialog", { name: "Column options: Count" });
      expect(below.style.top).toBe("100px");
      expect(below.style.maxHeight).toBe(`${window.innerHeight - 100}px`);
      fireEvent.keyDown(below, { key: "Escape" });

      cell.mockReturnValue(rect(window.innerHeight - 100) as DOMRect);
      openMenu("Count");
      const above = screen.getByRole("dialog", { name: "Column options: Count" });
      expect(above.style.top).toBe(`${window.innerHeight - 100 - 400}px`);
      expect(above.style.maxHeight).toBe(`${window.innerHeight - 100}px`);
    } finally {
      height.mockRestore();
      cell.mockRestore();
    }
  });

  it("a layout the host kept comes back applied after a remount", async () => {
    const { unmount } = render(<Kept initial={{ order: ["name", "ngsi-ld:status"], labels: { count: "Riders" }, width: { count: 120 } }} />);
    await screen.findByText("Alpha");
    expect(headers()).toEqual(["Name", "status", "Riders"]);
    unmount();
    render(<Kept initial={{ order: ["name", "ngsi-ld:status"], labels: { count: "Riders" }, width: { count: 120 } }} />);
    await screen.findByText("Alpha");
    expect(headers()).toEqual(["Name", "status", "Riders"]);
    expect(screen.getAllByRole("columnheader")[2]).toHaveStyle({ width: "120px" });
  });
});
