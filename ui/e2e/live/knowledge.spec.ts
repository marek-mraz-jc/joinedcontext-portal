/**
 * T-3057 — the knowledge sources on dev (API/01 §34): what the page shows is what
 * `/knowledge/sources` answers the same person. Where dev runs the assistant the list carries the
 * declared sources and a crawled one opens its page tree; where it does not yet, the page says
 * the sources could not be read with the Portal's own sentence, never that there are none.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { STEWARD, VIEWER, csrf, signIn } from "./portal";

test.setTimeout(180_000);

const PROJECT = "helsinki";

interface Sources {
  items: { source: string; state: string }[];
}

test("the knowledge sources and one source's page agree with what the API answers", async ({ browser }) => {
  const { context, page } = await signIn(browser, STEWARD, `/projects/${PROJECT}/knowledge?lang=en`);
  try {
    await expect(page.getByRole("heading", { level: 1, name: "Knowledge sources" })).toBeVisible({ timeout: 60_000 });
    const answer = await page.request.get(`/api/v1/projects/${PROJECT}/knowledge/sources`);
    if (!answer.ok()) {
      const problem = (await answer.json()) as { detail?: string };
      await expect(page.getByRole("alert")).toContainText(`The sources could not be read: ${problem.detail ?? ""}`);
      await expect(page.getByText("This project has no knowledge source")).toHaveCount(0);
      return;
    }
    const sources = (await answer.json()) as Sources;
    if (sources.items.length === 0) {
      await expect(page.getByText("This project has no knowledge source")).toBeVisible();
      return;
    }
    const table = page.getByRole("table", { name: "Knowledge sources" });
    for (const item of sources.items) {
      await expect(table.getByRole("row", { name: new RegExp(item.source) })).toBeVisible();
    }
    const crawled = sources.items.find((item) => item.state === "crawled");
    const opened = crawled?.source ?? sources.items[0].source;
    await page.goto(`/projects/${PROJECT}/knowledge/${opened}?lang=en`);
    await expect(page.getByRole("heading", { level: 1, name: `Source ${opened}` })).toBeVisible({ timeout: 60_000 });
    if (crawled) {
      await expect(page.getByRole("checkbox").first()).toBeVisible({ timeout: 60_000 });
    } else {
      await expect(page.getByRole("alert")).toContainText("has not been crawled");
    }
  } finally {
    await context.close();
  }
});

// T-3057 (reopened): the three writes of the knowledge workflow, each leaving dev as it found it.

async function post(page: Page, token: string, path: string, data: unknown) {
  return page.request.post(path, { headers: { "x-csrf-token": token }, data });
}

test("taking back a page already in the answers changes nothing, and a viewer may not leave one out", async ({ browser }) => {
  const steward = await signIn(browser, STEWARD, `/projects/${PROJECT}/knowledge?lang=en`);
  const viewer = await signIn(browser, VIEWER, `/projects/${PROJECT}/knowledge?lang=en`);
  try {
    const sources = await steward.page.request.get(`/api/v1/projects/${PROJECT}/knowledge/sources`);
    const listed = sources.ok() ? ((await sources.json()) as Sources).items : [];
    const crawled = listed.find((item) => item.state === "crawled")?.source ?? "web";
    const refused = await post(viewer.page, await csrf(viewer.context), `/api/v1/projects/${PROJECT}/knowledge/sources/${crawled}/inclusion`, {
      pages: [1],
      included: false,
    });
    // 403 where the viewer reads the sources, 404 where the seed grants them nothing: refused either way.
    expect([403, 404]).toContain(refused.status());
    if (!sources.ok()) {
      // dev runs no assistant yet: the steward meets the Portal's sentence, and nothing was asked.
      expect(sources.status()).toBe(503);
      return;
    }
    const roots = await steward.page.request.get(`/api/v1/projects/${PROJECT}/knowledge/sources/${crawled}/pages`);
    const page = (((await roots.json()) as { items?: { id: number; included: boolean }[] }).items ?? []).find((p) => p.included);
    if (!page) return;
    const answer = await post(steward.page, await csrf(steward.context), `/api/v1/projects/${PROJECT}/knowledge/sources/${crawled}/inclusion`, {
      pages: [page.id],
      included: true,
    });
    expect(answer.status()).toBe(200);
    expect(await answer.json()).toMatchObject({ pages: 0, documents: 0, passagesRemoved: 0 });
  } finally {
    await steward.context.close();
    await viewer.context.close();
  }
});

test("a viewer may not queue a crawl, and a steward's crawl now is queued once", async ({ browser }) => {
  const steward = await signIn(browser, STEWARD, `/projects/${PROJECT}/knowledge?lang=en`);
  const viewer = await signIn(browser, VIEWER, `/projects/${PROJECT}/knowledge?lang=en`);
  try {
    const sources = await steward.page.request.get(`/api/v1/projects/${PROJECT}/knowledge/sources`);
    const listed = sources.ok() ? ((await sources.json()) as Sources).items : [];
    const source = listed.find((item) => item.state === "crawled")?.source ?? "web";
    const path = `/api/v1/projects/${PROJECT}/knowledge/sources/${source}/recrawl`;
    expect([403, 404]).toContain((await post(viewer.page, await csrf(viewer.context), path, {})).status());
    if (!sources.ok()) {
      expect(sources.status()).toBe(503);
      return;
    }
    // The crawl the schedule runs anyway, brought forward: a second ask while it waits is 409.
    const token = await csrf(steward.context);
    const first = await post(steward.page, token, path, {});
    expect([202, 409]).toContain(first.status());
    expect((await post(steward.page, token, path, {})).status()).toBe(409);
  } finally {
    await steward.context.close();
    await viewer.context.close();
  }
});

test("a question outside the contract and an unknown assistant are refused before anything is spent", async ({ browser }) => {
  const { context, page } = await signIn(browser, VIEWER, `/projects/${PROJECT}/knowledge?lang=en`);
  try {
    const token = await csrf(context);
    const unknown = await post(page, token, `/api/v1/projects/${PROJECT}/knowledge/deployments/no-such-assistant/chat`, { message: "Hello" });
    expect(unknown.status()).toBe(404);
    const deployments = await page.request.get(`/api/v1/projects/${PROJECT}/assistantdeployments`);
    const name = (((await deployments.json()) as { items?: { metadata: { name: string } }[] }).items ?? [])[0]?.metadata.name;
    if (!name) return;
    const outside = await post(page, token, `/api/v1/projects/${PROJECT}/knowledge/deployments/${name}/chat`, { message: "Hello", password: "x" });
    expect(outside.status()).toBeGreaterThanOrEqual(400);
    expect(outside.status()).toBeLessThan(500);
  } finally {
    await context.close();
  }
});
