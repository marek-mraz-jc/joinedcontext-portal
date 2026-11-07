import type { Page } from "@playwright/test";
import { odataEndpoints } from "../tests/odataEndpoints";

/**
 * The project's OData Endpoints set (T-6645) for a spec that stubs the plain lists: each OData read
 * is built from the page's own `GET /projects/{p}/endpoints` and shared lists, asked through the
 * page so the spec's stubs answer them. Register it after the spec's own routes: the last route
 * registered runs first, and a spec that answers OData itself keeps its answer.
 */
export async function withODataEndpoints(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/projects\/[^/]+\/odata\//, async (route) => {
    const url = new URL(route.request().url());
    const get = async (path: string): Promise<Response> => {
      const read = await page.evaluate(async (address) => {
        const answer = await fetch(address, { headers: { Accept: "application/json" } });
        return { status: answer.status, type: answer.headers.get("Content-Type"), body: await answer.text() };
      }, path);
      return new Response(read.status === 204 ? null : read.body, {
        status: read.status,
        headers: { "Content-Type": read.type ?? "application/json" },
      });
    };
    const answer = await odataEndpoints(`${url.pathname}${url.search}`, get);
    if (!answer) return route.fallback();
    await route.fulfill({
      status: answer.status,
      headers: Object.fromEntries(answer.headers.entries()),
      body: Buffer.from(await answer.arrayBuffer()),
    });
  });
}
