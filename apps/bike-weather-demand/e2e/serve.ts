import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { stubTransport } from "@joinedcontext/sdk/testing";
import { ENTITIES, NOW, TEMPORAL } from "../src/fixtures/bikes";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
export const BASE = "http://portal.test/";
const SLUG = "r7bxzgiatcruw4b7l2rrkufidz";
const CONFIG = {
  slug: SLUG,
  orgDomain: "hel.fi",
  space: "helsinki",
  transport: "origin",
  appName: "bike-weather-demand",
  // Where the entity panel links a station (SDK-40); shown, never followed.
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

/** The App's server (T-3355) as the page sees it: two kept models of whichever station is asked. */
const MODELS = {
  models: [
    { id: 2, trained_on: "2030-10-21", trained_at: "2030-10-21T06:00:00Z", hours: 160, enough: true, per_degree: 0.42, rain: -1.5, sigma: 2.25, weather_station: "urn:ngsi-ld:WeatherObserved:w1" },
    { id: 1, trained_on: "2030-10-20", trained_at: "2030-10-20T06:00:00Z", hours: 150, enough: true, per_degree: 0.4, rain: -1.2, sigma: 2.5, weather_station: "urn:ngsi-ld:WeatherObserved:w1" },
  ],
  stale: false,
};

/** Serves the built bundle at the root of the App's own host, with the SDK stub answering the endpoint. */
export async function serve(page: Page, entities = ENTITIES, temporal = TEMPORAL): Promise<Served> {
  await page.clock.setFixedTime(new Date(NOW * 1000));
  const transport = stubTransport({
    entities,
    temporal,
    access: {
      permissions: [
        { resource: { type: "BikeHireDockingStation" }, actions: ["queryEntity", "retrieveEntity", "retrieveTemporal"], attributes: "*" },
        { resource: { type: "WeatherObserved" }, actions: ["queryEntity", "retrieveEntity", "retrieveTemporal"], attributes: "*" },
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
    if (url.pathname === "/apps/bike-weather-demand/api/models" && url.searchParams.get("station")?.startsWith("urn:")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MODELS) });
    }
    const snapshot = /^\/apps\/bike-weather-demand\/api\/models\/(\d+)\/snapshot$/.exec(url.pathname);
    if (snapshot) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: `http://portal.test/store/training/${snapshot[1]}.json` }) });
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
