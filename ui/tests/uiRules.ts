/**
 * T-2315: the measure behind the UI rules allow-list, in one place.
 *
 * `ui_rules.test.ts` reads the sources and fails on every line that breaks a rule; this is the
 * part of it a second test needs — the pattern each allow-listed rule is measured by, and what
 * an entry claims against what its file still holds. It lives here rather than in the test so
 * that `ui_rules_merge.test.ts` can measure a hypothetical allow-list without importing a suite.
 */

/** A source file as the rules read it. */
export interface Source {
  /** Path relative to `ui/`, as the allow-list names it. */
  path: string;
  text: string;
  /** A shared control may build what a page may not: that is what makes it the shared one. */
  shared: boolean;
}

export interface AllowEntry {
  /** Exactly how many lines of this file break the rule today. */
  lines: number;
  /** The task group that empties this file. */
  group: string;
  /** Why a line stays, when it is right as it is. */
  reason?: string;
}

export type Allowed = Record<string, Record<string, AllowEntry>>;

/** The pattern behind each allow-listed rule, so a stale entry can be found by the same measure. */
export const RULE_OF: Record<string, RegExp> = {
  hand_made_control: /<(?:button|input|select|textarea|table)\b/,
  colour_is_a_token:
    /#[0-9a-fA-F]{3,8}\b(?![-\w])|\brgba?\(|\b(?:bg|text|border|ring|fill|stroke)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/,
  size_is_on_the_scale:
    /\b(?:bg|text|border|p|px|py|m|mx|my|w|h|gap|rounded|shadow|min-w|max-w|min-h|max-h)-\[[^\]]+\]|style=\{\{/,
  asks_with_a_shared_dialog: /window\.confirm\(|window\.alert\(/,
  focus_is_not_stolen: /\bautoFocus\b/,
  check_is_not_suppressed: /@ts-ignore|@ts-expect-error|eslint-disable/,
};

/**
 * The rules that carry no allow-list at all, and may never gain one: every one of them is zero
 * across the whole UI, and an entry here would be a permanent exemption from a security rule.
 */
export const UNLISTABLE = new Set([
  "no_markup_is_built_from_a_string",
  "no_code_is_built_from_a_string",
  "a_new_tab_link_has_rel_noopener",
  "browser_storage_holds_preferences_only",
  "no_file_reaches_for_a_colour_family_the_theme_never_defined",
  "no_file_paints_with_half_of_a_token_name",
]);

/** Every line of `file` that `pattern` matches, as `path:line`. */
export function hits(file: Source, pattern: RegExp): string[] {
  return [...file.text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].map(
    (match) => `${file.path}:${file.text.slice(0, match.index).split("\n").length}`,
  );
}

/**
 * The lines that break `rule`, minus the ones the allow-list names for that file. A file whose
 * count has grown fails with the lines, because a file that is allowed 3 and now has 5 has two
 * new violations, not permission for five.
 */
export function breaches(allow: Allowed, rule: string, pattern: RegExp, files: Source[]): string[] {
  const allowed = allow[rule] ?? {};
  return files.flatMap((file) => {
    const found = hits(file, pattern);
    const budget = allowed[file.path]?.lines ?? 0;
    return found.length > budget ? found.slice(budget) : [];
  });
}

export interface StaleEntry {
  rule: string;
  path: string;
  allowed: number;
  found: number;
}

/**
 * Every entry that claims more than its file still holds — the half of the ratchet that refuses
 * a raise. A number written larger than the file is shows up here, so `lines` can only go up in
 * a change that really did add the violations, and that change is a diff on one file's object.
 */
export function staleEntries(allow: Allowed, files: Source[]): StaleEntry[] {
  return Object.entries(allow).flatMap(([rule, entries]) =>
    Object.entries(entries).flatMap(([path, entry]) => {
      const file = files.find((source) => source.path === path);
      const pattern = RULE_OF[rule];
      if (!file || !pattern) {
        return [];
      }
      const found = hits(file, pattern).length;
      return found < entry.lines ? [{ rule, path, allowed: entry.lines, found }] : [];
    }),
  );
}
