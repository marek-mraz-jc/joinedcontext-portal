import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CellView, cellDisplayText, columnKind, formatDate, kindOfCell, structuredText, targetName } from "../src/grid/cells";
import { toRichCell } from "../src/grid/model";

const labels = { yes: "Yes", no: "No", points: "points", openTarget: "Open" };
const cell = (attr: unknown) => toRichCell(attr, "en") ?? undefined;

describe("cells by what they hold (T-4827)", () => {
  it("a number reads in the locale with its unit's symbol, the unit's name on hover", () => {
    const c = cell({ type: "Property", value: 1234.5, unitCode: "GQ" });
    expect(kindOfCell(c)).toBe("number");
    expect(cellDisplayText(c, "en", labels)).toBe("1,234.5 µg/m³");
    expect(cellDisplayText(c, "fi", labels)).toBe("1 234,5 µg/m³");
    render(<CellView cell={c} locale="en" labels={labels} />);
    expect(screen.getByText("1,234.5 µg/m³")).toHaveAttribute("title", expect.stringContaining("GQ"));
  });

  it("a timestamp reads in local time with the stored value as its title; a bare date stays that day", () => {
    const c = cell({ type: "Property", value: "2026-10-01T08:30:00Z" });
    expect(kindOfCell(c)).toBe("datetime");
    const shown = formatDate("2026-10-01T08:30:00Z", "en");
    expect(shown).not.toContain("T08");
    render(<CellView cell={c} locale="en" labels={labels} />);
    expect(screen.getByText(shown)).toHaveAttribute("title", "2026-10-01T08:30:00Z");
    expect(formatDate("2026-10-01", "en")).toBe("Oct 1, 2026");
    expect(formatDate("not a date", "en")).toBe("not a date");
  });

  it("a structured value is key: value pairs, never JSON", () => {
    const c = cell({ type: "Property", value: { start: "2026-10-01", end: "2026-10-31", n: 3 } });
    expect(kindOfCell(c)).toBe("structured");
    const text = cellDisplayText(c, "en", labels);
    expect(text).toBe("start: Oct 1, 2026 · end: Oct 31, 2026 · n: 3");
    expect(text).not.toMatch(/[{}"]/);
    expect(structuredText({ streetAddress: "Mannerheimintie 1", postalCode: "00100", addressLocality: "Helsinki" }, "en", labels)).toBe(
      "Mannerheimintie 1, 00100 Helsinki",
    );
    expect(structuredText({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 }, "en", labels)).toMatch(/ · …$/);
  });

  it("a point is its coordinates, latitude first; another shape its type and point count", () => {
    const point = cell({ type: "GeoProperty", value: { type: "Point", coordinates: [24.9384, 60.1699] } });
    expect(kindOfCell(point)).toBe("geo");
    expect(cellDisplayText(point, "en", labels)).toBe("60.16990, 24.93840");
    const polygon = cell({
      type: "GeoProperty",
      value: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    });
    expect(cellDisplayText(polygon, "en", labels)).toBe("Polygon, 4 points");
  });

  it("a relationship is a chip naming its target, the URN only in its title, and it opens the target", () => {
    const c = cell({ type: "Relationship", object: "urn:ngsi-ld:Organization:helsinki:kpi:unit-12" });
    const onOpen = vi.fn();
    render(<CellView cell={c} locale="en" labels={labels} onOpen={onOpen} />);
    const chip = screen.getByRole("button", { name: "Open: Organization · unit-12" });
    expect(chip).toHaveTextContent(/^unit-12$/);
    expect(chip).toHaveAttribute("title", "urn:ngsi-ld:Organization:helsinki:kpi:unit-12");
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledWith("urn:ngsi-ld:Organization:helsinki:kpi:unit-12");
    expect(targetName("not-a-urn")).toEqual({ name: "not-a-urn" });
  });

  it("without a way to open it a chip is a label, not a button", () => {
    const c = cell({ type: "Relationship", object: ["urn:ngsi-ld:Stop:a", "urn:ngsi-ld:Stop:b"] });
    render(<CellView cell={c} locale="en" labels={labels} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("a")).toHaveAttribute("title", "urn:ngsi-ld:Stop:a");
    expect(screen.getByText("b")).toBeInTheDocument();
  });

  it("a language property reads in the asked language; a boolean as yes or no", () => {
    const name = toRichCell({ type: "LanguageProperty", languageMap: { fi: "Kauppatori", en: "Market Square" } }, "fi") ?? undefined;
    expect(kindOfCell(name)).toBe("language");
    expect(cellDisplayText(name, "fi", labels)).toBe("Kauppatori");
    expect(cellDisplayText(cell({ type: "Property", value: false }), "en", labels)).toBe("No");
  });

  it("an empty or unknown cell draws nothing and is text", () => {
    expect(cellDisplayText(undefined, "en", labels)).toBe("");
    expect(kindOfCell(undefined)).toBeUndefined();
    expect(columnKind([undefined, undefined])).toBe("text");
    expect(columnKind([], "integer")).toBe("number");
    expect(columnKind([], undefined, true)).toBe("relationship");
    expect(cellDisplayText(cell({ type: "Property", value: null }), "en", labels)).toBe("");
    const { container } = render(<CellView cell={undefined} locale="en" labels={labels} />);
    expect(container.textContent).toBe("");
  });

  it("markup in a value is shown as text, never parsed", () => {
    const c = cell({ type: "Property", value: { note: "<img src=x onerror=alert(1)>" } });
    const { container } = render(<CellView cell={c} locale="en" labels={labels} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
