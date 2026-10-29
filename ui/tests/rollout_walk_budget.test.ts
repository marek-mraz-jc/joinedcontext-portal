import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// T-5993: a host short of memory OOM-kills Chromium's renderer mid-walk; the walk waits for a later
// tick instead of spending its three tries, and walks anyway after WALK_DEFER_MAX deferrals.
describe("rollout-walk memory gate", () => {
  const sha = "943ebc79cdc0eb95db7793f4a5c4535d5fba0864";
  const setup = (availableKb: number) => {
    const root = mkdtempSync(join(tmpdir(), "rollout-walk-"));
    mkdirSync(join(root, "portal/api/v1"), { recursive: true });
    writeFileSync(join(root, "portal/api/v1/version"), JSON.stringify({ portal: { commit: sha } }));
    writeFileSync(join(root, "meminfo"), `MemTotal: 31457280 kB\nMemAvailable: ${availableKb} kB\n`);
    return root;
  };
  // No users file: a walk that gets past the gate stops at "no steward or viewer password" (exit 2).
  const walk = (root: string, env: Record<string, string> = {}) =>
    spawnSync("bash", ["e2e/live/rollout-walk.sh"], {
      env: { ...process.env, PORTAL_URL: `file://${root}/portal`, WALK_EVIDENCE: join(root, "evidence"), WALK_MEMINFO: join(root, "meminfo"), DEMO_USERS: join(root, "none"), WALK_SETTLE_S: "0", ...env },
      encoding: "utf8",
    });

  it("defers the walk while the host has less memory available than the walk needs", () => {
    const root = setup(2_000_000);
    const first = walk(root);
    expect(first.status).toBe(1);
    expect(first.stderr).toContain(`walk of ${sha} deferred (1 of 12)`);
    expect(readFileSync(join(root, "evidence/deferred"), "utf8").trim()).toBe("1");
    expect(existsSync(join(root, "evidence", sha, "tries"))).toBe(false);
  });

  it("walks anyway after WALK_DEFER_MAX deferrals, and at once with enough memory", () => {
    const short = setup(2_000_000);
    expect(walk(short, { WALK_DEFER_MAX: "1" }).status).toBe(1);
    const late = walk(short, { WALK_DEFER_MAX: "1" });
    expect(late.status).toBe(2);
    expect(late.stderr).toContain("no steward or viewer password");
    expect(existsSync(join(short, "evidence/deferred"))).toBe(false);
    const ample = walk(setup(12_000_000));
    expect(ample.status).toBe(2);
    expect(ample.stderr).toContain("no steward or viewer password");
  });
});

// T-6076: the walk that started a minute after a rollout met the edge's 502 on its first loads
// (13:17Z /api/v1/branding, 16:31Z /ai-connectors) while the dev sync still ran. A commit is walked
// only after it has been served for WALK_SETTLE_S (300 s), so the walk judges the settled Portal.
describe("rollout-walk settle gate", () => {
  const sha = "9be7dc6e721463d317c2c862c5b7dbea1a928e5d";
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "rollout-walk-"));
    mkdirSync(join(root, "portal/api/v1"), { recursive: true });
    mkdirSync(join(root, "evidence"));
    writeFileSync(join(root, "portal/api/v1/version"), JSON.stringify({ portal: { commit: sha } }));
    writeFileSync(join(root, "meminfo"), "MemAvailable: 12000000 kB\n");
    return root;
  };
  const walk = (root: string) =>
    spawnSync("bash", ["e2e/live/rollout-walk.sh"], {
      env: { ...process.env, PORTAL_URL: `file://${root}/portal`, WALK_EVIDENCE: join(root, "evidence"), WALK_MEMINFO: join(root, "meminfo"), DEMO_USERS: join(root, "none") },
      encoding: "utf8",
    });

  it("defers a commit dev has served for less than the settle time", () => {
    const root = setup();
    const first = walk(root);
    expect(first.status).toBe(1);
    expect(first.stderr).toContain(`walk of ${sha} deferred until the rollout settles`);
    expect(readFileSync(join(root, "evidence/first-seen"), "utf8")).toMatch(new RegExp(`^${sha} [0-9]+\n$`));
    expect(walk(root).status).toBe(1);
    expect(existsSync(join(root, "evidence", sha))).toBe(false);
  });

  it("walks a commit served for longer, and restarts the clock for a new commit", () => {
    const root = setup();
    const old = Math.floor(Date.now() / 1000) - 301;
    writeFileSync(join(root, "evidence/first-seen"), `${sha} ${old}\n`);
    const settled = walk(root);
    expect(settled.status).toBe(2);
    expect(settled.stderr).toContain("no steward or viewer password");
    writeFileSync(join(root, "evidence/first-seen"), `943ebc79cdc0eb95db7793f4a5c4535d5fba0864 ${old}\n`);
    expect(walk(root).status).toBe(1);
  });
});
