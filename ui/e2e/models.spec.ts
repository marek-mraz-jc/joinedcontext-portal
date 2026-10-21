import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// The Data models page as a person meets it (T-2765, T-2762; DM-61, DM-62): the list of the project's
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
    if (path.endsWith("/spaces/helsinki")) return json(SPACES.items[0]);
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
    await expect(page.getByRole("table", { name: "Fields of Alert" })).toContainText("Link to Station");

    await page.getByRole("tab", { name: "Form" }).click();
    // rjsf keys a select by index; the person reads the picked value.
    await expect(page.getByLabel("category").locator("option:checked")).toHaveText("weather");

    await page.getByRole("tab", { name: "YAML" }).click();
    await expect(page.getByLabel("The model's source (LinkML YAML)")).toContainText("permissible_values:");

    await page.getByRole("tab", { name: "Where used" }).click();
    await expect(page.getByRole("tabpanel").getByRole("link", { name: "helsinki-alerts" })).toHaveAttribute(
      "href",
      "/projects/helsinki/endpoints/helsinki-alerts",
    );

    await page.getByRole("link", { name: "All data models" }).click();
    await expect(page).toHaveURL(/\/projects\/helsinki\/models$/);
  });

  test("the space shows its model, and the model's name opens the model's page", async ({ page }) => {
    await stubApi(page);
    // The model is the space's Data model tab since T-4825; the data rows are its first tab.
    await page.goto("/projects/helsinki/spaces/helsinki?tab=model&lang=en");
    const model = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: "Data model" }) });
    await expect(model.getByRole("group", { name: "The model's classes and what joins them" })).toBeVisible();
    await model.getByRole("tab", { name: "YAML" }).click();
    await expect(model.getByLabel("The model's source (LinkML YAML)")).toContainText("permissible_values:");
    await model.getByRole("link", { name: "Helsinki city context" }).click();
    await expect(page).toHaveURL(/\/projects\/helsinki\/models\/helsinki$/);
  });

  test("a model's address opens its page, and an unknown one says so", async ({ page }) => {
    await stubApi(page);
    await page.goto("/projects/helsinki/models/helsinki?lang=en");
    await expect(page.getByRole("heading", { level: 1, name: "Helsinki city context" })).toBeVisible();
    await page.goto("/projects/helsinki/models/nope?lang=en");
    await expect(page.getByText("No data model named nope")).toBeVisible();
  });
});

// The KPI model as B05 drew it wrong (T-4829): a slot over LinkML `Any` and an inline period.
const KPI_LINKML = [
  "id: https://hel.fi/models/helsinki-kpi",
  "name: helsinki-kpi",
  "prefixes:",
  "  jc: https://hel.fi/terms/",
  "  linkml: https://w3id.org/linkml/",
  "default_prefix: jc",
  "default_range: string",
  "slots:",
  "  name: { slot_uri: jc:name, title: { en: Name, fi: Nimi } }",
  "  currentValue: { slot_uri: jc:currentValue, range: Any, inlined: true, required: true }",
  "  calculationPeriod: { slot_uri: jc:calculationPeriod, range: CalculationPeriod, inlined: true }",
  "  startsAt: { slot_uri: jc:startsAt, range: datetime }",
  "  endsAt: { slot_uri: jc:endsAt, range: datetime }",
  "  computedBy: { slot_uri: jc:computedBy, range: uri, required: true }",
  "  location: { slot_uri: jc:location, annotations: { ngsi_ld_kind: GeoProperty } }",
  "classes:",
  "  KeyPerformanceIndicator:",
  "    class_uri: jc:KeyPerformanceIndicator",
  "    title: { en: Key performance indicator, fi: Avainmittari }",
  "    slots: [name, currentValue, calculationPeriod, computedBy, location]",
  "  CalculationPeriod:",
  "    class_uri: jc:CalculationPeriod",
  "    slots: [startsAt, endsAt]",
  "  Any:",
  "    class_uri: linkml:Any",
  "",
].join("\n");

async function stubKpi(page: Page, verbs: string[]): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) return json(IDENTITY);
    if (path === "/api/v1/projects") return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "ProjectList", items: [{ name: "helsinki" }] });
    if (path.endsWith("/permissions/me")) {
      return json({ project: "helsinki", grants: [{ rule: { kinds: ["DataModel", "ContextSpace", "Endpoint"], verbs } }] });
    }
    if (path.endsWith("/datamodels")) {
      return json(list([{
        apiVersion: "joinedcontext.com/v1alpha1",
        kind: "DataModel",
        metadata: { name: "helsinki-kpi", namespace: "helsinki", title: "Helsinki indicators" },
        spec: { contextSpaceRef: "helsinki-kpi", version: "1.0.0", lifecycle: "published", linkml: KPI_LINKML },
      }]));
    }
    if (path === "/api/v1/tools/sdm-catalog") return json({ subjects: [] });
    if (path.endsWith("/organizations")) {
      return json(list([{ apiVersion: "joinedcontext.com/v1alpha1", kind: "Organization", metadata: { name: "hel" }, spec: { domain: "hel.fi", locales: ["en", "fi"], defaultLocale: "en" } }]));
    }
    return json(list([]));
  });
}

/** Screenshots for the task, where `JC_EVIDENCE_DIR` asks for them. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.JC_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

test.describe("one plain model editor (T-4829)", () => {
  for (const width of [1440, 400]) {
    test(`a steward reads the KPI in plain words and opens Add field at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width > 600 ? 900 : 860 });
      await stubKpi(page, ["read", "propose"]);
      await page.goto("/projects/helsinki/datamodels/helsinki-kpi?lang=en");
      await expect(page).toHaveURL(/\/projects\/helsinki\/models\/helsinki-kpi(\?|$)/);
      const diagram = page.getByRole("group", { name: "The model's classes and what joins them" });
      await expect(diagram).toBeVisible();
      await expect(diagram.getByText("Any", { exact: true })).toHaveCount(0);
      await expect(diagram.getByText("CalculationPeriod", { exact: true })).toHaveCount(0);
      const fields = page.getByRole("table", { name: "Fields of Key performance indicator" });
      await expect(fields.getByRole("row", { name: /currentValue/ })).toContainText("Any value");
      await expect(fields.getByRole("row", { name: /calculationPeriod/ })).toContainText("Holds startsAt, endsAt");
      await expect(fields.getByRole("row", { name: /location/ })).toContainText("Location");
      await expect(page.getByRole("table", { name: "Fields of Any" })).toHaveCount(0);
      const overflow = await page.evaluate(() => (document.scrollingElement?.scrollWidth ?? 0) - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await shot(page, `model-overview-steward-${width}`);

      await page.getByRole("button", { name: "Add field to Key performance indicator" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("button", { name: "Propose field" })).toBeVisible();
      await expect(dialog.getByText(/IRI/)).toHaveCount(0);
      await shot(page, `model-add-field-steward-${width}`);
    });
  }

  test("the editor offers Smart Data Models first, mints the IRI, and keeps it under Advanced", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await stubKpi(page, ["read", "propose"]);
    await page.goto("/projects/helsinki/models?new=blank&lang=en");
    const types = page.getByRole("region", { name: "Types" });
    await expect(types.getByRole("button", { name: "Import a Smart Data Model" })).toBeVisible();
    await types.getByRole("textbox", { name: "New type" }).fill("School");
    await types.getByRole("button", { name: "Add type" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "School" })).toBeVisible();
    // Titles in the Organization's languages: fi for Helsinki.
    await expect(page.getByLabel("Title (fi)")).toBeVisible();
    await expect(page.getByLabel("Class IRI")).toBeHidden();
    await shot(page, "model-editor-steward-1440");
    await page.getByText("Advanced (IRIs, mixins, profiles)").first().click();
    await expect(page.getByLabel("Class IRI")).toHaveValue(/^[a-z]+:School$/);
  });

  for (const width of [1440, 400]) {
    test(`a viewer reads the same page with no Add field at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width > 600 ? 900 : 860 });
      await stubKpi(page, ["read"]);
      await page.goto("/projects/helsinki/models/helsinki-kpi?lang=en");
      await expect(page.getByRole("table", { name: "Fields of Key performance indicator" })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Add field to/ })).toHaveCount(0);
      await shot(page, `model-overview-viewer-${width}`);
    });
  }
});

// The generated schema as Model Tools writes it for the Helsinki models (B06, T-4830): an optional
// enum as `anyOf [X, null]`, a value of two types as an untitled `anyOf`, GeoJSON coordinates with
// no `items`; and the model's published v1.0.0 as a merged Change.
const KPI_ARTIFACTS = {
  jsonSchema: {
    definitions: {
      Any: {},
      TransportMode: { type: "string", enum: ["bus", "tram"], title: "TransportMode" },
      KeyPerformanceIndicator: {
        type: "object",
        properties: {
          name: { type: "string", title: "Name" },
          currentValue: { $ref: "#/definitions/Any", anyOf: [{ type: "number" }, { type: "string" }], description: "The number." },
          mode: { anyOf: [{ $ref: "#/definitions/TransportMode" }, { type: "null" }], description: "What runs it." },
          location: {
            type: ["object", "null"],
            "x-ngsi-ld-kind": "GeoProperty",
            properties: {
              type: { type: "string", enum: ["Point", "Polygon"] },
              coordinates: { type: "array" },
            },
            required: ["type", "coordinates"],
          },
        },
      },
    },
  },
  example: { type: "KeyPerformanceIndicator", name: "Bus lines on time", currentValue: 94.5, location: { type: "Point", coordinates: [24.94, 60.17] } },
};

const PUBLISHED_CHANGE = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Change",
  metadata: { name: "chg-helsinki-00000007", namespace: "helsinki" },
  status: { lane: "yellow", phase: "Merged", plan: { create: 1, update: 0, delete: 0 } },
  summary: { key: "change.summary.create", params: { kind: "DataModel", name: "helsinki-kpi", fields: 6 } },
  author: { name: "Aino Virtanen" },
  createdAt: "2026-10-12T08:10:00Z",
  decision: { by: "mikko@hel.fi", at: "2026-10-12T09:02:00Z" },
};

test.describe("a model change is proposed, and read back (T-4830)", () => {
  for (const width of [1440, 400]) {
    test(`the Form tab has no schema error, History lists v1.0.0, Propose waits for an edit at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width > 600 ? 900 : 860 });
      await stubKpi(page, ["read", "propose"]);
      await page.route("**/api/v1/tools/generate", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(KPI_ARTIFACTS) }),
      );
      await page.route("**/api/v1/projects/helsinki/changes/history**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(list([PUBLISHED_CHANGE])) }),
      );
      await page.route("**/api/v1/projects/helsinki/datamodels/helsinki-kpi/source", (route) =>
        route.fulfill({ status: 200, contentType: "text/plain", body: KPI_LINKML }),
      );

      await page.goto("/projects/helsinki/models/helsinki-kpi?tab=form&lang=en");
      const panel = page.getByRole("tabpanel");
      await expect(panel.getByLabel("Name")).toHaveValue("Bus lines on time");
      await expect(panel).not.toContainText(/Unsupported field schema|Missing items definition|option \d/);
      await expect(panel).not.toContainText(/\bT-\d{4}\b|Development\/\d+/);
      await expect(panel.locator('[aria-invalid="true"]'), "a preview marks nothing invalid").toHaveCount(0);
      await expect(panel.getByRole("combobox").filter({ has: page.locator("option", { hasText: "Number" }) })).toBeVisible();
      await shot(page, `model-form-${width}`);

      await page.getByRole("tab", { name: "History" }).click();
      await expect(page.getByTestId("resource-history-item")).toHaveCount(1);
      await expect(page.getByTestId("resource-history-item")).toContainText("chg-helsinki-00000007");
      await shot(page, `model-history-${width}`);

      await page.goto("/projects/helsinki/models?edit=helsinki-kpi&lang=en");
      const propose = page.getByRole("button", { name: "Propose v1.0.0" });
      await expect(propose).toHaveAttribute("aria-disabled", "true");
      await expect(propose).toHaveAccessibleDescription("Nothing to propose: edit the model first.");
      const overflow = await page.evaluate(() => (document.scrollingElement?.scrollWidth ?? 0) - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await shot(page, `model-propose-unchanged-${width}`);
    });
  }
});

/** The last daily quality run of the space, as GET …/spaces/{space}/quality answers it (DM-74). */
const QUALITY = {
  observedAt: "2026-10-21T03:00:00Z",
  checked: 120,
  invalid: 0,
  truncated: false,
  rules: [],
  freshness: [],
  types: [
    {
      type: "Alert",
      count: 120,
      newest: "2026-10-21T02:55:00Z",
      attributes: [
        { name: "category", present: 118, outliers: 0, outlierExamples: [] },
        { name: "refStation", present: 60, outliers: 0, outlierExamples: [] },
      ],
    },
    { type: "Station", count: 0, attributes: [] },
  ],
};

test.describe("a model's fields beside what its space holds (T-5066)", () => {
  for (const width of [1440, 400]) {
    test(`the Fields tab at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await stubApi(page);
      await page.route("**/api/v1/projects/helsinki/spaces/helsinki/quality", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(QUALITY) }),
      );
      await page.goto("/projects/helsinki/models/helsinki?tab=fields&lang=en");
      const alert = page.getByRole("table", { name: "Fields of Alert, what each allows and what the space holds" });
      const category = alert.getByRole("row").filter({ hasText: "category" });
      await expect(category).toContainText("traffic (Traffic), weather");
      await expect(category).toContainText("98%");
      await expect(page.getByRole("table", { name: "Fields of Station, what each allows and what the space holds" })).toContainText(
        "No entity of this type yet",
      );
      const query = category.getByRole("link", { name: "Open Explore on the Alert entities that have category" });
      await expect(query).toHaveAttribute("href", "/projects/helsinki/explore?space=helsinki&type=Alert&q=category");
      await shot(page, `model-fields-${width}`);
      await query.click();
      await expect(page).toHaveURL(/\/projects\/helsinki\/explore\?space=helsinki&type=Alert&q=category/);
    });
  }
});
