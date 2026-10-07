import { describe, expect, it } from "vitest";
import { toRichRow } from "@joinedcontext/sdk";
import { byOrder, featuresOf, matches, placeOf, safeUrl } from "./places";
import { HOSPITALS, ORGANIZATIONS, SOCIAL } from "./fixtures/registre";

const hospital = (i: number) => placeOf(toRichRow(HOSPITALS[i]), "hospital", "sk");
const social = (i: number) => placeOf(toRichRow(SOCIAL[i]), "social", "sk");
const organization = (i: number) => placeOf(toRichRow(ORGANIZATIONS[i]), "organization", "sk");

describe("placeOf", () => {
  it("reads a hospital's kind, operator, specialties and position", () => {
    expect(hospital(0)).toMatchObject({
      name: "Fakultná nemocnica s poliklinikou F. D. Roosevelta",
      category: "general",
      specialties: ["chirurgia", "interná medicína", "pediatria"],
      coordinates: [19.1386, 48.7432],
    });
  });

  it("reads a social service's form, capacity, provider and district, and keeps missing values missing", () => {
    expect(social(0)).toMatchObject({ category: "residentialYearRound", capacity: 48, provider: "regionFounded", district: "Rimavská Sobota" });
    expect(social(1)).toMatchObject({ capacity: null, serviceKind: null, coordinates: null, url: null });
    expect(hospital(1)).toMatchObject({ operator: null, specialties: [] });
  });

  it("never opens a link that is not http or https", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(social(0).url).toBe("https://www.dsstisovec.sk/");
  });
});

describe("search and order", () => {
  it("finds words in the name, address, district or kind of service, without diacritics", () => {
    expect(matches(social(0), "rimavska")).toBe(true);
    expect(matches(social(0), "domov socialnych")).toBe(true);
    expect(matches(organization(1), "muzeum")).toBe(false);
  });

  it("orders by name and draws only what has a position", () => {
    const sorted = [organization(1), hospital(1), organization(0)].sort(byOrder).map((p) => p.name);
    expect(sorted).toEqual(["Nemocnica Zvolen", "Spojená škola Detva", "Stredoslovenské múzeum"]);
    expect(featuresOf([hospital(0), social(0), organization(1)], null).features).toHaveLength(1);
  });
});
