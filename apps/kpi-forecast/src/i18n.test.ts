import { describe, expect, it } from "vitest";
import { duration, langOf, moment, percent, t, value } from "./i18n";

describe("words and numbers", () => {
  it("takes the language from the address, else the browser", () => {
    expect(langOf("?lang=en", ["fi-FI"])).toBe("en");
    expect(langOf("", ["sv-FI"])).toBe("fi");
    expect(langOf("?lang=de", ["de-DE"])).toBe("en");
  });

  it("writes values, changes and moments the Finnish way and the English way", () => {
    expect(value("fi", 3848)).toBe("3 848");
    expect(value("en", 8.897)).toBe("8.9");
    expect(value("fi", 0.12345)).toBe("0,123");
    expect(percent("en", 0.035)).toBe("+3.5%");
    expect(percent("fi", -0.5)).toMatch(/^[−-]50\s?%$/);
    expect(moment("fi", Date.UTC(2030, 9, 3, 9, 0))).toBe("3.10.2030 klo 12.00");
    expect(moment("en", Date.UTC(2030, 9, 3, 9, 0))).toBe("3 Oct 2030, 12:00");
  });

  it("names a step in the unit that reads well", () => {
    expect(duration("en", 3_600_000)).toBe("60 min");
    expect(duration("fi", 6 * 3_600_000)).toBe("6 h");
    expect(duration("en", 86_400_000 * 2)).toBe("2 d");
  });

  it("fills its slots and leaves a missing one visible", () => {
    expect(t("en", "days", { n: 30 })).toBe("30 days");
    expect(t("en", "days")).toBe("{n} days");
  });
});
