import { expect, test } from "@playwright/test";
import { STEWARD, VIEWER, signIn } from "./portal";

for (const who of [STEWARD, VIEWER]) {
  test(`dock paths as ${who.user}`, async ({ browser }) => {
    const { page, context } = await signIn(browser, who, "/projects/helsinki/spaces?lang=en");
    await page.getByRole("button", { name: "Open the assistant" }).click();
    const paths = page.getByTestId("assistant-paths");
    await expect(paths.getByRole("button")).toHaveCount(8);
    await page.waitForTimeout(1500);
    const rows = await paths.getByRole("button").evaluateAll((buttons) =>
      buttons.map((b) => {
        const id = b.getAttribute("aria-describedby");
        const reason = id ? document.getElementById(id)?.textContent : "";
        return `${b.getAttribute("data-path")} disabled=${b.getAttribute("aria-disabled") ?? "no"} ${reason ?? ""}`;
      }),
    );
    console.log(`VERIFY ${who.user}:\n${rows.join("\n")}`);
    await page.screenshot({ path: `/tmp/claude-1001/-workspace/7c41e39b-6cac-4e56-b0cc-6feaac064103/scratchpad/paths-${who.user}.png` });
    await context.close();
  });
}
