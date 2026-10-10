/**
 * The User Guide's screenshots, taken by the live journeys themselves so a guide never shows a
 * Portal that no longer exists (T-3270). With `GUIDE_SHOTS=1` a journey's `guideShot(page, name)`
 * writes `test-results/guide/en/{name}.png` and `test-results/guide/sk/{name}.png` of the page as
 * it stands, at 1280 px; without it the call does nothing, so the journeys cost the same as before.
 * `scripts/publish-guide-shots.sh` quantizes the results into the docs repository's
 * `User-Guide/img/`, where `scripts/check-guide-shots.py` holds the guides to the shots that exist.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

/** What a guide may call a shot: lower-case words and digits joined by hyphens. */
const SHOT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The guide's two languages, in the order they are shot (T-3270). */
export const GUIDE_LANGS = ["en", "sk"] as const;
export type GuideLang = (typeof GUIDE_LANGS)[number];

/** The width every guide shot is taken at, so the guides show one Portal at one size. */
export const GUIDE_WIDTH = 1280;
const GUIDE_HEIGHT = 800;

/** Where a shot is written, relative to the run's directory; a name that is not a shot name throws. */
export function guideShotPath(lang: GuideLang, name: string, root = "test-results/guide"): string {
  if (!SHOT_NAME.test(name)) throw new Error(`guide shot name ${JSON.stringify(name)} is not lower-case-words-with-hyphens`);
  return join(root, lang, `${name}.png`);
}

/** Whether this run takes guide shots at all. */
export function guideShotsOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GUIDE_SHOTS === "1";
}

/** The language menu's words in a locale, read as the walker reads the bundles (no JSON import in Playwright's loader). */
function langWords(lang: GuideLang): { label: string; en: string; sk: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  return (JSON.parse(readFileSync(join(here, `../../src/locales/${lang}.json`), "utf8")) as { lang: { label: string; en: string; sk: string } }).lang;
}

const LABELS: Record<GuideLang, { label: string; name: string }> = {
  en: { label: langWords("en").label, name: langWords("en").en },
  sk: { label: langWords("sk").label, name: langWords("sk").sk },
};

/** Switches the Portal's language through its own header menu, as a person would. */
async function switchTo(page: Page, from: GuideLang, to: GuideLang): Promise<void> {
  await page.getByRole("button", { name: LABELS[from].label }).first().click();
  await page.getByRole("menuitem", { name: LABELS[to].name }).click();
  await page.waitForFunction((lang) => document.documentElement.lang === lang, to);
}

/**
 * Shoots the page as it stands, in English and in Slovak, for the guide step `name`. A password
 * field is masked, so no shot can carry one. The page is left in English at the size it had.
 * The language is switched through the header's menu, so a shot is taken with no dialog open:
 * a modal dialog hides the header from the menu's click.
 */
export async function guideShot(page: Page, name: string, root = "test-results/guide"): Promise<void> {
  if (!guideShotsOn()) return;
  const lang = await page.evaluate(() => document.documentElement.lang);
  if (lang !== "en") throw new Error(`guide shot ${name}: the page is in ${JSON.stringify(lang)}; journeys shoot from English (?lang=en)`);
  if (await page.locator("[role=dialog][aria-modal=true]").count()) {
    throw new Error(`guide shot ${name}: a dialog is open; shoot the page before or after it`);
  }
  const size = page.viewportSize();
  await page.setViewportSize({ width: GUIDE_WIDTH, height: GUIDE_HEIGHT });
  try {
    for (const [at, current] of GUIDE_LANGS.entries()) {
      if (at > 0) await switchTo(page, GUIDE_LANGS[at - 1], current);
      const path = guideShotPath(current, name, root);
      mkdirSync(join(path, ".."), { recursive: true });
      await page.screenshot({ path, animations: "disabled", caret: "hide", mask: [page.locator("input[type=password]")] });
    }
    await switchTo(page, GUIDE_LANGS[GUIDE_LANGS.length - 1], "en");
  } finally {
    if (size) await page.setViewportSize(size);
  }
}
