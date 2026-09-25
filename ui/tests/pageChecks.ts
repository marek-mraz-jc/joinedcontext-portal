/**
 * T-2730: what every page of the Portal owes a person, as one check over the rendered DOM
 * (UI-01, UI-15, UI-16, UI-44, UI-84).
 *
 * Two walkers run it: `tests/walker_pages.test.tsx` over every address of the router with the
 * API mocked, and `e2e/live/walker.spec.ts` on dev at 1440 and 2560 px. The function is written
 * to be handed to `page.evaluate` as it is, so it holds everything it uses inside its own body
 * and imports nothing: Playwright sends its source to the browser, not its closure.
 *
 * Each finding is `check: detail`, and the check names are what the walkers' allow lists name.
 */

export interface PageCheckOptions {
  /** The top-level keys of `en.json`: a text that is one of their dotted paths is an untranslated key. */
  namespaces: string[];
  /** Judge what needs a layout engine (overflow, form columns); jsdom has none. */
  layout: boolean;
}

export type PageCheck =
  | "one-h1"
  | "purpose-line"
  | "empty-state-next-step"
  | "field-hint"
  | "raw-i18n-key"
  | "raw-json"
  | "bare-urn"
  | "overflow"
  | "form-columns"
  // What the walkers add around the DOM check: axe's serious and critical rules, and (live)
  // the console, a request answering >= 400, and a write control a viewer can press.
  | "axe"
  | "console"
  | "http"
  | "viewer-write";

export function pageFindings(options: PageCheckOptions): string[] {
  const found: string[] = [];
  const root = document.querySelector("main") ?? document.body;
  const say = (check: string, detail: string) => found.push(`${check}: ${detail.replace(/\s+/g, " ").trim().slice(0, 160)}`);
  const shown = (element: Element) => {
    if (element.closest("[hidden], [aria-hidden='true'], .sr-only")) return false;
    if (!options.layout) return true;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  };
  const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

  // One H1 names the page (UI-16); a second one is a second page in one.
  // Counted behind an open dialog too: a modal hides the page from assistive technology while it
  // is open, and the page's h1 is still the page's.
  const headings = [...document.querySelectorAll("h1")].filter(
    (heading) => !heading.closest("[hidden]") && (!options.layout || heading.getClientRects().length > 0),
  );
  if (headings.length !== 1) say("one-h1", `${headings.length} h1: ${headings.map(text).join(" | ")}`);

  // The line under the title that says what the page manages (PageHeader's description, UI-01).
  const h1 = headings[0];
  if (h1) {
    const next = h1.nextElementSibling;
    if (!next || next.tagName !== "P" || text(next).length < 10) say("purpose-line", `no line under "${text(h1)}"`);
  }

  // An empty list says what to do next: a hint or the action that creates the first item.
  for (const empty of root.querySelectorAll("[data-empty-state]")) {
    if (!shown(empty)) continue;
    const hint = empty.querySelectorAll("p").length > 1;
    const action = empty.querySelector("button, a[href]");
    if (!hint && !action) say("empty-state-next-step", text(empty));
  }

  // Every field of a form carries a one-line hint wired to it (Field's description, UI-16).
  const skip = new Set(["hidden", "submit", "button", "reset", "image"]);
  for (const control of root.querySelectorAll("form input, form select, form textarea, [data-testid='form-page'] input, [data-testid='form-page'] select, [data-testid='form-page'] textarea")) {
    // A search box filters what the page shows; its label is the whole instruction.
    if (!shown(control) || skip.has((control as HTMLInputElement).type) || control.closest("[role='search']")) continue;
    if ((control as HTMLInputElement).type === "search") continue;
    const described = (control.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .some((hint) => hint !== null && text(hint).length > 0);
    if (!described) {
      const label = control.getAttribute("aria-label") ?? text(control.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`) : null);
      say("field-hint", label || control.getAttribute("name") || control.getAttribute("placeholder") || control.outerHTML.slice(0, 100));
    }
  }

  // What a person reads is words, never the machinery behind them.
  const namespaces = new Set(options.namespaces);
  const code = "pre, code, textarea, kbd, samp, [contenteditable], .monaco-editor, [data-raw]";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const seen = new Set<string>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = (node.textContent ?? "").trim();
    const parent = node.parentElement;
    if (value.length < 3 || !parent || parent.closest(code) || !shown(parent)) continue;
    const key = /^([a-z][A-Za-z]+)(\.[A-Za-z0-9_]+)+$/.exec(value);
    if (key && namespaces.has(key[1]) && !seen.has(`k${value}`)) {
      seen.add(`k${value}`);
      say("raw-i18n-key", value);
    }
    if (/^\s*[[{]\s*"|"\s*:\s*[[{"]/.test(value) && !seen.has(`j${value}`)) {
      seen.add(`j${value}`);
      say("raw-json", value);
    }
  }
  // Where a label belongs, a URN is not one (a cell may show an id; a heading, a button, a link,
  // a column header, a tab or a field label names a thing in words).
  for (const label of root.querySelectorAll("h1, h2, h3, button, a, th, label, legend, [role='tab'], dt")) {
    const value = text(label);
    if (/^urn:ngsi-ld:\S+$/.test(value) && shown(label) && !label.closest(code)) say("bare-urn", value);
  }

  if (options.layout) {
    const wide = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    if (wide > 1) say("overflow", `${wide}px sideways`);
    // On a big screen a form uses the width: its field grid shows three columns (T-2713, T-2755).
    if (window.innerWidth >= 1800) {
      for (const form of document.querySelectorAll("[data-testid='form-page'] form, [role='dialog'] form")) {
        const grids = [...form.querySelectorAll("*")].filter(
          (element) => getComputedStyle(element).display === "grid" && element.children.length >= 3,
        );
        const columns = Math.max(0, ...grids.map((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length));
        if (grids.length > 0 && columns < 3) say("form-columns", `${columns} column(s) at ${window.innerWidth}px`);
      }
    }
  }
  return found;
}

/** A finding the walkers excuse: a route, a check, and the open task that owes the fix. */
export interface Excused {
  route: string;
  check: PageCheck;
  task: string;
  why: string;
}

/** The findings of one address that no allow-list entry excuses. */
export function unexcused(route: string, findings: string[], allow: readonly Excused[]): string[] {
  return findings.filter(
    (finding) => !allow.some((entry) => entry.route === route && finding.startsWith(`${entry.check}:`)),
  );
}
