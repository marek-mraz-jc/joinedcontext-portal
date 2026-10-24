import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// The permission-aware grid in the explorer (T-5530): locked columns say why, an attribute the
// person may not read is a "hidden: no access" column with no value fetched, the review reads
// names and formatted values, and export and delete are offered only where the server allows
// them. `vite preview` has no gateway, so its answers are stubbed in the browser; the explorer,
// the grid and its review are the real thing.

const SLUG = "scsd2eehkx42n53z2zyd6vshfh7s7irf";
const TYPE = "BikeHireDockingStation";
const SHOTS = process.env.SHOTS_DIR ?? "test-results/grid-permissions";
const MANY = 10_000;

const list = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });
const manifest = (kind: string, name: string, spec: unknown) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind,
  metadata: { name, namespace: "helsinki", title: { en: name } },
  spec,
  status: { phase: "Live" },
});

const LINKML = [
  "id: https://hel.fi/models/mobility",
  "name: helsinki-mobility",
  "classes:",
  `  ${TYPE}:`,
  "    slots: [id, name, availableBikeNumber, status, location, refPointOfInterest, operatorNote]",
  "slots:",
  "  id: {}",
  "  name: { range: string }",
  "  availableBikeNumber: { range: integer }",
  "  status: { range: string }",
  "  location: { range: GeoProperty }",
  "  refPointOfInterest: { range: PointOfInterest }",
  "  operatorNote: { range: string }",
  "",
].join("\n");

type Persona = "editor" | "viewer";

/** Each persona's decisions, as the gateway's `access/attributes` answers them. */
function decisions(persona: Persona) {
  const row = (name: string, read: boolean, write: boolean, reason: string, del = false) => ({ name, read, write, delete: del, reason });
  const editor = persona === "editor";
  return [
    row("name", true, editor, editor ? "grant" : "not_in_grant", editor),
    row("availableBikeNumber", true, false, "not_in_grant", editor),
    row("status", true, false, "prohibited", editor),
    row("location", true, editor, editor ? "grant" : "not_in_grant", editor),
    row("refPointOfInterest", true, editor, editor ? "grant" : "not_in_grant", editor),
    row("operatorNote", false, false, "not_in_grant"),
  ];
}

function station(at: number) {
  const n = String(at + 1).padStart(5, "0");
  return {
    id: `urn:ngsi-ld:${TYPE}:hel.fi:mobility:${n}`,
    type: TYPE,
    name: { type: "Property", value: `Station ${n}` },
    availableBikeNumber: { type: "Property", value: at % 17 },
    status: { type: "Property", value: "working" },
    location: { type: "GeoProperty", value: { type: "Point", coordinates: [24.94 + (at % 100) / 1000, 60.17] } },
    refPointOfInterest: { type: "Relationship", object: `urn:ngsi-ld:PointOfInterest:hel.fi:poi:${n}` },
  };
}

interface Stubbed {
  /** Every `attrs` the entity reads asked for, to prove a hidden attribute is never requested. */
  attrs: (string | null)[];
}

async function stub(page: Page, persona: Persona, rows: number): Promise<Stubbed> {
  const seen: Stubbed = { attrs: [] };
  await page.route("**/{api,cs}/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) return json({ subject: "s1", username: `${persona}@hel.fi`, name: persona, roles: [] });
    if (path.endsWith(`/api/endpoint/${SLUG}/access/attributes`)) return json({ type: TYPE, attributes: decisions(persona) });
    if (path.endsWith("/access/check")) return json({ decision: true });
    if (path.endsWith("/access")) return json({ permissions: [{ resource: { type: TYPE }, actions: ["queryEntity"], attributes: "*" }], prohibitions: [] });
    if (path.endsWith("/entities")) {
      seen.attrs.push(url.searchParams.get("attrs"));
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "20");
      const page = Array.from({ length: Math.max(0, Math.min(limit, rows - offset)) }, (_, at) => station(offset + at));
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "NGSILD-Results-Count": String(rows) }, body: JSON.stringify(page) });
    }
    if (path === "/api/v1/projects") return json({ kind: "ProjectList", items: [{ name: "helsinki" }] });
    if (path.endsWith("/spaces")) return json(list([manifest("ContextSpace", "mobility", { dataModelRef: "helsinki-mobility" })]));
    if (path.endsWith("/endpoints")) return json(list([manifest("Endpoint", "helsinki-bikes", { contextSpaceRef: "mobility", slug: SLUG, audience: "project-list" })]));
    if (path.endsWith("/datamodels")) return json(list([manifest("DataModel", "helsinki-mobility", { version: "1.0.0", classes: [TYPE], linkml: LINKML })]));
    return json(list([]));
  });
  return seen;
}

const EXPLORE = `/projects/helsinki/explore?endpoint=helsinki-bikes&type=${TYPE}&attrs=name,availableBikeNumber,status,location,refPointOfInterest&lang=en`;

test("10 000 rows: the first row and twenty screens of scrolling, timed", async ({ page }) => {
  test.setTimeout(120_000);
  await stub(page, "editor", MANY);
  const started = Date.now();
  await page.goto(EXPLORE);
  await expect(page.getByRole("gridcell", { name: /Station 00001/ }).first()).toBeVisible();
  const firstRow = Date.now() - started;
  const box = page.locator(".jc-grid-scroll").first();
  const scrollStart = Date.now();
  for (let step = 1; step <= 20; step++) {
    await box.evaluate((el, by) => el.scrollBy(0, by), 1500);
    await page.waitForTimeout(0);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  }
  await expect(page.getByRole("gridcell").filter({ hasText: /Station / }).first()).toBeVisible();
  const scroll = Date.now() - scrollStart;
  const line = `${new Date().toISOString()} ${process.env.TIMING_LABEL ?? "run"} firstRowMs=${firstRow} scroll20Ms=${scroll}\n`;
  await writeFile(`${SHOTS}-timings.txt`, line, { flag: "a" });
  console.log(line.trim());
});
