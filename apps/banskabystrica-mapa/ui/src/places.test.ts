import { describe, expect, it } from "vitest";
import { toRichRow } from "@joinedcontext/sdk";
import { byOrder, featuresOf, matches, placeOf, safeUrl, upcoming } from "./places";
import { AIR, EVENTS, SCHOOLS } from "./fixtures/verejne";

const event = (index: number) => placeOf(toRichRow(EVENTS[index]), "event", "sk");
const school = (index: number) => placeOf(toRichRow(SCHOOLS[index]), "school", "sk");

describe("placeOf", () => {
  it("reads an event's name, days, time, category, address and position", () => {
    expect(event(0)).toMatchObject({
      name: "Radvanský jarmok",
      startDate: "2026-10-08",
      endDate: "2026-10-10",
      startTime: "09:00:00",
      category: "other",
      address: "Námestie SNP, Banská Bystrica",
      url: "https://www.banskabystrica.sk/podujatia/radvansky-jarmok",
      coordinates: [19.1459, 48.7357],
    });
  });

  it("keeps a missing value missing: no position, no pupils, no link", () => {
    expect(event(2).coordinates).toBeNull();
    expect(school(1).pupils).toBeNull();
    expect(school(1).language).toBeNull();
    expect(placeOf(toRichRow(AIR[0]), "air", "sk")).toMatchObject({ pm10: 21.4, pm25: null });
  });

  it("never opens a link that is not http or https", () => {
    expect(event(1).url).toBeNull();
    expect(safeUrl("ftp://example.org/a")).toBeNull();
    expect(safeUrl("not a url")).toBeNull();
    expect(safeUrl("https://example.org/a")).toBe("https://example.org/a");
  });
});

describe("filters", () => {
  it("keeps events from today on, and every other kind", () => {
    expect(upcoming(event(0), "2026-10-09")).toBe(true);
    expect(upcoming(event(0), "2026-10-11")).toBe(false);
    expect(upcoming(event(1), "2026-10-06")).toBe(false);
    expect(upcoming(school(0), "2030-01-01")).toBe(true);
  });

  it("finds every word of the search in the name or address, without diacritics", () => {
    expect(matches(school(0), "zakladna skola")).toBe(true);
    expect(matches(school(0), "moyzesova 18")).toBe(true);
    expect(matches(school(1), "moyzesova")).toBe(false);
    expect(matches(school(1), "   ")).toBe(true);
  });

  it("orders events by their first day and the rest by name", () => {
    const sorted = [school(1), event(2), event(0), school(0)].sort(byOrder).map((p) => p.name);
    expect(sorted.slice(0, 2)).toEqual(["Radvanský jarmok", "Výstava fotografií"]);
  });

  it("draws only the places with a position, the picked one marked", () => {
    const features = featuresOf([event(0), event(2)], event(0).id).features;
    expect(features).toHaveLength(1);
    expect(features[0].properties).toMatchObject({ picked: true });
  });
});
