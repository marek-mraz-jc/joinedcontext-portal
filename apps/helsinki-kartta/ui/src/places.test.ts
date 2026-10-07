import { describe, expect, it } from "vitest";
import { toRichRow } from "@joinedcontext/sdk";
import { byOrder, featuresOf, kindOf, matches, placeOf, safeUrl } from "./places";
import { SERVICES, WATER } from "./fixtures/helsinki";

const service = (i: number, locale = "fi") => {
  const row = toRichRow(SERVICES[i]);
  return placeOf(row, kindOf(row, "PointOfInterest")!, locale);
};
const sensor = (i: number) => placeOf(toRichRow(WATER[i]), "water", "fi");

describe("kinds", () => {
  it("are the register's category, nothing for one the map does not show, and water for a sensor", () => {
    expect([0, 1, 2, 3, 4].map((i) => kindOf(toRichRow(SERVICES[i]), "PointOfInterest"))).toEqual(["library", "healthStation", "swimmingHall", "beach", "school"]);
    expect(kindOf(toRichRow(SERVICES[5]), "PointOfInterest")).toBeNull();
    expect(kindOf(toRichRow(WATER[0]), "WaterQualityObserved")).toBe("water");
  });
});

describe("placeOf", () => {
  it("reads the name in the reader's language, else Finnish", () => {
    expect(service(0, "en").name).toBe("Central Library Oodi");
    expect(service(0, "sv").name).toBe("Centrumbiblioteket Ode");
    expect(service(1, "en").name).toBe("Kallion terveysasema");
  });

  it("reads a sensor's temperature, time and place, and keeps a missing reading missing", () => {
    expect(sensor(0)).toMatchObject({ temperature: 16.4, observedAt: "2026-08-15T09:00:00Z", refPlace: expect.stringContaining(":hietaniemi") });
    expect(sensor(1)).toMatchObject({ temperature: null, observedAt: null, refPlace: null });
  });

  it("never opens a link that is not http or https", () => {
    expect(service(4).url).toBeNull();
    expect(service(0).url).toBe("https://www.oodihelsinki.fi/");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("search and order", () => {
  it("finds every word in the name or address, without diacritics", () => {
    expect(matches(service(2), "yrjonkadun uimahalli")).toBe(true);
    expect(matches(service(0), "toolonlahdenkatu")).toBe(true);
    expect(matches(service(1), "oodi")).toBe(false);
  });

  it("orders by Finnish name and draws only what has a position", () => {
    expect([service(2), service(0), service(1)].sort(byOrder).map((p) => p.name)).toEqual(["Kallion terveysasema", "Keskustakirjasto Oodi", "Yrjönkadun uimahalli"]);
    expect(featuresOf([service(0), service(4)], null).features).toHaveLength(1);
  });
});
