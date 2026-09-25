import { expect, test } from "@playwright/test";
import { STEWARD, signIn } from "./portal";

const OUT = "/tmp/claude-1001/-workspace/7c41e39b-6cac-4e56-b0cc-6feaac064103/scratchpad";

test("integrate path: source question, file drop, the flow advances", async ({ browser }) => {
  test.setTimeout(180_000);
  const { page, context } = await signIn(browser, STEWARD, "/projects/helsinki/spaces?lang=en");
  await page.getByRole("button", { name: "Open the assistant" }).click();
  const started = Date.now();
  await page.getByRole("button", { name: /^Integrate a pipeline/ }).click();
  const radios = page.getByRole("radio");
  await expect(radios.first()).toBeVisible();
  console.log(`VERIFY question after ${Date.now() - started} ms: ${(await radios.allInnerTexts()).join(" | ")}`);
  const drop = page.getByLabel("Choose a file of your data");
  await expect(page.getByLabel("Or the address of a feed")).toBeVisible();
  await page.screenshot({ path: `${OUT}/integrate-question.png` });
  await drop.setInputFiles({
    name: "t2694-stations.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("station,name,bikes,lat,lon\n1,Kamppi,4,60.169,24.931\n2,Kallio,0,60.184,24.950\n"),
  });
  await expect(page.getByText("You handed over t2694-stations.csv")).toBeVisible();
  const answered = Date.now();
  // The next turn: another question or the assistant's words after the answer.
  await expect
    .poll(async () => (await page.getByRole("radio").count()) + (await page.getByText(/Which space|holds 2 rows|stations/i).count()), { timeout: 120_000 })
    .toBeGreaterThan(0);
  console.log(`VERIFY next turn ${Date.now() - answered} ms after the file`);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/integrate-after.png` });
  // Leave nothing running: a new conversation stops this one.
  await page.getByRole("button", { name: "Start a new conversation" }).click();
  await context.close();
});
