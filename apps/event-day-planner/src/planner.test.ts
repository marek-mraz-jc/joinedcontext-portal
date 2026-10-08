import { describe, expect, it } from "vitest";
import { dayBounds, eventsOfDay, planEvents } from "./events";
import { eventRows } from "./fixtures/events";
import { computeDay, planHere, readAnswer } from "./planner";

const SUNDAY = dayBounds("2030-10-20") as [number, number];
const events = planEvents(eventsOfDay(await eventRows(), SUNDAY), SUNDAY);

// The real WebAssembly planner (test-setup.ts loads it), called as the page calls it.
describe("planner", () => {
  it("orders the chosen events, flags the two at once and writes the calendar", async () => {
    const day = await planHere({ events, settings: { chosen: ["helsinki-agf3", "helsinki-agf1", "helsinki-agf2"], now: SUNDAY[0] } });
    expect(day.items[0].id).toBe("helsinki-agf1");
    expect(day.conflicts).toEqual([["helsinki-agf2", "helsinki-agf3"]]);
    expect(day.items.some((item) => item.fit === "late")).toBe(true);
    expect(day.ics).toContain("SUMMARY:Workshop for Families\r\n");
    expect(day.ics).toContain("DTSTART:20301020T070000Z\r\n");
  });

  it("suggests a day when nothing is chosen", async () => {
    const day = await computeDay({ events, settings: {} });
    expect(day.suggested).toBe(true);
    expect(day.items.length).toBeGreaterThan(1);
    expect(day.items.every((item) => item.fit === "ok")).toBe(true);
  });

  it("plans nothing for no event", async () => {
    const day = await planHere({ events: [], settings: {} });
    expect(day.items).toEqual([]);
  });

  it("says in words what the planner could not read", () => {
    expect(() => readAnswer(JSON.stringify({ error: "the events could not be read: x" }))).toThrow("the events could not be read");
  });
});
