// The four-width check of an application's screens (T-2777, T-2825, UI-84, SDK-12), for a
// Playwright spec: `layoutProblems(page, width)` lists what is wrong at the width the page has, and
// the spec asserts the list is empty. Nothing here imports `@playwright/test` at run time: a second
// copy of it (the SDK's, linked, beside the app's) is refused by Playwright, so the assertions stay
// in the app's own spec.
import type { Page } from "@playwright/test";

/** A phone, a tablet, a laptop and a wall. */
export const WIDTHS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
  { width: 2560, height: 1440 },
] as const;

/** The blocks that must never cover each other: every view, card, field and header part. */
export const BLOCKS = [
  ".jc-card",
  ".jc-tile",
  ".jc-table-wrap",
  ".jc-map",
  ".jc-chart",
  ".jc-field",
  ".jc-filter",
  ".jc-detail",
  ".jc-page-header",
  ".jc-export",
  ".jc-form-actions",
  ".jc-tabs",
  ".jc-sidebar-toggle",
  ".jc-grid",
  ".jc-header h1",
  ".jc-header nav",
].join(", ");

/** What an application may be built from besides the template's classes. */
export const LIVE_BLOCKS = `${BLOCKS}, article, aside, figure, form, table`;

/** Pairs of visible blocks, neither inside the other, whose boxes intersect by more than a pixel. */
export async function overlaps(page: Page, blocks: string = BLOCKS): Promise<string[]> {
  return page.evaluate((selector) => {
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} "${(el.textContent ?? "").trim().slice(0, 30)}"`;
    const boxes = [...document.querySelectorAll(selector)]
      .map((el) => ({ el, box: el.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0);
    const found: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const width = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
        const height = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
        if (width > 1 && height > 1) found.push(`${name(a.el)} × ${name(b.el)}`);
      }
    }
    return found;
  }, blocks);
}

/** Where axe-core sits, found from this module the way Node finds an import. */
function axePath(): string {
  try {
    const url = (import.meta as ImportMeta & { resolve: (specifier: string) => string }).resolve("axe-core/axe.min.js");
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    throw new Error("the responsive check needs axe-core: add \"axe-core\": \"4.13.0\" to the app's devDependencies");
  }
}

let axeSource: string | undefined;

/**
 * axe-core's bundle as text, read once through a blank page of the same browser: it carries no
 * Content Security Policy, and `axe.source` is the bundle axe injects into frames itself. axe sets
 * it only where it sees a CommonJS `module`, so the blank page gets one first.
 */
async function loadAxe(page: Page): Promise<string> {
  if (axeSource !== undefined) return axeSource;
  const blank = await page.context().newPage();
  try {
    await blank.evaluate(() => {
      (window as unknown as { module: object }).module = { exports: {} };
    });
    await blank.addScriptTag({ path: axePath() });
    const source = await blank.evaluate(() => (window as unknown as { axe: { source?: string } }).axe.source);
    if (typeof source !== "string") throw new Error("axe-core did not expose its source (axe.source)");
    axeSource = source;
    return source;
  } finally {
    await blank.close();
  }
}

/** What axe finds at WCAG 2.1 A and AA, one line per rule with the elements it names. */
export async function axeViolations(page: Page): Promise<string[]> {
  // Through the protocol, not a <script> tag: a published App is served with the static host's
  // Content Security Policy, which forbids an inline script but not what the test driver evaluates.
  await page.evaluate(await loadAxe(page));
  return page.evaluate(async () => {
    const run = (window as unknown as {
      axe: { run: (context: Document, options: object) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> };
    }).axe;
    const result = await run.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
  });
}

/**
 * Everything wrong with the page at the width it has: a sideways scroll, a table that scrolls
 * sideways on a phone (it should be cards there), overlapping blocks and axe violations. Empty
 * means the view passes.
 */
export async function layoutProblems(page: Page, blocks: string = BLOCKS): Promise<string[]> {
  const problems: string[] = [];
  const { sideways, width } = await page.evaluate(() => ({
    sideways: document.documentElement.scrollWidth - window.innerWidth,
    width: window.innerWidth,
  }));
  if (sideways > 0) problems.push(`the page scrolls sideways by ${sideways} px`);
  if (width < 600) {
    const scrolling = await page
      .locator(".jc-table-wrap")
      .evaluateAll((wraps) => wraps.filter((wrap) => wrap.scrollWidth > wrap.clientWidth + 1).length);
    if (scrolling > 0) problems.push(`${scrolling} table(s) scroll sideways on a phone`);
  }
  for (const pair of await overlaps(page, blocks)) problems.push(`overlap: ${pair}`);
  for (const violation of await axeViolations(page)) problems.push(`axe ${violation}`);
  return problems;
}
