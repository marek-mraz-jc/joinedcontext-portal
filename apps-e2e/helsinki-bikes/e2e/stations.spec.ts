import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { stubTransport } from "@joinedcontext/sdk/testing";
import { STATIONS } from "../src/fixtures/stations";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const BASE = "http://portal.test/apps/helsinki-bikes/";
const SLUG = "helsinkibikes";
const CONFIG = { slug: SLUG, orgDomain: "hel.fi", space: "helsinki", transport: "origin", appName: "helsinki-bikes" };
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

// AP-07, AP-14: the served bundle lists the five stations and the filter hides the ones with none.
test("the stations page shows the five stations and the filter hides the empty ones", async ({ page }) => {
  const transport = stubTransport({
    entities: STATIONS,
    access: { permissions: [{ resource: { type: "BikeHireDockingStation" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" }], prohibitions: [] },
  });
  const outside: string[] = [];
  const missing: string[] = [];
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://portal.test") {
      outside.push(url.href);
      return route.abort();
    }
    if (url.pathname.startsWith(`/api/endpoint/${SLUG}/`)) {
      const body = route.request().postData();
      const answer = await transport({ method: route.request().method() as "GET", path: url.pathname + url.search, body: body ? JSON.parse(body) : undefined });
      return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body ?? null) });
    }
    if (!url.pathname.startsWith("/apps/helsinki-bikes/")) return route.fulfill({ status: 404, body: "" });
    const file = normalize(url.pathname.slice("/apps/helsinki-bikes/".length) || "index.html");
    if (file.startsWith("..") || !existsSync(join(DIST, file))) {
      missing.push(url.pathname);
      return route.fulfill({ status: 404, body: "" });
    }
    let body = readFileSync(join(DIST, file));
    if (file === "index.html") {
      body = Buffer.from(
        body.toString("utf8").replace('<script id="jc-config" type="application/json"></script>', `<script id="jc-config" type="application/json">${JSON.stringify(CONFIG)}</script>`),
      );
    }
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body });
  });

  await page.goto(`${BASE}#stations`);
  const stations = page.getByRole("region", { name: "Stations" });
  const table = stations.getByRole("table");
  for (const station of STATIONS) await expect(table.getByText(String(station.name))).toBeVisible();

  await stations.getByRole("checkbox", { name: "Only stations with bikes" }).check();
  await expect(table.getByText("Laivasillankatu")).toHaveCount(0);
  await expect(table.getByText("Sepänkatu")).toHaveCount(0);
  await expect(table.getByText("Viiskulma")).toHaveCount(0);
  await expect(table.getByText("Kaivopuisto")).toBeVisible();

  // AP-11: nothing left the page for another host, and the bundle ran without an error. The
  // map's worker is part of the bundle: a published app has no library folder to find it in.
  await expect(stations.getByTestId("jc-map").locator("canvas")).toHaveCount(1);
  expect(missing).toEqual([]);
  expect(outside).toEqual([]);
  expect(problems).toEqual([]);
});
