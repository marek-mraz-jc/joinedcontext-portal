/** T-2795 (AP-136): the App probe's verdict per App, from what it saw. */
import { describe, expect, it } from "vitest";
import { summaryOf, verdictOf } from "../scripts/app-probe";
import type { Observation } from "../scripts/app-probe";

const WORKING: Observation = {
  project: "helsinki",
  name: "air-quality",
  visibility: "project",
  refused: false,
  dataMs: 2400,
  windowDataMs: 1800,
  consoleErrors: [],
  anonymous: "refused",
};

const seen = (change: Partial<Observation>): Observation => ({ ...WORKING, ...change });

describe("the App probe's verdict (AP-136)", () => {
  it("passes an App that read data in both places and turned a stranger away", () => {
    expect(verdictOf(WORKING)).toEqual({
      key: "helsinki/air-quality",
      verdict: "pass",
      title: "opened with data in 2.4 s",
    });
  });

  it.each([
    [{ dataMs: null }, "no row read inside the Portal in 60 s"],
    [{ windowDataMs: null }, "no row read in its own window in 60 s"],
    [{ consoleErrors: ["TypeError: x is undefined\n  at main.js:1"] }, "1 console error: TypeError: x is undefined at main.js:1"],
    [{ visibility: "public", anonymous: "refused" }, "a visitor who did not sign in read nothing"],
    [{ anonymous: "data" }, "a visitor who did not sign in read its data"],
    [{ anonymous: "blank" }, "a visitor who did not sign in was not sent to sign in"],
  ] as const)("fails %o as %s", (change, title) => {
    expect(verdictOf(seen(change as Partial<Observation>))).toMatchObject({ verdict: "fail", title });
  });

  it("skips an App whose default group the probe is not in, rather than calling it broken", () => {
    expect(verdictOf(seen({ refused: true, dataMs: null }))).toMatchObject({ verdict: "skip" });
  });

  it("cuts a long console error to one line in the title and keeps every error in the detail", () => {
    const result = verdictOf(seen({ consoleErrors: ["x".repeat(500), "second"] }));
    expect(result.title.length).toBeLessThan(140);
    expect(result.detail?.split("\n")).toHaveLength(2);
  });

  it("a public App read by a stranger passes", () => {
    expect(verdictOf(seen({ visibility: "public", anonymous: "data" })).verdict).toBe("pass");
  });

  it("writes the summary of the check apps", () => {
    const summary = summaryOf([WORKING, seen({ name: "alerts", dataMs: null })], "probe 1");
    expect(summary.check).toBe("apps");
    expect(summary.results.map((r) => [r.key, r.verdict])).toEqual([
      ["helsinki/air-quality", "pass"],
      ["helsinki/alerts", "fail"],
    ]);
  });
});
