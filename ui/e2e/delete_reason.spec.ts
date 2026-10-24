import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { attributeTable } from "./attributeAccess";
import type { Page } from "@playwright/test";
import { axeViolations } from "./axe";

// DM-113 (T-5341): the explorer's delete asks why, and the gateway gets the person's words
// percent-encoded as JC-Reason. `vite preview` has no API and no gateway, so both are answered
// in the browser.

const TYPE = "BikeHireDockingStation";
const SLUG = "scsd2eehkx42n53z2zyd6vshfh7s7irf";
const ID = `urn:ngsi-ld:${TYPE}:hel.fi:mobility:001`;
const ROW = { id: ID, type: TYPE, name: { type: "Property", value: "Dock 1" } };
const list = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });
const LINKML = ["id: https://hel.fi/models/mobility", "name: helsinki-mobility", "classes:", `  ${TYPE}:`, "    slots: [id, name]", "slots:", "  id: {}", "  name: { range: string }", ""].join("\n");

async function stub(page: Page): Promise<(string | null)[]> {
  const reasons: (string | null)[] = [];
  await page.route("**/{api,cs}/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() === "DELETE") {
      reasons.push(request.headers()["jc-reason"] ?? null);
      return route.fulfill({ status: 204, body: "" });
    }
    if (path.endsWith("/auth/me")) return json({ subject: "s1", username: "jana", name: "Jana Kováčová", roles: [] });
    if (path.endsWith("/access/check")) return json({ decision: true });
    if (path.endsWith("/access/attributes")) return json(attributeTable(TYPE, ["name"]));
    if (path.endsWith("/access")) {
      return json({ permissions: [{ action: "queryEntity", resource: { type: TYPE }, attributes: "*" }, { actions: ["deleteEntity"], resource: { type: TYPE } }], prohibitions: [] });
    }
    if (path.endsWith(`/entities/${encodeURIComponent(ID)}`)) return json(ROW);
    if (path.endsWith("/entities")) return json([ROW]);
    if (path === "/api/v1/projects") return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "ProjectList", items: [{ name: "helsinki" }] });
    if (path.endsWith("/spaces")) {
      return json(list([{ apiVersion: "joinedcontext.com/v1alpha1", kind: "ContextSpace", metadata: { name: "mobility", namespace: "helsinki", title: { en: "Mobility" } }, spec: { dataModelRef: "helsinki-mobility" }, status: { phase: "Live" } }]));
    }
    if (path.endsWith("/endpoints")) {
      return json(list([{ apiVersion: "joinedcontext.com/v1alpha1", kind: "Endpoint", metadata: { name: "helsinki-bikes", namespace: "helsinki", title: { en: "Helsinki city bike stations" } }, spec: { contextSpaceRef: "mobility", slug: SLUG, audience: "organization", enabledRepresentations: ["ngsi-ld"] }, status: { phase: "Live" } }]));
    }
    if (path.endsWith("/datamodels")) {
      return json(list([{ apiVersion: "joinedcontext.com/v1alpha1", kind: "DataModel", metadata: { name: "helsinki-mobility", namespace: "helsinki" }, spec: { version: "1.0.0", classes: [TYPE], linkml: LINKML } }]));
    }
    return json(list([]));
  });
  return reasons;
}

const SHOTS = process.env.T5341_SHOTS ?? "test-results/delete-reason";

for (const width of [1440, 400]) {
  test(`a delete asks why and sends the reason, at ${width} px`, async ({ page }) => {
    mkdirSync(SHOTS, { recursive: true });
    await page.setViewportSize({ width, height: 900 });
    const reasons = await stub(page);
    await page.goto(`/projects/helsinki/explore?endpoint=helsinki-bikes&type=${TYPE}&lang=en`);
    await page.getByRole("button", { name: ID }).click();
    await page.getByTestId("explore-delete").click();
    const dialog = page.getByRole("dialog");
    const reason = dialog.getByLabel(/^Reason/);
    await expect(reason).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/delete-reason-empty-${width}.png` });

    await page.getByTestId("explore-delete-confirm").click();
    await expect(dialog.getByText("Enter why you delete it, for example: Duplicate entry.")).toBeVisible();
    expect(reasons).toEqual([]);
    expect(await axeViolations(page)).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/delete-reason-error-${width}.png` });

    await reason.fill("Duplikát, ďalší je 12");
    await page.screenshot({ path: `${SHOTS}/delete-reason-filled-${width}.png` });
    await page.getByTestId("explore-delete-confirm").click();
    await expect(dialog).toBeHidden();
    expect(reasons).toEqual([encodeURIComponent("Duplikát, ďalší je 12")]);
  });
}
