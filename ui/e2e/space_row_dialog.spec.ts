import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { axeViolations } from "./axe";

// A space row as a dialog (T-4828): `?row=<urn>` opens it, Fields, History with every version and
// who changed it, Comments as tabs; "Add row" opens the type's form. `vite preview` has no Portal
// API behind it, so the API and the space surface are answered in the browser. With SHOTS_DIR set,
// the 1440 px and 400 px screenshots are written there for the task's evidence.

const PROJECT = "helsinki";
const SPACE = "helsinki-kpi";
const TYPE = "KeyPerformanceIndicator";
const URN = `urn:ngsi-ld:${TYPE}:hel.fi:kpi:3`;

const list = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });
const manifest = (kind: string, name: string, spec: Record<string, unknown>) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind,
  metadata: { name, namespace: PROJECT },
  spec,
  status: { phase: "Live" },
});

const LINKML = [
  "id: https://hel.fi/models/kpi",
  "name: helsinki-kpi",
  "classes:",
  "  KeyPerformanceIndicator:",
  "    title: Key performance indicator",
  "    slots: [id, name, kpiValue, category]",
  "slots:",
  "  id: {}",
  "  name: { range: string, title: Name }",
  "  kpiValue: { range: float, title: Value }",
  "  category: { range: string, title: Category }",
  "",
].join("\n");

function kpi(n: number) {
  return {
    id: `urn:ngsi-ld:${TYPE}:hel.fi:kpi:${n}`,
    type: TYPE,
    name: { type: "Property", value: `District ${n}` },
    kpiValue: { type: "Property", value: 10 * n, observedAt: "2026-10-20T10:00:00Z" },
    category: { type: "Property", value: "quantitative" },
  };
}

const VERSIONS = {
  id: URN,
  type: TYPE,
  kpiValue: [
    {
      type: "Property", value: 29, observedAt: "2026-10-20T10:00:00Z", supersededAt: "2026-10-20T11:02:00Z",
      provenance: { channel: "pipeline", operation: "create", actor: "kpi-import", writtenAt: "2026-10-20T10:00:04Z" },
    },
    {
      type: "Property", value: 30, observedAt: "2026-10-20T10:00:00Z",
      provenance: { channel: "ui", operation: "correct", actor: "jana.kovacova", reason: "Typo in the import", writtenAt: "2026-10-20T11:02:00Z" },
    },
    { type: "Property", value: 27, observedAt: "2026-10-19T10:00:00Z", provenance: { channel: "pipeline", operation: "create", actor: "kpi-import" } },
  ],
};

async function stubApi(page: Page): Promise<void> {
  await page.route("**/{api,cs}/**", async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) {
      return json({ subject: "b7c1e0f4", username: "jana.kovacova", name: "Jana Kováčová", roles: ["portal-editor"] });
    }
    if (path.endsWith("/datamodels/helsinki-kpi/source")) {
      return route.fulfill({ status: 200, contentType: "text/yaml", body: LINKML });
    }
    if (path.includes("/temporal/entities/")) {
      const all = url.searchParams.get("versions") === "all";
      return json(all ? VERSIONS : { ...VERSIONS, kpiValue: VERSIONS.kpiValue.filter((one) => !one.supersededAt) });
    }
    if (path.endsWith(`/entities/${URN}`)) return json(kpi(3));
    if (path.endsWith("/entities")) {
      const rows = Array.from({ length: 12 }, (_, i) => kpi(i + 1));
      return json(rows, 200, { "NGSILD-Results-Count": String(rows.length) });
    }
    if (path.endsWith(`/spaces/${SPACE}/comments`)) {
      return json([{ id: "c1", urn: URN, author: "jana.kovacova", text: "Checked against the city report.", createdAt: "2026-10-20T12:00:00Z", mine: true }]);
    }
    if (path === "/api/v1/projects") return json({ kind: "ProjectList", items: [{ name: PROJECT }] });
    if (path.endsWith(`/spaces/${SPACE}/usage`)) return json({ entities: 12, broker: "main", observedAt: "2026-10-20T16:00:00Z" });
    if (path.endsWith(`/spaces/${SPACE}/views`)) return json({ items: [] });
    if (path.endsWith(`/spaces/${SPACE}`)) return json(manifest("ContextSpace", SPACE, { dataModelRef: "helsinki-kpi" }));
    if (path.endsWith("/datamodels")) {
      return json(list([manifest("DataModel", "helsinki-kpi", { contextSpaceRef: SPACE, version: "1.0.0", classes: [TYPE], linkml: LINKML })]));
    }
    return json(list([]));
  });
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

for (const [label, width, height] of [["desktop-1440", 1440, 900], ["phone-400", 400, 860]] as const) {
  test(`a row opens as a dialog from its link, with history versions and comments (${label})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await stubApi(page);
    await page.goto(`/projects/${PROJECT}/spaces/${SPACE}?lang=en&row=${encodeURIComponent(URN)}`);

    const dialog = page.getByRole("dialog", { name: "Details: District 3" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("tab")).toHaveText(["Fields", "History", "Comments"]);
    await expect(dialog.getByText("30", { exact: true })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, `row-fields-${label}`);

    await dialog.getByRole("tab", { name: "History" }).click();
    await dialog.getByRole("combobox", { name: "Attribute" }).selectOption("kpiValue");
    await dialog.getByRole("checkbox", { name: /Every version/ }).check();
    await expect(dialog.getByRole("cell", { name: "Typo in the import" })).toBeVisible();
    await expect(dialog.getByRole("cell", { name: "pipeline · create · kpi-import" }).first()).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, `row-history-versions-${label}`);

    await dialog.getByRole("tab", { name: "Comments" }).click();
    await expect(dialog.getByText("Checked against the city report.")).toBeVisible();
    await shot(page, `row-comments-${label}`);

    // Escape closes it and the address no longer names the row.
    await dialog.getByRole("tab", { name: "Comments" }).focus();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("row")).toBeNull();

    await page.getByRole("button", { name: "Add row" }).click();
    const form = page.getByRole("dialog", { name: /^New / });
    await expect(form.getByRole("button", { name: "Create", exact: true })).toBeVisible();
    // DM-113 (T-5341): the form asks why, starting from a sentence the person may change.
    const reason = form.getByRole("textbox", { name: /^Reason/ });
    await expect(reason).toHaveValue("Entered through the form");
    await reason.clear();
    await form.getByRole("button", { name: "Create", exact: true }).click();
    await expect(form.getByText("Enter why you add it, for example: Inspection on 2026-10-22.")).toBeVisible();
    await shot(page, `row-add-${label}`);
  });
}
