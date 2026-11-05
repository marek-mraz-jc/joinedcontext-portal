/**
 * T-6516: a person draws a live Endpoint in Grafana from the Portal (T-6509). The film saves PM2.5 of
 * helsinki-air-quality as a time series at 1440 and at 400 (T-6603: every state on the phone too) and
 * opens it in Grafana, held until the panel is drawn. A second test saves Number, Table and Map once each and reads every panel in Grafana, because
 * src/grafana.rs dashboard_of wrote their JSON from the plugin source and Grafana never drew it. Every
 * `t6516-` visualization is removed again. Saving needs propose on Dashboard, which the dev seed gives
 * demo.editor (helsinki-role-editor.yaml): EDITOR_PASSWORD.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { EDITOR, csrf, withLocalUi } from "./portal";
import { CLIP_DIR, SIZES, clipOf, type Clip } from "./clips";
import { shareEdge } from "./edgeShare";

const PROJECT = "helsinki";
const ADDRESS = `/projects/${PROJECT}/grafana?lang=en`;
const ENDPOINT = "helsinki-air-quality";
const TYPE = "AirQualityObserved";
const PREFIX = "t6516-";
/** A readable title the film can show, tagged so the clean-up finds it again. */
const titled = (words: string) => `${words} (${PREFIX}${Date.now().toString(36)})`;

test.setTimeout(600_000);
test.skip(!EDITOR.password, "the editor signs in with EDITOR_PASSWORD");
test.describe.configure({ mode: "serial" });

async function choose(page: Page, kind: string, attribute: string, title: string): Promise<void> {
  await page.getByLabel("Endpoint", { exact: true }).selectOption(ENDPOINT);
  await page.getByLabel("Type", { exact: true }).selectOption(TYPE);
  await page.getByLabel("Attribute", { exact: true }).selectOption(attribute);
  await page.getByLabel("Visualization", { exact: true }).selectOption(kind);
  await page.getByLabel("Name", { exact: true }).fill(title);
}

async function save(page: Page, title: string): Promise<string> {
  await page.getByRole("button", { name: "Save to Grafana" }).click();
  const link = page.getByRole("link", { name: `Open ${title} in Grafana` });
  await expect(link).toBeVisible({ timeout: 60_000 });
  return (await link.getAttribute("href")) ?? "";
}

/**
 * Opens a saved dashboard; Grafana signs the person in through the same Keycloak session. Returns once
 * every panel is drawn: a 7-day query can take seconds after the panel frame appears, and a phone clip
 * that stopped at the frame filmed "Loading plugin panel" (T-6603).
 */
async function openInGrafana(page: Page, href: string): Promise<void> {
  await page.goto(href, { waitUntil: "load" });
  const sso = page.getByRole("link", { name: /Sign in with/ });
  if (await sso.isVisible().catch(() => false)) await sso.click();
  const panel = page.locator("[data-viz-panel-key], [data-testid^='data-testid Panel header']").first();
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Loading plugin panel")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator(".panel-loading, [aria-label='Panel loading bar']")).toHaveCount(0, { timeout: 60_000 });
  await expect(panel.locator(DRAWN).first()).toBeVisible({ timeout: 90_000 });
}

/** What a drawn panel holds: a chart or map canvas, a table, a number, or Grafana's own "No data". */
const DRAWN = "canvas, [role='table'], [role='grid'], table, [data-testid='data-testid panel content'] span, :text-is('No data')";

/** What Grafana drew: panel errors and "No data" are both a failed visualization. */
async function drawn(page: Page): Promise<{ errors: number; noData: number }> {
  return {
    errors: await page.locator("[data-testid='data-testid Panel status error']").count(),
    noData: await page.getByText("No data", { exact: true }).count(),
  };
}

/** The form filled, the preview read, the save and its "Open it": the same states at every width. */
async function pickPreviewSave(clip: Clip, title: string): Promise<string> {
  const { page } = clip;
  let href = "";
  await clip.step("Grafana in the project: pick what to draw", async () => {
    await expect(page.getByRole("button", { name: "Save to Grafana" })).toBeVisible({ timeout: 60_000 });
  });
  await clip.step("Helsinki air quality, PM2.5, as a time series", async () => {
    await choose(page, "timeseries", "pm25", title);
    await page.getByLabel("Name", { exact: true }).scrollIntoViewIfNeeded();
  });
  await clip.step("The preview: the rows you can read now", async () => {
    const preview = page.getByText("The first rows you can read now, as Grafana will draw them.");
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("dl dd").first()).toBeVisible({ timeout: 30_000 });
    await preview.scrollIntoViewIfNeeded();
  }, 5_000);
  await clip.step("Save: the Portal writes it into the project's Grafana folder", async () => {
    href = await save(page, title);
    await page.getByRole("link", { name: "Open it" }).scrollIntoViewIfNeeded();
  });
  return href;
}

/**
 * The whole page at one width, outside the film: the viewport grown to the page's height, because a
 * fullPage capture paints the sticky top bar over the middle of the page (KNOWLEDGE T-6423).
 */
async function wholePage(browser: Browser, signedIn: BrowserContext, width: number, path: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, storageState: await signedIn.storageState() });
  try {
    await withLocalUi(context);
    await shareEdge(context);
    const page = await context.newPage();
    await page.goto(ADDRESS, { waitUntil: "load" });
    await expect(page.getByRole("button", { name: "Save to Grafana" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("link", { name: /^Open .* in Grafana$/ }).first()).toBeVisible({ timeout: 60_000 });
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width, height });
    await page.screenshot({ path });
  } finally {
    await context.close();
  }
}

async function removeOurs(page: Page): Promise<void> {
  const list = await page.request.get(`/api/v1/projects/${PROJECT}/grafana`);
  if (!list.ok()) throw new Error(`clean-up could not list visualizations: ${list.status()}`);
  const body = (await list.json()) as { items?: { id: string; title: string }[] };
  const headers = { "x-csrf-token": await csrf(page.context()) };
  const ours = (body.items ?? []).filter((item) => item.title.startsWith(PREFIX) || item.title.includes(`(${PREFIX}`));
  const failed: string[] = [];
  for (const item of ours) {
    const gone = await page.request.delete(`/api/v1/projects/${PROJECT}/grafana/${item.id}`, { headers });
    if (!gone.ok()) failed.push(`${item.title}: ${gone.status()}`);
  }
  console.log(`removed ${ours.length - failed.length} of ${ours.length} test visualizations`);
  if (failed.length > 0) throw new Error(`clean-up left ${failed.join(", ")}; the next run removes them`);
}

test("a Grafana time series from a live Endpoint, at 1440 and 400", async ({ browser }) => {
  for (const size of SIZES) {
    const title = titled("PM2.5 by station");
    const clip = await clipOf(browser, EDITOR, "grafana-create", size, ADDRESS);
    try {
      const href = await pickPreviewSave(clip, title);
      await wholePage(browser, clip.context, size.width, `${CLIP_DIR}/page-${size.width}.png`);
      await clip.step("Open it in Grafana: live PM2.5 by station", async () => {
        await openInGrafana(clip.page, href);
        expect(await drawn(clip.page)).toEqual({ errors: 0, noData: 0 });
      }, 6_000);
    } finally {
      await removeOurs(clip.page).catch((failed: unknown) => console.log(String(failed)));
      await clip.finish().catch((failed: unknown) => console.log(String(failed)));
    }
  }
});

test("Number, Table and Map draw in Grafana", async ({ browser }) => {
  const clip = await clipOf(browser, EDITOR, "grafana-kinds", SIZES[0], ADDRESS);
  const { page } = clip;
  const seen: Record<string, { errors: number; noData: number }> = {};
  try {
    for (const [kind, attribute] of [["stat", "pm25"], ["table", "pm25"], ["map", "location"]] as const) {
      const title = titled(`Air quality ${kind}`);
      await page.goto(ADDRESS, { waitUntil: "load" });
      await expect(page.getByRole("button", { name: "Save to Grafana" })).toBeVisible({ timeout: 60_000 });
      await choose(page, kind, attribute, title);
      const href = await save(page, title);
      await openInGrafana(page, href);
      await clip.step(`${kind} in Grafana`, async () => {
        seen[kind] = await drawn(page);
      }, 2_000);
    }
    console.log(`kinds drawn: ${JSON.stringify(seen)}`);
    for (const kind of Object.keys(seen)) expect(seen[kind], kind).toEqual({ errors: 0, noData: 0 });
  } finally {
    await removeOurs(page).catch((failed: unknown) => console.log(String(failed)));
    await clip.finish().catch((failed: unknown) => console.log(String(failed)));
  }
});
