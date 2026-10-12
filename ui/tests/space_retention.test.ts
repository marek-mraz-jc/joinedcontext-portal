import { describe, expect, it } from "vitest";
import { fromIso, seconds, shortens, toIso, written } from "../src/pages/spaces/retention";

describe("retention durations (DM-82)", () => {
  it("reads and writes the broker's form within one minute and 3650 days", () => {
    expect(seconds("PT5M")).toBe(300);
    expect(seconds("P1DT12H")).toBe(129_600);
    expect(seconds("P3650D")).toBe(315_360_000);
    for (const bad of ["", "P", "PT", "P1DT", "PT59S", "P3651D", "P1Y", "P1W", "5m", "PT5X"]) {
      expect(seconds(bad), bad).toBeUndefined();
    }
    expect(toIso({ amount: 5, unit: "minutes" })).toBe("PT5M");
    expect(toIso({ amount: 8, unit: "hours" })).toBe("PT8H");
    expect(toIso({ amount: 30, unit: "days" })).toBe("P30D");
    for (const amount of [0, -1, 1.5, 3651]) {
      expect(toIso({ amount, unit: "days" }), String(amount)).toBeUndefined();
    }
  });

  it("shows a stored duration in the largest unit that holds it", () => {
    expect(fromIso("PT120M")).toEqual({ amount: 2, unit: "hours" });
    expect(fromIso("P1DT12H")).toEqual({ amount: 36, unit: "hours" });
    expect(fromIso("PT90S")).toEqual({ amount: 1, unit: "minutes" });
    expect(fromIso("P1Y")).toBeUndefined();
  });

  it("asks for a confirmation only when something is kept shorter", () => {
    const held = [{ entityType: "Vehicle", current: "PT5M", history: "PT8H" }];
    expect(shortens(held, held)).toBe(false);
    expect(shortens(held, [{ entityType: "Vehicle", current: "PT10M" }])).toBe(false);
    expect(shortens(held, [{ entityType: "Vehicle", current: "PT1M", history: "PT8H" }])).toBe(true);
    expect(shortens(held, [{ entityType: "Stop", history: "P30D" }])).toBe(true);
    expect(shortens([], [{ entityType: "Stop" }])).toBe(false);
  });

  it("writes no rule for a type kept forever", () => {
    expect(
      written([
        { entityType: "Vehicle", history: "PT8H", current: undefined },
        { entityType: "Stop" },
      ]),
    ).toEqual([{ entityType: "Vehicle", history: "PT8H" }]);
  });
});
