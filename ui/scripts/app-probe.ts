/**
 * T-2795: what the App probe saw of one published App, as the verdict the board and the Apps
 * page read (AP-136).
 *
 * `e2e/live/app-probe.spec.ts` gathers an `Observation` per App and writes `summaryOf` as the
 * summary of the check `apps`: one result per App, keyed `{project}/{name}`, which
 * `tasks/file-failures` files tasks from and `scripts/publish-health.py --passed` publishes for
 * the chips. Titles are what a person reads on the chip, so they name the step that failed and
 * never carry a password or a token; console messages are cut to one line.
 */

export interface Observation {
  project: string;
  name: string;
  visibility: string;
  /** The probe itself was refused the App: it is not in the App's default group. */
  refused: boolean;
  /** Milliseconds until the first row read inside the Portal, or null when none came. */
  dataMs: number | null;
  /** The same on the App's own host, opened from "Open in new window". */
  windowDataMs: number | null;
  consoleErrors: string[];
  /** What a visitor who did not sign in got: rows, a sign-in or refusal, or neither. */
  anonymous: "data" | "refused" | "blank";
}

export interface ProbeResult {
  key: string;
  verdict: "pass" | "fail" | "skip";
  title: string;
  detail?: string;
}

export interface ProbeSummary {
  check: "apps";
  repo: "joinedcontext-portal";
  run: string;
  requirements: string[];
  results: ProbeResult[];
}

/** How long the probe waits for a first row, in seconds; the titles name it. */
export const DATA_WAIT_S = 60;

const oneLine = (text: string, max = 120): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export function verdictOf(seen: Observation): ProbeResult {
  const key = `${seen.project}/${seen.name}`;
  const fail = (title: string, detail?: string): ProbeResult => ({ key, verdict: "fail", title, detail });
  if (seen.refused) {
    return { key, verdict: "skip", title: `the probe is not a member of ${seen.name}'s default group` };
  }
  if (seen.dataMs === null) return fail(`no row read inside the Portal in ${DATA_WAIT_S} s`);
  if (seen.windowDataMs === null) return fail(`no row read in its own window in ${DATA_WAIT_S} s`);
  if (seen.consoleErrors.length > 0) {
    const count = seen.consoleErrors.length;
    return fail(
      `${count} console error${count === 1 ? "" : "s"}: ${oneLine(seen.consoleErrors[0])}`,
      seen.consoleErrors.map((error) => oneLine(error, 300)).join("\n"),
    );
  }
  const isPublic = seen.visibility === "public";
  if (isPublic && seen.anonymous !== "data") return fail("a visitor who did not sign in read nothing");
  if (!isPublic && seen.anonymous === "data") return fail("a visitor who did not sign in read its data");
  if (!isPublic && seen.anonymous === "blank") return fail("a visitor who did not sign in was not sent to sign in");
  return { key, verdict: "pass", title: `opened with data in ${(seen.dataMs / 1000).toFixed(1)} s` };
}

export function summaryOf(observations: Observation[], run: string): ProbeSummary {
  return {
    check: "apps",
    repo: "joinedcontext-portal",
    run,
    requirements: ["AP-136"],
    results: observations.map(verdictOf),
  };
}
