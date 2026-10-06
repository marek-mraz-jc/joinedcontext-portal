import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { axeViolations } from "./axe";

// T-3057: the knowledge assistant's sources in a real browser, the API answered in the browser.
// What the list shows of `/knowledge/sources`, the source page's tree opened a level at a time,
// a branch left out of answers with what it removed, and what a viewer meets.

const IDENTITY = { subject: "b7c1e0f4", username: "eva.steward", name: "Eva Steward", email: "eva@hel.fi", roles: [] };

const grants = (verbs: string[]) => ({
  project: "helsinki",
  bootstrap: false,
  grants: [
    {
      role: verbs.includes("propose") ? "org-admin" : "viewer",
      binding: "helsinki-people",
      scope: "project:helsinki",
      rule: { kinds: ["KnowledgeSource", "AssistantDeployment"], verbs },
    },
  ],
});

const SOURCES = {
  items: [
    {
      source: "hel-web",
      type: "website",
      state: "crawled",
      startUrls: ["https://www.hel.fi/"],
      ckanInstanceRef: null,
      schedule: "0 3 * * *",
      visibility: "public",
      lastCrawl: "2026-10-06T03:00:00Z",
      pages: 40,
      pagesIncluded: 38,
      documents: 3,
      passages: 300,
      embedded: 300,
      job: { state: "done", attempts: 1, error: null },
    },
    { source: "hel-data", type: "ckan", state: "not-crawled", startUrls: [], ckanInstanceRef: "hel-fi", schedule: null, visibility: "public" },
  ],
};

const page = (id: number, url: string, extra: Record<string, unknown> = {}) => ({
  id, url, depth: 0, parentId: null, status: "fetched", included: true, excludedBy: null, language: "fi",
  fetchedAt: "2026-10-06T03:01:00Z", children: 0, documents: 0, passages: 5, ...extra,
});

async function stubApi(p: Page, verbs: string[] = ["read", "propose"]): Promise<{ writes: { path: string; body: unknown }[] }> {
  const writes: { path: string; body: unknown }[] = [];
  await p.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: status >= 400 ? "application/problem+json" : "application/json", body: JSON.stringify(body) });
    const base = "/api/v1/projects/helsinki/knowledge";
    if (url.pathname.endsWith("/auth/me")) return json(IDENTITY);
    if (url.pathname.endsWith("/permissions/me")) return json(grants(verbs));
    if (request.method() !== "GET") {
      writes.push({ path: url.pathname, body: request.postDataJSON() as unknown });
      return json({ pages: 2, documents: 0, passagesRemoved: 12 });
    }
    if (url.pathname === "/api/v1/projects") return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [{ name: "helsinki" }] });
    if (url.pathname === `${base}/sources`) return json(SOURCES);
    if (url.pathname === `${base}/sources/hel-web/pages`) {
      return url.searchParams.get("parent") === "1"
        ? json({ items: [page(2, "https://www.hel.fi/en/culture", { depth: 1, parentId: 1 })] })
        : json({ items: [page(1, "https://www.hel.fi/", { children: 1 })] });
    }
    if (url.pathname === `${base}/sources/hel-web/documents`) return json({ items: [] });
    return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] });
  });
  return { writes };
}

test.describe("the knowledge sources", () => {
  test("lists each source with what the assistant holds, and a source not crawled yet says so", async ({ page: p }) => {
    await stubApi(p);
    await p.goto("/projects/helsinki/knowledge?lang=en");
    await expect(p.getByRole("heading", { level: 1, name: "Knowledge sources" })).toBeVisible();
    const table = p.getByRole("table", { name: "Knowledge sources" });
    await expect(table.getByRole("row", { name: /hel-web/ }).getByText("38 of 40")).toBeVisible();
    await expect(table.getByRole("row", { name: /hel-data/ }).getByText("Not crawled yet")).toBeVisible();
    expect(await axeViolations(p)).toEqual([]);
  });

  test("opens a branch of the tree and leaves it out of answers with everything below it", async ({ page: p }) => {
    const { writes } = await stubApi(p);
    await p.goto("/projects/helsinki/knowledge/hel-web?lang=en");
    await p.getByRole("button", { name: "Show the 1 pages below https://www.hel.fi/" }).click();
    await expect(p.getByRole("link", { name: /^https:\/\/www\.hel\.fi\/en\/culture/ })).toBeVisible();
    await p.getByRole("checkbox", { name: "Select https://www.hel.fi/", exact: true }).check();
    await p.getByRole("button", { name: "Leave out of answers" }).click();
    await expect(p.getByText("Left out: 2 pages and 0 documents; 12 passages removed.")).toBeVisible();
    expect(writes).toEqual([
      { path: "/api/v1/projects/helsinki/knowledge/sources/hel-web/inclusion", body: { pages: [1], documents: [], subtree: true, included: false } },
    ]);
    expect(await axeViolations(p)).toEqual([]);
  });

  test("a viewer finds leaving out disabled with the reason, and pressing it sends nothing", async ({ page: p }) => {
    const { writes } = await stubApi(p, ["read"]);
    await p.goto("/projects/helsinki/knowledge/hel-web?lang=en");
    await p.getByRole("checkbox", { name: "Select https://www.hel.fi/", exact: true }).check();
    const exclude = p.getByRole("button", { name: "Leave out of answers" });
    await expect(exclude).toHaveAttribute("aria-disabled", "true");
    await expect(exclude).toHaveAccessibleDescription("Disabled: your role does not permit 'propose' on 'KnowledgeSource' in this project");
    await exclude.click({ force: true });
    expect(writes).toEqual([]);
  });
});
