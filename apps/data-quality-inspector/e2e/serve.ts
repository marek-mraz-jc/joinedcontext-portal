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

/** Serves the built bundle at the root of the App's own host, with the SDK stub answering the endpoint. */
export async function serve(page: Page, entities = ENTITIES, schema = SCHEMA_WITH_VEHICLE): Promise<Served> {
  const transport = stubTransport({
    entities,
    schema,
    access: ACCESS,
  });
  const served: Served = { outside: [], missing: [], problems: [] };
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
