import { describe, expect, it } from "vitest";
import { COLUMNS, DATASETS, ENUMS, exportUrl, gridConfig } from "./datasets";
import { LOCALES, stringsFor } from "./locales";

const SLUG = "tw3jx6pcam2qzk7nre5bdv4yfh";

describe("the grids", () => {
  it("give each register its columns with the region's labels, the name pinned and every column filterable", () => {
    for (const dataset of DATASETS) {
      const grid = gridConfig(SLUG, dataset, LOCALES.sk.column);
      expect(grid.columns.map((c) => c.attr)).toEqual(COLUMNS[dataset]);
      expect(grid.columns.every((c) => LOCALES.sk.column[c.attr] === c.label)).toBe(true);
      expect(grid.columns.filter((c) => c.pinned).map((c) => c.attr)).toEqual(["name"]);
      expect(grid.filters.allowed).toEqual(COLUMNS[dataset]);
    }
  });

  it("downloads a whole register from the endpoint's own files", () => {
    expect(exportUrl(SLUG, "bridges", "csv")).toBe(`/api/endpoint/${SLUG}/file.csv?type=Bridge&humanHeaders=true`);
    expect(exportUrl(SLUG, "hospitals", "geojson")).toBe(`/api/endpoint/${SLUG}/file.geojson?type=Hospital`);
  });
});

describe("locales", () => {
  it("say everything in Slovak and English, label every column and name every enum value", () => {
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(LOCALES.en)).toEqual(keys(LOCALES.sk));
    expect(keys(LOCALES.en.column)).toEqual(keys(LOCALES.sk.column));
    for (const attr of Object.values(COLUMNS).flat()) expect(LOCALES.sk.column[attr]).toBeTruthy();
    for (const value of Object.values(ENUMS).flat()) {
      expect(LOCALES.sk.values[value]).toBeTruthy();
      expect(LOCALES.en.values[value]).toBeTruthy();
    }
    expect(stringsFor("en").locale).toBe("en");
  });
});
