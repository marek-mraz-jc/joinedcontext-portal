/**
 * The Baserow-shaped grid (T-4883): the row number column with its checkbox and expand button,
 * shift-click ranges, no filter row for a host with its own panel, the footer and the row size.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { EntityGrid } from "../src/grid/EntityGrid";
import { parseGridConfig } from "../src/grid/config";
import { fixtureSource } from "../src/grid/source";
import type { FilterColumn } from "../src/grid/filters";

const entities = ["Kamppi", "Kallio", "Töölö", "Pasila"].map((name, i) => ({
  id: `urn:ngsi-ld:Station:${i + 1}`,
  type: "Station",
  name: { type: "Property", value: name },
  bikes: { type: "Property", value: i * 2 },
}));
const config = parseGridConfig({
  source: { kind: "fixture", name: "t" },
  type: "Station",
  columns: [{ attr: "name", label: "Name", pinned: true }, { attr: "bikes", label: "Bikes" }],
  pageSize: 10,
}).config!;
const NUMBERS = { selectRow: "Select row", selectAll: "Select all rows" };

function Host({ onSelected }: { onSelected?: (ids: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <EntityGrid
      config={config}
      source={fixtureSource(entities)}
      rowNumbers={NUMBERS}
      selected={selected}
      onSelectedChange={(ids) => {
        setSelected(ids);
        onSelected?.(ids);
      }}
      filterRow={false}
      rowSize="small"
      footer={(column) => `foot ${column.label}`}
    />
  );
}

describe("EntityGrid rows (T-4883)", () => {
  it("numbers the rows, checks one, a shift-click range and all", async () => {
    const onSelected = vi.fn();
    const { container } = render(<Host onSelected={onSelected} />);
    await waitFor(() => expect(screen.getByText("Pasila")).toBeInTheDocument());
    expect([...container.querySelectorAll("tbody .jc-grid-rownum-n")].map((n) => n.textContent)).toEqual(["1", "2", "3", "4"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row: Kamppi" }));
    expect(onSelected).toHaveBeenLastCalledWith(["urn:ngsi-ld:Station:1"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row: Töölö" }), { shiftKey: true });
    expect(onSelected).toHaveBeenLastCalledWith(["urn:ngsi-ld:Station:1", "urn:ngsi-ld:Station:2", "urn:ngsi-ld:Station:3"]);
    expect(container.querySelectorAll('tr[aria-selected="true"]')).toHaveLength(3);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(onSelected).toHaveBeenLastCalledWith(entities.map((e) => e.id));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(onSelected).toHaveBeenLastCalledWith([]);
  });

  it("opens the row from its expand button, draws no filter row, a footer and the row size", async () => {
    const { container } = render(<Host />);
    await waitFor(() => expect(screen.getByText("Kallio")).toBeInTheDocument());
    expect(container.querySelector(".jc-grid-filter-row")).toBeNull();
    expect(container.querySelector(".jc-grid")?.getAttribute("data-row-size")).toBe("small");
    expect(screen.getByText("foot Bikes")).toBeInTheDocument();
    fireEvent.click(container.querySelectorAll<HTMLButtonElement>("tbody .jc-grid-expand")[1]);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  });

  it("hands its filterable columns to the host", async () => {
    const seen: FilterColumn[][] = [];
    render(<EntityGrid config={config} source={fixtureSource(entities)} onFilterColumns={(c) => seen.push(c)} />);
    await waitFor(() => expect(screen.getByText("Kamppi")).toBeInTheDocument());
    const last = seen.at(-1)!;
    expect(last.find((c) => c.attr === "bikes")?.kind).toBe("number");
    expect(last.find((c) => c.attr === "name")?.kind).toBe("text");
  });
});
