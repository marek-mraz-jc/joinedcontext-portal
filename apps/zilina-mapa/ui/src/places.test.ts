import { describe, expect, it } from "vitest";
import { toRichRow } from "@joinedcontext/sdk";
import { byOrder, featuresOf, matches, placeOf } from "./places";
import { AIR, MONUMENTS, STATIONS } from "./fixtures/verejne";

const monument = (index: number) => placeOf(toRichRow(MONUMENTS[index]), "monument", "sk");
const station = (index: number) => placeOf(toRichRow(STATIONS[index]), "station", "sk");
const air = () => placeOf(toRichRow(AIR[0]), "air", "sk");

describe("placeOf", () => {
  it("reads a monument's register entries and its building, the name capitalised", () => {
    expect(monument(1)).toMatchObject({
      name: "Jezitský kláštor",
      monumentNumber: "1395/1",
      monumentKind: "KLÁŠTOR JEZUITOV",
      address: "Mariánske námestie 158/23, Žilina",
      cadastralArea: "Žilina",
    });
    expect(monument(1).coordinates).not.toBeNull();
  });

  it("keeps a monument without an address without a position", () => {
    expect(monument(0)).toMatchObject({ name: "Trojičný stĺp", address: null, coordinates: null });
  });

  it("reads each pollutant with its own unit and hour, carbon monoxide in mg/m³", () => {
    const station = air();
    expect(station.readings.pm10).toEqual({ value: 32.341, unit: "µg/m³", at: "2026-10-06T18:00:00Z" });
    expect(station.readings.o3).toEqual({ value: 11.8076, unit: "µg/m³", at: "2026-10-05T17:00:00Z" });
    expect(station.readings.co).toEqual({ value: 0.63452, unit: "mg/m³", at: "2026-10-06T18:00:00Z" });
  });

  it("reads a station's trains leaving today", () => {
    expect(STATIONS.map((_, index) => station(index)).find((p) => p.name === "Žilina")?.departures).toBe(166);
  });
});

describe("filters", () => {
  it("finds every word in the name, address, object or style, without diacritics", () => {
    expect(matches(monument(1), "jezuitov")).toBe(true);
    expect(matches(monument(1), "marianske 158")).toBe(true);
    expect(matches(monument(2), "kastiel")).toBe(true);
    expect(matches(monument(0), "marianske")).toBe(false);
    expect(matches(monument(0), "  ")).toBe(true);
  });

  it("orders stations busiest first and the rest by name", () => {
    const stations = STATIONS.map((_, index) => station(index)).sort(byOrder).map((p) => p.name);
    expect(stations[0]).toBe("Žilina");
    expect(stations[1]).toBe("Brodno");
    const monuments = MONUMENTS.map((_, index) => monument(index)).sort(byOrder).map((p) => p.name);
    expect(monuments).toEqual([...monuments].sort((a, b) => (a ?? "").localeCompare(b ?? "", "sk")));
  });

  it("draws only the places with a position, the picked one marked", () => {
    const features = featuresOf([monument(0), monument(1)], monument(1).id).features;
    expect(features).toHaveLength(1);
    expect(features[0].properties).toMatchObject({ picked: true });
  });
});
