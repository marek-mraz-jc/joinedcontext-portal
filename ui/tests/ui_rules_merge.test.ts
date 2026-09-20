/**
 * T-2315: two UI workers cleaning two different files must not conflict (TS-19, UI-01).
 *
 * The ratchet used to be six literal totals in `ui_rules.test.ts`. Four workers clean the `ui-*`
 * groups at once, and every one of them lowered the same line: on 2026-09-20 it blocked three
 * batches in a row while `ui_rules.allow.json` merged cleanly beside it every time. These cases
 * run the actual three-way merge git would run, on both shapes, and then check that the shape
 * that survives still refuses a number written larger than its file.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { staleEntries } from "./uiRules";
import type { Allowed, Source } from "./uiRules";

let work = "";

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ui-rules-merge-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/**
 * The merge git performs for one file, run on three throwaway copies. Returns the merged text,
 * or null when git reported a conflict — `git merge-file` exits non-zero with the number of
 * conflicts, which is what a worker sees as "resolve it on the branch".
 */
function threeWayMerge(mine: string, base: string, theirs: string): string | null {
  const paths = { mine: join(work, "mine"), base: join(work, "base"), theirs: join(work, "theirs") };
  writeFileSync(paths.mine, mine);
  writeFileSync(paths.base, base);
  writeFileSync(paths.theirs, theirs);
  try {
    return execFileSync("git", ["merge-file", "-p", paths.mine, paths.base, paths.theirs], {
      encoding: "utf8",
    });
  } catch {
    return null;
  }
}

const entry = (lines: number) => ({ lines, group: "ui-pages" });

const baseList = (): Allowed => ({
  hand_made_control: {
    "src/routes/AlphaPage.tsx": entry(3),
    "src/routes/BetaPage.tsx": entry(2),
  },
});

const asJson = (list: Allowed) => `${JSON.stringify(list, null, 2)}\n`;

/** The shape the ratchet used to have: one literal both workers had to lower. */
const asTotals = (files: number, lines: number) =>
  [
    "    const budget: Record<string, { files: number; lines: number }> = {",
    `      hand_made_control: { files: ${files}, lines: ${lines} },`,
    "      colour_is_a_token: { files: 5, lines: 41 },",
    "    };",
    "",
  ].join("\n");

const source = (path: string, buttons: number): Source => ({
  path,
  text: Array.from({ length: buttons }, () => "<button type=\"button\" />").join("\n"),
  shared: false,
});

describe("two workers cleaning two different files", () => {
  it("the_allow_list_merges_because_each_file_is_its_own_object", () => {
    const base = asJson(baseList());

    // One empties Alpha, the other empties Beta, neither knows about the other.
    const alphaCleaned = baseList();
    alphaCleaned.hand_made_control["src/routes/AlphaPage.tsx"] = entry(1);
    const betaCleaned = baseList();
    betaCleaned.hand_made_control["src/routes/BetaPage.tsx"] = entry(0 + 1);

    const merged = threeWayMerge(asJson(alphaCleaned), base, asJson(betaCleaned));
    expect(merged, "the allow-list is where the numbers live, and it merges").not.toBeNull();

    const result = JSON.parse(merged as string) as Allowed;
    expect(result.hand_made_control["src/routes/AlphaPage.tsx"].lines).toBe(1);
    expect(result.hand_made_control["src/routes/BetaPage.tsx"].lines).toBe(1);
  });

  it("one_shared_total_is_what_conflicted_and_it_is_not_there_any_more", () => {
    // The regression this task exists for, reproduced: both workers lower the same literal,
    // to different numbers, because each counted only the file they cleaned.
    const conflicted = threeWayMerge(asTotals(2, 3), asTotals(2, 5), asTotals(2, 4));
    expect(conflicted, "two totals on one line cannot be merged").toBeNull();

    // And the file that holds the ratchet has no such line left to conflict on.
    const test = readFileSync(join(import.meta.dirname, "ui_rules.test.ts"), "utf8");
    expect(test, "the ratchet is per file now; a shared total would bring this back").not.toContain(
      "const budget",
    );
  });

  it("the_merged_tree_still_refuses_a_number_written_larger_than_its_file", () => {
    const merged = baseList();
    merged.hand_made_control["src/routes/AlphaPage.tsx"] = entry(1);
    merged.hand_made_control["src/routes/BetaPage.tsx"] = entry(1);
    const files = [source("src/routes/AlphaPage.tsx", 1), source("src/routes/BetaPage.tsx", 1)];

    expect(staleEntries(merged, files)).toEqual([]);

    // A worker raises a number instead of lowering it: the file holds one, the entry claims four.
    const raised = structuredClone(merged);
    raised.hand_made_control["src/routes/AlphaPage.tsx"] = entry(4);
    expect(staleEntries(raised, files)).toEqual([
      { rule: "hand_made_control", path: "src/routes/AlphaPage.tsx", allowed: 4, found: 1 },
    ]);
  });

  it("an_entry_for_a_rule_nothing_measures_is_never_counted_as_clean", () => {
    // A rule with no pattern would be an exemption nothing can check; `ui_rules.test.ts` refuses
    // one outright, and `staleEntries` never reports it as satisfied either.
    const invented: Allowed = { a_rule_nobody_wrote: { "src/routes/AlphaPage.tsx": entry(9) } };
    expect(staleEntries(invented, [source("src/routes/AlphaPage.tsx", 1)])).toEqual([]);
  });
});
