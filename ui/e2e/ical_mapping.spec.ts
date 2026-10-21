import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// The Endpoint form's calendar mapping and the Endpoint page's subscription links (T-4900, EP-125),
// against a stubbed API as models.spec.ts does: `vite preview` has no Portal behind it.

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
  "Endpoint bbsk/podujatia, space podujatia: `ical` maps DTSTART to `name`, a LanguageProperty; DTSTART takes date or datetime (EP-125)";

async function stubApi(page: Page, refuse: boolean): Promise<void> {
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
    if (path.endsWith("/endpoints") && route.request().method() === "POST" && refuse)
      return json({ type: "https://joinedcontext.com/problems/bad-request", title: "Bad Request", status: 400, detail: REFUSAL }, 400);
    if (path.endsWith("/endpoints")) return json(list([ENDPOINT]));
    if (path.endsWith("/endpoints/podujatia")) return json(ENDPOINT);
    return json(list([]));
  });
}

const SHOTS = join(process.cwd(), "test-results", "ical-mapping");

async function shot(page: Page, name: string, locator?: ReturnType<Page["locator"]>): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const width = page.viewportSize()?.width ?? 0;
  const path = join(SHOTS, `${name}-${width}.png`);
  if (locator) await locator.screenshot({ path });
  else await page.screenshot({ path, fullPage: true });
}

for (const width of [1440, 400]) {
  test.describe(`calendar mapping at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("the form section off, on with the default, an own mapping missing a field, and the server's refusal", async ({ page }) => {
      await stubApi(page, true);
      await page.goto("/projects/bbsk/endpoints/new?lang=en");
      const section = page.getByTestId("ical-mapping");
      await expect(section).toContainText("Turn on the iCalendar feed");
      await shot(page, "1-off", section);

      await page.getByLabel("iCalendar feed").check();
      await expect(page.getByLabel("DTSTART")).toHaveAttribute("placeholder", "startDate");
      await shot(page, "2-default", section);

      await page.getByLabel("Start from").selectOption({ label: "Only the fields below" });
      await page.getByLabel("DTSTART").fill("");
      await expect(section.getByRole("alert")).toContainText("Map these required fields: DTSTART");
      await shot(page, "3-missing", section);

      await page.getByLabel("DTSTART").fill("name");
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("podujatia");
      await page.getByRole("checkbox", { name: "Event" }).check();
      await page.getByRole("button", { name: "Check", exact: true }).click();
      // The form shows jc-core's sentence without its requirement id.
      const refusal = page.getByRole("alert").filter({ hasText: REFUSAL.replace(" (EP-125)", "") });
      await expect(refusal).toBeVisible();
      // The form's footer with the server's verdict; the stub keeps no drafts, so the page top says so.
      await shot(page, "4-refused", refusal.locator("xpath=.."));
    });

    test("the Endpoint page offers the feed and its webcal address", async ({ page }) => {
      await stubApi(page, false);
      await page.goto("/projects/bbsk/endpoints/podujatia?lang=en");
      await expect(page.getByText("Calendar subscription")).toBeVisible();
      await expect(page.getByText(`webcal://`, { exact: false }).first()).toBeVisible();
      await shot(page, "5-detail");
    });
  });
}
