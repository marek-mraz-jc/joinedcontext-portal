import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { sdkAlias } from "../vite.config";

/**
 * Every view of an application at a phone, a tablet, a laptop and a wall (T-2777, UI-84, SDK-12).
 *
 * The template's own screens (the overview and a type page: filters, tiles, map, charts, table,
 * export) and a page built from each layout primitive (sidebar, tabs, split with a form and a
 * detail, a grid of cards, the NGSI-LD grid) are built with vite from the sources and served from
 * memory. At each width the page must not scroll sideways, no two blocks may overlap, and axe
 * must find nothing at WCAG 2.1 AA. A screenshot per view and width is attached to the report.
 *
 * The same three checks run against published applications when `JC_APP_URLS` names them
 * (space-separated), for the integrator after an apply:
 *
 *   JC_APP_URLS="https://dev.joinedcontext.com/apps/helsinki-bikes/ …" \
 *     [JC_STORAGE_STATE=signed-in.json] pnpm exec playwright test e2e/responsive.spec.ts -g live
 *
 * `JC_STORAGE_STATE` is a Playwright storage state of a signed-in person, for an App behind the
 * login; a public App needs none.
 */
const PAGE = "http://responsive.test/";
const WIDTHS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
  { width: 2560, height: 1440 },
];

const ENTRY = `
import { createRoot } from "react-dom/client";
import { createElement as h } from "react";
import "../../template/map-worker.ts";
import "../../src/sdk/style.css";
import "../../template/src/components/components.css";
import "../../template/src/app.css";
import { applyTokens, Card, EntityGrid, fixtureSource, Grid, Header, JcProvider, Page, Sidebar, Split, Tabs } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "../../template/src/App.tsx";
import { EntityDetail } from "../../template/src/components/EntityDetail.tsx";
import { EntityForm } from "../../template/src/components/EntityForm.tsx";
import { EntityTable } from "../../template/src/components/EntityTable.tsx";
import { StatTiles } from "../../template/src/components/StatTiles.tsx";
import tokens from "../../template/src/design-tokens.json";
import schema from "../../tests/fixtures/helsinki-air-quality.schema.json";

const STATIONS = ["Kallio", "Mäkelänkatu", "Leppävaara", "Kamppi", "Vallila", "Tikkurila", "Espoonlahti", "Malmi"];
const ROWS = Array.from({ length: 24 }, (_, i) => ({
  id: "urn:ngsi-ld:AirQualityObserved:hel.fi:air-quality:" + (i + 1),
  type: "AirQualityObserved",
  stationName: STATIONS[i % STATIONS.length],
  pm25: Math.round((4 + ((i * 7) % 11) + i / 10) * 10) / 10,
  temperature: 10 + (i % 9),
  dateObserved: new Date(Date.UTC(2026, 8, 1 + i, 8)).toISOString(),
  refStation: "urn:ngsi-ld:Station:hel.fi:air-quality:" + ((i % 8) + 1),
  location: { type: "Point", coordinates: [24.8 + (i % 8) * 0.03, 60.15 + (i % 5) * 0.02] },
}));
const ALL = { permissions: [{ actions: ["*"], resource: { type: "*" }, attributes: "*" }], prohibitions: [] };
const client = stubClient({
  entities: ROWS,
  schema: schema.definitions,
  access: ALL,
  functions: { summary: () => ({ types: [{ type: "AirQualityObserved", count: ROWS.length, averages: { pm25: 9.1 } }] }) },
}, { appName: "Air quality", endpointName: "helsinki-air-quality" });

const GRID = {
  source: { kind: "fixture", name: "readings" },
  type: "AirQualityObserved",
  columns: [{ attr: "stationName" }, { attr: "pm25" }, { attr: "temperature" }, { attr: "dateObserved" }, { attr: "refStation" }],
  entityTimestamps: false, filters: {}, pageSize: 10, mode: "view", editableAttrs: [],
  history: { enabled: false }, density: "comfortable", rowActions: [],
};
const NGSI = ROWS.map((row) => ({
  id: row.id, type: row.type,
  stationName: { type: "Property", value: row.stationName },
  pm25: { type: "Property", value: row.pm25, unitCode: "GQ" },
  temperature: { type: "Property", value: row.temperature, unitCode: "CEL" },
  dateObserved: { type: "Property", value: row.dateObserved },
  refStation: { type: "Relationship", object: row.refStation },
}));

function Layout() {
  const tiles = [{ label: "Readings", agg: "count" }, { label: "Average pm25", agg: "avg", attr: "pm25" }];
  return h("div", { className: "jc-shell" },
    h("main", { className: "jc-main" },
      h(Page, { label: "Desk" },
        h(Header, { level: 1, title: "Air quality desk", subtitle: "Readings of the last month", actions: h("button", { type: "button" }, "Export") }),
        h(Sidebar, { label: "Filters", side: h("p", null, "Stations and dates") },
          h(Tabs, { label: "Views of the readings", tabs: [
            { id: "table", label: "Table", render: () => h(EntityTable, { rows: ROWS, caption: "Readings", pageSize: 8 }) },
            { id: "detail", label: "Detail", render: () => h(EntityDetail, { row: ROWS[0], title: ROWS[0].stationName }) },
          ] }),
          h(Split, { ratio: "2:1" },
            h(EntityForm, { type: "AirQualityObserved", row: ROWS[1], rows: ROWS }),
            h(EntityDetail, { row: ROWS[1], title: ROWS[1].stationName }),
          ),
          h(Grid, { columns: 4 },
            ...STATIONS.slice(0, 4).map((name) =>
              h(Card, { key: name, title: name }, h(StatTiles, { rows: ROWS.filter((row) => row.stationName === name), tiles })),
            ),
          ),
          h(Card, { title: "All readings" }, h(EntityGrid, { config: GRID, source: fixtureSource(NGSI) })),
        ),
      ),
    ),
  );
}

applyTokens(tokens);
const view = new URLSearchParams(location.search).get("view");
createRoot(document.getElementById("root")).render(
  h(JcProvider, { client }, view === "layout" ? h(Layout) : h(App)),
);
`;

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Responsive check</title>
</head><body><div id="root"></div><script type="module" src="./entry.jsx"></script></body></html>`;

const files: Record<string, string> = {};

async function buildFixture(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  // Inside the package, not in /tmp: the entry imports `../src` and needs this `node_modules`.
  const work = join(here, "..", "node_modules", ".responsive-fixture");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "entry.jsx"), ENTRY);
  writeFileSync(join(work, "index.html"), HTML);
  const out = join(work, "dist");
  await build({
    root: work,
    logLevel: "silent",
    configFile: false,
    plugins: [react()],
    resolve: { alias: sdkAlias },
    build: { outDir: out, emptyOutDir: true, target: "es2022", assetsInlineLimit: 64 * 1024 },
  });
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      } else {
        files[`/${prefix}${entry.name}`] = readFileSync(join(dir, entry.name), "utf8");
      }
    }
  };
  walk(out, "");
  files["/"] = files["/index.html"];
}

async function serve(page: Page, problems: string[]): Promise<void> {
  page.on("pageerror", (error) => problems.push(error.message));
  await page.route(`${PAGE}**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = files[path];
    if (body === undefined) {
      return route.fulfill({ status: 404, body: "" });
    }
    return route.fulfill({
      contentType: path.endsWith(".css") ? "text/css" : path === "/" ? "text/html" : "text/javascript",
      body,
    });
  });
}

/** The blocks that must never cover each other: every view, card, field and header part. */
const BLOCKS = [
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

/** What a published App may be built from besides the template's classes. */
const LIVE_BLOCKS = `${BLOCKS}, article, aside, figure, form, table`;

/** Pairs of visible blocks, neither inside the other, whose boxes intersect by more than a pixel. */
async function overlaps(page: Page, blocks = BLOCKS): Promise<string[]> {
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

/** No sideways scroll, no overlapping blocks, nothing axe finds; the screenshot attached first. */
async function checkWidth(page: Page, name: string, width: number, blocks: string, testInfo: import("@playwright/test").TestInfo): Promise<void> {
  await testInfo.attach(`${name}-${width}.png`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(sideways, "the page scrolls sideways").toBeLessThanOrEqual(0);
  if (width < 600) {
    // On a phone a table is cards, not a strip to scroll through.
    const scrolling = await page.locator(".jc-table-wrap").evaluateAll((wraps) =>
      wraps.filter((wrap) => wrap.scrollWidth > wrap.clientWidth + 1).length,
    );
    expect(scrolling, "a table scrolls sideways on a phone").toBe(0);
  }
  expect(await overlaps(page, blocks)).toEqual([]);
  expect(await axeViolations(page)).toEqual([]);
}

const AXE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "axe-core", "axe.min.js"), "utf8");

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (context: Document, options: object) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
  });
}

const VIEWS = [
  { name: "overview", path: "#/overview", ready: "Server summary" },
  { name: "type page", path: "#/AirQualityObserved", ready: "pm25 over time" },
  { name: "layout primitives", path: "?view=layout", ready: "All readings" },
];

test.describe("the template's views", () => {
  test.beforeAll(buildFixture);
  for (const view of VIEWS) {
    for (const size of WIDTHS) {
      test(`${view.name} at ${size.width} px: no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
        const problems: string[] = [];
        await serve(page, problems);
        await page.setViewportSize(size);
        await page.goto(`${PAGE}${view.path}`);
        await expect(page.getByText(view.ready).first()).toBeVisible();
        // The charts draw after the rows, in an effect: wait for their canvases before measuring.
        const charts = page.locator(".jc-chart-canvas");
        for (let i = 0; i < (await charts.count()); i++) {
          await expect(charts.nth(i).locator("canvas")).toBeVisible();
        }
        await checkWidth(page, view.name, size.width, BLOCKS, testInfo);
        expect(problems).toEqual([]);
      });
    }
  }
});

const LIVE = (process.env.JC_APP_URLS ?? "").split(/\s+/).filter(Boolean);

test.describe("live", () => {
  if (process.env.JC_STORAGE_STATE) {
    test.use({ storageState: process.env.JC_STORAGE_STATE });
  }
  for (const url of LIVE) {
    for (const size of WIDTHS) {
      test(`live ${url} at ${size.width} px: no sideways scroll, no overlap, axe clean`, async ({ page }, testInfo) => {
        await page.setViewportSize(size);
        const answer = await page.goto(url);
        expect(answer?.status(), `${url} answers`).toBeLessThan(400);
        await page.waitForLoadState("networkidle");
        await checkWidth(page, new URL(url).pathname.replace(/\W+/g, "-"), size.width, LIVE_BLOCKS, testInfo);
      });
    }
  }
});
