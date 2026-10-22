import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openToJudge } from "./live/portal";

// T-5185: the walker judged /projects/helsinki/policies/new as "boot: the Portal did not load". The
// page drew its heading, then the Portal reloaded itself for a chunk it could not load (T-4949), and
// the check ran inside that reload, on index.html's fallback. Here the first document draws and
// reloads itself; the second is the real shell, drawn by its script a moment later.
test("the walker judges the page a Portal draws after reloading itself", async ({ page }) => {
  test.setTimeout(60_000);
  const shell = readFileSync("index.html", "utf8").replace(
    '<script type="module" src="/src/main.tsx"></script>',
    '<script>setTimeout(() => { document.getElementById("root").innerHTML = "<main><h1>New policy</h1></main>"; }, 3000);</script>',
  );
  let documents = 0;
  await page.route("http://portal.test/**", (route) => {
    documents += 1;
    const body = documents === 1 ? "<main><h1>New policy</h1></main><script>setTimeout(() => location.reload(), 500);</script>" : shell;
    return route.fulfill({ body, contentType: "text/html" });
  });
  expect(await openToJudge(page, "http://portal.test/projects/helsinki/policies/new", 1_000)).toBe(false);
  // Read once, as the walker's checks do: an expect that retries would wait out the reload itself.
  expect(await page.locator("#boot-failed").count()).toBe(0);
  expect(await page.getByRole("heading", { level: 1, name: "New policy" }).isVisible()).toBe(true);
  expect(documents).toBe(2);
});
