import { describe, expect, it } from "vitest";
import { toRichRow } from "@joinedcontext/sdk";
import type { EntitySource, RichRow } from "@joinedcontext/sdk";
import { DATASETS, exportCsv, gridConfig, plain, SPEC } from "./datasets";
import { AIR, MONUMENTS, STATIONS, WORKS } from "./fixtures/data";

const rows = (entities: unknown[]): RichRow[] => entities.map((entity) => toRichRow(entity as Record<string, unknown>));

/** A source over a list, paged the way the endpoint pages. */
function over(list: RichRow[], seen: number[] = []): EntitySource {
  return {
    async query(_q, page) {
      seen.push(page.offset);
      return { rows: list.slice(page.offset, page.offset + page.limit), total: list.length } as never;
    },
    async get() {
      return null;
    },
  };
}

describe("the datasets", () => {
  it("are read only and filter only on what the endpoint can answer", () => {
    for (const dataset of DATASETS) {
      const grid = gridConfig(dataset, "slug", {});
      expect(grid.mode).toBe("view");
      expect(grid.editableAttrs).toEqual([]);
      expect(grid.columns.map((c) => c.attr)).toEqual([...SPEC[dataset].columns]);
      for (const attr of grid.filters.allowed ?? []) expect(SPEC[dataset].columns).toContain(attr);
    }
  });

  it("show a reading with its hour, and a link as a link", () => {
    const air = gridConfig("air", "slug", {}).columns;
    expect(air.find((c) => c.attr === "co")?.show).toEqual({ observedAt: true });
    expect(gridConfig("works", "slug", {}).columns.find((c) => c.attr === "url")?.format).toBe("link");
  });
});

describe("plain", () => {
  it("writes a name in the reader's language, a number as a number and a missing value as nothing", () => {
    // A title in one language is written in it whatever the reader's language is.
    const [work] = rows(WORKS);
    expect(plain(work.cells.name, "en")).toBe(Object.values(WORKS[0].name.languageMap)[0]);
    const [station] = rows(AIR);
    expect(plain(station.cells.name, "en")).toBe("Station SK0020A, urban background");
    expect(plain(station.cells.co, "sk")).toBe(0.63452);
    expect(plain(station.cells.missing, "sk")).toBeNull();
    const zilina = rows(STATIONS).find((row) => plain(row.cells.name, "sk") === "Žilina") as RichRow;
    expect(plain(zilina.cells.dailyDepartures, "sk")).toBe(166);
  });
});

describe("exportCsv", () => {
  it("reads every page and writes one row per entity under the attribute names", async () => {
    const many = Array.from({ length: 1201 }, (_, index) => rows(MONUMENTS)[index % MONUMENTS.length]);
    const seen: number[] = [];
    const result = await exportCsv("monuments", over(many, seen), "sk");
    expect(seen).toEqual([0, 500, 1000]);
    expect(result).toMatchObject({ rows: 1201, truncated: false });
    const text = await result.file.text();
    const lines = text.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe(["id", ...SPEC.monuments.columns].join(","));
    expect(lines).toHaveLength(1202);
    // A column with no address is an empty field, never "null".
    expect(text).not.toContain("null");
  });

  it("says when it stopped at its ceiling", async () => {
    const many = Array.from({ length: 5000 }, () => rows(WORKS)[0]);
    expect(await exportCsv("works", over(many), "sk")).toMatchObject({ rows: 5000, truncated: true });
  });
});
