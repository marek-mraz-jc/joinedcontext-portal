/**
 * The filter panel as a query (T-4883): each operator per kind, AND/OR, nested groups and the
 * search box, as the `q` the endpoint receives. A table, so an operator nobody listed shows up.
 */
import { describe, expect, it } from "vitest";
import { queryFromGroup, searchQuery } from "../src/grid/filters";
import type { FilterColumn, FilterGroup } from "../src/grid/filters";

const COLUMNS: FilterColumn[] = [
  { key: "name", attr: "name", kind: "text" },
  { key: "seats", attr: "seats", kind: "number" },
  { key: "startDate", attr: "startDate", kind: "date" },
  { key: "category", attr: "category", kind: "enum" },
  { key: "refPlace", attr: "refPlace", kind: "relationship" },
  { key: "startDate:observedAt", attr: "startDate", meta: "observedAt", kind: "date" },
  { key: "id", attr: null, kind: "id" },
];

const one = (key: string, filter: object) =>
  queryFromGroup(COLUMNS, { join: "and", conditions: [{ key, filter: filter as never }] });

describe("one condition per operator", () => {
  it.each([
    ["name", { op: "contains", value: "a.b" }, 'name~="a\\.b"'],
    ["name", { op: "equals", value: "Café" }, 'name=="Café"'],
    ["name", { op: "notEquals", value: "x" }, 'name!="x"'],
    ["name", { op: "empty", value: "" }, "!name"],
    ["name", { op: "present", value: "" }, "name"],
    ["seats", { op: "gt", value: "10" }, "seats>10"],
    ["seats", { op: "gte", value: "10" }, "seats>=10"],
    ["seats", { op: "lt", value: "10" }, "seats<10"],
    ["seats", { op: "lte", value: "10" }, "seats<=10"],
    ["seats", { op: "between", value: "1", value2: "5" }, "seats>=1;seats<=5"],
    ["startDate", { op: "gte", value: "2026-10-20T00:00:00Z" }, "startDate>=2026-10-20T00:00:00Z"],
    ["category", { op: "anyOf", value: "", values: ["music", "10"] }, 'category=="music","10"'],
    ["refPlace", { op: "equals", value: "urn:ngsi-ld:Place:1" }, 'refPlace=="urn:ngsi-ld:Place:1"'],
    ["startDate:observedAt", { op: "lt", value: "2026-01-01" }, "startDate.observedAt<2026-01-01"],
  ])("%s %o -> %s", (key, filter, q) => {
    expect(one(key, filter)).toBe(q);
  });

  it("leaves out a condition still being typed, an unknown column and the id", () => {
    expect(one("seats", { op: "gt", value: " " })).toBeUndefined();
    expect(one("nope", { op: "present", value: "" })).toBeUndefined();
    expect(one("id", { op: "pattern", value: "x" })).toBeUndefined();
  });

  it("keeps a quote in a value data", () => {
    expect(one("name", { op: "equals", value: 'a";b' })).toBe('name=="a\\";b"');
    expect(one("name", { op: "contains", value: 'a"|b' })).toBe('name~="a\\"\\|b"');
  });
});

describe("AND, OR and groups", () => {
  it("joins by ; and | and puts composite terms in parentheses", () => {
    const group: FilterGroup = {
      join: "or",
      conditions: [
        { key: "name", filter: { op: "present", value: "" } },
        { key: "seats", filter: { op: "between", value: "1", value2: "5" } },
        {
          join: "and",
          conditions: [
            { key: "category", filter: { op: "anyOf", value: "", values: ["music"] } },
            { key: "seats", filter: { op: "gt", value: "100" } },
          ],
        },
      ],
    };
    expect(queryFromGroup(COLUMNS, group)).toBe('name|(seats>=1;seats<=5)|(category=="music";seats>100)');
    expect(queryFromGroup(COLUMNS, { ...group, join: "and" })).toBe('name;(seats>=1;seats<=5);(category=="music";seats>100)');
  });

  it("drops an empty group and does not wrap a lone term", () => {
    expect(queryFromGroup(COLUMNS, { join: "or", conditions: [] })).toBeUndefined();
    expect(
      queryFromGroup(COLUMNS, {
        join: "or",
        conditions: [{ join: "and", conditions: [] }, { key: "seats", filter: { op: "between", value: "1", value2: "2" } }],
      }),
    ).toBe("seats>=1;seats<=2");
  });
});

describe("search", () => {
  it("asks every named attribute, case-insensitively, with the text escaped", () => {
    expect(searchQuery("  ", ["name"])).toBeUndefined();
    expect(searchQuery("x", [])).toBeUndefined();
    expect(searchQuery("café", ["name"])).toBe('name~="(?i)café"');
    expect(searchQuery('a.(b"', ["name", "description"])).toBe(
      '(name~="(?i)a\\.\\(b\\""|description~="(?i)a\\.\\(b\\"")',
    );
  });
});
