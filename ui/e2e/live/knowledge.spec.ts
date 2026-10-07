/**
 * T-3057 — the knowledge sources on dev (API/01 §34): what the page shows is what
 * `/knowledge/sources` answers the same person. Where dev runs the assistant the list carries the
 * declared sources and a crawled one opens its page tree; where it does not yet, the page says
 * the sources could not be read with the Portal's own sentence, never that there are none.
 */
import { expect, test } from "@playwright/test";
import { STEWARD, signIn } from "./portal";

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
