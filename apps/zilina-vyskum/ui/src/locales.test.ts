import { describe, expect, it } from "vitest";
import { LOCALES, stringsFor } from "./locales";

describe("locales", () => {
  it("says every string in Slovak and English, and falls back to Slovak", () => {
    const keys = (strings: object) => Object.keys(strings).sort();
    expect(keys(LOCALES.en)).toEqual(keys(LOCALES.sk));
    expect(keys(LOCALES.en.kind)).toEqual(keys(LOCALES.sk.kind));
    expect(keys(LOCALES.en.language)).toEqual(keys(LOCALES.sk.language));
    expect(stringsFor("en-US").locale).toBe("en");
    expect(stringsFor(undefined).locale).toBe("sk");
  });

  it("counts works the Slovak way", () => {
    expect([1, 3, 251].map(LOCALES.sk.works)).toEqual(["1 práca", "3 práce", "251 prác"]);
  });
});
