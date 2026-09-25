/**
 * The data model editor on dev (T-2729; DM-01, UI-16, TS-26): what a steward does to a model, each
 * as a person does it, and the viewer's refusal.
 *
 * - a new model in the structure editor: two classes, an enum with a value, a slot whose range is
 *   the enum, a one-to-many relationship, one line typed into the source, a Check, and Save model,
 *   whose Change the approver rejects;
 * - a model drafted from a CSV sample, and a Smart Data Model imported into a model being built;
 * - a removal proposed from the models' list, rejected, so the model stays.
 *
 * Nothing lands: every Change is rejected, the drafts the editor keeps are swept, and a sample
 * or an import that fills the editor is never saved. The import starts from a model that already
 * has a class, because an import into an empty editor becomes a model that cannot be saved as new
 * (T-2847).
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { APPROVER, STEWARD, VIEWER, csrf, proposedChange, reject, signIn, sweepDrafts } from "./portal";

const PROJECT = "helsinki";
const SUFFIX = process.env.E2E_SUFFIX ?? new Date().toISOString().slice(11, 16).replace(":", "");
const MODEL = `jm-${SUFFIX}`;
/** Every draft this run leaves: the model, and the one the sample fills, named after its file. */
const MINE = new RegExp(`^jm-${SUFFIX}`);
const SAMPLE = `jm-${SUFFIX}-sample`;

test.setTimeout(600_000);

/** Adds a class in the structure editor and leaves it the active one. */
async function addClass(page: Page, name: string): Promise<void> {
  await page.getByLabel("New class").fill(name);
  await page.getByRole("button", { name: "Add class" }).click();
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
}

/** A new, empty model in the editor, named, in the first space that has no model yet. */
async function newModel(page: Page): Promise<void> {
  await page.goto(`/projects/${PROJECT}/models?new=blank&lang=en`, { waitUntil: "load" });
  const region = page.getByRole("region", { name: "New model" });
  await expect(region).toBeVisible({ timeout: 60_000 });
  await region.getByLabel("Name", { exact: true }).fill(MODEL);
  const space = region.getByLabel("Space", { exact: true });
  const free = await space.evaluate((element) =>
    [...(element as HTMLSelectElement).options].find((option) => option.value !== "" && !option.disabled)?.value ?? "",
  );
  expect(free, "every space of the project has a model already, so none can take a new one").not.toBe("");
  await space.selectOption(free);
}

test("a steward builds a model with classes, an enum and a has-many relation, edits its source, checks and proposes it", async ({
  browser,
}) => {
  const steward = await signIn(browser, STEWARD, `/projects/${PROJECT}/models?lang=en`);
  const approver = await signIn(browser, APPROVER, `/projects/${PROJECT}/approvals?lang=en`);
  const page = steward.page;
  try {
    await newModel(page);

    await addClass(page, "Station");
    await addClass(page, "Sensor");
    await page.getByLabel("New enum").fill("QualityBand");
    await page.getByRole("button", { name: "Add enum" }).click();
    await page.getByLabel("New value of QualityBand").fill("good");
    await page.getByRole("button", { name: "Add value to QualityBand" }).click();

    // A slot of Station whose range is the enum.
    await page.getByRole("button", { name: "Station", exact: true }).click();
    await page.getByLabel("New slot").fill("band");
    await page.getByRole("button", { name: "Add slot" }).click();
    await page.getByLabel("Range", { exact: true }).selectOption("QualityBand");

    // One Station has many Sensors: the relationship form writes both ends (multivalued on the owner).
    await page.getByRole("radio", { name: "One to many" }).check();
    await page.getByLabel("Target class").selectOption("Sensor");
    await page.getByRole("button", { name: "Add relationship" }).click();
    await expect(page.getByRole("table", { name: "Relationships" })).toContainText(/has many/);

    // One line typed into the source, where a person writes what the form has no control for.
    await page.getByRole("tab", { name: "Source" }).click();
    const source = page.locator(".monaco-editor .view-lines").first();
    await expect(source).toBeVisible({ timeout: 60_000 });
    await source.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type(`# edited in the source by the journey ${SUFFIX}`);

    await page.getByRole("button", { name: "Check" }).click();
    await expect(page.getByText(/Saves as version/)).toBeVisible({ timeout: 60_000 });

    const saved = page.waitForRequest(
      (request) => request.method() === "PUT" && /\/datamodels\/[^/]+\/source/.test(request.url()) && !request.url().includes("dryRun"),
    );
    await page.getByRole("button", { name: "Save model" }).click();
    const body = (await saved).postData() ?? "";
    for (const part of ["Station", "Sensor", "QualityBand", "multivalued: true", `# edited in the source by the journey ${SUFFIX}`]) {
      expect(body, `the saved source carries ${part}`).toContain(part);
    }
    const change = await proposedChange(page);
    await reject(approver.page, PROJECT, change);
  } finally {
    await sweepDrafts(steward.context, page, PROJECT, MINE, [{ kind: "DataModel", name: MODEL }]);
  }
});

test("a steward drafts a model from a CSV sample into the editor", async ({ browser }) => {
  const { page, context } = await signIn(browser, STEWARD, `/projects/${PROJECT}/models?new=file&lang=en`);
  try {
    const csv = "station,pm10,pm25,observed\nkallio,12.5,7.1,2026-09-25T08:00:00Z\nvallila,9.8,5.2,2026-09-25T08:00:00Z\n";
    await page.getByLabel("Choose a sample file").setInputFiles({ name: `${SAMPLE}.csv`, mimeType: "text/csv", buffer: Buffer.from(csv) });
    const draft = page.getByRole("dialog", { name: `Draft from ${SAMPLE}.csv` });
    await expect(draft).toBeVisible({ timeout: 120_000 });
    await expect(draft).toContainText("pm10");
    await draft.getByRole("button", { name: "Populate the editor" }).click();

    // The editor holds the drafted model under the file's name, still to be placed in a space.
    const region = page.getByRole("region", { name: "New model" });
    await expect(region.getByLabel("Name", { exact: true })).toHaveValue(SAMPLE, { timeout: 30_000 });
    await page.getByRole("tab", { name: "Source" }).click();
    await expect(page.locator(".monaco-editor .view-lines").first()).toContainText("pm10", { timeout: 60_000 });
  } finally {
    await sweepDrafts(context, page, PROJECT, MINE);
  }
});

test("a steward imports a Smart Data Model into a model being built", async ({ browser }) => {
  const { page, context } = await signIn(browser, STEWARD, `/projects/${PROJECT}/models?lang=en`);
  try {
    await newModel(page);
    await addClass(page, "Station");

    await page.getByRole("tab", { name: "Import" }).click();
    await page.getByRole("searchbox", { name: "Search models and attributes" }).fill("AirQualityObserved");
    await page.getByRole("button", { name: /^AirQualityObserved/ }).first().click({ timeout: 120_000 });
    await page.getByRole("button", { name: "Import AirQualityObserved" }).click({ timeout: 120_000 });

    // Merged into the model in hand: its own class kept, the upstream one added beside it.
    await expect(page.getByRole("button", { name: "AirQualityObserved", exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Station", exact: true })).toBeVisible();
  } finally {
    await sweepDrafts(context, page, PROJECT, MINE, [{ kind: "DataModel", name: MODEL }]);
  }
});

test("a steward proposes removing a model, and the rejected removal keeps it", async ({ browser }) => {
  const steward = await signIn(browser, STEWARD, `/projects/${PROJECT}/datamodels?lang=en`);
  const approver = await signIn(browser, APPROVER, `/projects/${PROJECT}/approvals?lang=en`);
  const page = steward.page;
  const listed = await page.request.get(`/api/v1/projects/${PROJECT}/datamodels`);
  expect(listed.ok()).toBe(true);
  const [model] = ((await listed.json()) as { items: { metadata: { name: string } }[] }).items.map((item) => item.metadata.name);
  expect(model, "the project has no model to propose removing").toBeDefined();

  const row = page.locator("tr, li").filter({ hasText: model }).first();
  await row.getByRole("button", { name: /^More actions for / }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  const dialog = page.getByRole("dialog");
  const propose = dialog.getByRole("button", { name: "Propose removal" });
  // Nothing is proposed until the name is typed back (a Red change, CC-19).
  await expect(propose).toHaveAttribute("aria-disabled", "true");
  await dialog.getByLabel(`Type ${model} to confirm`).fill(model);
  await propose.click();
  const id = dialog.getByText(/^chg-[0-9a-f]{8}$/);
  await expect(id).toBeVisible({ timeout: 60_000 });
  await reject(approver.page, PROJECT, (await id.textContent()) ?? "");

  const kept = await page.request.get(`/api/v1/projects/${PROJECT}/datamodels/${model}`);
  expect(kept.status(), "a rejected removal removed the model").toBe(200);
});

test("a viewer meets the model buttons refused with the reason, and the source route refuses a save", async ({ browser }) => {
  const { page, context } = await signIn(browser, VIEWER, `/projects/${PROJECT}/models?lang=en`);
  const create = page.getByRole("button", { name: "New blank model" }).first();
  await expect(create).toHaveAttribute("aria-disabled", "true", { timeout: 60_000 });
  await expect(create).toHaveAccessibleDescription(/does not permit 'propose' on 'DataModel'/);

  // A save of a model the project has: the route checks the role before it reads the source.
  const listed = await page.request.get(`/api/v1/projects/${PROJECT}/datamodels`);
  expect(listed.ok()).toBe(true);
  const [model] = ((await listed.json()) as { items: { metadata: { name: string } }[] }).items.map((item) => item.metadata.name);
  expect(model, "the project has no model").toBeDefined();
  const answer = await page.request.put(`/api/v1/projects/${PROJECT}/datamodels/${model}/source`, {
    headers: { "x-csrf-token": await csrf(context), "content-type": "text/yaml" },
    data: `id: https://example.org/${model}\nname: ${model}\nclasses:\n  Station: {}\n`,
  });
  expect(answer.status(), await answer.text()).toBe(403);
});
