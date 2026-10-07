import { describe, expect, it } from "vitest";
import { toRichRow } from "@joinedcontext/sdk";
import { byOrder, featuresOf, kindOf, matches, placeOf, safeUrl } from "./places";
import { ISLES, POIS } from "./fixtures/praha";

const poi = (i: number) => toRichRow(POIS[i]);
const place = (i: number) => placeOf(poi(i), kindOf(poi(i), "PointOfInterest")!, "cs");

describe("kinds", () => {
  it("are the point of interest's category, and nothing for a category the map does not show", () => {
    expect([0, 1, 2, 3].map((i) => kindOf(poi(i), "PointOfInterest"))).toEqual(["school", "culture", "publicToilet", "ticketSale"]);
    expect(kindOf(poi(4), "PointOfInterest")).toBeNull();
    expect(kindOf(toRichRow(ISLES[0]), "WasteContainerIsle")).toBe("waste");
  });
});

describe("placeOf", () => {
  it("reads each kind's own fields and keeps a missing value missing", () => {
    expect(place(0)).toMatchObject({ name: "Základní škola Vodičkova", pupils: 410, facilityType: "základní škola", coordinates: [14.4232, 50.0807] });
    expect(place(2)).toMatchObject({ openingHours: "6:00–22:00", wheelchairAccessible: true });
    expect(place(3)).toMatchObject({ wheelchairAccessible: false, address: null, openingHours: null });
    expect(placeOf(toRichRow(ISLES[1]), "waste", "cs")).toMatchObject({ stationCode: "0002/ 004", access: "residents" });
  });

  it("never opens a link that is not http or https", () => {
    expect(place(5).url).toBeNull();
    expect(place(1).url).toBe("https://www.narodni-divadlo.cz/");
    expect(safeUrl("data:text/html,x")).toBeNull();
  });
});

describe("search and order", () => {
  it("finds every word in the name, address, kind or point code, without diacritics", () => {
    expect(matches(place(1), "narodni divadlo")).toBe(true);
    expect(matches(place(0), "zakladni skola praha 1")).toBe(true);
    expect(matches(placeOf(toRichRow(ISLES[0]), "waste", "cs"), "0001")).toBe(true);
    expect(matches(place(2), "divadlo")).toBe(false);
  });

  it("orders by Czech name and draws only what has a position", () => {
    expect([place(2), place(1), place(0)].sort(byOrder).map((p) => p.name)).toEqual(["Národní divadlo", "Veřejné WC Anděl", "Základní škola Vodičkova"]);
    expect(featuresOf([place(1), place(5)], null).features).toHaveLength(1);
  });
});
