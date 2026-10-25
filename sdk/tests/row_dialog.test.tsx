// T-4828: a row opens as a modal dialog with Fields, History and the host's tabs, can be named by
// the host (a deep link), and asks the gateway for every version only when the person asks.
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { EntityGrid } from "../src/grid/EntityGrid";
import { parseGridConfig } from "../src/grid/config";
import { fixtureSource, historyOf, SourceError } from "../src/grid/source";
import type { EntitySource, HistoryPoint, HistoryWindow } from "../src/grid/source";

const KPI = "urn:ngsi-ld:KeyPerformanceIndicator:kpi-1";
const OTHER = "urn:ngsi-ld:KeyPerformanceIndicator:kpi-2";
const kpis: Record<string, unknown>[] = [
  {
    id: KPI,
    type: "KeyPerformanceIndicator",
    name: { type: "Property", value: "Recycling rate" },
    kpiValue: { type: "Property", value: 41.5, observedAt: "2026-10-20T10:00:00Z" },
  },
  {
    id: OTHER,
    type: "KeyPerformanceIndicator",
    name: { type: "Property", value: "Bus punctuality" },
    kpiValue: { type: "Property", value: 88, observedAt: "2026-10-20T10:00:00Z" },
  },
];

function configOf(mode: "edit" | "view", pageSize = 10) {
  return parseGridConfig({
    source: { kind: "fixture", name: "test" },
    type: "KeyPerformanceIndicator",
    columns: [
      { attr: "name", label: "Name", pinned: true },
      { attr: "kpiValue", label: "Value" },
    ],
    pageSize,
    mode,
    history: { enabled: true },
    ...(mode === "edit" ? { editableAttrs: ["kpiValue"] } : {}),
  }).config!;
}

type History = (id: string, attr: string, window: HistoryWindow) => Promise<HistoryPoint[]>;

function sourceWith(history?: History): EntitySource {
  const base = fixtureSource(kpis);
  return { ...base, patch: vi.fn(async () => undefined), ...(history ? { history } : {}) };
}

describe("row dialog (T-4828)", () => {
  it("opens as a modal with Fields first, moves between tabs by arrow keys and shows the host's tab", async () => {
    const history = vi.fn<History>(async () => []);
    render(
      <EntityGrid
        config={configOf("edit")}
        source={sourceWith(history)}
        detailTabs={(row) => [{ id: "comments", label: "Comments", content: <p>{`comments of ${row.id}`}</p> }]}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open: Recycling rate" }));
    const dialog = screen.getByRole("dialog", { name: "Details: Recycling rate" });
    const tabs = within(dialog).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Fields", "History", "Metadata", "Comments"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    // Fields edit with the grid's own editor and join its pending list, shown inside the dialog.
    fireEvent.change(within(dialog).getByRole("spinbutton"), { target: { value: "42" } });
    expect(within(dialog).getByText("1 not applied yet")).toBeInTheDocument();

    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(within(dialog).getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("tab", { name: "History" })).toHaveFocus();
    await waitFor(() => expect(history).toHaveBeenCalledWith(KPI, "name", expect.objectContaining({ lastN: expect.any(Number) })));
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Attribute" }), { target: { value: "kpiValue" } });
    await waitFor(() => expect(history).toHaveBeenLastCalledWith(KPI, "kpiValue", expect.anything()));

    fireEvent.keyDown(within(dialog).getByRole("tab", { name: "History" }), { key: "End" });
    expect(within(dialog).getByRole("tabpanel")).toHaveTextContent(`comments of ${KPI}`);
  });

  it("has no History tab where the source reads no history", async () => {
    render(<EntityGrid config={configOf("edit")} source={sourceWith()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open: Recycling rate" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Fields", "Metadata"]);
  });

  it("shows values without editors to a person the grant gives no write", async () => {
    render(<EntityGrid config={configOf("view")} source={sourceWith()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open: Recycling rate" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("spinbutton")).toBeNull();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(dialog).toHaveTextContent("41.5");
  });

  it("opens the row a host names, reads one off the page by its id, and reports the close", async () => {
    const source = sourceWith();
    const get = vi.spyOn(source, "get");
    const onOpenRow = vi.fn();
    // One row a page: the second KPI is not loaded, so the dialog reads it by its id.
    render(<EntityGrid config={configOf("edit", 1)} source={source} openRow={OTHER} onOpenRow={onOpenRow} />);
    const dialog = await screen.findByRole("dialog", { name: "Details: Bus punctuality" });
    expect(get).toHaveBeenCalledWith(OTHER);
    // A row read on its own has no editors: an edit is written against the loaded page.
    expect(within(dialog).queryByRole("spinbutton")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onOpenRow).toHaveBeenLastCalledWith(null);
  });

  // T-5600: a row read by its id showed "6.7" without its unit, an ISO time and "Point".
  it("shows a row read by its id as the loaded page shows it", async () => {
    const measured = kpis.map((kpi) => ({
      ...kpi,
      kpiValue: { ...(kpi.kpiValue as object), unitCode: "GQ" },
      location: { type: "GeoProperty", value: { type: "Point", coordinates: [24.94, 60.17] } },
    }));
    const config = parseGridConfig({
      source: { kind: "fixture", name: "test" },
      type: "KeyPerformanceIndicator",
      columns: [{ attr: "name", label: "Name", pinned: true }, { attr: "kpiValue", label: "Value" }, { attr: "location", label: "Place" }],
      pageSize: 10,
    }).config!;
    const fields = async (pageSize: number) => {
      const { unmount } = render(<EntityGrid config={{ ...config, pageSize }} source={fixtureSource(measured)} openRow={OTHER} onOpenRow={vi.fn()} />);
      const text = (await screen.findByRole("dialog", { name: "Details: Bus punctuality" })).textContent;
      unmount();
      return text;
    };
    const listed = await fields(10);
    expect(listed).toContain("µg/m³");
    expect(await fields(1)).toBe(listed);
  });

  it("closes a link to a row that is gone or not readable", async () => {
    const onOpenRow = vi.fn();
    render(<EntityGrid config={configOf("edit")} source={sourceWith()} openRow="urn:ngsi-ld:KeyPerformanceIndicator:none" onOpenRow={onOpenRow} />);
    await waitFor(() => expect(onOpenRow).toHaveBeenCalledWith(null));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks for every version only when switched on and says a refusal in words", async () => {
    const history = vi.fn<History>(async (_id, _attr, window) => {
      if (window.versions) throw new SourceError(403, "readVersions not granted");
      return [{ at: "2026-10-20T10:00:00Z", value: 41.5 }];
    });
    render(<EntityGrid config={configOf("edit")} source={sourceWith(history)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open: Recycling rate" }));
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    await waitFor(() => expect(history).toHaveBeenCalled());
    expect(history.mock.calls.every(([, , window]) => !window.versions)).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Every version/ }));
    expect(await screen.findByText(/Your role may not read earlier versions/)).toBeInTheDocument();
    expect(history).toHaveBeenLastCalledWith(KPI, "name", expect.objectContaining({ versions: true }));
  });

  it("lists each version with who changed it and why, markup as text", async () => {
    const history = vi.fn<History>(async () => [
      {
        at: "2026-10-20T10:00:00Z",
        value: 40,
        supersededAt: "2026-10-20T11:00:00Z",
        provenance: { channel: "pipeline", operation: "create", actor: "pipeline-kpi" },
      },
      {
        at: "2026-10-20T10:00:00Z",
        value: 41.5,
        provenance: { channel: "ui", operation: "correct", reason: "<img src=x onerror=alert(1)>checked" },
      },
    ]);
    render(<EntityGrid config={configOf("edit")} source={sourceWith(history)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open: Recycling rate" }));
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Every version/ }));
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByText("pipeline · create · pipeline-kpi")).toBeInTheDocument();
    expect(within(dialog).getByText("ui · correct")).toBeInTheDocument();
    expect(within(dialog).getByText("<img src=x onerror=alert(1)>checked")).toBeInTheDocument();
    expect(dialog.querySelector("img")).toBeNull();
    expect(within(dialog).getByRole("columnheader", { name: "Reason" })).toBeInTheDocument();
  });
});

describe("versions in a temporal answer (DM-114)", () => {
  it("keeps supersededAt and the text fields of provenance, organization and actorKind included, nothing else", () => {
    const body = {
      kpiValue: [
        {
          type: "Property",
          value: 40,
          observedAt: "2026-10-20T10:00:00Z",
          supersededAt: "2026-10-20T11:00:00Z",
          provenance: { channel: "ui", actor: "a1", operation: "correct", reason: "typo", requestId: "9a07", writtenAt: "2026-10-20T11:00:00Z", organization: "helsinki", actorKind: "person", extra: { nested: 1 } },
        },
        { type: "Property", value: 41, observedAt: "2026-10-20T10:00:00Z" },
      ],
    };
    expect(historyOf(body, "kpiValue")).toEqual([
      {
        at: "2026-10-20T10:00:00Z",
        value: 40,
        supersededAt: "2026-10-20T11:00:00Z",
        provenance: { channel: "ui", actor: "a1", operation: "correct", reason: "typo", writtenAt: "2026-10-20T11:00:00Z", organization: "helsinki", actorKind: "person" },
      },
      { at: "2026-10-20T10:00:00Z", value: 41 },
    ]);
  });
});
