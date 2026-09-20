/**
 * T-1726: the UI rules as one test (UI-01, UI-16, PF-50).
 *
 * `components/ui/index.ts` says "nothing on a page styles a control by hand". This is what
 * enforces it. Each rule reads the sources and fails on every line that breaks it, except the
 * lines `ui_rules.allow.json` already names — today's measured state, which the per-file tasks of
 * the `ui-components`, `ui-forms`, `ui-pages` and `ui-parts` groups empty file by file. The
 * allow-list may only shrink: its totals are asserted, so a new violation cannot be waved through
 * by adding a line to it.
 *
 * The security rules carry no allow-list at all. They are zero today and this keeps them zero.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowPath = join(ui, "tests/ui_rules.allow.json");

type Allowed = Record<string, Record<string, { lines: number; group: string }>>;
const allow = JSON.parse(readFileSync(allowPath, "utf8")) as Allowed;

interface Source {
  /** Path relative to `ui/`, as the allow-list names it. */
  path: string;
  text: string;
  /** A shared control may build what a page may not: that is what makes it the shared one. */
  shared: boolean;
}

function sources(): Source[] {
  const out: Source[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name))
        out.push({
          path: relative(ui, full),
          text: readFileSync(full, "utf8"),
          shared: full.includes("/components/ui/"),
        });
    }
  };
  walk(join(ui, "src"));
  return out;
}

const all = sources();
const pages = all.filter((file) => !file.shared);

/** Every line of `file` that `pattern` matches, as `path:line`. */
function hits(file: Source, pattern: RegExp): string[] {
  return [...file.text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].map(
    (match) => `${file.path}:${file.text.slice(0, match.index).split("\n").length}`,
  );
}

/**
 * The lines that break `rule`, minus the ones the allow-list names for that file. A file whose
 * count has grown fails with the lines, because a file that is allowed 3 and now has 5 has two
 * new violations, not permission for five.
 */
function breaches(rule: string, pattern: RegExp, files: Source[] = pages): string[] {
  const allowed = allow[rule] ?? {};
  return files.flatMap((file) => {
    const found = hits(file, pattern);
    const budget = allowed[file.path]?.lines ?? 0;
    return found.length > budget ? found.slice(budget) : [];
  });
}

describe("what a page may not do by hand", () => {
  it("a_page_does_not_hand_make_a_button_input_select_textarea_or_table", () => {
    expect(breaches("hand_made_control", /<(?:button|input|select|textarea|table)\b/)).toEqual([]);
  });

  it("a_colour_is_a_token", () => {
    expect(
      breaches(
        "colour_is_a_token",
        /#[0-9a-fA-F]{3,8}\b(?![-\w])|\brgba?\(|\b(?:bg|text|border|ring|fill|stroke)-(?:red|blue|green|gray|slate|zinc|amber|yellow|emerald|sky|indigo|rose|orange)-\d{2,3}\b/,
      ),
    ).toEqual([]);
  });

  it("a_size_is_on_the_scale", () => {
    expect(
      breaches(
        "size_is_on_the_scale",
        /\b(?:bg|text|border|p|px|py|m|mx|my|w|h|gap|rounded|shadow|min-w|max-w|min-h|max-h)-\[[^\]]+\]|style=\{\{/,
      ),
    ).toEqual([]);
  });

  it("nothing_asks_with_window_confirm", () => {
    expect(breaches("asks_with_a_shared_dialog", /window\.confirm\(|window\.alert\(/)).toEqual([]);
  });

  it("focus_is_not_stolen_on_arrival", () => {
    expect(breaches("focus_is_not_stolen", /\bautoFocus\b/)).toEqual([]);
  });

  it("a_check_is_not_suppressed", () => {
    expect(breaches("check_is_not_suppressed", /@ts-ignore|@ts-expect-error|eslint-disable/)).toEqual(
      [],
    );
  });
});

describe("what nothing in the UI may do", () => {
  // No allow-list below this line: every one of these is zero today.
  const everywhere = (pattern: RegExp): string[] => all.flatMap((file) => hits(file, pattern));

  it("no_markup_is_built_from_a_string", () => {
    expect(everywhere(/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write/)).toEqual(
      [],
    );
  });

  it("no_code_is_built_from_a_string", () => {
    expect(everywhere(/\beval\(|new Function\(/)).toEqual([]);
  });

  it("a_new_tab_link_has_rel_noopener", () => {
    // Per element, not per file: one link with `rel` does not cover the next one without it.
    const open = all.flatMap((file) =>
      [...file.text.matchAll(/<(?:a|Link|area)\b[^>]*>/gs)]
        // `noreferrer` implies `noopener` in every browser that understands it, so either does.
        .filter(
          (tag) =>
            tag[0].includes('target="_blank"') &&
            !/rel="[^"]*(?:noopener|noreferrer)/.test(tag[0]),
        )
        .map((tag) => `${file.path}:${file.text.slice(0, tag.index).split("\n").length}`),
    );
    expect(open).toEqual([]);
    // `window.open` cannot carry `rel` at all, so it is not used.
    expect(everywhere(/window\.open\(/)).toEqual([]);
  });

  it("browser_storage_holds_preferences_only", () => {
    // What a viewer may keep in their own browser: how they like the UI, never platform state
    // and never anything a session could be resumed from (UI-09, PF-50).
    const keys = new Set(["jc-lang", "jc-theme", "jc-project", "jc-advanced"]);
    const used = all.flatMap((file) =>
      [...file.text.matchAll(/(?:local|session)Storage\.\w+\(\s*("[^"]*"|`[^`]*`|[A-Z_]+)/g)].map(
        (match) => ({
          where: `${file.path}:${file.text.slice(0, match.index).split("\n").length}`,
          key: match[1].replace(/["`]/g, ""),
        }),
      ),
    );
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter(({ key }) => !keys.has(key) && !/^[A-Z_]+$/.test(key))).toEqual([]);
  });
});

describe("the allow-list", () => {
  it("the_allow_list_only_shrinks", () => {
    // The measured state of 2026-09-20. Lower these when a file is cleaned; a change that raises
    // one is a new violation, which is what this number is here to refuse.
    const budget: Record<string, { files: number; lines: number }> = {
      hand_made_control: { files: 40, lines: 89 },
      colour_is_a_token: { files: 7, lines: 49 },
      size_is_on_the_scale: { files: 19, lines: 55 },
      focus_is_not_stolen: { files: 4, lines: 7 },
      check_is_not_suppressed: { files: 6, lines: 7 },
      // T-1727 moved both callers to ConfirmDialog; this rule is clean and stays that way.
      asks_with_a_shared_dialog: { files: 0, lines: 0 },
    };
    for (const [rule, ceiling] of Object.entries(budget)) {
      const entries = Object.values(allow[rule] ?? {});
      expect(entries.length, `${rule}: files`).toBeLessThanOrEqual(ceiling.files);
      expect(
        entries.reduce((sum, entry) => sum + entry.lines, 0),
        `${rule}: lines`,
      ).toBeLessThanOrEqual(ceiling.lines);
    }
    // A rule nobody wrote a budget for cannot be allow-listed into existence.
    expect(Object.keys(allow).filter((rule) => !(rule in budget))).toEqual([]);
  });

  it("every_entry_names_a_file_that_exists_and_the_group_that_empties_it", () => {
    const known = new Set(pages.map((file) => file.path));
    const groups = new Set(["ui-components", "ui-forms", "ui-pages", "ui-parts"]);
    for (const [rule, files] of Object.entries(allow)) {
      for (const [path, entry] of Object.entries(files)) {
        expect(known, `${rule} allows ${path}, which no source file is`).toContain(path);
        expect(entry.lines, `${rule}/${path}`).toBeGreaterThan(0);
        expect(groups, `${rule}/${path} names no group`).toContain(entry.group);
      }
    }
  });

  it("no_entry_survives_the_file_it_was_written_for", () => {
    // A file cleaned below its budget is an entry to delete, and this says which.
    const stale = Object.entries(allow).flatMap(([rule, files]) =>
      Object.entries(files).flatMap(([path, entry]) => {
        const file = pages.find((source) => source.path === path);
        return file && hits(file, RULE_OF[rule]).length < entry.lines ? [`${rule}/${path}`] : [];
      }),
    );
    expect(stale, "these entries allow more than the file still does; lower or delete them").toEqual(
      [],
    );
  });
});

/** The pattern behind each allow-listed rule, so a stale entry can be found by the same measure. */
const RULE_OF: Record<string, RegExp> = {
  hand_made_control: /<(?:button|input|select|textarea|table)\b/,
  colour_is_a_token:
    /#[0-9a-fA-F]{3,8}\b(?![-\w])|\brgba?\(|\b(?:bg|text|border|ring|fill|stroke)-(?:red|blue|green|gray|slate|zinc|amber|yellow|emerald|sky|indigo|rose|orange)-\d{2,3}\b/,
  size_is_on_the_scale:
    /\b(?:bg|text|border|p|px|py|m|mx|my|w|h|gap|rounded|shadow|min-w|max-w|min-h|max-h)-\[[^\]]+\]|style=\{\{/,
  asks_with_a_shared_dialog: /window\.confirm\(|window\.alert\(/,
  focus_is_not_stolen: /\bautoFocus\b/,
  check_is_not_suppressed: /@ts-ignore|@ts-expect-error|eslint-disable/,
};
