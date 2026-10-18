/**
 * T-4552 — a signed-in steward opens their own MCP connectors on dev (UI-98, T-4531).
 */
import { expect, test } from "@playwright/test";
import { STEWARD, signIn } from "./portal";

test.setTimeout(120_000);

test("a steward opens their MCP connectors", async ({ browser }) => {
  const { context, page } = await signIn(browser, STEWARD, `/connectors?lang=en`);
  try {
    await expect(page.getByRole("heading", { level: 1, name: "My MCP connectors" })).toBeVisible({ timeout: 60_000 });
  } finally {
    await context.close();
  }
});
