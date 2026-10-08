import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { stubTransport } from "@joinedcontext/sdk/testing";
import { AIR_STATIONS, HISTORY, NOW, WEATHER_STATIONS } from "../src/fixtures/stations";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
export const BASE = "http://portal.test/";
const SLUG = "airweatherexplorer";
const CONFIG = { slug: SLUG, orgDomain: "hel.fi", space: "helsinki", transport: "origin", appName: "air-weather-explorer", language: "en" };
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};
// What the Portal's static host sends for a `kind: ui` App once T-3327 allows WebAssembly: no
// 'unsafe-eval', only 'wasm-unsafe-eval', and nothing from another host.
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";

/** What the served page did that it should not: a host it called, a file it missed, an error it threw. */
export interface Served {
  outside: string[];
  missing: string[];
  problems: string[];
}

/** Serves the built bundle at the root of the App's own host, with the SDK's stub answering its endpoint. */
export async function serve(page: Page): Promise<Served> {
  const transport = stubTransport({
    entities: [...AIR_STATIONS, ...WEATHER_STATIONS],
    temporal: HISTORY,
    access: {
      permissions: ["AirQualityObserved", "WeatherObserved"].map((type) => ({ resource: { type }, actions: ["queryEntity", "retrieveEntity", "retrieveTemporal"], attributes: "*" as const })),
      prohibitions: [],
    },
  });
  const served: Served = { outside: [], missing: [], problems: [] };
  page.on("pageerror", (error) => served.problems.push(error.message));
  await page.clock.setFixedTime(new Date(NOW));

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://portal.test") {
      served.outside.push(url.href);
      return route.abort();
    }
    if (url.pathname.startsWith(`/api/endpoint/${SLUG}/`)) {
      const body = route.request().postData();
      const path = url.pathname + url.search;
      const answer = await transport({ method: route.request().method() as "GET", path, body: body ? JSON.parse(body) : undefined });
      return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body ?? null) });
    }
    const file = normalize(url.pathname.slice(1) || "index.html");
    if (file.startsWith("..") || !existsSync(join(DIST, file))) {
      served.missing.push(url.pathname);
      return route.fulfill({ status: 404, body: "" });
    }
    let body = readFileSync(join(DIST, file));
    if (file === "index.html") {
      body = Buffer.from(
        body.toString("utf8").replace('<script id="jc-config" type="application/json"></script>', `<script id="jc-config" type="application/json">${JSON.stringify(CONFIG)}</script>`),
      );
    }
    return route.fulfill({
      status: 200,
      contentType: TYPES[extname(file)] ?? "application/octet-stream",
      headers: { "content-security-policy": CSP },
      body,
    });
  });
  return served;
}
