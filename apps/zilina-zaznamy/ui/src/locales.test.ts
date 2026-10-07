import { describe, expect, it } from "vitest";
import { DATASETS, SPEC } from "./datasets";
import { LOCALES, stringsFor } from "./locales";

describe("locales", () => {
  it("names every dataset and every column in Slovak and English, and falls back to Slovak", () => {
    const keys = (strings: object) => Object.keys(strings).sort();
    expect(keys(LOCALES.en)).toEqual(keys(LOCALES.sk));
    const columns = [...new Set(DATASETS.flatMap((dataset) => SPEC[dataset].columns))].sort();
    for (const s of [LOCALES.sk, LOCALES.en]) {
      for (const table of [s.name, s.about, s.licence]) expect(Object.keys(table).sort()).toEqual([...DATASETS].sort());
      expect(Object.keys(s.column).sort()).toEqual(columns);
    }
    expect(stringsFor("en-GB").locale).toBe("en");
    expect(stringsFor("de").locale).toBe("sk");
  });
});
