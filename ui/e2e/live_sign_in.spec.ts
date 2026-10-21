import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { goSignedIn } from "./live/portal";

// T-5068: the walker's viewer sign-in met the shell's "The Portal did not load" notice (the entry
// script failed during a rollout) and waited 60 s for a navigation that never came. The real
// index.html with its entry script refused stands in for that load; the reload answers the Portal.
test("the live sign-in reloads a Portal whose entry script did not load", async ({ page }) => {
  test.setTimeout(60_000);
  const shell = readFileSync("index.html", "utf8");
  let documents = 0;
  await page.route("http://portal.test/**", (route) => {
    if (route.request().resourceType() !== "document") return route.fulfill({ status: 429 });
    documents += 1;
    const body = documents === 1 ? shell : '<nav aria-label="Main navigation"><a href="/">Home</a></nav>';
    return route.fulfill({ body, contentType: "text/html" });
  });
  await goSignedIn(page, { user: "nobody", password: "unused" }, "http://portal.test/projects");
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  expect(documents).toBe(2);
});

test("the live sign-in still fails a Portal that never boots", async ({ page }) => {
  test.setTimeout(240_000);
  const shell = readFileSync("index.html", "utf8");
  let documents = 0;
  await page.route("http://portal.test/**", (route) => {
    if (route.request().resourceType() !== "document") return route.fulfill({ status: 429 });
    documents += 1;
    return route.fulfill({ body: shell, contentType: "text/html" });
  });
  await expect(goSignedIn(page, { user: "nobody", password: "unused" }, "http://portal.test/projects")).rejects.toThrow(
    /Main navigation/,
  );
  expect(documents).toBe(3);
});
