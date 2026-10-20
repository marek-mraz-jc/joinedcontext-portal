/**
 * T-4822: which layer sets a type's retention (DM-83, DM-97), the `expiresAt` the output mapper
 * writes for each expiry choice (TS 104 175 4.22, PL-64), and the import's expiry per row.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveCurrent, effectiveHistory, PLATFORM_HISTORY, rulesOf } from "../src/pages/spaces/retention";
import { generate, plusSeconds, preview, problemsOf, readBack, type Attribute, type MapperState } from "../src/pages/pipelines/outputMapper";
import { modeOf, timeFieldOf } from "../src/pages/pipelines/ExpiryChoice";
import { EXPIRES_AT, expiresOf, toEntities } from "../src/pages/spaces/importRows";

describe("the effective retention of a type", () => {
  const rules = [
    { entityType: "Vehicle", current: "PT10M", history: "PT8H" },
    { entityType: "Alert", history: "off" },
    { entityType: "Station", history: "forever", reason: "register" },
    { entityType: "*", history: "P90D" },
  ];

  it("takes the entity's own, then the type's rule, then the space default, then the platform", () => {
    expect(effectiveHistory("Vehicle", rules, "PT1H")).toEqual({ value: "PT1H", layer: "entity" });
    expect(effectiveHistory("Vehicle", rules)).toEqual({ value: "PT8H", layer: "type" });
    expect(effectiveHistory("Sensor", rules)).toEqual({ value: "P90D", layer: "space" });
    expect(effectiveHistory("*", rules)).toEqual({ value: "P90D", layer: "space" });
    expect(effectiveHistory("Sensor", rules.slice(0, 3))).toEqual({ value: PLATFORM_HISTORY, layer: "platform" });
    expect(PLATFORM_HISTORY).toBe("P28D");
  });

  it("holds off and forever at the type, and ignores an entity value that is neither a duration nor off", () => {
    expect(effectiveHistory("Alert", rules)).toEqual({ value: "off", layer: "type" });
    expect(effectiveHistory("Station", rules)).toEqual({ value: "forever", layer: "type" });
    expect(effectiveHistory("Alert", rules, "off")).toEqual({ value: "off", layer: "entity" });
    expect(effectiveHistory("Station", rules, "forever")).toEqual({ value: "forever", layer: "type" });
    expect(effectiveHistory("Station", rules, "soon")).toEqual({ value: "forever", layer: "type" });
  });

  it("keeps current state until deleted unless the entity's expiresAt or the type's rule says otherwise", () => {
    expect(effectiveCurrent("Vehicle", rules)).toEqual({ value: "PT10M", layer: "type" });
    expect(effectiveCurrent("Vehicle", rules, "2026-10-20T10:00:00Z")).toEqual({ value: "2026-10-20T10:00:00Z", layer: "entity" });
    expect(effectiveCurrent("Sensor", rules)).toEqual({ layer: "none" });
    expect(effectiveCurrent("*", rules)).toEqual({ layer: "none" });
  });

  it("reads the rules of a manifest, and none from anything else", () => {
    expect(rulesOf({ spec: { retention: rules } })).toBe(rules);
    expect(rulesOf({ spec: { retention: "P1D" } })).toEqual([]);
    expect(rulesOf({})).toEqual([]);
  });
});

const SPEED: Attribute[] = [{ name: "speed", kind: "Property", valueType: "number", required: false }];
const BUS: MapperState = {
  type: "Vehicle",
  idField: "vehicle",
  attributes: { speed: { field: "speed" } },
  expires: { field: "observedAt", plus: "PT10M" },
};
const RECORDS = [{ vehicle: "1234", speed: "31", observedAt: "2026-10-20T10:00:00Z" }];

describe("the expiry the output mapper writes", () => {
  it("writes the bus recipe, observedAt plus 10 minutes, as the step the runner test runs", () => {
    // The same text the Rust test runs through the pinned Bento (tests/pipeline_expires_tests.rs).
    const fixture = readFileSync(join(__dirname, "..", "..", "tests", "fixtures", "bus-expires.blobl"), "utf8");
    expect(generate(BUS, SPEED, "transport")).toBe(fixture);
    expect(readBack(fixture, SPEED, "transport")).toEqual(BUS);
  });

  it("writes the time of writing when no field is picked, and nothing without a choice", () => {
    const now = generate({ ...BUS, expires: { plus: "PT1H" } }, SPEED, "transport");
    expect(now).toContain("let expires = now().ts_unix()\n");
    expect(now).toContain("($expires + 3600)");
    expect(generate({ ...BUS, expires: undefined }, SPEED, "transport")).not.toContain("expiresAt");
    expect(generate({ ...BUS, expires: { field: "valid to" } }, SPEED, "transport")).toContain('this."valid to".ts_unix()');
  });

  it("reads a while in whole minutes up to 3650 days only", () => {
    expect(plusSeconds(undefined)).toBe(0);
    expect(plusSeconds("PT10M")).toBe(600);
    expect(plusSeconds("P1DT2H")).toBe(93_600);
    for (const bad of ["P", "PT", "PT10S", "P3651D", "10m", "P1Y"]) expect(plusSeconds(bad), bad).toBeUndefined();
  });

  it("previews the expiresAt and names a time field the sample lacks or cannot read", () => {
    expect(preview(BUS, SPEED, RECORDS, "transport", "example.org")[0].expiresAt).toBe("2026-10-20T10:10:00Z");
    const at = Date.parse("2026-10-20T12:00:00Z");
    expect(preview({ ...BUS, expires: {} }, SPEED, RECORDS, "transport", "example.org", at)[0].expiresAt).toBe("2026-10-20T12:00:00Z");
    expect(problemsOf(BUS, SPEED, RECORDS)).toEqual([]);
    expect(problemsOf({ ...BUS, expires: { field: "gone" } }, SPEED, RECORDS)).toEqual([
      { attribute: "expiresAt", kind: "notInSample", field: "gone" },
    ]);
    expect(problemsOf({ ...BUS, expires: { field: "speed" } }, SPEED, RECORDS)).toEqual([
      { attribute: "expiresAt", kind: "notTime", field: "speed", value: "31" },
    ]);
  });

  it("is one choice: an own expiresAt, the pipeline's sweep, or never", () => {
    expect(modeOf(BUS.expires, undefined)).toBe("source");
    expect(modeOf(undefined, { after: "14d", types: ["Vehicle"] })).toBe("stale");
    expect(modeOf(undefined, {})).toBe("never");
    expect(modeOf(undefined, undefined)).toBe("never");
    expect(timeFieldOf(["vehicle", "timestamp", "observedAt"])).toBe("observedAt");
    expect(timeFieldOf(["vehicle", "validTo"])).toBeUndefined();
    expect(timeFieldOf(["vehicle", "lastDate"])).toBe("lastDate");
  });
});

describe("the expiry of imported rows", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const target = { type: "Roadwork", orgDomain: "example.org", space: "city" };
  const table = {
    columns: ["id", "ends"],
    rows: [
      { id: "a", ends: "2026-10-21T08:00:00Z" },
      { id: "b", ends: "" },
      { id: "c", ends: "2026-10-19T08:00:00Z" },
      { id: "d", ends: "tomorrow" },
    ],
  };

  it("writes the column's time, the fixed time where the cell is empty, and refuses a past or unreadable one", () => {
    const fixed = "2026-11-01T00:00:00.000Z";
    const out = toEntities(table, { id: "id", ends: EXPIRES_AT }, [], target, () => "x", fixed, now);
    expect(out.entities.map((item) => [item.entity.id, item.entity.expiresAt])).toEqual([
      ["urn:ngsi-ld:Roadwork:example.org:city:a", "2026-10-21T08:00:00.000Z"],
      ["urn:ngsi-ld:Roadwork:example.org:city:b", fixed],
    ]);
    expect(out.rejected.map((row) => [row.row, row.reason])).toEqual([
      [4, "expiresAt: 2026-10-19T08:00:00.000Z is already past"],
      [5, "expiresAt: `tomorrow` is not a date and time"],
    ]);
  });

  it("writes no expiresAt without a choice", () => {
    const out = toEntities(table, { id: "id" }, [], target, () => "x", undefined, now);
    expect(out.entities.every((item) => item.entity.expiresAt === undefined)).toBe(true);
    expect(expiresOf("", now)).toBeUndefined();
    expect(expiresOf("21.10.2026 08:00", now)).toBeTypeOf("string");
  });
});
