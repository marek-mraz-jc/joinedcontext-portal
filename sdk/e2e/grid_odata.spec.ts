import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { build } from "vite";

/**
 * The grid over an OData entity set in a real browser (T-6644): one journey per state (filled,
 * empty, error, refused edit) at 1440 and 400 px. The page is the SDK grid with an `odata` source
 * over the browser's own fetch (`originTransport`); the spec answers the OData service itself with
 * the answers odata-axum gives (T-6642), so the leg is offline.
 *
 * `ODATA_UPSTREAM` (e.g. http://127.0.0.1:42041/odata for odata-axum's `tables` example) sends the
 * service requests to a running server instead, for the live evidence of a task.
 */
const PAGE = "http://gridodata.test/";
const SHOTS = process.env.SHOTS_DIR ?? "test-results/grid-odata";
const UPSTREAM = process.env.ODATA_UPSTREAM;
const SET = process.env.ODATA_SET ?? "Things";

const ENTRY = `
import { createRoot } from "react-dom/client";
import { createElement as h } from "react";
import { EntityGrid } from "../../src/grid/EntityGrid";
import { parseGridConfig } from "../../src/grid/config";
import { columnsOf, odataSource } from "../../src/grid/odata";
import { originTransport } from "../../src/sdk/transport";

const params = new URLSearchParams(location.search);
const set = params.get("set") ?? "Things";
const source = odataSource("/odata", set, originTransport());
const edits = params.get("edit") ? { [params.get("edit")]: { [params.get("attr")]: params.get("value") } } : undefined;
source.metadata().then(
  (described) => {
    const { config, findings } = parseGridConfig({
      source: { kind: "odata", url: "/odata", entitySet: set },
      type: described.entityType,
      columns: columnsOf(described),
      pageSize: 2,
      mode: edits ? "edit" : "view",
      editableAttrs: described.properties.filter((p) => p.name !== described.key).map((p) => p.name),
      density: "comfortable",
    });
    if (!config) throw new Error(JSON.stringify(findings));
    createRoot(document.getElementById("root")).render(
      h("main", { style: { padding: 16 } }, h("h1", null, set), h(EntityGrid, { config, source, hidden: ["entity:type"], state: edits ? { edits } : undefined })),
    );
  },
  (error) => { document.getElementById("root").textContent = "metadata: " + error.message; },
);
`;

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OData grid</title></head><body><div id="root"></div><script type="module" src="./entry.jsx"></script></body></html>`;

const CSDL = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0"><edmx:DataServices>
<Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="Example">
<EntityType Name="Thing"><Key><PropertyRef Name="id"/></Key>
<Property Name="id" Type="Edm.String" Nullable="false"/><Property Name="name" Type="Edm.String"/><Property Name="size" Type="Edm.Int64"/>
</EntityType>
<EntityContainer Name="Service"><EntitySet Name="Things" EntityType="Example.Thing"/></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;

/** A value that would close its literal and widen the filter if it were spliced in as text. */
const ATTACK = "') or true or ('";
const ESCAPED = "''') or true or ('''";

const THINGS = [
  { id: "t1", name: "Alpha", size: 3 },
  { id: "t2", name: "Beta", size: 1 },
  { id: "t3", name: "Gamma", size: 7 },
];

const files: Record<string, string> = {};

test.beforeAll(async () => {
  const work = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".gridodata-fixture");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "entry.jsx"), ENTRY);
  writeFileSync(join(work, "index.html"), HTML);
  const out = join(work, "dist");
  await build({ root: work, logLevel: "silent", build: { outDir: out, emptyOutDir: true, target: "es2022" } });
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else files[`/${prefix}${entry.name}`] = readFileSync(join(dir, entry.name), "utf8");
    }
  };
  walk(out, "");
  files["/"] = files["/index.html"];
});

/** A small OData service over THINGS, as odata-axum answers: $filter by name and size, sort, paging, count. */
function stub(state: State, asked: string[], things: typeof THINGS) {
  return async (route: Route): Promise<void> => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    asked.push(`${route.request().method()} ${decodeURIComponent(path + url.search)}`);
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/odata/$metadata") return route.fulfill({ status: 200, contentType: "application/xml", body: CSDL });
    if (path === "/odata/Things/$allowed") {
      return state === "writable"
        ? json(200, { allowed: true, permission: null, reason: "" })
        : json(200, { allowed: false, permission: null, reason: "Things does not offer update" });
    }
    if (route.request().method() === "PATCH" && state === "writable") {
      // A write is conditional on the tag the row was read with.
      if (route.request().headers()["if-match"] !== '"v1"') return json(412, { error: { code: "PreconditionFailed", message: "changed" } });
      Object.assign(things[0], route.request().postDataJSON());
      return route.fulfill({ status: 204, headers: { etag: '"v2"' } });
    }
    if (path !== "/odata/Things") return json(404, { error: { code: "NotFound", message: "the resource does not exist" } });
    if (state === "error") return json(503, { error: { code: "ServiceUnavailable", message: "the list is being rebuilt; try again in a minute" } });
    const filter = url.searchParams.get("$filter") ?? "";
    let rows = state === "empty" ? [] : things.map((row, at) => (at === 0 ? { "@odata.etag": '"v1"', ...row } : row));
    const contains = /contains\(name,'(.*)'\)/.exec(filter);
    if (contains) rows = rows.filter((row) => row.name.includes(contains[1].replace(/''/g, "'")));
    const gt = /size gt (\d+)/.exec(filter);
    if (gt) rows = rows.filter((row) => row.size > Number(gt[1]));
    if (url.searchParams.get("$orderby") === "size desc") rows = [...rows].sort((a, b) => b.size - a.size);
    const skip = Number(url.searchParams.get("$skip") ?? 0);
    const top = Number(url.searchParams.get("$top") ?? 100);
    return json(200, { "@odata.context": "http://gridodata.test/odata/$metadata#Things", "@odata.count": rows.length, value: rows.slice(skip, skip + top) });
  };
}

type State = "filled" | "empty" | "error" | "writable";

async function open(page: Page, width: number, state: State, query = ""): Promise<{ asked: string[]; problems: string[] }> {
  const asked: string[] = [];
  const problems: string[] = [];
  const things = THINGS.map((row) => ({ ...row }));
  await page.setViewportSize({ width, height: 800 });
  page.on("pageerror", (error) => problems.push(error.message));
  await page.route(`${PAGE}**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/odata/")) {
      if (!UPSTREAM) return stub(state, asked, things)(route);
      asked.push(`${route.request().method()} ${decodeURIComponent(url.pathname + url.search)}`);
      const response = await route.fetch({ url: `${UPSTREAM}${url.pathname.slice("/odata".length)}${url.search}` });
      return route.fulfill({ response });
    }
    const body = files[url.pathname];
    if (body === undefined) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: url.pathname.endsWith(".js") ? "text/javascript" : url.pathname.endsWith(".css") ? "text/css" : "text/html", body });
  });
  await page.goto(`${PAGE}${query}`);
  return { asked, problems };
}

/** The header filter of `column` (the phone layout keeps it too): `contains` and the text. */
async function filterContains(page: Page, column: string, text: string): Promise<void> {
  await page.getByRole("button", { name: `Filter column: ${column}` }).click();
  const dialog = page.getByRole("dialog", { name: `Filter: ${column}` });
  await dialog.getByRole("combobox", { name: `Condition: ${column}` }).selectOption({ label: "contains" });
  await dialog.getByRole("textbox").last().fill(text);
  await dialog.getByRole("button", { name: "Apply" }).click();
}

/** The refused edit: the review asks `$allowed`, shows its reason on the row and sends no write. */
async function refusedEdit(page: Page, asked: string[], set: string, key: string, reason: string): Promise<void> {
  await page.getByRole("button", { name: "Review the changes" }).click();
  const review = page.getByRole("region", { name: "Review the changes" }).first();
  await review.getByRole("textbox").last().fill("Typo in the name");
  await review.getByRole("button", { name: /apply/i }).click();
  await expect(review.getByText(`${key}: You may not change this row: ${reason}. Discard the change.`)).toBeVisible();
  expect(asked).toContain(`GET /odata/${set}/$allowed?op=update&key=${key}`);
  expect(asked.some((a) => a.startsWith("PATCH"))).toBe(false);
}

for (const width of UPSTREAM ? [] : [1440, 400]) {
  test(`filled: filter, sort, paging and count are the OData answer's at ${width}px`, async ({ page }) => {
    const { asked, problems } = await open(page, width, "filled");
    const grid = page.getByRole("grid");
    await expect(grid).toContainText("Alpha");
    await expect(grid).toHaveAttribute("aria-rowcount", "4");
    await page.screenshot({ path: `${SHOTS}/filled-${width}.png`, fullPage: true });
    // The next page is $skip of the OData set, its rows the server's.
    await page.getByRole("button", { name: /next/i }).first().click();
    await expect(grid).toContainText("Gamma");
    // The count is its own read (limit 0), the rows ask for no count (T-6161).
    expect(asked).toContain("GET /odata/Things?$top=0&$count=true");
    expect(asked).toContain("GET /odata/Things?$top=2&$skip=2");
    // A sort orders the whole set on the server.
    await page.getByRole("button", { name: "Sort all rows by size" }).click();
    await expect.poll(() => asked.some((a) => a.includes("$orderby=size"))).toBe(true);
    // A typed value with quotes and parentheses reaches the server as one literal.
    await filterContains(page, "name", ATTACK);
    await expect.poll(() => asked.find((a) => a.includes("$filter")) ?? "none", { timeout: 10_000 }).toContain(`contains(name,${ESCAPED})`);
    await expect(grid).not.toContainText("Alpha");
    await filterContains(page, "name", "ph");
    await expect(grid).toContainText("Alpha");
    await expect(grid).not.toContainText("Beta");
    await expect(grid).toHaveAttribute("aria-rowcount", "2");
    await page.screenshot({ path: `${SHOTS}/filtered-${width}.png`, fullPage: true });
    expect(problems).toEqual([]);
  });
}

/**
 * The live leg (ODATA_UPSTREAM): odata-axum's `tables` example, a MemoryTable `Things` (t1 Alpha,
 * t2 Beta) or a GitTable `Files` (f1..f4, f4 titled "O'Brien (draft)"): the count, a filter with a
 * quote and the example's refusal of every write, as the server answers them.
 */
const LIVE = { Things: { column: "name", text: "lph", total: 2, key: "t1" }, Files: { column: "title", text: "O'Brien", total: 4, key: "f1" } }[SET];
for (const width of UPSTREAM && LIVE ? [1440, 400] : []) {
  test(`live ${SET}: count, filter and a refused edit as the server answers at ${width}px`, async ({ page }) => {
    const { asked, problems } = await open(page, width, "filled", `?set=${SET}`);
    await expect(page.getByText(`${LIVE!.total} matching`)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/live-${SET}-${width}.png`, fullPage: true });
    await filterContains(page, LIVE!.column, LIVE!.text);
    await expect(page.getByRole("grid")).toHaveAttribute("aria-rowcount", "2");
    await expect(page.getByText("1 matching")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/live-${SET}-filtered-${width}.png`, fullPage: true });
    await page.goto(`${PAGE}?set=${SET}&edit=${LIVE!.key}&attr=${LIVE!.column}&value=Changed`);
    await refusedEdit(page, asked, SET, LIVE!.key, `${SET} does not offer update`);
    await page.screenshot({ path: `${SHOTS}/live-${SET}-refused-edit-${width}.png`, fullPage: true });
    expect(problems).toEqual([]);
  });
}

// The stubbed states need the stub service: with ODATA_UPSTREAM only the live journey runs.
for (const width of UPSTREAM ? [] : [1440, 400]) {
  test.describe(() => {
    test(`empty: says there are no rows at ${width}px`, async ({ page }) => {
      const { problems } = await open(page, width, "empty");
      await expect(page.getByText(/no (rows|entities|matching)/i).first()).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/empty-${width}.png`, fullPage: true });
      expect(problems).toEqual([]);
    });

    test(`error: shows the module's own sentence at ${width}px`, async ({ page }) => {
      const { problems } = await open(page, width, "error");
      await expect(page.getByText("the list is being rebuilt; try again in a minute")).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/error-${width}.png`, fullPage: true });
      expect(problems).toEqual([]);
    });

    test(`refused edit: $allowed is asked and its reason shown, no write sent at ${width}px`, async ({ page }) => {
      const { asked, problems } = await open(page, width, "filled", "?edit=t1&attr=name&value=Alfa");
      await refusedEdit(page, asked, "Things", "t1", "Things does not offer update");
      await page.screenshot({ path: `${SHOTS}/refused-edit-${width}.png`, fullPage: true });
      expect(problems).toEqual([]);
    });

    test(`edit: the change is sent as PATCH with If-Match and the row reads it back at ${width}px`, async ({ page }) => {
      const { asked, problems } = await open(page, width, "writable", "?edit=t1&attr=name&value=Alfa");
      await page.getByRole("button", { name: "Review the changes" }).click();
      const review = page.getByRole("region", { name: "Review the changes" }).first();
      await review.getByRole("textbox").last().fill("Typo in the name");
      await review.getByRole("button", { name: /apply/i }).click();
      await expect(page.getByRole("region", { name: "Review the changes" })).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: /name/i }).first()).toHaveValue("Alfa");
      expect(asked).toContain("PATCH /odata/Things('t1')");
      await page.screenshot({ path: `${SHOTS}/edited-${width}.png`, fullPage: true });
      expect(problems).toEqual([]);
    });
  });
}
