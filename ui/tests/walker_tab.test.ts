import type { BrowserContext, Page } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { Tab } from "../e2e/live/tab";

// T-5730: a renderer crash ("Target crashed") in one page ended the steward's walk with no report.
// The tab opens a fresh page in the same context and the walk goes on.
function fakePage() {
  const handlers: Record<string, (() => void)[]> = {};
  return {
    closed: false,
    on(event: string, handler: () => void) {
      (handlers[event] ??= []).push(handler);
    },
    crash() {
      for (const handler of handlers.crash ?? []) handler();
    },
    async close() {
      this.closed = true;
    },
  };
}

function tabOver() {
  const pages = [fakePage()];
  const set: unknown[] = [];
  const context = {
    async newPage() {
      const page = fakePage();
      pages.push(page);
      return page;
    },
  } as unknown as BrowserContext;
  const tab = new Tab(context, pages[0] as unknown as Page, (page) =>
    set.push(page),
  );
  return { tab, pages, set };
}

describe("walker Tab", () => {
  it("answers the work's value on a live tab", async () => {
    const { tab, pages } = tabOver();
    expect(await tab.run(async () => 7)).toEqual({ crashed: false, value: 7 });
    expect(tab.page).toBe(pages[0]);
  });

  it("opens a fresh tab, set up again, after the renderer crashed", async () => {
    const { tab, pages, set } = tabOver();
    const outcome = await tab.run(async () => {
      pages[0].crash();
      throw new Error("locator.evaluateAll: Target crashed");
    });
    expect(outcome).toEqual({ crashed: true });
    expect(pages).toHaveLength(2);
    expect(tab.page).toBe(pages[1]);
    expect(set).toEqual([pages[0], pages[1]]);
    expect(pages[0].closed).toBe(true);
    expect(await tab.run(async (page) => page)).toEqual({
      crashed: false,
      value: pages[1],
    });
  });

  it("throws any other error", async () => {
    const { tab, pages } = tabOver();
    await expect(
      tab.run(async () => {
        throw new Error("Timeout 30000ms exceeded");
      }),
    ).rejects.toThrow("Timeout");
    expect(pages).toHaveLength(1);
  });
});
