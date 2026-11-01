/**
 * T-6303: the grid's one toolbar, shared by the space's data tab and an Endpoint's Data section.
 * The row draws what the host holds and reports each change; both pages import this one component.
 */
import { readFileSync } from "node:fs";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilterColumn } from "@joinedcontext/sdk";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { DataToolbar } from "../src/components/entities/DataToolbar";
import type { DataToolbarProps } from "../src/components/entities/DataToolbar";
import { expectNoAxeViolations, renderPart } from "./page_contract";

const COLUMNS: FilterColumn[] = [{ key: "startDate", attr: "startDate", kind: "date" }];

function props(own: Partial<DataToolbarProps> = {}): DataToolbarProps {
  return {
    filterColumns: COLUMNS,
    filterTitle: (column) => (column.attr === "startDate" ? "Start" : column.key),
    filters: { join: "and", conditions: [{ key: "startDate", filter: { op: "gte", value: "2026-11-01" } }] },
    onFilters: vi.fn(),
    attributes: ["name", "startDate"],
    enums: {},
    extras: { hidden: ["startDate"] },
    onExtras: vi.fn(),
    fields: [
      { value: "name", label: "Name" },
      { value: "startDate", label: "Start" },
    ],
    sortKeys: [],
    onSortKeys: vi.fn(),
    groupBy: [],
    onGroupBy: vi.fn(),
    rowSize: "small",
    onRowSize: vi.fn(),
    searchText: "",
    onSearchText: vi.fn(),
    showQuery: false,
    onShowQuery: vi.fn(),
    ...own,
  };
}

describe("the grid's one toolbar (T-6303)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("draws the space's tools, each with the count it holds", () => {
    renderPart(<DataToolbar {...props()} />);
    const t = en.spaces.toolbar;
    for (const label of [t.filter, t.hide, t.sort, t.group, t.colour, t.rowSize]) {
      expect(screen.getByText(label, { selector: "summary" })).toBeInTheDocument();
    }
    expect(screen.getByText(t.filter, { selector: "summary" })).toHaveTextContent(`${t.filter}1`);
    expect(screen.getByText(t.hide, { selector: "summary" })).toHaveTextContent(`${t.hide}1`);
    expect(screen.getByRole("searchbox", { name: t.search })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.query })).toHaveAttribute("aria-pressed", "false");
  });

  it("names each field as its column does and reports a field shown again", async () => {
    const user = userEvent.setup();
    const onExtras = vi.fn();
    renderPart(<DataToolbar {...props({ onExtras })} />);
    await user.click(screen.getByText(en.spaces.toolbar.hide, { selector: "summary" }));
    const start = screen.getByRole("checkbox", { name: "Start" });
    expect(start).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Name" })).toBeChecked();
    await user.click(start);
    expect(onExtras).toHaveBeenLastCalledWith({ hidden: [] });
  });

  it("reports the search and the query switch", async () => {
    const user = userEvent.setup();
    const onSearchText = vi.fn();
    const onShowQuery = vi.fn();
    renderPart(<DataToolbar {...props({ onSearchText, onShowQuery })} />);
    await user.type(screen.getByRole("searchbox", { name: en.spaces.toolbar.search }), "k");
    expect(onSearchText).toHaveBeenLastCalledWith("k");
    await user.click(screen.getByRole("button", { name: en.spaces.toolbar.query }));
    expect(onShowQuery).toHaveBeenLastCalledWith(true);
  });

  it("shows the filter's condition in the panel, its field titled", async () => {
    const user = userEvent.setup();
    renderPart(<DataToolbar {...props()} />);
    await user.click(screen.getByText(en.spaces.toolbar.filter, { selector: "summary" }));
    const field = screen.getByRole("combobox", { name: en.spaces.toolbar.field });
    expect(field).toHaveValue("startDate");
    expect(within(field).getByRole("option", { name: "Start" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: en.spaces.toolbar.operator })).toHaveValue("gte");
  });

  it("has no axe violation", async () => {
    const { container } = renderPart(<DataToolbar {...props()} />);
    await expectNoAxeViolations(container);
  });

  it("is the one toolbar both pages import", () => {
    for (const file of ["src/pages/spaces/SpaceInside.tsx", "src/components/entities/EndpointDataView.tsx"]) {
      const code = readFileSync(file, "utf8");
      expect(code).toMatch(/import \{ DataToolbar \} from "[./]+\/(components\/entities\/)?DataToolbar";/);
      expect(code).not.toMatch(/<FilterPanel\b|<SortPanel\b|<GroupPanel\b/);
    }
  });
});
