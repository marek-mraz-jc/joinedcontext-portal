import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { stubTransport } from "@joinedcontext/sdk/testing";
import { ENTITIES, NOW, SCHEMA_WITH_VEHICLE } from "../src/fixtures/quality";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
export const BASE = "http://portal.test/";
const SLUG = "rywjgug3g32ayfjwkzr5j3tqom";
const CONFIG = {
  slug: SLUG,
  orgDomain: "hel.fi",
  space: "helsinki",
  transport: "origin",
  appName: "data-quality-inspector",
  // Where the entity panel links an entity (SDK-40); shown, never followed.
  portal: "https://portal.hel.fi/projects/helsinki",
};

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

export interface Served {
  outside: string[];
  missing: string[];
  problems: string[];
}

const ACCESS = {
  permissions: [
    { resource: { type: "BikeHireDockingStation" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" },
    { resource: { type: "CityDistrict" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" },
    { resource: { type: "Event" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" },
    { resource: { type: "Vehicle" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" },
  ],
  prohibitions: [],
};

/** The App's server (T-3354) as the page sees it: the runs it keeps, in memory, a run now added. */
function appServer() {
  const runs = [{ id: 1, ran_at: "2030-10-20T09:00:00Z", types: [], entities: 40, findings: 3, completeness: 0.9, valid: 0.75 }];
  return (method: string, path: string): { status: number; body: unknown } => {
    if (path === "/runs" && method === "GET") return { status: 200, body: { runs: [...runs].reverse(), stale: false } };
    if (path === "/runs" && method === "POST") {
      const id = runs.length + 1;
      runs.push({ id, ran_at: "2030-10-21T09:00:00Z", types: [], entities: 41, findings: 2, completeness: 0.92, valid: 0.8 });
      return { status: 201, body: { id } };
    }
    const report = /^\/runs\/(\d+)\/report$/.exec(path);
    if (report && runs.some((r) => r.id === Number(report[1]))) return { status: 200, body: { url: `http://portal.test/store/runs/${report[1]}/report.json` } };
    return { status: 404, body: { title: "Not Found", detail: "no such run" } };
  };
}

/** Serves the built bundle at the root of the App's own host, with the SDK stub answering the endpoint. */
export async function serve(page: Page, entities = ENTITIES, schema = SCHEMA_WITH_VEHICLE): Promise<Served> {
  const transport = stubTransport({
    entities,
    schema,
    access: ACCESS,
  });
  const served: Served = { outside: [], missing: [], problems: [] };
  const api = appServer();
  page.on("pageerror", (error) => served.problems.push(error.message));
  // The page reads ages against the fixtures' moment, so they are the ones the unit tests assert.
  await page.clock.setFixedTime(new Date(NOW * 1000));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://portal.test") {
      served.outside.push(url.href);
      return route.abort();
    }
    if (url.pathname.startsWith(`/api/endpoint/${SLUG}/`)) {
      const body = route.request().postData();
      const answer = await transport({
        method: route.request().method() as "GET",
        path: url.pathname + url.search,
        body: body ? JSON.parse(body) : undefined,
      });
      return route.fulfill({
        status: answer.status,
        contentType: "application/json",
        body: JSON.stringify(answer.body ?? null),
      });
    }
    if (url.pathname.startsWith("/apps/data-quality-inspector/api/")) {
      const answer = api(route.request().method(), url.pathname.slice("/apps/data-quality-inspector/api".length));
      return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
    }
    const file = normalize(url.pathname.slice(1) || "index.html");
    if (file.startsWith("..") || !existsSync(join(DIST, file))) {
      served.missing.push(url.pathname);
      return route.fulfill({ status: 404, body: "" });
    }
    let body = readFileSync(join(DIST, file));
    if (file === "index.html") {
      body = Buffer.from(
        body
          .toString("utf8")
          .replace(
            '<script id="jc-config" type="application/json"></script>',
            `<script id="jc-config" type="application/json">${JSON.stringify(CONFIG)}</script>`,
          ),
      );
    }
    const headers =
      file === "index.html"
        ? { "Content-Security-Policy": "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:" }
        : undefined;
    return route.fulfill({
      status: 200,
      contentType: TYPES[extname(file)] ?? "application/octet-stream",
      body,
      headers,
    });
  });
  return served;
}
