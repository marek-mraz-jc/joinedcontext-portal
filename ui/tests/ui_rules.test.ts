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

/**
 * The numbered colour families `@theme` defines — `primary-500`, `neutral-200` — which are
 * tokens here and resolve through `--portal-*`. Read from the stylesheet rather than listed
 * twice, so adding a family to the theme does not need this file edited.
 */
const THEMED = new Set(
  [...readFileSync(join(ui, "src/index.css"), "utf8").matchAll(/--color-([a-z]+)-\d{1,3}:/g)].map(
    (match) => match[1],
  ),
);

/**
 * The semantic colour names `@theme` defines whole: `fg`, `fg-muted`, `surface-subtle`, `danger`.
 * Read from the same file as `THEMED`, so a name added to the theme needs no edit here.
 */
const SEMANTIC = new Set(
  [...readFileSync(join(ui, "src/index.css"), "utf8").matchAll(/--color-([a-z-]+):/g)].map(
    (match) => match[1],
  ),
);

/**
 * The tails of those names — `muted` out of `fg-muted` and `surface-muted`, `subtle` out of
 * `surface-subtle` — minus any that is a whole name in its own right (`fg` is, so it is not a
 * tail). A tail on its own is the shape of the mistake: `text-muted` for `text-fg-muted`.
 * Tailwind emits no rule for a name the theme never defined, so the class is silently nothing
 * and the text renders at full foreground colour. Seventeen hints across four pages did.
 */
const TAILS = new Set(
  [...SEMANTIC]
    .flatMap((name) =>
      name
        .split("-")
        .map((_, index, parts) => parts.slice(index + 1).join("-"))
        .filter(Boolean),
    )
    .filter((tail) => !SEMANTIC.has(tail)),
);

/** Any `bg-rose-500`-shaped class whose family `@theme` never defined. */
const STOCK_PALETTE = new RegExp(
  `\\b(?:bg|text|border|ring|fill|stroke|from|via|to|accent|decoration|outline|shadow|divide)-([a-z]+)-\\d{2,3}\\b`,
  "g",
);

function stockColours(file: Source): string[] {
  return [...file.text.matchAll(STOCK_PALETTE)]
    .filter((match) => !THEMED.has(match[1]))
    .map((match) => `${file.path}:${file.text.slice(0, match.index).split("\n").length}`);
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
        /#[0-9a-fA-F]{3,8}\b(?![-\w])|\brgba?\(|\b(?:bg|text|border|ring|fill|stroke)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/,
      ),
    ).toEqual([]);
  });

  it("no_file_reaches_for_a_colour_family_the_theme_never_defined", () => {
    // Everywhere, shared controls included: a shared control may build a control by hand — that
    // is what makes it the shared one — but nothing in the UI may paint in a colour no theme and
    // no installation's brand can reach. `Badge` carried `bg-purple-500` for months because this
    // rule skipped its whole folder, and `purple` was missing from the pattern besides.
    // `primary` and `neutral` are the two numbered families today; the guard is that the read
    // worked at all, not how many there are.
    expect(THEMED.size, "no themed colour families were read from index.css").toBeGreaterThan(1);
    expect(all.flatMap(stockColours)).toEqual([]);
  });

  it("no_file_paints_with_half_of_a_token_name", () => {
    // `text-muted` where the theme defines `fg-muted`: Tailwind emits nothing for it, so the
    // class does nothing and the hint renders at full foreground weight, looking exactly like
    // the label above it. Seventeen of them across AppGenerator, AppsCatalog, EndpointPreview
    // and Instantiate, and no rule saw them because the existing one only reads numbered
    // families. Shared controls included: the mistake is as easy to make there.
    expect(TAILS.size, "no tails were derived from the theme's own names").toBeGreaterThan(1);
    // `(?<![\w-])` so the prefix is the start of the class and not the middle of a longer one:
    // `ring-border-focus` names the real `border-focus` token and must not read as `border-` +
    // the tail `focus`.
    const pattern = new RegExp(
      `(?<![\\w-])(?:bg|text|border|ring|fill|stroke|divide|outline)-(?:${[...TAILS].join("|")})\\b`,
      "g",
    );
    expect(
      all.flatMap((file) =>
        [...file.text.matchAll(pattern)].map(
          (match) =>
            `${file.path}:${file.text.slice(0, match.index).split("\n").length} ${match[0]}`,
        ),
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
      hand_made_control: { files: 39, lines: 87 },
      colour_is_a_token: { files: 5, lines: 41 },
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
    /#[0-9a-fA-F]{3,8}\b(?![-\w])|\brgba?\(|\b(?:bg|text|border|ring|fill|stroke)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/,
  size_is_on_the_scale:
    /\b(?:bg|text|border|p|px|py|m|mx|my|w|h|gap|rounded|shadow|min-w|max-w|min-h|max-h)-\[[^\]]+\]|style=\{\{/,
  asks_with_a_shared_dialog: /window\.confirm\(|window\.alert\(/,
  focus_is_not_stolen: /\bautoFocus\b/,
  check_is_not_suppressed: /@ts-ignore|@ts-expect-error|eslint-disable/,
};
