import { describe, expect, it } from "vitest";
import { LOCALES, stringsFor } from "./locales";

describe("locales", () => {
  it("says every string in Slovak and English, and falls back to Slovak", () => {
    const keys = (strings: object) => Object.keys(strings).sort();
    expect(keys(LOCALES.en)).toEqual(keys(LOCALES.sk));
    expect(Object.keys(LOCALES.en.category).sort()).toEqual(Object.keys(LOCALES.sk.category).sort());
    expect(stringsFor("en-GB").locale).toBe("en");
    expect(stringsFor("fi").locale).toBe("sk");
    expect(stringsFor(undefined).locale).toBe("sk");
  });

  it("counts places the Slovak way", () => {
    expect([1, 3, 5].map(LOCALES.sk.results)).toEqual(["1 miesto", "3 miesta", "5 miest"]);
  });
});
