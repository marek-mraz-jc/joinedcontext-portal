import { describe, expect, it } from "vitest";
import { LOCALES, stringsFor } from "./locales";

describe("locales", () => {
  it("says every string in Finnish and English, and falls back to Finnish", () => {
    const keys = (strings: object) => Object.keys(strings).sort();
    expect(keys(LOCALES.en)).toEqual(keys(LOCALES.fi));
    expect(Object.keys(LOCALES.en.kind).sort()).toEqual(Object.keys(LOCALES.fi.kind).sort());
    expect(stringsFor("en-GB").locale).toBe("en");
    expect(stringsFor("sv").locale).toBe("fi");
    expect(stringsFor(undefined).locale).toBe("fi");
  });

  it("counts places the Finnish way", () => {
    expect([1, 3].map(LOCALES.fi.results)).toEqual(["1 paikka", "3 paikkaa"]);
  });
});
