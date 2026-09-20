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
