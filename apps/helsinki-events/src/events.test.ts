import { describe, expect, it } from "vitest";
import type { Row } from "@joinedcontext/sdk";
import { byRegister, filterEvents, inputDay, located, perDay, registerOf, sourceOf, upcomingQuery, when } from "./events";
import { EVENTS as SENT } from "./fixtures/events";

// The rows as the SDK hands them to the page: a language map already read in English.
const EVENTS: Row[] = SENT.map(
  (row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === "object" && value !== null && "languageMap" in value ? (value.languageMap as Record<string, string>).en : value,
      ]),
    ) as Row,
);
const ids = (rows: Row[]) => rows.map((row) => row.id.slice(row.id.lastIndexOf(":") + 1));
const bare = (id: string, fields: Record<string, unknown> = {}): Row => ({ id, type: "Event", ...fields }) as Row;

describe("the events", () => {
  it("asks only for the events that have not ended, with an unquoted DateTime", () => {
    expect(upcomingQuery(new Date("2030-10-20T00:00:00.000Z"))).toBe("endDate>=2030-10-20T00:00:00Z");
  });

  it("names the register from the local id's prefix, the raw prefix when unknown, Other when none", () => {
    expect(EVENTS.map(registerOf)).toEqual([
      "City of Helsinki",
      "City of Helsinki",
      "City of Espoo",
      "Culture centres",
      "Culture centres",
      "City of Helsinki",
    ]);
    expect(registerOf(bare("urn:ngsi-ld:Event:hel.fi:helsinki:vantaa-12"))).toBe("vantaa");
    expect(registerOf(bare("urn:ngsi-ld:Event:hel.fi:helsinki:12"))).toBe("Other");
    expect(registerOf(bare("urn:ngsi-ld:Event:hel.fi:helsinki:-12"))).toBe("Other");
  });

  it("keeps the events overlapping the range, soonest first, and the one with no date", () => {
    const from = inputDay("2030-10-21");
    expect(ids(filterEvents(EVENTS, { from }))).toEqual(["espoo_le-agn5", "kulke-7712", "kulke-7711"]);
    expect(ids(filterEvents(EVENTS, { from: inputDay("2030-10-20"), to: inputDay("2030-10-20", true) }))).toEqual([
      "helsinki-agf1",
      "helsinki-agf2",
    ]);
    const undated = bare("urn:ngsi-ld:Event:hel.fi:helsinki:helsinki-x", { name: "Undated" });
    expect(ids(filterEvents([undated, ...EVENTS], { from }))).toEqual(["espoo_le-agn5", "kulke-7712", "kulke-7711", "helsinki-x"]);
  });

  it("searches every word in the name, place and description, ignoring case and accents", () => {
    expect(ids(filterEvents(EVENTS, { query: "JAZZ stoa" }))).toEqual(["kulke-7711"]);
    expect(ids(filterEvents(EVENTS, { query: "siltakatu" }))).toEqual(["helsinki-agf1"]);
    expect(ids(filterEvents(EVENTS, { query: "   " }))).toHaveLength(EVENTS.length);
    expect(filterEvents(EVENTS, { query: "jazz nowhere" })).toEqual([]);
    const accented = bare("urn:ngsi-ld:Event:hel.fi:helsinki:helsinki-y", { name: "Kesäjuhla" });
    expect(ids(filterEvents([accented], { query: "kesajuhla" }))).toEqual(["helsinki-y"]);
  });

  it("picks one Helsinki day and one register", () => {
    // 22:30 UTC on the 19th is already the 20th in Helsinki.
    const late = bare("urn:ngsi-ld:Event:hel.fi:helsinki:helsinki-late", { startDate: "2030-10-19T22:30:00Z" });
    expect(ids(filterEvents([late, ...EVENTS], { day: "2030-10-20" }))).toEqual(["helsinki-late", "helsinki-agf1", "helsinki-agf2"]);
    expect(ids(filterEvents(EVENTS, { register: "Culture centres" }))).toEqual(["kulke-7712", "kulke-7711"]);
    expect(filterEvents([], { day: "2030-10-20", register: "City of Espoo" })).toEqual([]);
  });

  it("counts the events per day over 30 days, empty days included", () => {
    const series = perDay(EVENTS, new Date("2030-10-19T21:00:00Z"));
    expect(series).toHaveLength(30);
    expect(series[0]).toEqual({ day: "2030-10-20", count: 2 });
    expect(series.slice(1, 4).map((point) => point.count)).toEqual([0, 1, 1]);
    // 5 November falls inside the 30 days; the 2020 event does not.
    expect(series.reduce((sum, point) => sum + point.count, 0)).toBe(5);
    expect(perDay([], new Date("2030-10-19T21:00:00Z"), 0)).toEqual([]);
  });

  it("counts per register, most first and ties by name", () => {
    expect(byRegister(EVENTS)).toEqual([
      { register: "City of Helsinki", count: 3 },
      { register: "Culture centres", count: 2 },
      { register: "City of Espoo", count: 1 },
    ]);
    expect(byRegister([])).toEqual([]);
  });

  it("links a source only when it is https", () => {
    expect(EVENTS.map(sourceOf).filter(Boolean)).toHaveLength(3);
    expect(sourceOf(EVENTS[2])).toBe("");
    expect(sourceOf(bare("x", { source: "javascript:alert(1)" }))).toBe("");
    expect(sourceOf(bare("x"))).toBe("");
  });

  it("says when in Helsinki's time, and what is missing", () => {
    expect(when(EVENTS[0])).toBe("20 Oct 2030, 17:00 – 20 Oct 2030, 19:00");
    expect(when(bare("x", { startDate: "2030-10-20T14:00:00Z" }))).toBe("from 20 Oct 2030, 17:00");
    expect(when(bare("x", { endDate: "2030-10-20T14:00:00Z" }))).toBe("until 20 Oct 2030, 17:00");
    expect(when(bare("x", { startDate: "not a date" }))).toBe("date not given");
  });

  it("puts only the events with a point on the map", () => {
    expect(EVENTS.filter(located)).toHaveLength(5);
  });
});
