import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// T-5161: the host cron kills rollout-walk.sh at the time `--budget` prints; it must cover the
// steward walk, then the viewer walk, and the journeys, each with its own cap and kill grace.
const budget = (env: Record<string, string>) =>
  Number(
    execFileSync("bash", ["e2e/live/rollout-walk.sh", "--budget"], {
      env: { ...process.env, WALK_EVIDENCE: "/nonexistent/never-created", ...env },
      encoding: "utf8",
    }).trim(),
  );

describe("rollout-walk --budget", () => {
  it("covers two walks and the journeys at the defaults", () => {
    expect(budget({})).toBeGreaterThanOrEqual(2 * 900 + 3600);
  });

  it("follows WALK_CAP and SWEEP_CAP", () => {
    expect(budget({ WALK_CAP: "1200", SWEEP_CAP: "60" })).toBeGreaterThanOrEqual(2 * 1200 + 60);
  });
});
