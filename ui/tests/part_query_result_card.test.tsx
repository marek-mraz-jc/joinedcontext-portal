/**
 * T-1838: what the assistant read from an endpoint, against the UI contract (UI-01, UI-11,
 * UI-16, UI-27, AG-46, AG-75, PF-50).
 *
 * The gateway wrote the answer and the model chose the call, so every value on this card is
 * data. What it owns: the three shapes an answer takes, the caps that keep a ten-row answer a
 * card rather than a page, and — the reason this task exists — a table that is the shared one,
 * so its header scope, its caption and its sideways scroll are the same as every other table in
 * the Portal, and a keyboard can drive that scroll.
 */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import {
  MAX_ATTRIBUTES,
  MAX_ROWS,
  QueryResultCard,
  textOf,
  viewOf,
} from "../src/pages/apps/QueryResultCard";
import { expectNoAxeViolations, inEveryLocale, renderPart } from "./page_contract";

function entity(index: number, extra: Record<string, unknown> = {}) {
  return {
    id: `urn:ngsi-ld:AirQualityObserved:helsinki:mobility:station-${index}`,
    type: "AirQualityObserved",
    pm10: { type: "Property", value: 21 + index },
    name: { type: "Property", value: `Station ${index}` },
    ...extra,
  };
}

function card(entities: unknown[]) {
  return {
    endpoint: "air-public",
    tool: "queryEntities",
    argument: "type: AirQualityObserved",
    view: viewOf(entities),
  };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

describe("the card of a query answer", () => {
  it("names the endpoint, the tool and the argument that matters", () => {
    renderPart(<QueryResultCard result={card([entity(0)])} />);
    expect(screen.getByText("air-public · queryEntities")).toBeInTheDocument();
    expect(screen.getByText("type: AirQualityObserved")).toBeInTheDocument();
  });

  // UI-01: the shared Table. Its caption is what names it to a screen reader, and its frame is
  // one focusable, named stop so a keyboard can scroll the columns a phone cannot show (UI-27).
  it("draws the rows in the shared table, named and reachable by keyboard", async () => {
    const { container } = renderPart(<QueryResultCard result={card([entity(0), entity(1)])} />);
    const table = screen.getByRole("table", { name: en.assistant.query.caption });
    expect(within(table).getAllByRole("columnheader")[0]).toHaveTextContent(en.assistant.query.id);
    for (const header of within(table).getAllByRole("columnheader")) {
      expect(header).toHaveAttribute("scope", "col");
    }
    const frame = screen.getByRole("group", { name: en.assistant.query.caption });
    expect(frame).toHaveAttribute("tabindex", "0");
    await expectNoAxeViolations(container);
  });

  // The entity's name is its last URN segment: a person reads "station-0", never the whole urn.
  it("reads an entity by the last segment of its id", () => {
    renderPart(<QueryResultCard result={card([entity(0)])} />);
    expect(screen.getByText("station-0")).toBeInTheDocument();
    expect(screen.queryByText(/urn:ngsi-ld/)).not.toBeInTheDocument();
  });

  // The caps: ten rows and five attributes, and the count says how much was left out.
  it("draws at most ten rows and says how many there are", () => {
    const many = Array.from({ length: 25 }, (_, index) => entity(index));
    renderPart(<QueryResultCard result={card(many)} />);
    const table = screen.getByRole("table", { name: en.assistant.query.caption });
    expect(table.querySelectorAll("tbody tr")).toHaveLength(MAX_ROWS);
    expect(
      screen.getByText(
        en.assistant.query.someRows.replace("{shown}", String(MAX_ROWS)).replace("{total}", "25"),
      ),
    ).toBeInTheDocument();
  });

  it("draws at most five attributes", () => {
    const wide = [
      entity(0, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`attr${i}`, i]))),
    ];
    renderPart(<QueryResultCard result={card(wide)} />);
    const table = screen.getByRole("table", { name: en.assistant.query.caption });
    // The entity column plus the capped attributes.
    expect(within(table).getAllByRole("columnheader")).toHaveLength(MAX_ATTRIBUTES + 1);
  });

  // An answer that is one object is a list of fields, and one that is neither is its text.
  it("draws a single object as a list of fields", () => {
    renderPart(
      <QueryResultCard result={{ endpoint: "e", tool: "t", view: viewOf({ count: 42 }) }} />,
    );
    expect(screen.getByText("count")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("draws text that is not JSON as itself", () => {
    renderPart(
      <QueryResultCard
        result={{ endpoint: "e", tool: "t", view: viewOf({ content: [{ text: "no entities" }] }) }}
      />,
    );
    expect(screen.getByText("no entities")).toBeInTheDocument();
  });

  // AG-46, PF-50: the gateway wrote every value here, so every value is drawn as text.
  it("renders a value that arrived as markup as text", () => {
    renderPart(
      <QueryResultCard
        result={card([entity(0, { name: { type: "Property", value: "<img src=x onerror=alert(1)>" } })])}
      />,
    );
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("renders a column name that arrived as markup as text", () => {
    renderPart(
      <QueryResultCard result={card([entity(0, { "<script>": { type: "Property", value: 1 } })])} />,
    );
    expect(screen.getByText("<script>")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });

  it("says how many rows in every language", async () => {
    await inEveryLocale(async (locale) => {
      cleanup();
      renderPart(<QueryResultCard result={card([entity(0), entity(1)])} />);
      expect(
        screen.getByRole("table", { name: i18n.t("assistant.query.caption") }),
        `the table has no caption in ${locale}`,
      ).toBeInTheDocument();
      expect(
        screen.getByText(i18n.t("assistant.query.rows", { count: 2 })),
      ).toBeInTheDocument();
    });
  });

  it("has no axe violations for each shape an answer takes", async () => {
    for (const view of [
      viewOf([entity(0)]),
      viewOf({ count: 42 }),
      viewOf({ content: [{ text: "no entities" }] }),
    ]) {
      cleanup();
      const { container } = renderPart(
        <QueryResultCard result={{ endpoint: "e", tool: "t", view }} />,
      );
      await expectNoAxeViolations(container);
    }
  });
});

// T-2460: "what alerts are there?" drew ten rows each carrying a road's MultiLineString, hundreds
// of coordinates, and the table's width went with them.
describe("a value as words (T-2760)", () => {
  it("reads a language map in the reader's language, then English, then any", () => {
    const name = { languageMap: { fi: "Kauppatori", en: "Market Square" } };
    expect(textOf(name, "fi")).toBe("Kauppatori");
    expect(textOf(name, "de")).toBe("Market Square");
    expect(textOf({ languageMap: { sv: "Salutorget" } }, "de")).toBe("Salutorget");
  });

  it("reads a list and a structured value without braces or quotes", () => {
    expect(textOf(["a", 2, true])).toBe("a, 2, true");
    expect(textOf({ streetAddress: "Pohjoisesplanadi 11", addressLocality: "Helsinki" })).toBe(
      "streetAddress: Pohjoisesplanadi 11; addressLocality: Helsinki",
    );
    expect(textOf({ value: { languageMap: { en: "x" } } }, "en")).toBe("x");
    expect(textOf({})).toBe("");
    expect(textOf([])).toBe("");
  });
});

describe("a wide value in the card (T-2460)", () => {
  const line = Array.from({ length: 400 }, (_, i) => [24.9 + i * 0.001, 60.1 + i * 0.0005]);
  const alert = (index: number, extra: Record<string, unknown> = {}) =>
    entity(index, {
      location: { type: "GeoProperty", value: { type: "MultiLineString", coordinates: [line, [[25.5, 60], [25.6, 60.4]]] } },
      ...extra,
    });

  it("draws a geometry as its type and where it is, never its coordinates", () => {
    renderPart(<QueryResultCard result={card([alert(0)])} />);
    const table = screen.getByRole("table", { name: en.assistant.query.caption });
    expect(within(table).getByText("MultiLineString [24.9, 60 … 25.6, 60.4]")).toBeInTheDocument();
    expect(table.textContent ?? "").not.toMatch(/\[\[/);
    expect((table.textContent ?? "").length).toBeLessThan(400);
  });

  it("reads a point by its position and a geometry the Portal folded by its box", () => {
    const view = viewOf([
      entity(0, { near: { type: "GeoProperty", value: { type: "Point", coordinates: [24.93545, 60.16952] } } }),
      entity(1, { near: { type: "GeoProperty", value: { type: "Polygon", bbox: [24.9, 60.1, 25, 60.2], positions: 90 } } }),
    ]);
    if (view.kind !== "table") throw new Error("a table");
    const near = view.columns.indexOf("near");
    expect(view.rows[0].cells[near]).toBe("Point [24.9355, 60.1695]");
    expect(view.rows[1].cells[near]).toBe("Polygon [24.9, 60.1 … 25, 60.2]");
  });

  it("folds a very long value inside its cell instead of widening the column", () => {
    const long = "x".repeat(4000);
    renderPart(<QueryResultCard result={card([alert(0, { description: { type: "Property", value: long } })])} />);
    const cell = screen.getByTitle(long);
    const fold = cell.querySelector("span");
    expect(fold, "the value sits in a block that can be clamped").not.toBeNull();
    expect(fold?.className).toMatch(/\bmax-w-48\b/);
    expect(fold?.className).toMatch(/\btruncate\b/);
  });

  it("says the size of the whole set when the answer is one page of it", () => {
    renderPart(
      <QueryResultCard
        result={{ endpoint: "helsinki-alerts", tool: "query_entities", view: viewOf({ entities: [alert(0), alert(1)], total: 20, nextCursor: 2 }) }}
      />,
    );
    expect(
      screen.getByText(en.assistant.query.someRows.replace("{shown}", "2").replace("{total}", "20")),
    ).toBeInTheDocument();
  });
});
