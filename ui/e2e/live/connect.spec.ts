/**
 * T-4169 — the public MCP setup page on dev: a visitor with no session opens the region's
 * connector page, reads its tools from the live server and finds the Claude Code command.
 */
import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

test("a visitor opens the region's public MCP connector page", async ({ browser }) => {
  const visitor = await browser.newContext();
  try {
    const page = await visitor.newPage();
    await page.goto(`/connect/bbsk/otvorene-data?lang=sk`, { waitUntil: "load" });
    await expect(page.getByRole("heading", { level: 1, name: "Pripojte AI asistenta" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("query_entities", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/^claude mcp add --transport http bbsk-otvorene-data https:\/\//)).toBeVisible();
  } finally {
    await visitor.close();
  }
});
