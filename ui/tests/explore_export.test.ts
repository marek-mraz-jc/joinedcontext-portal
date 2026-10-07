// covers (T-2137, the module gate in gate_modules.test.ts): src/pages/explore/exportView.ts.
// The explorer's export (T-3253): each format opens as written, Slovak Excel reads its numbers and
// dates, a text a spreadsheet would run stays text, and the whole view is paged, capped and
// cancelled the way the page says.
import { describe, expect, it } from "vitest";
import { andQ, cellText, collect, columnsOf, exportFile, sortEntities, toCsv, toGeoJson } from "../src/pages/explore/exportView";

const STATIONS = [
  {
    id: "urn:ngsi-ld:BikeStation:2",
    type: "BikeStation",
    name: "Kauppatori; harbour",
    bikes: 3.5,
    observedAt: "2026-10-07T08:05:09Z",
    location: { type: "Point", coordinates: [24.95, 60.17] },
  },
  { id: "urn:ngsi-ld:BikeStation:1", type: "BikeStation", name: '=HYPERLINK("http://evil")', bikes: -2 },
  { id: "urn:ngsi-ld:BikeStation:3", type: "BikeStation", name: "Rautatientori\nnorth" },
];

describe("the CSV for Slovak Excel", () => {
  const csv = toCsv(STATIONS, ["id", "name", "bikes", "observedAt"], "excel-sk");

  it("starts with the byte-order mark, separates with ; and ends lines with CRLF", () => {
    expect(csv.startsWith("﻿id;name;bikes;observedAt\r\n")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("writes a decimal comma and a day.month.year date in the person's time zone", () => {
    const at = new Date("2026-10-07T08:05:09Z");
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = `${pad(at.getDate())}.${pad(at.getMonth() + 1)}.${at.getFullYear()} ${pad(at.getHours())}:${pad(at.getMinutes())}:09`;
    expect(csv).toContain(`;3,5;${local}`);
    expect(cellText("2026-10-07", "excel-sk")).toBe("07.10.2026");
  });

  it("quotes a text holding the separator, a quote or a line break", () => {
    expect(csv).toContain('"Kauppatori; harbour"');
    expect(csv).toContain('"Rautatientori\nnorth"');
  });

  it("keeps a text a spreadsheet would run as a formula as text, and a negative number a number", () => {
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain(";-2;");
  });
});

describe("the other formats", () => {
  it("keeps the API's own forms in the plain CSV", () => {
    const csv = toCsv(STATIONS.slice(0, 1), ["id", "bikes", "observedAt"], "plain");
    expect(csv).toBe("id,bikes,observedAt\nurn:ngsi-ld:BikeStation:2,3.5,2026-10-07T08:05:09Z\n");
  });

  it("writes the located entities as GeoJSON features with the chosen columns, and nothing when none is located", () => {
    const geo = JSON.parse(toGeoJson(STATIONS, ["id", "name", "bikes"]) ?? "null");
    expect(geo.type).toBe("FeatureCollection");
    expect(geo.features).toEqual([
      {
        type: "Feature",
        id: "urn:ngsi-ld:BikeStation:2",
        geometry: { type: "Point", coordinates: [24.95, 60.17] },
        properties: { name: "Kauppatori; harbour", bikes: 3.5 },
      },
    ]);
    expect(toGeoJson(STATIONS.slice(1), ["id"])).toBeNull();
    expect(exportFile("geojson", STATIONS.slice(1), ["id"], "BikeStation")).toBeNull();
  });

  it("names each file by the type and the format", () => {
    expect(exportFile("csv-excel", STATIONS, ["id"], "BikeStation")?.name).toBe("BikeStation.csv");
    expect(exportFile("json", STATIONS, ["id"], "BikeStation")).toMatchObject({ name: "BikeStation.json", type: "application/json" });
  });

  it("takes the chosen columns after the id, or every attribute the rows carry", () => {
    expect(columnsOf(STATIONS, ["name", "id"])).toEqual(["id", "name"]);
    expect(columnsOf(STATIONS, [])).toEqual(["id", "type", "name", "bikes", "observedAt", "location"]);
  });

  it("reads a normalized attribute by its value", () => {
    expect(cellText({ type: "Property", value: 4.25 }, "excel-sk")).toBe("4,25");
    expect(cellText({ type: "Relationship", object: "urn:ngsi-ld:Device:1" }, "plain")).toBe("urn:ngsi-ld:Device:1");
  });
});

describe("the view's order and filter", () => {
  it("sorts numbers by value, both ways, the rows without a value last", () => {
    expect(sortEntities(STATIONS, { attr: "bikes", dir: "asc" }).map((e) => e.id)).toEqual([
      "urn:ngsi-ld:BikeStation:1",
      "urn:ngsi-ld:BikeStation:2",
      "urn:ngsi-ld:BikeStation:3",
    ]);
    expect(sortEntities(STATIONS, { attr: "bikes", dir: "desc" })[0].id).toBe("urn:ngsi-ld:BikeStation:2");
    expect(sortEntities(STATIONS, null)).toBe(STATIONS);
  });

  it("joins the page's filter and the grid's with ;, an alternative in brackets", () => {
    expect(andQ("bikes>0", undefined, " ")).toBe("bikes>0");
    expect(andQ("bikes>0", "name==\"a\"|name==\"b\"")).toBe('bikes>0;(name=="a"|name=="b")');
    expect(andQ(undefined, "")).toBeUndefined();
  });
});

describe("reading the whole view", () => {
  const pages = (total: number) => async (offset: number, limit: number) => ({
    rows: Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({ id: String(offset + i) })),
    count: total,
  });

  it("pages until the endpoint has no more, saying how far it is", async () => {
    const seen: number[] = [];
    const { entities, truncated, total } = await collect(pages(1_100), { pageSize: 500, progress: (done) => seen.push(done) });
    expect(entities).toHaveLength(1_100);
    expect(seen).toEqual([500, 1_000, 1_100]);
    expect(truncated).toBe(false);
    expect(total).toBe(1_100);
  });

  it("stops at the cap and says the rest was left out", async () => {
    const { entities, truncated } = await collect(pages(1_300), { pageSize: 500, max: 1_000 });
    expect(entities).toHaveLength(1_000);
    expect(truncated).toBe(true);
  });

  it("an empty view is no error, and a cancelled one asks no further page", async () => {
    expect((await collect(pages(0))).entities).toEqual([]);
    const controller = new AbortController();
    let asked = 0;
    const reading = collect(
      async (offset, limit) => {
        asked += 1;
        controller.abort();
        return pages(5_000)(offset, limit);
      },
      { signal: controller.signal, pageSize: 500 },
    );
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(asked).toBe(1);
  });
});
