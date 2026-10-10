import { describe, expect, it } from "vitest";
import { day, hourOfWeek, langOf, number, subCategory, t } from "./i18n";

describe("the App's language", () => {
  it("takes the address first, then a Finnish or Swedish browser, else English", () => {
    expect(langOf("?lang=en", ["fi-FI"])).toBe("en");
    expect(langOf("?lang=xx", ["sv-FI"])).toBe("fi");
    expect(langOf("", ["de-DE", "fi"])).toBe("fi");
    expect(langOf("", ["en-US"])).toBe("en");
    expect(langOf("", [])).toBe("en");
  });

  it("writes numbers, days and hours as Helsinki does", () => {
    expect(number("fi", 1234)).toBe("1 234");
    expect(number("en", 1234)).toBe("1,234");
    // 21:30 UTC on 7 October is already the 8th in Helsinki.
    expect(day("fi", Date.parse("2030-10-07T21:30:00Z"))).toBe("8.10.2030");
    expect(day("en", Date.parse("2030-10-07T21:30:00Z"))).toBe("8 Oct 2030");
    expect(hourOfWeek("fi", 0, 7)).toBe("maanantai klo 7–8");
    expect(hourOfWeek("en", 6, 23)).toBe("Sunday 23:00–00:00");
  });

  it("names the known kinds and keeps an unknown code readable", () => {
    expect(subCategory("fi", "ROAD_WORK")).toBe("Tietyö");
    expect(subCategory("en", "NEW_KIND")).toBe("NEW_KIND");
    expect(subCategory("en", "")).toBe("Other");
    expect(t("en", "unlocated", { n: 3 })).toBe("3 alerts have no location and are not on the map.");
  });

  it("writes one alert in the singular and any other count in the plural", () => {
    expect(t("en", "summaryNoTime", { kept: "1", hot: "1" })).toBe("1 alert. Most in one hexagon: 1.");
    expect(t("en", "summaryNoTime", { kept: "2", hot: "1" })).toBe("2 alerts. Most in one hexagon: 1.");
    expect(t("fi", "summaryNoTime", { kept: "1", hot: "1" })).toBe("1 tiedote. Eniten kuusikulmiossa: 1 tiedote.");
    expect(t("fi", "summaryNoTime", { kept: "1 234", hot: "11" })).toBe("1 234 tiedotetta. Eniten kuusikulmiossa: 11 tiedotetta.");
    expect(t("en", "unlocated", { n: "1" })).toBe("1 alert has no location and is not on the map.");
    expect(t("en", "unlocated", { n: "0" })).toBe("0 alerts have no location and are not on the map.");
    expect(t("fi", "unlocated", { n: "1" })).toBe("1 tiedotteella ei ole sijaintia, eikä sitä näy kartalla.");
    expect(t("en", "hexLine", { count: "1" })).toBe("1 alert in this hexagon");
    expect(t("en", "placeLine", { count: "1", radius: "0" })).toBe("1 alert within 0 m");
    expect(t("fi", "reportLine", { kept: "1", when: "8.10.2030" })).toBe("1 tiedote, tallennettu 8.10.2030");
  });
});
