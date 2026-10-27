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

// T-5743: the walker reported "console: TypeError: Failed to fetch dynamically imported module" on /
// with the edge's own "Too many requests" page in the shot. The edge refused the App chunk (429), the
// Portal logged it and reloaded itself, and that reload met the same 429. Here the first document's
// chunk is refused, its reload is refused, and the load after the edge's window draws the page.
test("the walker judges a page the edge refused only after the edge's window, without the refused load's console", async ({ page }) => {
  test.setTimeout(60_000);
  const logged: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) logged.push(message.text());
  });
  const portal = '<main><h1>Home</h1></main><script>import("/assets/App.js").catch((error) => { console.error(String(error)); setTimeout(() => location.reload(), 200); });</script>';
  let documents = 0;
  let chunks = 0;
  await page.route("http://portal.test/**", (route) => {
    if (route.request().url().endsWith("/assets/App.js")) {
      chunks += 1;
      return chunks === 1
        ? route.fulfill({ status: 429, headers: { "retry-after": "0" }, body: "" })
        : route.fulfill({ body: "export default 1;", contentType: "text/javascript" });
    }
    documents += 1;
    return documents === 2
      ? route.fulfill({ status: 429, headers: { "retry-after": "0" }, body: "<main><h1>Too many requests</h1></main>", contentType: "text/html" })
      : route.fulfill({ body: portal, contentType: "text/html" });
  });
  expect(await openToJudge(page, "http://portal.test/", 1_000, () => logged.splice(0))).toBe(false);
  expect(await page.getByRole("heading", { level: 1, name: "Home" }).isVisible()).toBe(true);
  expect(logged).toEqual([]);
  expect(documents).toBe(3);
});

// A Portal the edge keeps refusing stays a finding: openToJudge says so after two loads again.
test("the walker reports a page the edge refuses on every load", async ({ page }) => {
  test.setTimeout(60_000);
  await page.route("http://portal.test/**", (route) =>
    route.fulfill({ status: 429, headers: { "retry-after": "0" }, body: "<main><h1>Too many requests</h1></main>", contentType: "text/html" }),
  );
  expect(await openToJudge(page, "http://portal.test/", 1_000)).toBe(true);
});

// T-5834: the walker judged "Add an assistant" on /projects/helsinki/knowledge as pressable by the
// viewer at 1440 and refused at 400. The heading drew, permissions/me answered after the walker's
// 1.5 s, and until then PermissionGuard leaves a control as it is (PF-51). Here the answer takes 3 s.
test("the walker judges a page's controls after its permissions document answered", async ({ page }) => {
  test.setTimeout(60_000);
  const portal =
    '<main><h1>Knowledge</h1><button id="add">Add an assistant</button></main><script>fetch("/api/v1/projects/helsinki/permissions/me").then(() => document.getElementById("add").setAttribute("aria-disabled", "true"));</script>';
  await page.route("http://portal.test/**", async (route) => {
    if (route.request().url().endsWith("/permissions/me")) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return route.fulfill({ body: '{"grants":[]}', contentType: "application/json" });
    }
    return route.fulfill({ body: portal, contentType: "text/html" });
  });
  expect(await openToJudge(page, "http://portal.test/projects/helsinki/knowledge", 1_000)).toBe(false);
  expect(await page.locator("#add").getAttribute("aria-disabled")).toBe("true");
});
