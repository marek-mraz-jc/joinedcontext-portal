import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { stubTransport } from "@joinedcontext/sdk/testing";
import { ENTITIES } from "../src/fixtures/districts";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
export const BASE = "http://portal.test/";
const SLUG = "2yawubrec4dv22ty3pyksixi7r";
const CONFIG = {
  slug: SLUG,
  orgDomain: "hel.fi",
  space: "helsinki",
  transport: "origin",
  appName: "district-compare",
  // Where the entity panel links a district (SDK-40); shown, never followed.
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

/** Serves the built bundle at the root of the App's own host, with the SDK stub answering the endpoint. */
export async function serve(page: Page, entities = ENTITIES): Promise<Served> {
  const transport = stubTransport({
    entities,
    access: {
      permissions: [
        { resource: { type: "CityDistrict" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" },
        { resource: { type: "Event" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" },
        { resource: { type: "BikeHireDockingStation" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" },
        { resource: { type: "Alert" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" },
        { resource: { type: "AirQualityObserved" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" },
      ],
      prohibitions: [],
    },
  });
  const served: Served = { outside: [], missing: [], problems: [] };
  page.on("pageerror", (error) => served.problems.push(error.message));
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
