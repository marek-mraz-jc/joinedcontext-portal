import { describe, expect, it } from "vitest";
import type { Row } from "@joinedcontext/sdk";
import { STATIONS } from "./fixtures/stations";
import { bikes, hasBikes, isEmpty, totals } from "./stations";

const row = (availableBikeNumber: unknown): Row => ({ id: "urn:x", type: "BikeHireDockingStation", availableBikeNumber }) as Row;

describe("stations", () => {
  // AP-07: the tiles count what the feed says, and a station that says nothing is not empty.
  it("totals the five sampled stations", () => {
    expect(totals(STATIONS)).toEqual({ stations: 5, bikes: 15, empty: 2 });
    expect(totals([])).toEqual({ stations: 0, bikes: 0, empty: 0 });
  });

  it("reads a missing, negative or non-numeric count as unknown", () => {
    for (const value of [undefined, null, -1, "3", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(bikes(row(value)), String(value)).toBeNull();
      expect(isEmpty(row(value)), String(value)).toBe(false);
      expect(hasBikes(row(value)), String(value)).toBe(false);
    }
    expect(isEmpty(row(0))).toBe(true);
    expect(hasBikes(row(1))).toBe(true);
  });
});
