import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { EntityGrid } from "../src/grid/EntityGrid";
import { parseGridConfig } from "../src/grid/config";
import { fixtureSource } from "../src/grid/source";
import { DEFAULT_LABELS, useEntityGrid } from "../src/grid/useEntityGrid";

const bikeEntities: Record<string, unknown>[] = [
  {
    id: "urn:ngsi-ld:BikeHireDockingStation:hel:helsinki:001",
    type: "BikeHireDockingStation",
    availableBikeNumber: { type: "Property", value: 5, unitCode: "C62", observedAt: "2026-01-01T10:00:00Z" },
    refDevice: { type: "Relationship", object: "urn:ngsi-ld:Device:hel:001" },
    location: { type: "GeoProperty", value: { type: "Point", coordinates: [24.93, 60.17] } },
    name: { type: "LanguageProperty", languageMap: { en: "Kamppi", fi: "Kamppi" } },
  },
  {
    id: "urn:ngsi-ld:BikeHireDockingStation:hel:helsinki:002",
    type: "BikeHireDockingStation",
    availableBikeNumber: { type: "Property", value: 3, unitCode: "C62", observedAt: "2026-01-01T11:00:00Z" },
    refDevice: { type: "Relationship", object: "urn:ngsi-ld:Device:hel:002" },
    location: { type: "GeoProperty", value: { type: "Point", coordinates: [24.95, 60.18] } },
    name: { type: "LanguageProperty", languageMap: { en: "Kallio", fi: "Kallio" } },
  },
];

const configResult = parseGridConfig({
  source: { kind: "fixture", name: "test" },
  type: "BikeHireDockingStation",
  columns: [
    { attr: "name", label: "Name" },
    { attr: "availableBikeNumber", label: "Bikes", show: { unit: true } },
    { attr: "refDevice", label: "Device" },
    { attr: "location", label: "Location" },
  ],
  pageSize: 10,
});

const config = configResult.config!;
// One row a page, so the pager has somewhere to go.
const onePerPage = { ...config, pageSize: 1 };

describe("EntityGrid", () => {
  it("leaves a column without a filter without a header cell in the filter row", async () => {
    const some = { ...config, filters: { allowed: ["availableBikeNumber"], preset: {} } };
    const { container } = render(<EntityGrid config={some} source={fixtureSource(bikeEntities)} />);
    await waitFor(() => expect(screen.getByText("5")).toBeInTheDocument());
    const row = container.querySelector("tr.jc-grid-filter-row") as HTMLTableRowElement;
    // Every header cell of the filter row holds a filter; the other columns get a plain cell.
    expect(Array.from(row.querySelectorAll("th")).every((cell) => cell.childElementCount > 0)).toBe(true);
    expect(row.querySelectorAll("td").length).toBeGreaterThan(0);
    expect(row.cells).toHaveLength(container.querySelectorAll("thead tr:first-child > *").length);
  });

  it("leaves out the attributes a view hides, and marks a row with its tone and the reason", async () => {
    render(
      <EntityGrid
        config={config}
        source={fixtureSource(bikeEntities)}
        hidden={["availableBikeNumber"]}
        rowTone={(row) => (row.id === bikeEntities[0].id ? { tone: "danger", label: "No bikes left" } : undefined)}
      />,
    );
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1));
    expect(screen.queryByRole("columnheader", { name: /availableBikeNumber/ })).toBeNull();
    const marked = screen.getAllByRole("img", { name: "No bikes left" });
    expect(marked).toHaveLength(1);
    expect(marked[0].closest("tr")).toHaveClass("jc-grid-tr--danger");
  });

  it("tells the host the query its filters ask, as it changes, for a saved view to keep", async () => {
    const onQuery = vi.fn();
    const { rerender } = render(<EntityGrid config={config} source={fixtureSource(bikeEntities)} onQuery={onQuery} />);
    await waitFor(() => expect(onQuery).toHaveBeenLastCalledWith({ q: undefined, idPattern: undefined }));
    rerender(
      <EntityGrid config={config} source={fixtureSource(bikeEntities)} onQuery={onQuery} state={{ filterText: "availableBikeNumber<3" }} />,
    );
    await waitFor(() => expect(onQuery).toHaveBeenLastCalledWith({ q: "availableBikeNumber<3", idPattern: undefined }));
  });

  it("renders value with unit", async () => {
    render(<EntityGrid config={config} source={fixtureSource(bikeEntities)} />);
    await waitFor(() => {
      expect(screen.getByText("5")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
    });
  });

  it("writes a value with its unit's symbol and names the unit on hover (DM-06)", async () => {
    const air = parseGridConfig({
      source: { kind: "fixture", name: "air" },
      type: "AirQualityObserved",
      columns: [{ attr: "pm10", label: "PM10" }],
      pageSize: 10,
    }).config!;
    const station = {
      id: "urn:ngsi-ld:AirQualityObserved:hel:helsinki:1",
      type: "AirQualityObserved",
      pm10: { type: "Property", value: 12, unitCode: "GQ" },
    };
    render(<EntityGrid config={air} source={fixtureSource([station])} />);
    const cell = await screen.findByText("12 µg/m³");
    expect(cell.closest("td")).toHaveAttribute("title", "microgram per cubic metre (GQ)");
    expect(screen.getByRole("columnheader", { name: /PM10 \(µg\/m³\)/ })).toBeInTheDocument();
  });

  it("toggles observedAt column via header menu", async () => {
    render(<EntityGrid config={config} source={fixtureSource(bikeEntities)} />);
    await waitFor(() => {
      expect(screen.getByText("Kamppi")).toBeInTheDocument();
    });

    // Click the menu button for availableBikeNumber
    const menuBtn = screen.getByLabelText("Show metadata for availableBikeNumber");
    fireEvent.click(menuBtn);

    // Check the observedAt checkbox
    const observedCheckbox = screen.getByLabelText("Observed");
    expect(observedCheckbox).not.toBeChecked();
    fireEvent.click(observedCheckbox);

    // Now the observedAt column should appear
    await waitFor(() => {
      expect(screen.getByText("2026-01-01T10:00:00Z")).toBeInTheDocument();
      expect(screen.getByText("2026-01-01T11:00:00Z")).toBeInTheDocument();
    });
  });

  it("renders relationship URN as button when onOpenRelationship given", async () => {
    const onOpen = vi.fn();
    render(
      <EntityGrid
        config={config}
        source={fixtureSource(bikeEntities)}
        onOpenRelationship={onOpen}
      />,
    );
    await waitFor(() => {
      const buttons = screen.getAllByRole("button");
      const relBtn = buttons.find((b) => b.textContent === "urn:ngsi-ld:Device:hel:001");
      expect(relBtn).toBeInTheDocument();
      fireEvent.click(relBtn!);
      expect(onOpen).toHaveBeenCalledWith("urn:ngsi-ld:Device:hel:001");
    });
  });

  it("shows empty label when source has no rows", async () => {
    render(<EntityGrid config={config} source={fixtureSource([])} />);
    await waitFor(() => {
      expect(screen.getByText("No rows.")).toBeInTheDocument();
    });
  });

  it("moves data-active with ArrowRight, ArrowDown, Home, End, PageDown", async () => {
    render(<EntityGrid config={config} source={fixtureSource(bikeEntities)} />);
    await waitFor(() => {
      expect(screen.getByText("Kamppi")).toBeInTheDocument();
    });

    const grid = screen.getByRole("grid");
    grid.focus();

    // ArrowDown
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    await waitFor(() => {
      // second row should have data-active
      const cells = grid.querySelectorAll('[data-active]');
      expect(cells.length).toBeGreaterThan(0);
    });

    // ArrowRight
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    // Home
    fireEvent.keyDown(grid, { key: "Home" });
    // End
    fireEvent.keyDown(grid, { key: "End" });
    // PageDown
    fireEvent.keyDown(grid, { key: "PageDown" });
  });

  // T-3097, UI-70: one tab stop, the active cell announced as the grid's active descendant, its
  // place counted in the whole set, Ctrl+End to the last cell, Enter into the cell's own editor and
  // Escape back to the grid.
  it("names the active cell to assistive technology and moves into and out of its editor", async () => {
    const editable = parseGridConfig({
      source: { kind: "fixture", name: "test" },
      type: "BikeHireDockingStation",
      columns: [
        { attr: "name", label: "Name" },
        { attr: "availableBikeNumber", label: "Bikes" },
      ],
      pageSize: 1,
      mode: "edit",
      editableAttrs: ["availableBikeNumber"],
    }).config!;
    const source = { ...fixtureSource(bikeEntities), patch: vi.fn() };
    render(<EntityGrid config={editable} source={source} />);
    await screen.findByText("Kamppi");
    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("aria-rowcount", "3");
    grid.focus();

    fireEvent.keyDown(grid, { key: "End", ctrlKey: true });
    const active = grid.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    const cell = document.getElementById(active!)!;
    expect(cell).toHaveAttribute("role", "gridcell");
    expect(cell).toHaveAttribute("data-active");

    fireEvent.keyDown(grid, { key: "Enter" });
    const input = cell.querySelector("input")!;
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(grid).toHaveFocus();

    // Page two counts from the whole set: the row is the second of two, after the header.
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await screen.findByText("Kallio");
    expect(screen.getByText("Kallio").closest("[role=row]")).toHaveAttribute("aria-rowindex", "3");
  });

  // T-3097: the identifier opens the row whole, every attribute with the grid's own editors, and
  // Escape goes back to the grid.
  it("opens a row's detail panel from its identifier, edits there, and closes back to the grid", async () => {
    const two = parseGridConfig({
      source: { kind: "fixture", name: "test" },
      type: "BikeHireDockingStation",
      columns: [
        { attr: "name", label: "Name" },
        { attr: "availableBikeNumber", label: "Bikes" },
      ],
      pageSize: 10,
      mode: "edit",
      editableAttrs: ["availableBikeNumber"],
    }).config!;
    const source = { ...fixtureSource(bikeEntities), patch: vi.fn() };
    render(<EntityGrid config={two} source={source} />);
    await screen.findByText("Kamppi");

    fireEvent.click(screen.getByRole("button", { name: "Open: Kamppi" }));
    const panel = screen.getByRole("complementary", { name: "Details: Kamppi" });
    expect(screen.getByRole("heading", { name: "Details: Kamppi" })).toHaveFocus();
    // The grid's columns, then what the entity carries beyond them.
    const terms = Array.from(panel.querySelectorAll("dt")).map((dt) => dt.textContent);
    expect(terms).toEqual(["Name", "Bikes", "location", "refDevice"]);

    const bikes = panel.querySelector<HTMLInputElement>("dd input")!;
    fireEvent.change(bikes, { target: { value: "7" } });
    expect(screen.getByText("1 not applied yet")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("heading", { name: "Details: Kamppi" }), { key: "Escape" });
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.getByRole("grid")).toHaveFocus();
  });

  // T-3097: a range pasted from a spreadsheet lands on the editable cells from the active one and
  // says what it skipped; nothing is pending outside edit mode.
  it("pastes a copied range from the active cell into editable cells and says what it skipped", async () => {
    const editable = parseGridConfig({
      source: { kind: "fixture", name: "test" },
      type: "BikeHireDockingStation",
      columns: [
        { attr: "name", label: "Name" },
        { attr: "availableBikeNumber", label: "Bikes" },
      ],
      pageSize: 10,
      mode: "edit",
      editableAttrs: ["availableBikeNumber"],
    }).config!;
    const source = { ...fixtureSource(bikeEntities), patch: vi.fn() };
    render(<EntityGrid config={editable} source={source} />);
    await screen.findByText("Kamppi");
    const grid = screen.getByRole("grid");
    grid.focus();
    // id, name, bikes: two to the right is the bikes column of the first row.
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.paste(grid, { clipboardData: { getData: () => "8\tignored\n4\n" } });

    expect(screen.getByText("2 cells pasted, 1 skipped (not editable, off the page or not a listed value)")).toBeInTheDocument();
    expect(screen.getByText("2 not applied yet")).toBeInTheDocument();
    expect(screen.getByDisplayValue("8")).toBeInTheDocument();
    expect(screen.getByDisplayValue("4")).toBeInTheDocument();
  });

  // T-3106: the host adds what belongs under a row, such as its comments, to the panel.
  it("draws what the host adds under the opened row's attributes", async () => {
    const config = parseGridConfig({
      source: { kind: "fixture", name: "test" },
      type: "BikeHireDockingStation",
      columns: [{ attr: "name", label: "Name" }],
      pageSize: 10,
    }).config!;
    render(
      <EntityGrid
        config={config}
        source={fixtureSource(bikeEntities)}
        detailExtra={(row) => <p>{`notes on ${row.id}`}</p>}
      />,
    );
    await screen.findByText("Kamppi");
    expect(screen.queryByText(/^notes on/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open: Kamppi" }));
    const panel = screen.getByRole("complementary", { name: "Details: Kamppi" });
    expect(panel).toHaveTextContent(/notes on urn:ngsi-ld:BikeHireDockingStation:/);
  });

  // T-3097, ADR-N-042: a pinned column is the primary field. It takes the identifier's place as the
  // first column, its value opens the row (the id on hover and in the panel), and in the panel it is
  // edited like any other attribute.
  it("puts a pinned primary field first, opens the row from it and edits it in the panel", async () => {
    const primary = parseGridConfig({
      source: { kind: "fixture", name: "test" },
      type: "BikeHireDockingStation",
      columns: [
        { attr: "availableBikeNumber", label: "Bikes" },
        { attr: "name", label: "Name", pinned: true },
      ],
      pageSize: 10,
      mode: "edit",
      editableAttrs: ["name", "availableBikeNumber"],
    }).config!;
    const source = { ...fixtureSource(bikeEntities), patch: vi.fn() };
    render(<EntityGrid config={primary} source={source} />);
    const open = await screen.findByRole("button", { name: "Open: Kamppi" });
    const headers = screen.getAllByRole("columnheader").map((th) => th.textContent ?? "");
    expect(headers[0]).toMatch(/^Name/);
    expect(headers.some((h) => h.startsWith("ID"))).toBe(false);
    expect(open).toHaveAttribute("title", "urn:ngsi-ld:BikeHireDockingStation:hel:helsinki:001");
    expect(open.closest("td")).toHaveClass("jc-grid-pinned");

    fireEvent.click(open);
    const panel = screen.getByRole("complementary", { name: "Details: Kamppi" });
    expect(within(panel).getByText("urn:ngsi-ld:BikeHireDockingStation:hel:helsinki:001")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /^Open/ })).toBeNull();
    expect(within(panel).getAllByRole("textbox").length).toBeGreaterThan(0);
  });

  // T-3097: a scrolling grid draws the rows in sight and loads the next page as the person nears
  // the end; the footer counts what is loaded of the whole set, and the rows keep their places.
  it("scrolls through more rows than a page, drawing only a window and loading as it goes", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      id: `urn:ngsi-ld:BikeHireDockingStation:hel:helsinki:${String(i).padStart(3, "0")}`,
      type: "BikeHireDockingStation",
      name: { type: "Property", value: `Station ${i}` },
    }));
    const scrolling = parseGridConfig({
      source: { kind: "fixture", name: "many" },
      type: "BikeHireDockingStation",
      columns: [{ attr: "name", label: "Name" }],
      pageSize: 50,
    }).config!;
    const { container } = render(<EntityGrid config={scrolling} source={fixtureSource(many)} virtual />);
    await screen.findByText("Station 0");
    expect(screen.getByText("50 of 120 loaded")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    const drawn = () => container.querySelectorAll("tbody tr:not(.jc-grid-spacer)");
    expect(drawn().length).toBeLessThanOrEqual(50);

    const box = container.querySelector<HTMLDivElement>(".jc-grid-scroll")!;
    box.scrollTop = 30 * 36;
    fireEvent.scroll(box);
    await screen.findByText("100 of 120 loaded");
    // The window moved: the first drawn row is twenty rows in, and says so to a screen reader.
    expect(screen.queryByText("Station 0")).toBeNull();
    expect(drawn()[0]).toHaveAttribute("aria-rowindex", "22");
    expect(drawn().length).toBeLessThan(100);
  });

  it("has role grid with aria-rowcount and headers with aria-colindex", async () => {
    render(<EntityGrid config={config} source={fixtureSource(bikeEntities)} />);
    await waitFor(() => {
      expect(screen.getByText("Kamppi")).toBeInTheDocument();
    });

    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("aria-rowcount", "3"); // 2 rows + 1 header
    expect(grid).toHaveAttribute("aria-colcount");

    const headers = grid.querySelectorAll('[role="columnheader"]');
    expect(headers.length).toBeGreaterThan(0);
    headers.forEach((h, i) => {
      expect(h).toHaveAttribute("aria-colindex", String(i + 1));
    });
  });

  it("controlled: pager next calls onStateChange and offset does not change by itself", async () => {
    const onStateChange = vi.fn();
    render(
      <EntityGrid
        config={onePerPage}
        source={fixtureSource(bikeEntities)}
        state={{ offset: 0, activeCell: null, selected: [], shown: {}, sort: null }}
        onStateChange={onStateChange}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Kamppi")).toBeInTheDocument();
    });

    const nextBtn = screen.getByText("Next");
    fireEvent.click(nextBtn);
    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 1 }),
    );
    // offset should still be 0 because controlled
    expect(screen.getByText("Page 1")).toBeInTheDocument();
  });

  it("uncontrolled works without state props", async () => {
    render(<EntityGrid config={onePerPage} source={fixtureSource(bikeEntities)} />);
    await waitFor(() => {
      expect(screen.getByText("Kamppi")).toBeInTheDocument();
    });
    // pager works
    const nextBtn = screen.getByText("Next");
    fireEvent.click(nextBtn);
    await waitFor(() => {
      expect(screen.getByText("Page 2")).toBeInTheDocument();
    });
  });

  it("hook alone shows same rows", async () => {
    function TestComponent() {
      const grid = useEntityGrid({ config, source: fixtureSource(bikeEntities) });
      return (
        <ul>
          {grid.rows.map((r) => (
            <li key={r.id}>{r.id}</li>
          ))}
        </ul>
      );
    }
    render(<TestComponent />);
    await waitFor(() => {
      expect(screen.getByText("urn:ngsi-ld:BikeHireDockingStation:hel:helsinki:001")).toBeInTheDocument();
      expect(screen.getByText("urn:ngsi-ld:BikeHireDockingStation:hel:helsinki:002")).toBeInTheDocument();
    });
  });

  it("Slovak labels show no English text", async () => {
    const slovakLabels = {
      id: "ID",
      type: "Typ",
      createdAt: "Vytvorené",
      modifiedAt: "Upravené",
      observedAt: "Pozorované",
      unit: "Jednotka",
      datasetId: "Dataset",
      empty: "Prázdne.",
      loading: "Načítavam…",
      previous: "Predchádzajúca",
      next: "Nasledujúca",
      page: "Strana",
      showMetadata: "Zobraziť metadáta pre",
      error: "Chyba",
      filter: "Filter",
      ops: {
        contains: "obsahuje",
        equals: "je",
        notEquals: "nie je",
        gt: ">",
        gte: "≥",
        lt: "<",
        lte: "≤",
        between: "medzi",
        empty: "je prázdne",
        present: "má hodnotu",
        pattern: "vyhovuje",
        anyOf: "je jedno z",
      },
      value: "Hodnota",
      upperValue: "Horná hodnota",
      query: "Čo sa pýta",
      copyQuery: "Kopírovať dotaz",
      editAsText: "Upraviť ako text",
      filterRow: "Filtre",
      sortPage: "Zoradiť túto stranu podľa",
      matching: "vyhovujúcich",
    };
    render(
      <EntityGrid
        config={config}
        source={fixtureSource(bikeEntities)}
        labels={slovakLabels}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Kamppi")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText("Zobraziť metadáta pre availableBikeNumber"));
    // Every visible string is the host's: none of the English defaults that differ from Slovak shows.
    const text = document.body.textContent ?? "";
    const pairs: [string, string][] = Object.entries(DEFAULT_LABELS).flatMap(([key, english]) =>
      typeof english === "string"
        ? [[key, english] as [string, string]]
        : Object.entries(english).map(([op, name]) => [`${key}.${op}`, name] as [string, string]),
    );
    for (const [key, english] of pairs) {
      const host = key.startsWith("ops.")
        ? slovakLabels.ops[key.slice(4) as keyof typeof slovakLabels.ops]
        : slovakLabels[key as keyof typeof slovakLabels];
      if (english !== host) {
        expect(text, key).not.toContain(english);
      }
    }
    expect(screen.getByText("Strana 1")).toBeInTheDocument();
    expect(screen.getByText("Pozorované")).toBeInTheDocument();
  });

  it("renders <b>x</b> as text, not HTML", async () => {
    const entitiesWithHtml: Record<string, unknown>[] = [
      {
        id: "urn:1",
        type: "T",
        name: { type: "Property", value: "<b>x</b>" },
      },
    ];
    const configHtml = parseGridConfig({
      source: { kind: "fixture", name: "test" },
      type: "T",
      columns: [{ attr: "name" }],
    }).config!;
    render(<EntityGrid config={configHtml} source={fixtureSource(entitiesWithHtml)} />);
    await waitFor(() => {
      const cell = screen.getByText("<b>x</b>");
      expect(cell).toBeInTheDocument();
      expect(cell.querySelector("b")).toBeNull();
    });
  });

  /**
   * The filter row asks the endpoint, never the loaded page (T-1429, UI-66): each case reads the
   * query the source was given, because that is the only thing that decides what a person sees.
   */
  describe("the filter row", () => {
    /** A source that records every query the grid sends it. */
    function recordingSource(entities: Record<string, unknown>[]) {
      const asked: { q?: string; idPattern?: string; offset: number }[] = [];
      const inner = fixtureSource(entities);
      return {
        asked,
        source: {
          query: async (q: Parameters<typeof inner.query>[0], page: Parameters<typeof inner.query>[1]) => {
            asked.push({ q: q.q, idPattern: q.idPattern, offset: page.offset });
            return inner.query(q, page);
          },
          get: inner.get,
        },
      };
    }

    it("sends the query the chosen operator and value compose", async () => {
      const { asked, source } = recordingSource(bikeEntities);
      render(<EntityGrid config={config} source={source} />);
      await waitFor(() => expect(screen.getByText("Kamppi")).toBeInTheDocument());

      fireEvent.change(screen.getByLabelText("Filter: Bikes"), { target: { value: "gt" } });
      fireEvent.change(screen.getByLabelText("Value: Bikes"), { target: { value: "4" } });

      await waitFor(() => {
        expect(asked.at(-1)?.q).toBe("availableBikeNumber>4");
      });
      // And it says so under the grid, where a person can copy it.
      expect(screen.getByText("q=availableBikeNumber>4")).toBeInTheDocument();
    });

    it("asks nothing until the filter is complete, and starts again at the first page", async () => {
      const { asked, source } = recordingSource(bikeEntities);
      render(<EntityGrid config={onePerPage} source={source} />);
      await waitFor(() => expect(screen.getByText("Kamppi")).toBeInTheDocument());

      fireEvent.click(screen.getByText(DEFAULT_LABELS.next));
      await waitFor(() => expect(asked.at(-1)?.offset).toBe(1));

      // The operator alone narrows nothing: the value is still missing.
      fireEvent.change(screen.getByLabelText("Filter: Bikes"), { target: { value: "gt" } });
      await waitFor(() => expect(asked.at(-1)?.q).toBeUndefined());

      fireEvent.change(screen.getByLabelText("Value: Bikes"), { target: { value: "4" } });
      await waitFor(() => {
        expect(asked.at(-1)?.q).toBe("availableBikeNumber>4");
        // Page one, because page two of the narrowed answer may not exist.
        expect(asked.at(-1)?.offset).toBe(0);
      });
    });

    it("asks the id column by pattern rather than by a term of the query", async () => {
      const { asked, source } = recordingSource(bikeEntities);
      render(<EntityGrid config={config} source={source} />);
      await waitFor(() => expect(screen.getByText("Kamppi")).toBeInTheDocument());

      fireEvent.change(screen.getByLabelText("Filter: ID"), { target: { value: "pattern" } });
      fireEvent.change(screen.getByLabelText("Value: ID"), { target: { value: "helsinki:002" } });

      await waitFor(() => {
        expect(asked.at(-1)?.idPattern).toBe("helsinki:002");
        expect(asked.at(-1)?.q).toBeUndefined();
      });
      // The endpoint answered about the set, and the grid shows what came back.
      await waitFor(() => expect(screen.queryByText("Kamppi")).toBeNull());
      expect(screen.getByText("Kallio")).toBeInTheDocument();
    });

    it("hands the query over as text, and sends what the person typed", async () => {
      const { asked, source } = recordingSource(bikeEntities);
      render(<EntityGrid config={config} source={source} />);
      await waitFor(() => expect(screen.getByText("Kamppi")).toBeInTheDocument());

      fireEvent.change(screen.getByLabelText("Filter: Bikes"), { target: { value: "gt" } });
      fireEvent.change(screen.getByLabelText("Value: Bikes"), { target: { value: "4" } });
      await waitFor(() => expect(asked.at(-1)?.q).toBe("availableBikeNumber>4"));

      // The switch starts from what the row built, so nothing is lost by taking it over.
      fireEvent.click(screen.getByLabelText(DEFAULT_LABELS.editAsText));
      const field = screen.getByLabelText(DEFAULT_LABELS.query);
      expect(field).toHaveValue("availableBikeNumber>4");

      // And a `q` the row cannot show is exactly what the text field is for.
      fireEvent.change(field, { target: { value: 'availableBikeNumber>4|name=="Kallio"' } });
      await waitFor(() => expect(asked.at(-1)?.q).toBe('availableBikeNumber>4|name=="Kallio"'));
      // With the query in the person's hands the row's controls are gone, so the two cannot
      // disagree about what is being asked.
      expect(screen.queryByLabelText("Filter: Bikes")).toBeNull();
    });

    it("keeps a preset and a filter both true, and offers only the allowed columns", async () => {
      const { asked, source } = recordingSource(bikeEntities);
      render(
        <EntityGrid
          config={{
            ...config,
            filters: { allowed: ["availableBikeNumber"], preset: { q: 'name=="Kamppi"' } },
          }}
          source={source}
        />,
      );
      await waitFor(() => expect(screen.getByText("Kamppi")).toBeInTheDocument());
      // Only the allowed column has a filter: a grid narrowed by its dashboard stays narrowed.
      expect(screen.queryByLabelText("Filter: Name")).toBeNull();

      fireEvent.change(screen.getByLabelText("Filter: Bikes"), { target: { value: "gt" } });
      fireEvent.change(screen.getByLabelText("Value: Bikes"), { target: { value: "4" } });
      await waitFor(() => expect(asked.at(-1)?.q).toBe('name=="Kamppi";availableBikeNumber>4'));
    });

    it("shows the endpoint's own count in the footer, and nothing when it sent none", async () => {
      const counted = {
        query: async () => ({ rows: [], total: 41 }),
        get: async () => null,
      };
      const { unmount } = render(<EntityGrid config={config} source={counted} />);
      expect(await screen.findByText(`41 ${DEFAULT_LABELS.matching}`)).toBeInTheDocument();
      unmount();

      // A narrowed answer carries no count (R22): the footer then pages without claiming a total.
      const uncounted = { query: async () => ({ rows: [] }), get: async () => null };
      render(<EntityGrid config={config} source={uncounted} />);
      await waitFor(() => expect(screen.getByText(DEFAULT_LABELS.empty)).toBeInTheDocument());
      expect(screen.queryByText(new RegExp(DEFAULT_LABELS.matching))).toBeNull();
    });

    it("offers no filter for a geometry, and none for a column of entity timestamps", async () => {
      render(<EntityGrid config={{ ...config, entityTimestamps: true }} source={fixtureSource(bikeEntities)} />);
      await waitFor(() => expect(screen.getByText("Kamppi")).toBeInTheDocument());

      expect(screen.queryByLabelText("Filter: Location")).toBeNull();
      expect(screen.queryByLabelText(`Filter: ${DEFAULT_LABELS.createdAt}`)).toBeNull();
      expect(screen.getByLabelText("Filter: Bikes")).toBeInTheDocument();
    });

    it("says that sorting orders the loaded page", async () => {
      render(<EntityGrid config={config} source={fixtureSource(bikeEntities)} />);
      await waitFor(() => expect(screen.getByText("Kamppi")).toBeInTheDocument());

      const sort = screen.getByRole("button", { name: `${DEFAULT_LABELS.sortPage} Bikes` });
      fireEvent.click(sort);
      // Ascending by the page's own values: 3 before 5, and the header says which way it went.
      const cells = screen.getAllByRole("gridcell").map((cell) => cell.textContent);
      expect(cells.indexOf("3")).toBeLessThan(cells.indexOf("5"));
      expect(screen.getByRole("button", { name: `${DEFAULT_LABELS.sortPage} Bikes` }).textContent).toContain("↑");
      // A screen reader hears the direction from the header, the arrow being for the eye.
      expect(sort.closest('[role="columnheader"]')).toHaveAttribute("aria-sort", "ascending");
      fireEvent.click(sort);
      expect(sort.closest('[role="columnheader"]')).toHaveAttribute("aria-sort", "descending");
      expect(screen.getByRole("button", { name: `${DEFAULT_LABELS.sortPage} Name` }).closest('[role="columnheader"]')).not.toHaveAttribute("aria-sort");
    });
  });

  // What a host needs to build a page around the grid instead of a table of its own (T-1432): a way
  // to make a row open something, and the page of rows it is looking at.
  describe("what it hands the host", () => {
    it("lets the host draw the identifier, so a row opens what the page keeps", async () => {
      const opened: string[] = [];
      render(
        <EntityGrid
          config={config}
          source={fixtureSource(bikeEntities)}
          renderers={{
            id: (_cell, row) => (
              <button type="button" onClick={() => opened.push(row.id)}>
                {row.id}
              </button>
            ),
          }}
        />,
      );
      await waitFor(() => expect(screen.getByText("Kamppi")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: bikeEntities[1].id as string }));
      expect(opened).toEqual([bikeEntities[1].id]);
    });

    it("hands over the page it shows, with the offset it starts at", async () => {
      const pages: { ids: string[]; offset: number }[] = [];
      render(
        <EntityGrid
          config={onePerPage}
          source={fixtureSource(bikeEntities)}
          onRows={(rows, offset) => pages.push({ ids: rows.map((row) => row.id), offset })}
        />,
      );
      await waitFor(() => expect(screen.getByText("Kamppi")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: DEFAULT_LABELS.next }));

      // Waited on for its own sake, not for the row to paint (T-2275): the text and the handover are
      // two effects of one render, so asserting after the text can read the call before it happened.
      // This still fails if the handover never comes — `waitFor` ends in the assertion's own failure.
      await waitFor(() =>
        expect(pages.at(-1)).toEqual({ ids: [bikeEntities[1].id], offset: 1 }),
      );
    });
  });
});
