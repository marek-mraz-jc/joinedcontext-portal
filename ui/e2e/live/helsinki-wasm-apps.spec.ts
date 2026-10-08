/**
 * The Helsinki apps that compute in WebAssembly, on dev (T-3331..T-3333, AP-142): each opened by an
 * anonymous visitor, as a public App is, answers its question on arrival with live data; its module
 * comes from its own bundle as `application/wasm`, and the page runs under a CSP that allows
 * `'wasm-unsafe-eval'` and nothing wider. The time to the first answer is printed for the task.
 * Read only.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const APPS_URL = process.env.APPS_URL ?? "https://dev.joinedcontext.com";

test.setTimeout(240_000);

/** Opens an App anonymously and watches its module and its CSP on the way. */
async function open(page: Page, app: string, search: string) {
  const wasm: { type: string; url: string }[] = [];
  page.on("response", (response) => {
    if (response.url().endsWith(".wasm")) wasm.push({ type: response.headers()["content-type"] ?? "", url: response.url() });
  });
  const started = Date.now();
  const response = await page.goto(`${APPS_URL}/apps/${app}/${search}`, { waitUntil: "domcontentloaded" });
  const csp = response?.headers()["content-security-policy"] ?? "";
  return { wasm, csp, started };
}

function expectWasmPolicy(csp: string, wasm: { type: string; url: string }[], app: string) {
  expect(csp, "the static host's CSP").toContain("'wasm-unsafe-eval'");
  expect(csp.split(/[\s;]+/), "no eval of JavaScript").not.toContain("'unsafe-eval'");
  expect(wasm.length, "the module was loaded").toBeGreaterThan(0);
  for (const each of wasm) {
    expect(each.type).toContain("application/wasm");
    expect(new URL(each.url).pathname).toContain(`/apps/${app}/`);
  }
}

test("alerts-heatmap answers where and when with the live alerts", async ({ page }) => {
  const { wasm, csp, started } = await open(page, "alerts-heatmap", "?lang=en");
  await expect(page.locator(".app-summary")).toHaveText(/^[\d,]+ alerts from \d{1,2} \w{3} \d{4} to \d{1,2} \w{3} \d{4}\./, { timeout: 120_000 });
  console.log(`alerts-heatmap: first answer after ${Date.now() - started} ms`);
  await expect(page.getByTestId("jc-map").locator("canvas")).toHaveCount(1);
  await expect(page.getByRole("list", { name: "Places alerts keep coming back to" })).toBeVisible();
  expectWasmPolicy(csp, wasm, "alerts-heatmap");
});
