import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// The Data models page as a person meets it (T-2765; DM-61, DM-62): the list of the project's
// models, one click to a model's own page, and its diagram, form and YAML. `vite preview` has no
// Portal API behind it, so the API is answered in the browser; the pages are the real build.

const IDENTITY = {
  subject: "b7c1e0f4",
  username: "jana.kovacova",
  name: "Jana Kováčová",
  email: "jana.kovacova@hel.fi",
  roles: ["portal-editor"],
};

const list = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });

const LINKML = [
  "id: https://hel.fi/models/helsinki",
  "name: helsinki",
  "classes:",
  "  Alert:",
  "    slots: [category, refStation]",
  "  Station:",
  "    slots: [name]",
  "slots:",
  "  category: { range: AlertCategory }",
  "  refStation: { range: Station }",
  "  name: { range: string }",
  "enums:",
  "  AlertCategory:",
  "    permissible_values:",
  "      traffic: { title: { en: Traffic } }",
  "      weather: {}",
  "",
].join("\n");

const MODELS = list([
  {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "DataModel",
    metadata: { name: "helsinki", namespace: "helsinki", title: "Helsinki city context" },
    spec: { contextSpaceRef: "helsinki", version: "1.0.0", lifecycle: "published", classes: ["Alert", "Station"], linkml: LINKML },
  },
]);

const SPACES = list([
  { apiVersion: "joinedcontext.com/v1alpha1", kind: "ContextSpace", metadata: { name: "helsinki", namespace: "helsinki" }, spec: {} },
]);

const ENDPOINTS = list([
  {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "Endpoint",
    metadata: { name: "helsinki-alerts", namespace: "helsinki" },
    spec: { contextSpaceRef: "helsinki", slug: "alerts0000000000000000000000000a", audience: "public" },
  },
]);

const ARTIFACTS = {
  jsonSchema: {
    definitions: {
      Alert: {
        type: "object",
        properties: { category: { type: "string", enum: ["traffic", "weather"], title: "category" } },
      },
      Station: { type: "object", properties: { name: { type: "string", title: "name" } } },
    },
  },
  example: { type: "Alert", category: "weather" },
};

async function stubApi(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) return json(IDENTITY);
    if (path === "/api/v1/projects") return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "ProjectList", items: [{ name: "helsinki" }] });
    if (path.endsWith("/datamodels")) return json(MODELS);
    if (path.endsWith("/spaces")) return json(SPACES);
    if (path.endsWith("/endpoints")) return json(ENDPOINTS);
    if (path === "/api/v1/tools/generate") return json(ARTIFACTS);
    return json(list([]));
  });
}

test.describe("the data models", () => {
  test("the list opens a model, and the model shows its diagram, form and YAML", async ({ page }) => {
    await stubApi(page);
    await page.goto("/projects/helsinki/models?lang=en");
    const table = page.getByRole("table", { name: "The project's data models" });
    await expect(table.getByRole("row")).toHaveCount(2);
    await expect(table).toContainText("1 endpoint");
    await table.getByRole("link", { name: "Helsinki city context" }).click();

    await expect(page).toHaveURL(/\/projects\/helsinki\/models\/helsinki$/);
    await expect(page.getByRole("heading", { level: 1, name: "Helsinki city context" })).toBeVisible();
    await expect(page.getByRole("group", { name: "The model's classes and what joins them" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Classes" })).toContainText("refStation: Station");

    await page.getByRole("tab", { name: "Form" }).click();
    // rjsf keys a select by index; the person reads the picked value.
    await expect(page.getByLabel("category").locator("option:checked")).toHaveText("weather");

    await page.getByRole("tab", { name: "YAML" }).click();
    await expect(page.getByLabel("The model's LinkML")).toContainText("permissible_values:");

    await page.getByRole("tab", { name: "Where used" }).click();
    await expect(page.getByRole("tabpanel").getByRole("link", { name: "helsinki-alerts" })).toHaveAttribute(
      "href",
      "/projects/helsinki/endpoints/helsinki-alerts",
    );

    await page.getByRole("link", { name: "All data models" }).click();
    await expect(page).toHaveURL(/\/projects\/helsinki\/models$/);
  });

  test("a model's address opens its page, and an unknown one says so", async ({ page }) => {
    await stubApi(page);
    await page.goto("/projects/helsinki/models/helsinki?lang=en");
    await expect(page.getByRole("heading", { level: 1, name: "Helsinki city context" })).toBeVisible();
    await page.goto("/projects/helsinki/models/nope?lang=en");
    await expect(page.getByText("No data model named nope")).toBeVisible();
  });
});
