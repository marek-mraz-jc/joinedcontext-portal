/**
 * Uploading a CSV into a space, in a browser (T-3840; DM-81).
 *
 * `tests/upload_csv.test.tsx` holds the page's logic under jsdom. This run is the page at its own
 * address: a file given to the picker is read in the browser, an unreachable catalogue still
 * leaves the file its own model, and nothing is proposed before a space is named.
 */
import { expect, test } from "@playwright/test";
import { axeViolations } from "./axe";

const API = "joinedcontext.com/v1alpha1";
const PROJECT = "banskabystrica";

const IDENTITY = {
  subject: "b7c1e0f4",
  username: "jana.kovacova",
  name: "Jana Kováčová",
  email: "jana.kovacova@bb.sk",
  roles: ["portal-editor"],
};

test("a CSV is read in the browser and waits for a type and a space before anything is proposed", async ({ page }) => {
  const writes: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() !== "GET") writes.push(url.pathname);
    if (url.pathname.endsWith("/auth/me")) return json(IDENTITY);
    if (url.pathname === "/api/v1/projects") return json({ apiVersion: API, kind: "List", items: [{ name: PROJECT }] });
    if (url.pathname === "/api/v1/tools/sdm-catalog") return json({ title: "unreachable" }, 503);
    return json({ apiVersion: API, kind: "List", items: [] });
  });

  await page.goto(`/projects/${PROJECT}/spaces/upload?lang=en`);
  await expect(page.getByRole("heading", { level: 1, name: "Upload a CSV" })).toBeVisible();
  await page.getByLabel("Choose a CSV file").setInputFiles({
    name: "garages.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("name,capacity\nNorth,120\nSouth,80\n"),
  });

  await expect(page.getByText(/No Smart Data Models type names enough/)).toBeVisible();
  await expect(page.getByRole("radio", { name: "My own model" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Propose the change" })).toBeDisabled();
  expect(await axeViolations(page)).toEqual([]);
  expect(writes, "nothing is written before the change is proposed").toEqual([]);
});
