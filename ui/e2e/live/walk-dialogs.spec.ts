/**
 * T-3986 — the interactive half of the walker: on every page `walker.spec.ts` opens, as the steward,
 * press each control that opens a dialog, judge the dialog a person meets, and close it again
 * (UI-01, UI-15, UI-44).
 *
 * Nothing is written. Every request to the Portal API that is not a read is aborted before it
 * leaves the browser, so a control that writes at once instead of opening a dialog writes nothing
 * and is listed under `instant`; a dialog is closed with Escape and never confirmed, so no Change
 * is opened and none is left to reject. Per dialog the walk asks: does it carry a name, does
 * Escape close it, no console error, no read answered >= 400, axe with no serious or critical
 * violation. A screenshot is saved per dialog (`SHOTS_DIR` as the walker); `WALK_ONLY=<regex>`
 * walks only the addresses it matches. The pages walked and the findings are attached as JSON
 * and written to `SHOTS_DIR/walk-dialogs-steward.json`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { axeViolations } from "../axe";
import { STEWARD, hiddenSections, inHiddenSection, signIn } from "./portal";
import { shot, writeIndex } from "./shoot";
import { P, visits } from "./walk-routes";

const ONLY = process.env.WALK_ONLY ? new RegExp(process.env.WALK_ONLY) : undefined;
const DIALOG = "[role='dialog']:visible, [role='alertdialog']:visible";

interface Opened {
  address: string;
  control: string;
  dialog: string;
  findings: string[];
  screenshot: string;
  /** The writes a control sends at once, without a dialog; aborted before they leave the browser. */
  instant?: string[];
}

/** The names of the controls on the page a person can press: buttons in main, no tab, none disabled. */
async function pressable(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const names: string[] = [];
    for (const element of document.querySelectorAll("main button:not([role='tab']), main [role='button']")) {
      if (element.getClientRects().length === 0 || element.closest("[hidden], [inert], [role='dialog']")) continue;
      if ((element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true") continue;
      const name = (element.getAttribute("aria-label") ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  });
}

/** The control a person would press by its name, the first visible one. */
function control(page: Page, name: string): Locator {
  return page.locator("main").getByRole("button", { name, exact: true }).first();
}

test("every dialog on every page opens, says what it is and closes, for the steward", async ({ browser }) => {
  test.setTimeout(3_600_000);
  const { context, page } = await signIn(browser, STEWARD, `${P}/spaces?lang=en`);
  await page.setViewportSize({ width: 1440, height: 900 });
  const report: Opened[] = [];
  const writes: string[] = [];
  const walked: string[] = [];
  let current: string[] = [];
  await page.route("**/api/**", (route) => {
    const request = route.request();
    if (request.method() === "GET" || request.method() === "HEAD") return route.continue();
    writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.abort("blockedbyclient");
  });
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !text.startsWith("Failed to load resource") && !/ERR_BLOCKED_BY_CLIENT/.test(text)) {
      current.push(`console: ${text.slice(0, 200)}`);
    }
  });
  page.on("pageerror", (error) => current.push(`console: ${error.message.slice(0, 200)}`));
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400 && response.request().method() === "GET") {
      current.push(`http: ${response.status()} GET ${new URL(response.url()).pathname}`);
    }
  });

  try {
    const hidden = await hiddenSections(page.request);
    const all = (await visits(page, "steward")).filter((visit) => !inHiddenSection(visit.address, hidden) && (!ONLY || ONLY.test(visit.address)));
    for (const visit of all) {
      walked.push(visit.address);
      const open = async () => {
        await page.goto(`${visit.address}${visit.address.includes("?") ? "&" : "?"}lang=en`, { waitUntil: "load" });
        await page.locator("h1:visible").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
        await page.waitForTimeout(1500);
      };
      await open();
      const names = await pressable(page);
      // A row control ("Remove <name>") repeats on every row and opens the same dialog: one per verb.
      const verb = (name: string) => name.split(" ")[0];
      const repeated = (name: string) => names.filter((other) => verb(other) === verb(name)).length > 1;
      const seen = new Set<string>();
      for (const name of names) {
        const key = repeated(name) ? verb(name) : name;
        if (seen.has(key)) continue;
        seen.add(key);
        if (page.url().split("?")[0] !== new URL(visit.address, page.url()).href.split("?")[0]) await open();
        const button = control(page, name);
        if ((await button.count()) === 0 || !(await button.isEnabled().catch(() => false))) continue;
        current = [];
        const before = writes.length;
        await button.click({ timeout: 5_000 }).catch(() => undefined);
        const dialog = page.locator(DIALOG).first();
        if (!(await dialog.waitFor({ timeout: 3_000 }).then(() => true, () => false))) {
          if (writes.length > before) {
            // A one-click write (a star, "Use in this project" proposing a reference) is by design: recorded, never a finding.
            report.push({ address: visit.address, control: name, dialog: "", findings: [], screenshot: "", instant: writes.slice(before) });
          }
          await page.keyboard.press("Escape");
          continue;
        }
        await page.waitForTimeout(800);
        const title = ((await dialog.getAttribute("aria-label")) ?? (await dialog.locator("h1, h2, [id$='title']").first().textContent().catch(() => "")) ?? "").trim();
        const findings = [
          ...current,
          ...(title ? [] : [`unnamed: the dialog "${name}" opens has no title`]),
          ...(await axeViolations(page)).filter((violation) => /\((serious|critical)\)/.test(violation)).map((violation) => `axe: ${violation.slice(0, 200)}`),
        ];
        const screenshot = test.info().outputPath(`dialog${visit.address.replace(/[^a-z0-9]+/gi, "-")}-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.png`);
        await page.screenshot({ path: screenshot });
        await shot(page, { area: "portal", route: visit.address, state: `dialog-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40)}`, who: "steward", lang: "en" });
        await page.keyboard.press("Escape");
        if (!(await dialog.waitFor({ state: "hidden", timeout: 3_000 }).then(() => true, () => false))) {
          findings.push(`escape: the dialog "${title || name}" stays open on Escape`);
          await open();
        }
        report.push({ address: visit.address, control: name, dialog: title, findings, screenshot });
      }
    }
  } finally {
    // Beside the screenshots too: a passing test's attachments are dropped, and the module rows
    // of human_ui_walk.json are filled from the pages walked, not only from those with a dialog.
    const body = JSON.stringify({ walked, report, writes }, null, 2);
    if (process.env.SHOTS_DIR) {
      writeIndex(process.env.SHOTS_DIR);
      writeFileSync(join(process.env.SHOTS_DIR, "walk-dialogs-steward.json"), body);
    }
    await test.info().attach("walk-dialogs-steward.json", { body, contentType: "application/json" });
    await context.close();
  }
  expect(report.filter((entry) => entry.dialog).length, "the walk opened dialogs").toBeGreaterThan(ONLY ? 0 : 10);
  expect(report.filter((entry) => entry.findings.length > 0).map(({ address, control: name, findings }) => ({ address, control: name, findings }))).toEqual([]);
});
