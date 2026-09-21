/**
 * T-2474, UI-27: a bigger form is a page with an address of its own, on the deployed Portal.
 *
 * The create form of a kind opens at `/new` and survives a reload; one space's edit form is
 * opened straight from its address, survives a reload, and saving it lands on the list with the
 * change it opened. The change is rejected afterwards, so dev is left as it was.
 */
import { expect, test } from "@playwright/test";
import { APPROVER, STEWARD, listedNames, proposedChange, reject, signIn } from "./portal";

const PROJECT = "helsinki";
const SUFFIX = process.env.E2E_SUFFIX ?? new Date().toISOString().slice(11, 16).replace(":", "");

test("a create form is a page at /new that a reload keeps", async ({ browser }) => {
  const { context, page } = await signIn(browser, STEWARD, `/projects/${PROJECT}/policies/new?lang=en`);
  try {
    const form = page.getByTestId("form-page");
    await expect(form).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.reload({ waitUntil: "load" });
    await expect(form).toBeVisible({ timeout: 30_000 });

    await form.getByRole("button", { name: "Back to the list" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/policies(\\?|$)`));
    await expect(page.getByRole("heading", { level: 1, name: "Policies" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("an edit form opened from its address survives a reload, and saving lands on the list", async ({
  browser,
}) => {
  const steward = await signIn(browser, STEWARD, `/projects/${PROJECT}/spaces?lang=en`);
  let change = "";
  try {
    const [space] = await listedNames(steward.page, PROJECT, "spaces");
    expect(space, "helsinki has a space to edit").toBeTruthy();

    await steward.page.goto(`/projects/${PROJECT}/spaces/${space}/edit?lang=en`, { waitUntil: "load" });
    const form = steward.page.getByTestId("form-page");
    await expect(form).toBeVisible({ timeout: 30_000 });
    await steward.page.reload({ waitUntil: "load" });
    await expect(form).toBeVisible({ timeout: 30_000 });
    await expect(form.locator("#root_name")).toHaveValue(space);

    await form.locator("#root_title").fill(`Form pages journey ${SUFFIX}`);
    await form.getByRole("button", { name: "Propose change" }).click();

    change = await proposedChange(steward.page);
    await expect(steward.page).toHaveURL(new RegExp(`/projects/${PROJECT}/spaces(\\?|$)`));
    await expect(form).toHaveCount(0);
    await expect(steward.page.getByRole("heading", { level: 1, name: /spaces/i })).toBeVisible();
  } finally {
    if (change) {
      const approver = await signIn(browser, APPROVER, `/projects/${PROJECT}/approvals?lang=en`);
      await reject(approver.page, PROJECT, change);
      await approver.context.close();
    }
    await steward.context.close();
  }
});
