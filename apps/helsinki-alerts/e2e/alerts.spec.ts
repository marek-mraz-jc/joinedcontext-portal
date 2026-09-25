import { expect, test } from "@playwright/test";
import { STEWARD, VIEWER } from "../src/fixtures/access";
import { SLUG, serve } from "./serve";

// AP-09, AP-96: the viewer reads every alert and is offered no way to change one.
test("a viewer reads the alerts and gets no form, no edit and no delete", async ({ page }) => {
  const { alerts, writes, outside, problems } = await serve(page, "viewer", VIEWER);

  await alerts.getByRole("table").getByText("Kauppatori, Helsinki").click();
  await expect(alerts.getByRole("heading", { level: 2 })).toBeVisible();
  await expect(alerts.getByRole("button", { name: "New alert" })).toHaveCount(0);
  await expect(alerts.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(alerts.getByRole("button", { name: "Delete" })).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(outside).toEqual([]);
  expect(problems).toEqual([]);
});

// AP-62: the steward's correction is one PATCH of the attribute that changed, and nothing else.
test("a steward corrects an alert with one PATCH of the changed attribute", async ({ page }) => {
  const { alerts, writes, outside, problems } = await serve(page, "steward", STEWARD);

  await alerts.getByRole("table").getByText("Mannerheimintie resurfacing").click();
  await alerts.getByRole("button", { name: "Edit" }).click();
  const form = alerts.getByRole("form", { name: "Edit Alert" });
  await form.getByLabel("address").fill("Mannerheimintie 14, Helsinki");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);

  expect(writes).toEqual([
    {
      method: "PATCH",
      path: `/api/endpoint/${SLUG}/ngsi-ld/v1/entities/${encodeURIComponent("urn:ngsi-ld:Alert:hel.fi:helsinki:GUID50001")}/attrs`,
      body: { address: { type: "Property", value: "Mannerheimintie 14, Helsinki" } },
    },
  ]);
  await expect(alerts.getByRole("table").getByText("Mannerheimintie 14, Helsinki")).toBeVisible();
  expect(outside).toEqual([]);
  expect(problems).toEqual([]);
});

// AP-09: a steward adds an alert, and removes only an alert a steward added.
test("a steward adds an alert and deletes it, and cannot delete Fintraffic's", async ({ page }) => {
  const { alerts, writes, problems } = await serve(page, "steward", STEWARD);

  await alerts.getByRole("button", { name: "New alert" }).click();
  const form = alerts.getByRole("form", { name: "New alert" });
  await form.getByLabel("Local id").fill("steward-closure");
  await form.getByLabel("address", { exact: true }).fill("Senaatintori, Helsinki");
  await form.getByLabel("category", { exact: true }).fill("event");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);

  await alerts.getByRole("table").getByText("Mannerheimintie resurfacing").click();
  await expect(alerts.getByRole("button", { name: "Delete" })).toHaveCount(0);

  await alerts.getByRole("table").getByText("Senaatintori, Helsinki").click();
  await alerts.getByRole("button", { name: "Delete" }).click();
  await expect(alerts.getByRole("table").getByText("Senaatintori, Helsinki")).toHaveCount(0);

  expect(writes.map((write) => write.method)).toEqual(["POST", "DELETE"]);
  expect(writes[0].body).not.toHaveProperty("source");
  expect(writes[1].path).toContain(encodeURIComponent("urn:ngsi-ld:Alert:hel.fi:helsinki:steward-closure"));
  expect(problems).toEqual([]);
});
