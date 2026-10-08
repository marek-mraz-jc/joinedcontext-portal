// The weight every page of the Portal pays before it answers (T-3280): the entry chunk the
// built index.html loads, gzipped. A route's own code loads with the route; what is left in the
// entry is what every visit downloads first. Over the budget, the build lane goes red with the
// chunk named, so a static import of a heavy page is caught the day it lands.
//
//   node scripts/bundle-budget.mjs ui/dist
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * KB, gzipped. Measured 1 679 on 2026-10-08 before T-3280 and 978 after the heavy pages, the form
 * engine and the map loaded with their routes; 1 000 before and 729 after T-3316 loaded only the
 * chosen language, 493 once the create and edit dialogs loaded with their first opening. The
 * budget is the last measure plus 5 %.
 */
export const ENTRY_BUDGET_KB = 518;

/** The scripts index.html loads at once: the entry, and the chunks it preloads. */
export function entryScripts(html) {
  return [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*rel="modulepreload"[^>]*\shref)="\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
}

export function weightKb(bytes) {
  return Math.round(gzipSync(bytes).length / 1024);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dist = process.argv[2];
  if (!dist) {
    console.error("usage: node scripts/bundle-budget.mjs <ui/dist>");
    process.exit(2);
  }
  const scripts = entryScripts(readFileSync(join(dist, "index.html"), "utf8"));
  if (scripts.length === 0) {
    console.error("index.html loads no script: the build is not what this budget measures");
    process.exit(1);
  }
  const weights = scripts.map((script) => [script, weightKb(readFileSync(join(dist, script)))]);
  const total = weights.reduce((sum, [, kb]) => sum + kb, 0);
  for (const [script, kb] of weights) console.log(`${String(kb).padStart(6)} KB gz  ${script}`);
  console.log(`${String(total).padStart(6)} KB gz  every page, before it answers (budget ${ENTRY_BUDGET_KB})`);
  if (total > ENTRY_BUDGET_KB) {
    console.error(`over the budget by ${total - ENTRY_BUDGET_KB} KB: load the heavy page lazily (router.tsx) instead of raising the number`);
    process.exit(1);
  }
}
