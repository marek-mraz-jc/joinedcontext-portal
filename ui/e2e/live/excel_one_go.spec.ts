/**
 * One workbook, one go (T-6445): a person with only a project editor's rights gives Complete this
 * space one .xlsx, the approver approves the bundle, and the same page loads every row of the
 * chosen sheet without asking for the file again. The count through the space's Endpoint is the
 * proof. Run with SHOTS_DIR set to keep the 1440 and 400 pictures and the timings of each step.
 *
 * Names are `t6445-…`, so the janitor sweeps what a dead run leaves.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { APPROVER, EDITOR, STEWARD, VIEWER, approve, ask, csrf, proposedChange, rejectOpen, removeCompletely, signIn, sweepDrafts } from "./portal";

type Session = { context: BrowserContext; page: Page };

const PROJECT = "helsinki";
const WORKBOOK = join(dirname(fileURLToPath(import.meta.url)), "fixtures/kulturne-miesta-bbsk.xlsx");
const SHEET = "Kultúrne miesta";
const TYPE = "KulturneMiesta";
/** The data rows of the sheet the journey loads; the other sheet holds 275. */
const ROWS = 338;
const SPACE = `t6445-excel-${Date.now().toString().slice(-6)}`;
const SHOTS = process.env.SHOTS_DIR;
/** `EXCEL_VIDEO=<dir>`: the recorded run (T-6445): it starts from the assistant, holds each state to be read and asks about the data. */
const VIDEO = process.env.EXCEL_VIDEO;
const QUESTIONS = [
  `Which attributes does the data model of the context space ${SPACE} have, and are their types right?`,
  `How many ${TYPE} records are there per Mesto in ${SPACE}? Show the five largest.`,
  `Is any column of ${TYPE} in ${SPACE} missing or empty?`,
];
const marks: Record<string, number> = {};
let started = 0;
const mark = (name: string) => {
  marks[name] = Math.round((Date.now() - started) / 100) / 10;
};
const hold = async (page: Page, ms = 2_500) => {
  if (VIDEO) await page.waitForTimeout(ms);
};

/** The newest assistant answer once it stopped growing. */
async function settledAnswer(page: Page, earlier: number): Promise<string> {
  const answers = page.getByRole("listitem").filter({ hasText: "Assistant" });
  await expect.poll(() => answers.count(), { timeout: 180_000 }).toBeGreaterThan(earlier);
  let text = "";
  await expect
    .poll(
      async () => {
        const now = await answers.last().innerText();
        const same = now === text && now.length > 40;
        text = now;
        return same;
      },
      { timeout: 240_000, intervals: [4_000] },
    )
    .toBe(true);
  return text;
}

const timings: { step: string; seconds: number; clicks: number }[] = [];
let lap = Date.now();
function took(step: string, clicks: number): void {
  timings.push({ step, seconds: Math.round((Date.now() - lap) / 100) / 10, clicks });
  lap = Date.now();
}

/** Both widths of one state, full height so the sticky sidebar is not cut. */
async function shot(page: Page, state: string): Promise<void> {
  if (!SHOTS) return;
  const started = Date.now();
  mkdirSync(SHOTS, { recursive: true });
  for (const width of [1440, 400]) {
    await page.setViewportSize({ width, height: 900 });
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width, height: Math.min(height, 4000) });
    await page.screenshot({ path: join(SHOTS, `${state}-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  lap += Date.now() - started;
}

test.describe.configure({ mode: "serial" });

let editor: Session;
let slug = "";

/**
 * Leaves dev with no open Change and no reader of the space. A sync run takes minutes on dev, so
 * nothing here waits for one: a space whose grants are still going is refused with 409 and stays
 * for the residue journey, which removes every `t<task>-` object.
 */
test.afterAll(async ({ browser }) => {
  const steward = await signIn(browser, STEWARD, `/projects/${PROJECT}?lang=en`);
  await rejectOpen(steward, PROJECT, SPACE, "excel_one_go");
  const removed = async (plural: string, name: string) => removeCompletely(steward, PROJECT, plural, name).catch((refused: unknown) => console.log(String(refused)));
  for (const plural of ["endpoints", "policies"]) {
    const answer = await steward.page.request.get(`/api/v1/projects/${PROJECT}/${plural}`);
    const items = answer.ok() ? (((await answer.json()) as { items?: { metadata: { name: string } }[] }).items ?? []) : [];
    for (const { metadata } of items.filter((one) => one.metadata.name.startsWith(SPACE))) await removed(plural, metadata.name);
  }
  await removed("spaces", SPACE);
  await sweepDrafts(editor.context, editor.page, PROJECT, new RegExp(`^${SPACE}`));
  await steward.context.close();
  await editor.context.close();
});

test("one .xlsx makes the model, the space and its rows, read back through the Endpoint", async ({ browser }) => {
  started = Date.now();
  editor = await signIn(browser, EDITOR, VIDEO ? `/projects/${PROJECT}?lang=en` : `/projects/${PROJECT}/spaces/complete?lang=en`);
  const page = editor.page;
  if (VIDEO) {
    await ask(page, "Create a context space and a data model from my Excel file and load all its rows.");
    await expect(page).toHaveURL(/\/spaces\/complete/, { timeout: 120_000 }).catch(() => console.log("the assistant did not open the page"));
    await hold(page, 6_000);
    if (!/\/spaces\/complete/.test(page.url())) await page.goto(`/projects/${PROJECT}/spaces/complete?lang=en`);
  }
  lap = Date.now();
  await expect(page.getByRole("heading", { name: "Complete this space", level: 1 })).toBeVisible();
  await shot(page, "1-empty");

  await page.locator("#complete-space").fill(SPACE);
  await page.keyboard.press("Tab");
  await page.getByLabel("Files", { exact: true }).setInputFiles(WORKBOOK);
  await page.locator("#complete-sheet-0").selectOption(SHEET);
  await expect(page.locator("#complete-sheet-0")).toContainText(`${ROWS} rows`);
  took("Name the space, choose the file and the sheet", 2);
  await hold(page);
  await shot(page, "2-file-chosen");

  await page.locator("#complete-btn").click();
  await expect(page.locator("#complete-propose")).toBeVisible({ timeout: 60_000 });
  for (const kind of ["DataModel", "ContextSpace", "Endpoint"]) {
    await expect(page.getByTestId(`complete-draft-${kind}`)).toContainText("Check passed");
  }
  await expect(page.getByText("Check failed")).toHaveCount(0);
  took("Complete: every draft checked", 1);
  await page.getByTestId("complete-draft-DataModel").scrollIntoViewIfNeeded();
  await hold(page, 4_000);
  await shot(page, "3-drafts-checked");

  const answered = page.waitForResponse((r) => r.url().includes("jc_space_complete"));
  await page.locator("#complete-propose").click();
  const out = (await (await answered).json()) as { drafts?: { kind: string; manifest: { spec?: { slug?: string } } }[] };
  slug = out.drafts?.find((d) => d.kind === "Endpoint")?.manifest.spec?.slug ?? "";
  expect(slug).not.toBe("");
  const change = await proposedChange(page);
  took("Propose all", 1);
  await hold(page);
  mark("proposed");
  await shot(page, "4-proposed");

  const approver = await signIn(browser, APPROVER, `/projects/${PROJECT}/approvals?lang=en`);
  lap = Date.now();
  await approve(approver.page, PROJECT, change, SPACE);
  await approver.context.close();
  took("The approver types the space name and approves (another person, their own page)", 1);

  const write = page.getByRole("button", { name: new RegExp(`Write ${ROWS} rows`) });
  await expect(write).not.toHaveAttribute("aria-disabled", "true", { timeout: 300_000 });
  took("The change goes live, the page unlocks the load by itself", 0);
  await shot(page, "5-approved");

  mark("live");
  await hold(page);
  await write.click();
  await expect(page.getByRole("status").filter({ hasText: `${ROWS} rows written, none refused.` })).toBeVisible({ timeout: 180_000 });
  took("Load every row", 1);
  await shot(page, "6-rows-loaded");

  const read = await page.request.get(`/api/endpoint/${slug}/ngsi-ld/v1/entities?type=${TYPE}&count=true&limit=0`);
  expect(read.status(), await read.text()).toBe(200);
  expect(Number(read.headers()["ngsild-results-count"])).toBe(ROWS);
  took("Read the count through the Endpoint", 0);

  if (VIDEO) {
    await hold(page, 3_000);
    await page.getByRole("link", { name: "Open the space" }).click();
    await page.getByRole("tab", { name: "Data model" }).click();
    await hold(page, 5_000);
    const answered: { question: string; answer: string }[] = [];
    for (const question of QUESTIONS) {
      const earlier = await page.getByRole("listitem").filter({ hasText: "Assistant" }).count();
      await ask(page, question);
      answered.push({ question, answer: await settledAnswer(page, earlier) });
      await hold(page, 6_000);
    }
    writeFileSync(join(VIDEO, "answers.json"), JSON.stringify({ space: SPACE, marks, answered }, null, 1));
  }

  const total = timings.reduce((sum, one) => sum + one.seconds, 0);
  console.log(JSON.stringify({ total: Math.round(total * 10) / 10, clicks: timings.reduce((sum, one) => sum + one.clicks, 0), timings }, null, 1));
  if (SHOTS) writeFileSync(join(SHOTS, `timings-${Date.now()}.json`), JSON.stringify({ space: SPACE, total, timings }, null, 1));
});

test("a viewer reads why, and the op refuses them", async ({ browser }) => {
  const viewer = await signIn(browser, VIEWER, `/projects/${PROJECT}/spaces/complete?lang=en`);
  await expect(viewer.page.getByRole("status").filter({ hasText: "Your role lets you look at these" })).toBeVisible();
  await expect(viewer.page.locator("#complete-btn")).toHaveCount(0);
  await shot(viewer.page, "7-viewer-refused");
  const refused = await viewer.page.request.post(`/api/v1/projects/${PROJECT}/ops/jc_space_complete`, {
    headers: { "x-csrf-token": await csrf(viewer.context), "content-type": "application/json" },
    data: { space: `${SPACE}-v`, files: [{ name: "a.csv", content: "name\nx\n" }], upload: true, propose: true },
  });
  expect(refused.status()).toBe(403);
  await viewer.context.close();
});
