/**
 * A walker tab that outlives a renderer crash (T-5730). Chromium's renderer can die under host
 * memory pressure ("Target crashed"); every later call on that page throws, so one crash ended the
 * steward's whole walk with an empty report. `run` notices the crash, opens a fresh tab in the same
 * signed-in context (cookies and routes are the context's) and tells the caller, which reports the
 * crash on the page it hit and walks on.
 */
import type { BrowserContext, Page } from "@playwright/test";

export type Outcome<T> = { crashed: false; value: T } | { crashed: true };

export class Tab {
  page!: Page;
  private crashed = false;

  /** `setup` runs on every page the tab opens: the listeners the walk judges by. */
  constructor(
    private readonly context: BrowserContext,
    page: Page,
    private readonly setup: (page: Page) => void,
  ) {
    this.adopt(page);
  }

  private adopt(page: Page): void {
    this.page = page;
    this.crashed = false;
    page.on("crash", () => {
      this.crashed = true;
    });
    this.setup(page);
  }

  /** Runs `work` on the tab. A crash under it opens a fresh tab; any other error is `work`'s own and is thrown. */
  async run<T>(work: (page: Page) => Promise<T>): Promise<Outcome<T>> {
    try {
      return { crashed: false, value: await work(this.page) };
    } catch (error) {
      if (!this.crashed) throw error;
      const dead = this.page;
      this.adopt(await this.context.newPage());
      await dead.close().catch(() => undefined);
      return { crashed: true };
    }
  }
}
