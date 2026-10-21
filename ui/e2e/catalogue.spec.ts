import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { axeViolations } from "./axe";

// The public catalogue (EP-81, EP-82, T-2726) as somebody who is not signed in opens it: the
// built bundle, the API answered from the browser, `/auth/me` answering 401 as it does for a
// visitor with no session.

const ENDPOINT = "http://127.0.0.1/api/endpoint/k7m2qz4tv6xh3n5jb2ryd3wcfa/";

const PAGE = {
  total: 1,
  page: 1,
  pageSize: 20,
  datasets: [
    {
      name: "bbsk-kpi",
      title: "Ukazovatele kraja",
      notes: "Ukazovatele Banskobystrického samosprávneho kraja.",
      publisher: { name: "bbsk", title: "Banskobystrický samosprávny kraj" },
      licence: { id: "cc-by", title: "Creative Commons Attribution" },
      formats: ["CSV", "NGSI-LD"],
      themes: ["ECON"],
      modified: "2026-09-21T05:52:34Z",
    },
  ],
  facets: {
    publisher: [{ value: "bbsk", label: "Banskobystrický samosprávny kraj", count: 1 }],
    theme: [{ value: "ECON", label: "Economy and finance", count: 1 }],
    format: [{ value: "CSV", label: "CSV", count: 1 }],
    licence: [{ value: "cc-by", label: "Creative Commons Attribution", count: 1 }],
    spatial: [],
    year: [{ value: "2026", label: "2026", count: 1 }],
  },
  unavailable: [],
};

const DETAIL = {
  name: "bbsk-kpi",
  title: "Ukazovatele kraja",
  notes: "Ukazovatele Banskobystrického samosprávneho kraja.",
  keywords: ["ukazovatele"],
  publisher: { name: "bbsk", title: "Banskobystrický samosprávny kraj" },
  licence: { id: "cc-by", title: "Creative Commons Attribution" },
  themes: [{ code: "ECON", label: "Economy and finance" }],
  spatial: [],
  catalogueUrl: "https://data.example.org/dataset/bbsk-kpi",
  resources: [{ name: "CSV", format: "CSV", url: `${ENDPOINT}file.csv` }],
  endpoint: { url: ENDPOINT, representations: ["ngsi-ld", "csv"] },
  model: { name: "kpi", classes: [{ name: "KeyPerformanceIndicator", description: "An indicator." }] },
};

const SAMPLE = {
  type: "KeyPerformanceIndicator",
  columns: ["id", "type", "value"],
  rows: [["urn:ngsi-ld:KeyPerformanceIndicator:bbsk:kpi:1", "KeyPerformanceIndicator", "12"]],
};

async function stubApi(page: Page, asked: string[]): Promise<void> {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    asked.push(url.pathname + url.search);
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: status >= 400 ? "application/problem+json" : "application/json",
        body: JSON.stringify(body),
      });
    if (url.pathname.endsWith("/auth/me")) return json({ title: "Unauthorized", status: 401 }, 401);
    if (url.pathname === "/api/v1/catalogue") return json(PAGE);
    if (url.pathname === "/api/v1/catalogue/datasets/bbsk-kpi") return json(DETAIL);
    if (url.pathname === "/api/v1/catalogue/datasets/bbsk-kpi/sample") return json(SAMPLE);
    if (url.pathname === "/api/v1/catalogue/datasets/gone") {
      return json({ title: "Not Found", status: 404, detail: "dataset 'gone' is not in the catalogue" }, 404);
    }
    return json({ title: "Not Found", status: 404, detail: "not stubbed" }, 404);
  });
}

test.describe("the public catalogue", () => {
  test("a visitor searches, filters and opens a dataset without signing in", async ({ page }) => {
    const asked: string[] = [];
    await stubApi(page, asked);

    await page.goto("/catalogue?lang=en");
    await expect(page.getByRole("heading", { level: 1, name: "Catalogue" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Ukazovatele kraja" })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);

    await page.getByRole("checkbox", { name: /Economy and finance/ }).check();
    await expect(page).toHaveURL(/theme=/);
    await expect.poll(() => asked.some((a) => a.startsWith("/api/v1/catalogue?") && a.includes("theme=ECON"))).toBe(true);

    await page.getByRole("searchbox", { name: "Search datasets" }).fill("kraj");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect.poll(() => asked.some((a) => a.includes("q=kraj"))).toBe(true);

    await page.getByRole("link", { name: "Ukazovatele kraja" }).click();
    await expect(page).toHaveURL(/\/catalogue\/bbsk-kpi$/);
    await expect(page.getByRole("heading", { level: 1, name: "Ukazovatele kraja" })).toBeVisible();
    await expect(page.getByRole("table", { name: /Up to ten KeyPerformanceIndicator/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "From a shell (NGSI-LD)" })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    // Nothing on either page asked for a project: the catalogue needs no session.
    expect(asked.filter((a) => a.startsWith("/api/v1/projects"))).toEqual([]);
  });

  // T-4265 (photo audit T-4160 #15, #40): a curl line, a URL or a NUTS URI is one long word; it ran
  // past its card and, at 768 px, made the whole page scroll sideways.
  for (const width of [375, 768]) {
    test(`a dataset's long values wrap inside their cards at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      // Registered after the stub, so it answers first: Playwright tries the newest route first.
      await stubApi(page, []);
      const curl = `curl -H 'Accept: application/ld+json' '${ENDPOINT}ngsi-ld/v1/entities?type=KeyPerformanceIndicator&limit=1000&options=keyValues'`;
      // A predicate, not a glob: the route gate reads a glob's star and slash as the end of a comment.
      await page.route((url) => url.pathname === "/api/v1/catalogue/datasets/bbsk-kpi", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...DETAIL,
            spatial: ["http://data.europa.eu/nuts/code/SK032", "http://data.europa.eu/nuts/code/CZ010"],
            resources: [{ name: "NGSI-LD API", format: "NGSI-LD", url: `${ENDPOINT}ngsi-ld/v1/entities`, description: curl }],
          }),
        }),
      );
      await page.goto("/catalogue/bbsk-kpi?lang=sk");
      await expect(page.getByRole("heading", { level: 1, name: "Ukazovatele kraja" })).toBeVisible();
      // The publisher's text waits behind its disclosure (T-4264); opened, it wraps in its card.
      await page.getByText("Pre vývojárov").click();
      await expect(page.getByText(curl)).toBeVisible();
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(sideways, "the page scrolls sideways").toBeLessThanOrEqual(0);
      const frame = page.getByRole("group", { name: "Zdroje" });
      const wider = await frame.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(wider, "the resources table is wider than its frame").toBeLessThanOrEqual(1);
    });
  }

  // T-4949: the publisher's Markdown (jcctl publish) quotes JSON and commands; they read as code,
  // never as JSON in a sentence, on a desktop and a phone.
  for (const width of [1440, 400]) {
    test(`a dataset's commands and JSON read as code at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await stubApi(page, []);
      const live =
        "Live updates: open one WebSocket, subscribe to the entities you want. With `websocat`, then type the subscription:\n\n" +
        `    websocat --protocol ngsi-ld-ws '${ENDPOINT}ws'\n` +
        '    {"metadata":{"x-op":"x-subscribe","x-id":"s1"},"body":{"type":"Subscription","entities":[{"type":"KeyPerformanceIndicator"}]}}\n\n' +
        "Public: anyone reads it.";
      const mcp =
        `For AI assistants: a Model Context Protocol server over this dataset's endpoint ${ENDPOINT}mcp.\n\n` +
        `An MCP client reaches it with this configuration:\n\n    {"mcpServers":{"bbsk-kpi":{"type":"http","url":"${ENDPOINT}mcp"}}}\n`;
      await page.route((url) => url.pathname === "/api/v1/catalogue/datasets/bbsk-kpi", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...DETAIL,
            notes: "Ukazovatele Banskobystrického samosprávneho kraja, mesačne.\n\n    curl 'https://data.example.org/kpi.csv'",
            resources: [
              { name: "Live updates", format: "WebSocket", url: `${ENDPOINT}ws`, description: live },
              { name: "MCP", format: "MCP", url: `${ENDPOINT}mcp`, description: mcp },
            ],
          }),
        }),
      );
      await page.goto("/catalogue/bbsk-kpi?lang=en");
      await expect(page.getByRole("heading", { level: 1, name: "Ukazovatele kraja" })).toBeVisible();
      for (const toggle of await page.getByText("For developers").all()) await toggle.click();
      await expect(page.locator("pre code", { hasText: '"x-op":"x-subscribe"' })).toBeVisible();
      await expect(page.locator("pre code", { hasText: '"mcpServers"' })).toBeVisible();
      await expect(page.locator("code", { hasText: /^websocat$/ })).toBeVisible();
      await expect(page.locator("pre code", { hasText: "curl 'https://data.example.org/kpi.csv'" })).toBeVisible();
      // No JSON outside code, as the live walker judges a page (pageChecks raw-json).
      const raw = await page.evaluate(() =>
        [...document.querySelectorAll("main p, main div, main span, main li")]
          .flatMap((el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => (n.textContent ?? "").trim()))
          .filter((text) => /^\s*[[{]\s*"|"\s*:\s*[[{"]/.test(text)),
      );
      expect(raw).toEqual([]);
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(sideways, "the page scrolls sideways").toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);
      if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/dataset-code-${width}.png`, fullPage: true });
    });
  }

  test("a dataset the catalogue does not hold says so and leads back", async ({ page }) => {
    await stubApi(page, []);
    await page.goto("/catalogue/gone?lang=en");
    await expect(page.getByText("No public dataset has this name")).toBeVisible();
    await page.getByRole("link", { name: "All datasets" }).click();
    await expect(page).toHaveURL(/\/catalogue(\?.*)?$/);
  });
});
