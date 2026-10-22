/**
 * The grid's toolbar (T-4883): the filter panel builds the condition tree whose `q` the endpoint
 * runs, a saved tree is checked before use, and each footer aggregation is the endpoint's own
 * count over the whole filtered set, read with the person's session.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { queryFromGroup, SourceError } from "@joinedcontext/sdk";
import type { EntitySource, FilterColumn, FilterGroup, GridQuery } from "@joinedcontext/sdk";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { conditionCount, EMPTY_GROUP, FilterPanel, readGroup } from "../src/components/entities/FilterPanel";
import { FooterAggregate, percent, ToolbarPopover } from "../src/components/entities/GridToolbar";
import { mayDelete } from "../src/components/entities/AccessPanel";
import type { Aggregation } from "../src/components/entities/GridToolbar";
import { viewerWriteFindings } from "./pageChecks";
import { BulkSetDialog, bulkValue, changedRows, rowSignatures } from "../src/pages/spaces/SpaceInside";
import { enumColours } from "../src/components/entities/ViewOptions";
import type { FilterSlot } from "../src/components/entities/filters";
import type { RichRow } from "@joinedcontext/sdk";

const L = en.spaces.toolbar;
const COLUMNS: FilterColumn[] = [
  { key: "id", attr: null, kind: "id" },
  { key: "name", attr: "name", kind: "text" },
  { key: "seats", attr: "seats", kind: "number" },
  { key: "category", attr: "category", kind: "enum", options: [{ value: "music", title: "Music" }, { value: "sport" }] },
];

function wrap(node: React.ReactNode) {
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>
    </I18nextProvider>,
  );
}

function Panel({ seen }: { seen: (next: FilterGroup) => void }) {
  const [value, setValue] = useState<FilterGroup>(EMPTY_GROUP);
  return (
    <FilterPanel
      columns={COLUMNS}
      titleOf={(column) => column.attr ?? column.key}
      value={value}
      onChange={(next) => {
        setValue(next);
        seen(next);
      }}
    />
  );
}

describe("FilterPanel", () => {
  it("builds conditions joined by AND or OR, and a group, into the endpoint's q", async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    wrap(<Panel seen={seen} />);
    expect(screen.getByText(L.noFilters)).toBeInTheDocument();
    // The id column is not offered: idPattern cannot take part in an OR.
    await user.click(screen.getByRole("button", { name: L.addCondition }));
    expect(screen.queryByRole("option", { name: "id" })).toBeNull();
    await user.type(screen.getByRole("textbox", { name: L.value }), "jazz");
    await user.click(screen.getByRole("button", { name: L.addCondition }));
    const fields = screen.getAllByRole("combobox", { name: L.field });
    await user.selectOptions(fields[1]!, "seats");
    await user.selectOptions(screen.getAllByRole("combobox", { name: L.operator })[1]!, "gt");
    await user.type(screen.getByRole("spinbutton", { name: L.value }), "100");
    let tree = seen.mock.lastCall![0] as FilterGroup;
    expect(queryFromGroup(COLUMNS, tree)).toBe('name~="jazz";seats>100');
    await user.selectOptions(screen.getByRole("combobox", { name: L.join }), "or");
    tree = seen.mock.lastCall![0] as FilterGroup;
    expect(queryFromGroup(COLUMNS, tree)).toBe('name~="jazz"|seats>100');
    await user.click(screen.getByRole("button", { name: L.addGroup }));
    tree = seen.mock.lastCall![0] as FilterGroup;
    expect(conditionCount(tree)).toBe(3);
    await user.click(screen.getByRole("button", { name: L.removeGroup }));
    await user.click(screen.getAllByRole("button", { name: L.removeCondition })[0]!);
    tree = seen.mock.lastCall![0] as FilterGroup;
    expect(queryFromGroup(COLUMNS, tree)).toBe("seats>100");
  });

  // T-5005/T-5006: the live walker read "Add condition" and "Add condition group" as writes a viewer
  // could press; they only edit the filter in hand, so its viewer-write rule passes them, and a real
  // write control beside them is still found.
  it("holds no write control a viewer could press, in the walker's viewer-write rule", async () => {
    const user = userEvent.setup();
    wrap(
      <main>
        <Panel seen={vi.fn()} />
        <button type="button">New endpoint</button>
      </main>,
    );
    await user.click(screen.getByRole("button", { name: L.addCondition }));
    await user.click(screen.getByRole("button", { name: L.addGroup }));
    expect(screen.getByRole("button", { name: L.removeGroup })).toBeInTheDocument();
    expect(viewerWriteFindings(false)).toEqual(['viewer-write: "New endpoint" can be pressed']);
  });

  it("picks an enum's values instead of typing them", async () => {
    const user = userEvent.setup();
    const seen = vi.fn();
    wrap(<Panel seen={seen} />);
    await user.click(screen.getByRole("button", { name: L.addCondition }));
    await user.selectOptions(screen.getByRole("combobox", { name: L.field }), "category");
    await user.selectOptions(screen.getByRole("listbox", { name: L.value }), ["music", "sport"]);
    expect(queryFromGroup(COLUMNS, seen.mock.lastCall![0] as FilterGroup)).toBe('category=="music","sport"');
  });
});

describe("readGroup", () => {
  it("keeps a well-formed tree and drops what is not one", () => {
    const tree = { join: "or", conditions: [{ key: "name", filter: { op: "contains", value: "a" } }, { join: "and", conditions: [] }] };
    expect(readGroup(tree)).toEqual(tree);
    expect(readGroup({ join: "xor", conditions: [] })).toBeNull();
    expect(readGroup("name==1")).toBeNull();
    expect(readGroup({ join: "and", conditions: [{ key: 1 }, { key: "a", filter: { op: "equals", value: 3 } }] })).toEqual({
      join: "and",
      conditions: [{ key: "a", filter: { op: "equals", value: "" } }],
    });
    // Groups nest one level, as the panel draws them.
    const deep = { join: "and", conditions: [{ join: "and", conditions: [{ join: "and", conditions: [] }] }] };
    expect(readGroup(deep)).toEqual({ join: "and", conditions: [{ join: "and", conditions: [] }] });
  });
});

function countingSource(totals: (q: string | undefined) => number | Error): { source: EntitySource; asked: (string | undefined)[] } {
  const asked: (string | undefined)[] = [];
  const source = {
    async query(q: GridQuery) {
      asked.push(q.q);
      const total = totals(q.q);
      if (total instanceof Error) throw total;
      return { rows: [], total };
    },
  } as unknown as EntitySource;
  return { source, asked };
}

function Footer({ source, start }: { source: EntitySource; start: Aggregation }) {
  const [value, setValue] = useState<Aggregation>(start);
  return <FooterAggregate source={source} type="Event" attr="seats" label="Seats" q={'category=="music"'} value={value} onChange={setValue} />;
}

describe("FooterAggregate", () => {
  it("counts filled and empty at the endpoint over the view's whole query", async () => {
    const user = userEvent.setup();
    const { source, asked } = countingSource((q) => (q?.endsWith(";seats") ? 30 : 120));
    wrap(<Footer source={source} start="percentEmpty" />);
    expect(await screen.findByText("75 %")).toBeInTheDocument();
    expect(asked).toEqual(expect.arrayContaining(['category=="music"', 'category=="music";seats']));
    await user.selectOptions(screen.getByRole("combobox", { name: "Footer of Seats" }), "empty");
    expect(await screen.findByText("90")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Footer of Seats" }), "filled");
    expect(await screen.findByText("30")).toBeInTheDocument();
  });

  it("says a refused count is not counted, never a number", async () => {
    const { source } = countingSource(() => new Error("403 Forbidden"));
    wrap(<Footer source={source} start="count" />);
    expect(await screen.findByText(L.aggregateFailedShort)).toHaveAttribute("title", L.aggregateFailed);
  });

  it("asks nothing for none", () => {
    const { source, asked } = countingSource(() => 1);
    wrap(<Footer source={source} start="none" />);
    expect(asked).toEqual([]);
  });

  it("divides only by a whole", () => {
    expect(percent(1, 0)).toBeNull();
    expect(percent(1, 3)).toBe("33.3 %");
  });
});

describe("ToolbarPopover", () => {
  it("shows its count and closes on Escape", async () => {
    const user = userEvent.setup();
    wrap(
      <ToolbarPopover label="Filter" count={2}>
        <button type="button">inside</button>
      </ToolbarPopover>,
    );
    const summary = screen.getByText("Filter").closest("summary")!;
    expect(summary).toHaveTextContent("Filter2");
    await user.click(summary);
    const details = summary.parentElement as HTMLDetailsElement;
    await waitFor(() => expect(details.open).toBe(true));
    await user.keyboard("{Escape}");
    expect(details.open).toBe(false);
  });
});

describe("mayDelete", () => {
  it("offers a delete only where a grant names deleteEntity and no prohibition does", () => {
    const grant = { resource: { type: "Event" }, actions: ["queryEntity", "deleteEntity"] };
    expect(mayDelete({ permissions: [grant] }, "Event")).toBe(true);
    expect(mayDelete({ permissions: [grant] }, "Vehicle")).toBe(false);
    expect(mayDelete({ permissions: [{ ...grant, actions: ["queryEntity", "updateAttrs"] }] }, "Event")).toBe(false);
    expect(mayDelete({ permissions: [grant], prohibitions: [{ resource: { type: "*" }, actions: ["deleteEntity"] }] }, "Event")).toBe(false);
    expect(mayDelete(undefined, "Event")).toBe(false);
  });
});

describe("bulkValue", () => {
  const slot = (over: Partial<FilterSlot>): FilterSlot => ({ name: "f", kind: "Property", ...over });
  it("takes a value only in the shape the field's range takes it", () => {
    expect(bulkValue(slot({ values: ["open", "closed"] }), "open")).toBe("open");
    expect(bulkValue(slot({ values: ["open", "closed"] }), "ajar")).toBeUndefined();
    expect(bulkValue(slot({ range: "integer" }), " 42 ")).toBe(42);
    expect(bulkValue(slot({ range: "integer" }), "4.2")).toBeUndefined();
    expect(bulkValue(slot({ range: "float" }), "4.2")).toBe(4.2);
    expect(bulkValue(slot({ range: "float" }), "Infinity")).toBeUndefined();
    expect(bulkValue(slot({ range: "boolean" }), "false")).toBe(false);
    expect(bulkValue(slot({ range: "boolean" }), "no")).toBeUndefined();
    expect(bulkValue(slot({ range: "string" }), "  Main Street 1 ")).toBe("Main Street 1");
    expect(bulkValue(slot({ range: "string" }), "   ")).toBeUndefined();
  });
});

describe("live flash", () => {
  const row = (id: string, name: string) => ({ id, type: "T", cells: { name: { kind: "text", value: name } } }) as unknown as RichRow;
  it("marks the rows that are new or changed since the last read, not the rest", () => {
    const before = rowSignatures([row("a", "A"), row("b", "B")]);
    expect([...changedRows(before, [row("a", "A"), row("b", "B2"), row("c", "C")])]).toEqual(["b", "c"]);
    expect(changedRows(before, [row("a", "A")]).size).toBe(0);
  });
});

describe("enumColours", () => {
  it("makes one rule per value with the tones in turn, at most twenty", () => {
    expect(enumColours("status", [{ value: "open" }, { value: 'say "hi"' }])).toEqual([
      { when: 'status=="open"', colour: "info" },
      { when: 'status=="say \\"hi\\""', colour: "success" },
    ]);
    expect(enumColours("n", Array.from({ length: 30 }, (_, at) => ({ value: String(at) })))).toHaveLength(20);
  });
});

describe("BulkSetDialog", () => {
  const row = (id: string, name: string) => ({ id, type: "T", cells: { name: { kind: "property", value: name } } }) as unknown as RichRow;
  const rows = [row("urn:ngsi-ld:T:a", "Alpha"), row("urn:ngsi-ld:T:b", "Beta")];
  const slots: FilterSlot[] = [
    { name: "seats", range: "integer", kind: "Property" },
    { name: "status", range: "Status", kind: "Property", values: ["open", "closed"] },
  ];
  const applyName = L.setApply.replace("{n}", "2");

  function setup(patch: (id: string, body: Record<string, unknown>, reason: string) => Promise<void>) {
    const onDone = vi.fn();
    wrap(<BulkSetDialog open onOpenChange={() => {}} rows={rows} slots={slots} source={{ patch }} onDone={onDone} />);
    return { onDone, user: userEvent.setup() };
  }

  it("refuses a value the field's range does not take and writes nothing without a reason", async () => {
    const patch = vi.fn(async () => {});
    const { user } = setup(patch);
    const invalid = L.setValueInvalid.replace("{range}", "integer");
    await user.selectOptions(screen.getByLabelText(L.setFieldLabel), "seats");
    await user.type(screen.getByLabelText(L.setValue), "2.5");
    expect(screen.getByText(invalid)).toBeInTheDocument();
    await user.clear(screen.getByLabelText(L.setValue));
    await user.type(screen.getByLabelText(L.setValue), "40");
    expect(screen.queryByText(invalid)).toBeNull();
    await user.click(screen.getByRole("button", { name: applyName }));
    expect(patch).not.toHaveBeenCalled();
  });

  it("writes the enum value into every row with the reason, names a refused row and reloads", async () => {
    const patch = vi.fn(async (id: string) => {
      if (id === "urn:ngsi-ld:T:b") throw new SourceError(403, "status closed needs an approver");
    });
    const { user, onDone } = setup(patch);
    await user.selectOptions(screen.getByLabelText(L.setFieldLabel), "status");
    await user.selectOptions(screen.getByLabelText(L.setValue), "closed");
    await user.type(screen.getByLabelText(L.setReason), "Closed after the inspection");
    await user.click(screen.getByRole("button", { name: applyName }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledWith("urn:ngsi-ld:T:a", { status: { type: "Property", value: "closed" } }, "Closed after the inspection");
    expect(screen.getByText("Beta: status closed needs an approver")).toBeInTheDocument();
    expect(screen.getByText("1 row was not changed")).toBeInTheDocument();
  });

  it("does not reload when every row is refused", async () => {
    const { user, onDone } = setup(async () => {
      throw new SourceError(403, "");
    });
    await user.selectOptions(screen.getByLabelText(L.setFieldLabel), "seats");
    await user.type(screen.getByLabelText(L.setValue), "40");
    await user.type(screen.getByLabelText(L.setReason), "Recount");
    await user.click(screen.getByRole("button", { name: applyName }));
    await waitFor(() => expect(screen.getByText("2 rows were not changed")).toBeInTheDocument());
    expect(screen.getByText(`Alpha: ${L.setRefusedRow} (403)`)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });
});
