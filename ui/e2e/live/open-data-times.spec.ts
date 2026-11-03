/**
 * T-6540: how long a visitor waits on the open data portal's dataset pages (EP-82). For each
 * dataset of the named publishers, an anonymous browser opens `/catalogue/{name}` cold (a fresh
 * context, empty HTTP cache) and warm (the same page again in that context), and times the
 * dataset card (h1), the data grid's first row and the map's first drawn features, each with the
 * slowest request that finished before it.
 *
 * A hand-run measuring tool, kept out of the hourly sweep (sweep.sh), run with --no-deps:
 *
 *   OPEN_DATA_PUBLISHERS=zilina,banskabystrica OPEN_DATA_WIDTHS=1440,400 OPEN_DATA_OUT=times.jsonl \
 *     PORTAL_URL=https://portal.dev.joinedcontext.com \
 *     npx playwright test -c playwright.live.config.ts --no-deps --project=chromium open-data-times
 *
 * OPEN_DATA_LIMIT caps datasets per publisher; OPEN_DATA_NAMES (comma list) times only those.
 * Reads are paced: each page waits OPEN_DATA_PAUSE_MS (default 1500) so one run stays well under
 * the edge's 600 reads a minute. With OPEN_DATA_BUDGET=1 a warm page at 1440 over 2 s to its
 * first grid row or 3 s to its first map features fails the test.
 */
import { appendFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Browser, Page, Request } from "@playwright/test";

const PUBLISHERS = (process.env.OPEN_DATA_PUBLISHERS ?? "bratislava,banskabystrica,bbsk,zilina,slovensko").split(",").filter(Boolean);
const WIDTHS = (process.env.OPEN_DATA_WIDTHS ?? "1440").split(",").map(Number).filter((width) => width > 0);
const LIMIT = Number(process.env.OPEN_DATA_LIMIT ?? "0") || Infinity;
const NAMES = (process.env.OPEN_DATA_NAMES ?? "").split(",").filter(Boolean);
const PAUSE = Number(process.env.OPEN_DATA_PAUSE_MS ?? "1500");
const OUT = process.env.OPEN_DATA_OUT;
const BUDGET = process.env.OPEN_DATA_BUDGET === "1";
const WAIT = 30_000;

test.setTimeout(6 * 60 * 60_000);

interface Slowest {
  url: string;
  ms: number;
}

interface Times {
  card: number | null;
  /** "none": the grid answered no row; "absent": the page has no data section (a Portal before T-6376). */
  grid: number | null | "none" | "absent";
  map: number | null | "none";
  slowest: { card?: Slowest; grid?: Slowest; map?: Slowest };
  /** Answers the edge rate-limited (429) during the visit: such a visit times the limit, not the page. */
  limited: number;
}

/** The data rows of the SDK grid, never its spacer or group rows. */
const GRID_ROW = '[data-jc-sdk="grid"] tbody tr:not(.jc-grid-spacer):not(.jc-grid-group)';
/** The grid's own end states, which also end the wait: a refusal, an empty answer or a failure. */
const GRID_END = '[data-jc-sdk="grid"] .jc-grid-refusal, [data-jc-sdk="grid"] .jc-grid-empty, section[aria-labelledby="catalogue-data"] [role="alert"]';
const DATA = 'section[aria-labelledby="catalogue-data"]';
const MAP = 'section[aria-labelledby="catalogue-map"] canvas';

async function datasets(page: Page): Promise<{ publisher: string; name: string }[]> {
  if (NAMES.length > 0) return NAMES.map((name) => ({ publisher: "-", name }));
  const all: { publisher: string; name: string }[] = [];
  for (const publisher of PUBLISHERS) {
    for (let number = 1; all.filter((each) => each.publisher === publisher).length < LIMIT; number++) {
      const answer = await page.request.get(`/api/v1/catalogue?publisher=${encodeURIComponent(publisher)}&page=${number}`);
      expect(answer.ok(), `the catalogue lists ${publisher} (page ${number})`).toBe(true);
      const listed = (await answer.json()) as { total: number; datasets: { name: string }[] };
      for (const each of listed.datasets.slice(0, LIMIT - all.filter((one) => one.publisher === publisher).length)) {
        all.push({ publisher, name: each.name });
      }
      if (listed.datasets.length === 0 || number * 20 >= listed.total) break;
    }
  }
  return all;
}

/** The slowest request that ended before `at` (ms since the navigation started). */
function slowestBefore(finished: { url: string; start: number; end: number }[], at: number): Slowest | undefined {
  const before = finished.filter((each) => each.end <= at + 50);
  const top = before.sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  return top ? { url: top.url.replace(/^https?:\/\/[^/]+/, ""), ms: Math.round(top.end - top.start) } : undefined;
}

async function visit(page: Page, name: string): Promise<Times> {
  const finished: { url: string; start: number; end: number }[] = [];
  let started = 0;
  let mapFeatures: number | undefined;
  let limited = 0;
  const onLimited = (response: import("@playwright/test").Response) => {
    if (response.status() === 429) limited++;
  };
  const onFinished = (request: Request) => {
    const timing = request.timing();
    if (timing.startTime > 0 && timing.responseEnd >= 0) {
      finished.push({ url: request.url(), start: timing.startTime - started, end: timing.startTime - started + timing.responseEnd });
    }
  };
  const onMap = async (response: import("@playwright/test").Response) => {
    if (!/\/api\/v1\/catalogue\/datasets\/[^/]+\/map/.test(response.url())) return;
    try {
      const body = (await response.json()) as { features?: unknown[] };
      mapFeatures = body.features?.length ?? 0;
    } catch {
      mapFeatures = 0;
    }
  };
  page.on("requestfinished", onFinished);
  page.on("response", onMap);
  page.on("response", onLimited);
  started = Date.now();
  const since = () => Date.now() - started;
  const times: Times = { card: null, grid: null, map: null, slowest: {}, limited: 0 };
  try {
    await page.goto(`/catalogue/${encodeURIComponent(name)}?lang=en`, { waitUntil: "commit" });
    const card = page.getByRole("heading", { level: 1 }).waitFor({ timeout: WAIT }).then(() => (times.card = since()), () => undefined);
    // A row ends the wait; an end state counts only once it has held for 3 s, since the grid can
    // show its empty line for a moment before the first page arrives.
    const grid = (async () => {
      const deadline = Date.now() + WAIT;
      let ended: number | undefined;
      while (Date.now() < deadline) {
        if ((await page.locator(GRID_ROW).count()) > 0) return (times.grid = since());
        if (typeof times.card === "number" && since() - times.card > 3_000 && (await page.locator(DATA).count()) === 0) {
          return (times.grid = "absent");
        }
        if ((await page.locator(GRID_END).count()) > 0) {
          ended ??= Date.now();
          if (Date.now() - ended >= 3_000) return (times.grid = "none");
        } else ended = undefined;
        await page.waitForTimeout(50);
      }
      return undefined;
    })();
    const map = (async () => {
      const deadline = Date.now() + WAIT;
      while (Date.now() < deadline) {
        if (mapFeatures === 0) return (times.map = "none");
        if (mapFeatures !== undefined && (await page.locator(MAP).count()) > 0) {
          // The canvas exists once MapLibre starts; the features are drawn when it goes idle.
          await page
            .locator(MAP)
            .first()
            .evaluate((canvas) => new Promise<void>((done) => {
              const box = canvas.getBoundingClientRect();
              if (box.width > 0) requestAnimationFrame(() => requestAnimationFrame(() => done()));
              else done();
            }));
          return (times.map = since());
        }
        await page.waitForTimeout(50);
      }
      return undefined;
    })();
    await Promise.all([card, grid, map]);
  } finally {
    page.off("requestfinished", onFinished);
    page.off("response", onMap);
    page.off("response", onLimited);
  }
  times.limited = limited;
  for (const key of ["card", "grid", "map"] as const) {
    const at = times[key];
    if (typeof at === "number") times.slowest[key] = slowestBefore(finished, at);
  }
  return times;
}

async function measure(browser: Browser, width: number, publisher: string, name: string): Promise<void> {
  // A visitor's browser sends no run header: the config's X-JC-Run-Origin would make the grid's
  // cross-origin read to the api host a CORS preflight the gateway refuses.
  const context = await browser.newContext({ viewport: { width, height: width >= 1000 ? 900 : 860 }, extraHTTPHeaders: {} });
  const page = await context.newPage();
  try {
    for (const run of ["cold", "warm"] as const) {
      let times = await visit(page, name);
      // The edge allows each client address 300 Portal-host requests a minute, shared with every
      // other run from the same host: a visit it refused is waited out and taken again.
      for (let again = 0; times.limited > 0 && again < 3; again++) {
        await page.waitForTimeout(30_000);
        times = await visit(page, name);
      }
      const row = { at: new Date().toISOString(), base: test.info().project.use.baseURL, width, run, publisher, name, ...times };
      if (OUT) appendFileSync(OUT, `${JSON.stringify(row)}\n`);
      console.log(JSON.stringify(row));
      if (BUDGET && run === "warm" && width === 1440) {
        expect.soft(times.card, `${name}: the card shows`).not.toBeNull();
        if (typeof times.grid === "number") expect.soft(times.grid, `${name}: warm grid first rows`).toBeLessThanOrEqual(2_000);
        else expect.soft(times.grid, `${name}: the grid answers within ${WAIT} ms`).not.toBeNull();
        if (typeof times.map === "number") expect.soft(times.map, `${name}: warm map first features`).toBeLessThanOrEqual(3_000);
        else expect.soft(times.map, `${name}: the map answers within ${WAIT} ms`).toBe("none");
      }
      await page.waitForTimeout(PAUSE);
    }
  } finally {
    await context.close();
  }
}

test("a visitor's dataset pages show card, grid and map in time", async ({ browser }) => {
  const lister = await browser.newContext();
  const all = await datasets(await lister.newPage());
  await lister.close();
  expect(all.length, "the named publishers list datasets").toBeGreaterThan(0);
  for (const width of WIDTHS) {
    for (const { publisher, name } of all) await measure(browser, width, publisher, name);
  }
});
