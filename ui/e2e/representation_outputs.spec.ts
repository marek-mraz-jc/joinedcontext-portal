import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// The Endpoint form's named calendar and feed outputs (T-5218, API/11 EP-159) and the Endpoint page's
// subscription links (T-4900, EP-125), against a stubbed API as models.spec.ts does: `vite preview` has
// no Portal behind it. Shots of every state at 1440 and 400 go to test-results/representation-outputs.

const IDENTITY = { subject: "b7c1e0f4", username: "jana", name: "Jana Kováčová", email: "jana@example.org", roles: ["portal-editor"] };
const list = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });
const LINKML = [
  "id: https://example.org/models/events",
  "name: events",
  "classes:",
  "  Event:",
  "    slots: [name, startDate, endDate, description, address, url]",
  "slots:",
  "  name: { required: true, annotations: { ngsi_ld_kind: LanguageProperty } }",
  "  startDate: { range: datetime, required: true }",
  "  endDate: { range: datetime }",
  "  description: { range: string }",
  "  address: { range: string }",
  "  url: { range: uri }",
  "",
].join("\n");
const SLUG = "k7m2qz4tv6xh3n5jb2ryd3wcfa";
const ENDPOINT = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Endpoint",
  metadata: { name: "podujatia", namespace: "bbsk", title: "Podujatia v kraji" },
  spec: {
    contextSpaceRef: "podujatia",
    slug: SLUG,
    audience: "public",
    enabledRepresentations: ["ngsi-ld", "mcp", "ical"],
    representations: { ical: { preset: "sdm-event", mapping: { LOCATION: { join: ["address", "description"], separator: ", " } } } },
  },
};
const REFUSAL =
  "Endpoint bbsk/podujatia, space podujatia: spec.representations.feed: feed output `novinky`: `filter.q` is no NGSI-LD query: unexpected end of input";

async function stubApi(page: Page, answer: "refuse" | "forbid" | "accept"): Promise<string[]> {
  const posted: string[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) return json(IDENTITY);
    if (path === "/api/v1/projects") return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "ProjectList", items: [{ name: "bbsk" }] });
    if (path.endsWith("/datamodels"))
      return json(list([{ apiVersion: "joinedcontext.com/v1alpha1", kind: "DataModel", metadata: { name: "events", namespace: "bbsk" }, spec: { contextSpaceRef: "podujatia", version: "1.0.0", lifecycle: "published", linkml: LINKML } }]));
    if (path.endsWith("/spaces")) return json(list([{ apiVersion: "joinedcontext.com/v1alpha1", kind: "ContextSpace", metadata: { name: "podujatia", namespace: "bbsk" }, spec: {} }]));
    if (path.endsWith("/endpoints") && route.request().method() === "POST") {
      posted.push(route.request().postData() ?? "");
      if (answer === "refuse")
        return json({ type: "https://joinedcontext.com/problems/unprocessable", title: "Unprocessable Content", status: 422, detail: REFUSAL, errors: [REFUSAL] }, 422);
      if (answer === "forbid")
        return json({ type: "https://joinedcontext.com/problems/forbidden", title: "Forbidden", status: 403, detail: "no role of yours grants create on endpoints in project bbsk" }, 403);
    }
    if (path.endsWith("/endpoints")) return json(list([ENDPOINT]));
    if (path.endsWith("/endpoints/podujatia")) return json(ENDPOINT);
    return json(list([]));
  });
  return posted;
}

const SHOTS = join(process.cwd(), "test-results", "representation-outputs");

async function shot(page: Page, name: string, locator?: ReturnType<Page["locator"]>): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const width = page.viewportSize()?.width ?? 0;
  const path = join(SHOTS, `${name}-${width}.png`);
  if (locator) await locator.screenshot({ path });
  else await page.screenshot({ path, fullPage: true });
}

/** The form up to the outputs, with the Endpoint's name and type filled and iCal on. */
async function openForm(page: Page): Promise<ReturnType<Page["locator"]>> {
  await page.goto("/projects/bbsk/endpoints/new?lang=en");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("podujatia");
  await page.getByRole("checkbox", { name: "Event" }).check();
  return page.getByTestId("representation-outputs");
}

for (const width of [1440, 400]) {
  test.describe(`calendar and feed outputs at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("empty, a calendar and a feed added and filled, a duplicate name, then the server's 422", async ({ page }) => {
      const posted = await stubApi(page, "refuse");
      const section = await openForm(page);
      await expect(section).toContainText("No news feed yet");
      await expect(section).toContainText("Turn on the iCalendar feed");
      await shot(page, "1-empty", section);

      await page.getByLabel("iCalendar feed").check();
      await section.getByRole("button", { name: "Add a calendar" }).click();
      await section.getByLabel("Title in Slovak").first().fill("Kalendár podujatí");
      await section.getByRole("button", { name: "Add a news feed" }).click();
      const feed = section.locator("section").filter({ hasText: "News feeds" });
      await feed.getByLabel("Title in Slovak").fill("Novinky z kultúry");
      await feed.getByLabel("Only entities matching (optional)").fill('eventCategory=="kultura"');
      await expect(feed.getByLabel("Title", { exact: true }).locator("option")).toContainText(["name", "startDate"]);
      await feed.getByLabel("Title", { exact: true }).selectOption("name");
      await shot(page, "2-filled", section);

      await feed.getByLabel(/^Name in the address/).fill("kalendar");
      await section.getByRole("button", { name: "Add a news feed" }).click();
      await feed.getByLabel(/^Name in the address/).last().fill("novinky");
      await expect(feed.getByText("Each output needs its own name")).toHaveCount(0);
      await feed.getByLabel(/^Name in the address/).first().fill("novinky");
      await expect(feed.getByText("Each output needs its own name; these occur twice: novinky")).toBeVisible();
      await shot(page, "3-duplicate", section);
      await feed.getByRole("button", { name: /^Remove output/ }).last().click();

      await page.getByRole("button", { name: "Check", exact: true }).click();
      const refusal = page.getByRole("alert").filter({ hasText: "filter.q" });
      await expect(refusal).toBeVisible();
      expect(posted.at(-1)).toContain('"feed":[{"name":"novinky"');
      expect(posted.at(-1)).toContain('"ical":[{"name":"kalendar"');
      await shot(page, "4-refused", refusal.locator("xpath=.."));
    });

    test("a person without the Endpoint right is refused with the reason", async ({ page }) => {
      await stubApi(page, "forbid");
      const section = await openForm(page);
      await section.getByRole("button", { name: "Add a news feed" }).click();
      await page.getByRole("button", { name: "Check", exact: true }).click();
      const refusal = page.getByRole("alert").filter({ hasText: /grants create on endpoints|permission|Forbidden/i });
      await expect(refusal.first()).toBeVisible();
      await shot(page, "5-forbidden");
    });

    test("the Endpoint page offers the feed and its webcal address", async ({ page }) => {
      await stubApi(page, "accept");
      await page.goto("/projects/bbsk/endpoints/podujatia?lang=en");
      await expect(page.getByText("Calendar subscription")).toBeVisible();
      await expect(page.getByText(`webcal://`, { exact: false }).first()).toBeVisible();
      await shot(page, "6-detail");
    });
  });
}
