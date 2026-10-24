import { expect, test } from "@playwright/test";
import { attributeTable } from "./attributeAccess";
import type { Locator, Page } from "@playwright/test";
import { axeViolations } from "./axe";

// The views beside the grid shaped like Baserow, part 2 (T-4884): gallery with covers, a board by
// an enum whose drag writes the attribute, a calendar and a timeline whose drag moves the dates,
// a map of the same rows, a form that creates an entity, and the API tab with the URL of the
// view's own query. Every write goes to the person's Endpoint with the reason they typed; the
// Policy (answered here in the browser, since `vite preview` has no Portal behind it) refuses one
// move, and a viewer gets no move at all. With SHOTS_DIR set, each state is written at 1440 and
// 400 px for the task's evidence.

const PROJECT = "helsinki";
const SPACE = "helsinki";
const TYPE = "Event";
const SLUG = "k7m2qz4tv6xh3n5jb2ryd3wcfa";

const list = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });
const manifest = (kind: string, name: string, spec: Record<string, unknown>, title?: string) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind,
  metadata: { name, namespace: PROJECT, ...(title ? { title: { en: title } } : {}) },
  spec,
  status: { phase: "Live" },
});

const LINKML = [
  "id: https://hel.fi/models/events",
  "name: helsinki-events",
  "classes:",
  "  Event:",
  "    title: Event",
  "    slots: [id, name, eventStatus, startDate, endDate, image]",
  "slots:",
  "  id: {}",
  "  name: { range: string, title: Name, required: true }",
  "  eventStatus: { range: EventStatus, title: Status }",
  "  startDate: { range: datetime, title: Starts }",
  "  endDate: { range: datetime, title: Ends }",
  "  image: { range: uri, title: Image }",
  "enums:",
  "  EventStatus:",
  "    permissible_values:",
  "      scheduled: { title: Scheduled }",
  "      postponed: { title: Postponed }",
  "      cancelled: { title: Cancelled }",
  "",
].join("\n");

const NAMES = [
  "Finnish Language Café",
  "Board game club",
  "Workshop for Families",
  "Toastmasters evening",
  "Chinese Mid Autumn Festival",
  "Time machine",
  "Men's cafe",
  "Library jazz night",
];
const STATUS = ["scheduled", "scheduled", "postponed", "cancelled"];

// Four small covers on the Portal's own origin: the CSP draws no image from another host.
const COVERS = [
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAASCAIAAAC1qksFAAAAH0lEQVR4nGPQztlAU8QwasGoBaMWjFowasGoBfSwAAB0Rt/fMfJbRgAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAASCAIAAAC1qksFAAAAH0lEQVR4nGO4WaVNU8QwasGoBaMWjFowasGoBfSwAABBrVuug3i/CwAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAASCAIAAAC1qksFAAAAH0lEQVR4nGOwmhVNU8QwasGoBaMWjFowasGoBfSwAAAkjanfQ6kh1AAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAASCAIAAAC1qksFAAAAH0lEQVR4nGPoc1lLU8QwasGoBaMWjFowasGoBfSwAAAhB13uPprFswAAAABJRU5ErkJggg==",
];

const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}`;

function event(n: number) {
  const start = 6 + ((n * 3) % 20);
  return {
    id: `urn:ngsi-ld:Event:hel.fi:linkedevents:${n}`,
    type: TYPE,
    name: { type: "Property", value: `${NAMES[n % NAMES.length]} ${n}` },
    eventStatus: { type: "Property", value: STATUS[n % STATUS.length] },
    startDate: { type: "Property", value: `${day(start)}T17:00:00Z` },
    endDate: { type: "Property", value: `${day(start + (n % 3))}T20:00:00Z` },
    image: { type: "Property", value: `/api/v1/projects/${PROJECT}/files/cover-${n % COVERS.length}.png` },
    location: { type: "GeoProperty", value: { type: "Point", coordinates: [24.9 + n / 100, 60.15 + n / 200] } },
  };
}

interface Seen {
  writes: { path: string; body: unknown; reason: string | null }[];
  creates: unknown[];
}

async function stubApi(page: Page, seen: Seen, viewer: boolean): Promise<void> {
  await page.route("**/{api,cs}/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
    if (path.endsWith("/auth/me")) {
      return json({ subject: "b7c1e0f4", username: "jana.kovacova", name: "Jana Kováčová", roles: [viewer ? "portal-viewer" : "portal-editor"] });
    }
    if (path.includes("/files/cover-")) {
      const n = Number(path.match(/cover-(\d)/)?.[1] ?? 0);
      return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(COVERS[n], "base64") });
    }
    if (path.includes("/basemap/")) return route.fulfill({ status: 404, body: "" });
    if (path.endsWith("/datamodels/helsinki-events/source")) {
      return route.fulfill({ status: 200, contentType: "text/yaml", body: LINKML });
    }
    if (path.endsWith("/attrs") && method === "PATCH") {
      const id = decodeURIComponent(path.split("/entities/")[1]?.replace(/\/attrs$/, "") ?? "");
      const reason = request.headers()["jc-reason"] ?? null;
      seen.writes.push({ path: decodeURIComponent(path), body: request.postDataJSON(), reason: reason && decodeURIComponent(reason) });
      // The Policy refuses any write on the second event: the view puts it back with these words.
      if (id.endsWith(":2")) return json({ title: "Forbidden", detail: "the Policy grants no update of this event" }, 403);
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith("/entities") && method === "POST") {
      seen.creates.push(request.postDataJSON());
      return route.fulfill({ status: 201, headers: { Location: "/ngsi-ld/v1/entities/urn:ngsi-ld:Event:new" } });
    }
    if (path.endsWith("/entities")) {
      const rows = Array.from({ length: 12 }, (_, i) => event(i + 1));
      return json(rows, 200, { "NGSILD-Results-Count": String(rows.length) });
    }
    if (path.endsWith("/access/attributes")) {
      const slots = ["name", "eventStatus", "startDate", "endDate", "image"];
      return json(attributeTable(TYPE, slots, viewer ? [] : slots));
    }
    if (path.endsWith("/access")) {
      const actions = viewer ? ["queryEntity"] : ["queryEntity", "createEntity", "updateAttrs", "deleteEntity"];
      return json({ permissions: [{ resource: { type: TYPE }, actions, attributes: "*" }] });
    }
    if (path === "/api/v1/projects") return json({ kind: "ProjectList", items: [{ name: PROJECT }] });
    if (path.endsWith(`/spaces/${SPACE}/views`)) return json({ items: [] });
    if (path.endsWith(`/spaces/${SPACE}`)) {
      return json(manifest("ContextSpace", SPACE, { dataModelRef: "helsinki-events" }, "Helsinki city context"));
    }
    if (path.endsWith("/datamodels")) {
      return json(list([manifest("DataModel", "helsinki-events", { contextSpaceRef: SPACE, version: "1.0.0", classes: [TYPE], linkml: LINKML })]));
    }
    if (path.endsWith("/endpoints")) {
      return json(list([manifest("Endpoint", "app-helsinki-data", { contextSpaceRef: SPACE, slug: SLUG, audience: "project", enabledRepresentations: ["ngsi-ld", "ogc-features", "odata"] })]));
    }
    return json(list([]));
  });
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

async function noSideways(page: Page): Promise<void> {
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(sideways).toBeLessThanOrEqual(0);
}

// The HTML drag events themselves: a mouse drag across a board that scrolls while it moves can pick
// up the card under the pointer after the scroll instead of the one asked for.
async function drag(page: Page, source: Locator, target: Locator): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
  await source.dispatchEvent("dragend", { dataTransfer });
}

async function open(page: Page, tab: string): Promise<void> {
  await page.getByRole("tab", { name: tab, exact: true }).click();
}

for (const [label, width, height] of [["desktop-1440", 1440, 900], ["phone-400", 400, 860]] as const) {
  const phone = width < 640;

  test(`Each view type works on the Helsinki events (${label})`, async ({ page }) => {
    const seen: Seen = { writes: [], creates: [] };
    await page.setViewportSize({ width, height });
    await stubApi(page, seen, false);
    await page.goto(`/projects/${PROJECT}/spaces/${SPACE}?lang=en&view=gallery`);

    // Gallery: a card per event with its cover from the Portal's origin.
    const gallery = page.getByTestId("view-gallery");
    await expect(gallery.getByRole("button", { name: "Board game club 1" })).toBeVisible();
    await expect(gallery.locator("img").first()).toHaveJSProperty("complete", true);
    await noSideways(page);
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, `views-gallery-${label}`);

    // Board: columns by the status enum; a move writes it with the reason, a refused one goes back.
    await open(page, "Board");
    const board = page.getByTestId("view-kanban");
    await expect(board.getByTestId("kanban-column-postponed")).toBeVisible();
    await board.getByLabel("Why you move (optional)").fill("Venue closed for repairs");
    if (phone) {
      await board.getByRole("combobox", { name: /Board game club 1/ }).selectOption("postponed");
    } else {
      await drag(page, board.getByRole("listitem").filter({ hasText: "Board game club 1" }), board.getByTestId("kanban-column-postponed"));
    }
    await expect.poll(() => seen.writes.length).toBe(1);
    expect(seen.writes[0]).toMatchObject({
      path: `/api/endpoint/${SLUG}/ngsi-ld/v1/entities/urn:ngsi-ld:Event:hel.fi:linkedevents:1/attrs`,
      body: { eventStatus: { type: "Property", value: "postponed" } },
      reason: "Venue closed for repairs",
    });
    await expect(board.getByTestId("kanban-column-postponed").getByRole("button", { name: "Board game club 1" })).toBeVisible();
    await board.getByRole("combobox", { name: /Workshop for Families 2/ }).selectOption("cancelled");
    await expect(board.getByRole("alert")).toContainText("the Policy grants no update of this event");
    await expect(board.getByTestId("kanban-column-postponed").getByRole("button", { name: "Workshop for Families 2" })).toBeVisible();
    await noSideways(page);
    await shot(page, `views-board-${label}`);

    // Calendar: the event on its start day; moved to another day keeps its time of day.
    await open(page, "Calendar");
    const calendar = page.getByTestId("view-calendar");
    await expect(calendar.getByTestId(`calendar-day-${day(9)}`).getByRole("button", { name: "Board game club 1" })).toBeVisible();
    if (phone) {
      await calendar.getByRole("button", { name: "Board game club 1" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel(/Move startDate to/).fill(day(12));
      await dialog.getByRole("button", { name: "Move" }).click();
    } else {
      await drag(page, calendar.getByRole("button", { name: "Board game club 1", exact: true }), calendar.getByTestId(`calendar-day-${day(12)}`));
    }
    await expect.poll(() => seen.writes.length).toBe(3);
    expect(seen.writes[2].body).toEqual({ startDate: { type: "Property", value: `${day(12)}T17:00:00Z` } });
    await expect(calendar.getByTestId(`calendar-day-${day(12)}`).getByRole("button", { name: "Board game club 1" })).toBeVisible();
    await noSideways(page);
    await shot(page, `views-calendar-${label}`);

    // Timeline: start to end; a bar dragged a few days moves both dates by the same days.
    await open(page, "Timeline");
    const timeline = page.getByTestId("view-timeline");
    await expect(timeline.getByLabel("Starts", { exact: true })).toHaveValue("startDate");
    await expect(timeline.getByLabel("Ends", { exact: true })).toHaveValue("endDate");
    const bar = timeline.getByTestId("timeline-bar-urn:ngsi-ld:Event:hel.fi:linkedevents:4");
    if (phone) {
      await timeline.getByRole("button", { name: "Chinese Mid Autumn Festival 4" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel(/New startDate/).fill(day(20));
      await dialog.getByRole("button", { name: "Move" }).click();
    } else {
      await bar.scrollIntoViewIfNeeded();
      const box = await bar.boundingBox();
      if (!box) throw new Error("the timeline bar is not drawn");
      await page.mouse.move(box.x + 40, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 40 + box.width / 4, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
    }
    await expect.poll(() => seen.writes.length).toBe(4);
    const moved = seen.writes[3].body as { startDate: { value: string }; endDate: { value: string } };
    // Event 4 lasts one day (18 → 19): the move keeps that.
    const length = (Date.parse(moved.endDate.value) - Date.parse(moved.startDate.value)) / 3_600_000;
    expect(length).toBe(27);
    expect(moved.startDate.value).not.toBe(`${day(18)}T17:00:00Z`);
    await noSideways(page);
    await shot(page, `views-timeline-${label}`);

    // Map: the same rows by their location.
    await open(page, "Map");
    await expect(page.getByTestId("view-map").getByText("12 rows of 12 on the map")).toBeVisible();
    await expect(page.getByRole("region", { name: /Map of the rows by location/ }).or(page.getByLabel(/Map of the rows by location/)).first()).toBeVisible();
    await noSideways(page);
    await shot(page, `views-map-${label}`);

    // Form: creates one event through the space; the model's required name is asked first.
    await open(page, "Form");
    await page.getByRole("button", { name: "Create" }).first().click();
    await expect(page.getByText("1 answer needs fixing before the form can be sent.")).toBeVisible();
    await page.getByRole("tabpanel").getByRole("textbox", { name: "Name", exact: true }).fill("Harbour clean-up");
    await page.getByRole("button", { name: "Create" }).first().click();
    await expect.poll(() => seen.creates.length).toBe(1);
    expect(seen.creates[0]).toMatchObject({ type: TYPE, name: { value: "Harbour clean-up" } });
    await noSideways(page);
    await shot(page, `views-form-${label}`);

    // API: the URL of this view's query on each representation the Endpoint serves.
    await open(page, "API");
    const query = page.getByTestId("api-view-query");
    await expect(query.getByText(`/api/endpoint/${SLUG}/ngsi-ld/v1/entities?type=Event`, { exact: false })).toBeVisible();
    await expect(query.getByText(`/ogc/features/collections/Event/items`, { exact: false })).toBeVisible();
    await expect(query.getByText(`/odata/v4/Event`, { exact: false })).toBeVisible();
    await expect(query.getByRole("button", { name: "Copy the OData URL" })).toBeVisible();
    await noSideways(page);
    expect(await axeViolations(page)).toEqual([]);
    await shot(page, `views-api-${label}`);
  });

  test(`A viewer reads the board and the timeline without a move (${label})`, async ({ page }) => {
    const seen: Seen = { writes: [], creates: [] };
    await page.setViewportSize({ width, height });
    await stubApi(page, seen, true);
    await page.goto(`/projects/${PROJECT}/spaces/${SPACE}?lang=en&view=kanban`);
    const board = page.getByTestId("view-kanban");
    await expect(board.getByText(/None of your Endpoints lets you change eventStatus/)).toBeVisible();
    await expect(board.getByRole("combobox", { name: /Move/ })).toHaveCount(0);
    await expect(board.getByLabel("Why you move (optional)")).toHaveCount(0);
    await shot(page, `views-board-viewer-${label}`);
    await open(page, "Timeline");
    await expect(page.getByTestId("view-timeline").getByText(/Drag a bar sideways/)).toHaveCount(0);
    expect(seen.writes).toEqual([]);
  });
}
