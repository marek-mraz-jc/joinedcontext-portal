import { describe, expect, it } from "vitest";
import { analyseHere, computeAnalysis, readAnswer, strength, strongest } from "./analysis";

const HOUR = 3_600_000;
const T0 = Date.UTC(2030, 9, 20);
const hours = (f: (h: number) => number, n = 12): Array<[number, number]> => Array.from({ length: n }, (_, h) => [T0 + h * HOUR, f(h)]);

// The real WebAssembly statistics (test-setup.ts loads them), called as the page calls them.
describe("analysis", () => {
  it("finds that PM2.5 falls as the wind rises", async () => {
    const result = await analyseHere({ air: { pm25: hours((h) => 30 - 2 * h) }, weather: { windSpeed: hours((h) => 1 + h) }, settings: { window: 1 } });
    expect(result.hours).toHaveLength(12);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({ air: "pm25", weather: "windSpeed", n: 12 });
    expect(result.pairs[0].pearson).toBeCloseTo(-1, 9);
    expect(result.pairs[0].spearman).toBeCloseTo(-1, 9);
    expect(strongest(result.pairs)?.weather).toBe("windSpeed");
  });

  it("marks an outlying reading and smooths with the rolling mean", async () => {
    const result = await computeAnalysis({ air: { pm25: hours((h) => (h === 5 ? 90 : 10 + (h % 2))) }, weather: {}, settings: { window: 3 } });
    expect(result.air[0].outliers).toEqual([5]);
    expect(result.air[0].smooth[2]).toBeCloseTo((10 + 11 + 10) / 3, 9);
  });

  it("answers nothing for no readings", async () => {
    const result = await analyseHere({ air: {}, weather: {}, settings: {} });
    expect(result).toEqual({ hours: [], air: [], weather: [], pairs: [] });
    expect(strongest([])).toBeNull();
  });

  it("names the strength of a correlation", () => {
    expect([0.1, -0.3, 0.5, -0.9].map(strength)).toEqual(["none", "weak", "moderate", "strong"]);
  });

  it("says in words what it could not read", () => {
    expect(() => readAnswer(JSON.stringify({ error: "the readings could not be read: x" }))).toThrow("the readings could not be read");
  });
});
