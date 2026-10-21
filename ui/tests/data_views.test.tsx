/**
 * The views beside the grid (ADR-N-042 §3.2): one page of the type, read through the space's
 * source, drawn as cards (T-3100); a click opens the row whole.
 */
// covers (T-2137, the module gate in gate_modules.test.ts): src/pages/spaces/DataViews.tsx.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sentTo } from "./requests";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourceError, toRichRow } from "@joinedcontext/sdk";
import type { EntitySource } from "@joinedcontext/sdk";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import {
  addDays,
  CARD_FIELDS,
  CalendarView,
  geoAttributes,
  MapOfRows,
  rowFeatures,
  shifted,
  startKeyOf,
  writes,
  deleteRow,
  GalleryView,
  KanbanView,
  TimelineView,
  columnsOf,
  dateKeys,
  dayOf,
  daysOf,
  imageOf,
  linkAttributes,
  primaryOf,
  rescheduled,
  stepOf,
  TrashPanel,
  writable,
} from "../src/pages/spaces/DataViews";
import { expectNoViolations } from "./checks";
import type { MapLayer } from "../src/components/dashboards/MapLibreView";
import type { ReactNode } from "react";

// MapLibre draws on a canvas jsdom does not have: the view is judged by the layer it hands over.
const drawn: { layers: MapLayer[] } = { layers: [] };
vi.mock("../src/components/dashboards/MapLibreView", async (original) => ({
  ...(await original<typeof import("../src/components/dashboards/MapLibreView")>()),
  MapLibreView: ({ layers, label }: { layers: MapLayer[]; label: string }) => {
    drawn.layers = layers;
    return <div role="application" aria-label={label} />;
  },
}));

const ORIGIN = window.location.origin;

const station = (n: number, extra: Record<string, unknown> = {}) =>
  toRichRow(
    {
      id: `urn:ngsi-ld:BikeHireDockingStation:hel.fi:bikes:${n}`,
      type: "BikeHireDockingStation",
      name: { type: "Property", value: `Station ${n}` },
      availableBikeNumber: { type: "Property", value: n },
      totalSlotNumber: { type: "Property", value: 20 },
      address: { type: "Property", value: `Street ${n}` },
      status: { type: "Property", value: "working" },
      operator: { type: "Property", value: "HSL" },
      zone: { type: "Property", value: "A" },
      ...extra,
    },
    "en",
  );

describe("the helpers of the views", () => {
  it("calls a row by its name, and by its id when it has none", () => {
    expect(primaryOf(station(1))).toBe("Station 1");
    const unnamed = toRichRow({ id: "urn:ngsi-ld:T:x", type: "T" }, "en");
    expect(primaryOf(unnamed)).toBe("urn:ngsi-ld:T:x");
  });

  it("draws an image of the Portal's own origin and links any other one, never a script", () => {
    const row = station(1, {
      own: { type: "Property", value: "/api/endpoint/abc/files/a.jpg" },
      far: { type: "Property", value: "https://images.example/a.jpg" },
      bad: { type: "Property", value: "javascript:alert(1)" },
    });
    expect(imageOf(row, "own", ORIGIN)).toEqual({ src: `${ORIGIN}/api/endpoint/abc/files/a.jpg` });
    expect(imageOf(row, "far", ORIGIN)).toEqual({ external: "https://images.example/a.jpg" });
    expect(imageOf(row, "bad", ORIGIN)).toBeUndefined();
    expect(imageOf(row, "name", ORIGIN)).toBeUndefined();
    expect(imageOf(row, undefined, ORIGIN)).toBeUndefined();
    expect(linkAttributes([row])).toEqual(["far", "own"]);
  });
});

describe("the gallery", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  const show = (rows = [station(1), station(2)]) =>
    render(
      <I18nextProvider i18n={i18n}>
        <GalleryView rows={rows} />
      </I18nextProvider>,
    );

  it("draws a card per entity with its name and at most five fields, and opens the row", async () => {
    show();
    const cards = screen.getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    const first = cards[0];
    expect(within(first).getByRole("button", { name: "Station 1" })).toBeInTheDocument();
    expect(within(first).getAllByRole("term")).toHaveLength(CARD_FIELDS);
    await expectNoViolations(screen.getByTestId("view-gallery"));

    await userEvent.click(within(first).getByRole("button", { name: "Station 1" }));
    const detail = await screen.findByRole("dialog", { name: "Station 1" });
    expect(within(detail).getByText("urn:ngsi-ld:BikeHireDockingStation:hel.fi:bikes:1")).toBeInTheDocument();
    expect(within(detail).getByText("operator")).toBeInTheDocument();
  });

  it("lets the person choose the fields, and keeps a sixth one closed with the reason", async () => {
    show();
    const ticked = () =>
      screen.getAllByRole("checkbox").filter((box) => (box as HTMLInputElement).checked);
    expect(ticked()).toHaveLength(CARD_FIELDS);
    const sixth = screen.getAllByRole("checkbox").find((box) => !(box as HTMLInputElement).checked) as HTMLElement;
    expect(sixth).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(ticked()[0]);
    expect(ticked()).toHaveLength(CARD_FIELDS - 1);
    expect(sixth).not.toHaveAttribute("aria-disabled");
  });

  it("puts an image elsewhere behind a link the person opens", () => {
    show([station(1, { photo: { type: "Property", value: "https://images.example/1.jpg" } })]);
    expect(screen.getByLabelText(en.spaces.views.image)).toHaveValue("photo");
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("link", { name: new RegExp(en.spaces.views.openImage) })).toHaveAttribute(
      "href",
      "https://images.example/1.jpg",
    );
  });
});

describe("the board (T-3101)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  const STATUS = [
    { value: "working", title: "Working" },
    { value: "outOfService", title: "Out of service" },
  ];
  const rows = [
    station(1),
    station(2, { status: { type: "Property", value: "outOfService" } }),
    station(3, { status: { type: "Property", value: "retired" } }),
  ];
  const sourceWith = (patch: EntitySource["patch"]): EntitySource => ({
    query: vi.fn(),
    get: vi.fn(),
    patch,
  });
  const show = (source: EntitySource, enums: Record<string, typeof STATUS> = { status: STATUS }) =>
    render(
      <I18nextProvider i18n={i18n}>
        <KanbanView rows={rows} source={source} enums={enums} />
      </I18nextProvider>,
    );

  it("puts each row under its value, a value the model does not list under none", () => {
    const columns = columnsOf(rows, "status", STATUS);
    expect([...columns.keys()]).toEqual(["working", "outOfService", ""]);
    expect(columns.get("working")?.map(primaryOf)).toEqual(["Station 1"]);
    expect(columns.get("")?.map(primaryOf)).toEqual(["Station 3"]);
    expect(columnsOf(rows, "status", STATUS, { [rows[0].id]: "outOfService" }).get("outOfService")).toHaveLength(2);
  });

  it("counts each column and moves a card from the card itself, writing the attribute", async () => {
    const patch = vi.fn(() => Promise.resolve());
    show(sourceWith(patch));
    expect(screen.getByRole("region", { name: "Working, 1 card" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "No value, 1 card" })).toBeInTheDocument();
    await expectNoViolations(screen.getByTestId("view-kanban"));

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Move Station 1 to" }), "outOfService");
    expect(patch).toHaveBeenCalledWith(rows[0].id, { status: { type: "Property", value: "outOfService" } }, undefined);
    expect(within(screen.getByTestId("kanban-column-outOfService")).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByTestId("kanban-column-working")).toBeInTheDocument();
  });

  it("takes a dropped card and puts a refused move back with the policy's words", async () => {
    const patch = vi.fn(() => Promise.reject(new SourceError(403, "the policy grants no update of status")));
    show(sourceWith(patch));
    const card = within(screen.getByTestId("kanban-column-working")).getByRole("listitem");
    fireEvent.dragStart(card, { dataTransfer: { setData: () => undefined } });
    fireEvent.dragOver(screen.getByTestId("kanban-column-outOfService"));
    fireEvent.drop(screen.getByTestId("kanban-column-outOfService"));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Station 1 was not moved: the policy grants no update of status",
    );
    await waitFor(() =>
      expect(within(screen.getByTestId("kanban-column-working")).getAllByRole("listitem")).toHaveLength(1),
    );
  });

  it("says why there is no board when the model lists no values", () => {
    show(sourceWith(vi.fn()), {});
    expect(screen.getByText(en.spaces.views.noEnum)).toBeInTheDocument();
  });
});

describe("the calendar and the timeline (T-3102)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  const event = (n: number, start: unknown, end?: unknown, observedAt?: string) =>
    toRichRow(
      {
        id: `urn:ngsi-ld:Event:hel.fi:events:${n}`,
        type: "Event",
        name: { type: "Property", value: `Event ${n}` },
        startDate: { type: "Property", value: start, ...(observedAt ? { observedAt } : {}) },
        ...(end !== undefined ? { endDate: { type: "Property", value: end } } : {}),
      },
      "en",
    );
  const rows = [
    event(1, "2026-10-06T18:00:00Z", "2026-10-08", "2026-10-01T10:00:00Z"),
    event(2, { "@type": "DateTime", "@value": "2026-10-20T09:30:00Z" }, "2026-10-21"),
    event(3, "2026-11-02"),
  ];

  it("places a row by a date attribute or by when it was observed, and offers only keys that are dates", () => {
    expect(dayOf(rows[0], "startDate")).toBe("2026-10-06");
    expect(dayOf(rows[1], "startDate")).toBe("2026-10-20");
    expect(dayOf(rows[0], "startDate.observedAt")).toBe("2026-10-01");
    expect(dayOf(rows[0], "name")).toBeUndefined();
    expect(dateKeys(rows)).toEqual(["endDate", "startDate", "startDate.observedAt"]);
  });

  it("moves a date in the shape it was written, and never when it was observed", () => {
    expect(rescheduled(rows[0], "startDate", "2026-10-09")).toEqual({
      startDate: { type: "Property", value: "2026-10-09T18:00:00Z" },
    });
    expect(rescheduled(rows[1], "startDate", "2026-10-22")).toEqual({
      startDate: { type: "Property", value: { "@type": "DateTime", "@value": "2026-10-22T09:30:00Z" } },
    });
    expect(rescheduled(rows[2], "startDate", "2026-11-03")).toEqual({ startDate: { type: "Property", value: "2026-11-03" } });
    expect(rescheduled(rows[0], "startDate.observedAt", "2026-10-09")).toBeUndefined();
    expect(rescheduled(rows[0], "startDate", "not a day")).toBeUndefined();
  });

  it("shows whole weeks from Monday around a month, a week and a day, and steps by each", () => {
    const month = daysOf("2026-10-15", "month");
    expect(month[0]).toBe("2026-09-28");
    expect(month[month.length - 1]).toBe("2026-11-01");
    expect(month).toHaveLength(35);
    expect(daysOf("2026-10-15", "week")).toEqual([
      "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18",
    ]);
    expect(daysOf("2026-10-15", "day")).toEqual(["2026-10-15"]);
    expect(stepOf("2026-01-31", "month", 1)).toBe("2026-02-01");
    expect(stepOf("2026-10-15", "week", -1)).toBe("2026-10-08");
    expect(stepOf("2026-12-31", "day", 1)).toBe("2027-01-01");
  });

  const source = (patch: EntitySource["patch"]): EntitySource => ({ query: vi.fn(), get: vi.fn(), patch });
  const calendar = (patch: EntitySource["patch"]) =>
    render(
      <I18nextProvider i18n={i18n}>
        <CalendarView rows={rows} source={source(patch)} today="2026-10-15" />
      </I18nextProvider>,
    );

  it("puts each row on its day and moves one dropped on another day", async () => {
    const patch = vi.fn(() => Promise.resolve());
    calendar(patch);
    // endDate is the first date key; the calendar is placed by startDate once chosen.
    await userEvent.selectOptions(screen.getByLabelText(en.spaces.views.dateBy), "startDate");
    expect(within(screen.getByTestId("calendar-day-2026-10-06")).getByRole("button", { name: "Event 1" })).toBeInTheDocument();
    // Event 3 is in November, past the last week of October.
    expect(screen.queryByRole("button", { name: "Event 3" })).toBeNull();
    await expectNoViolations(screen.getByTestId("view-calendar"));

    const chip = within(screen.getByTestId("calendar-day-2026-10-06")).getByRole("button", { name: "Event 1" });
    fireEvent.dragStart(chip, { dataTransfer: { setData: () => undefined } });
    fireEvent.dragOver(screen.getByTestId("calendar-day-2026-10-09"));
    fireEvent.drop(screen.getByTestId("calendar-day-2026-10-09"));
    expect(patch).toHaveBeenCalledWith(rows[0].id, { startDate: { type: "Property", value: "2026-10-09T18:00:00Z" } }, undefined);
    expect(within(screen.getByTestId("calendar-day-2026-10-09")).getByRole("button", { name: "Event 1" })).toBeInTheDocument();
  });

  it("moves a row from its own dialog by the keyboard, and puts a refused move back", async () => {
    const patch = vi.fn(() => Promise.reject(new SourceError(403, "the policy grants no update of startDate")));
    calendar(patch);
    await userEvent.selectOptions(screen.getByLabelText(en.spaces.views.dateBy), "startDate");
    await userEvent.click(within(screen.getByTestId("calendar-day-2026-10-20")).getByRole("button", { name: "Event 2" }));
    const dialog = await screen.findByRole("dialog", { name: "Event 2" });
    const day = within(dialog).getByLabelText(/^Move startDate to/);
    fireEvent.change(day, { target: { value: "2026-10-23" } });
    await userEvent.click(within(dialog).getByRole("button", { name: en.spaces.views.rescheduleSave }));
    expect(patch).toHaveBeenCalledWith(rows[1].id, {
      startDate: { type: "Property", value: { "@type": "DateTime", "@value": "2026-10-23T09:30:00Z" } },
    }, undefined);
    expect(await screen.findByRole("alert")).toHaveTextContent("Event 2 was not moved: the policy grants no update of startDate");
    expect(within(screen.getByTestId("calendar-day-2026-10-20")).getByRole("button", { name: "Event 2" })).toBeInTheDocument();
  });

  it("steps to the next month and back to today", async () => {
    calendar(vi.fn());
    await userEvent.click(screen.getByRole("button", { name: en.spaces.views.next }));
    expect(screen.getByTestId("calendar-day-2026-11-30")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: en.spaces.views.today }));
    expect(screen.getByTestId("calendar-day-2026-10-15")).toBeInTheDocument();
  });

  it("draws a bar per row from start to end in start order, and counts the rows without both", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <TimelineView rows={rows} />
      </I18nextProvider>,
    );
    // The first two date keys are endDate and startDate: choose them the right way round.
    fireEvent.change(screen.getByLabelText(en.spaces.views.start), { target: { value: "startDate" } });
    fireEvent.change(screen.getByLabelText(en.spaces.views.end), { target: { value: "endDate" } });
    const bars = within(screen.getByTestId("view-timeline")).getAllByRole("listitem");
    expect(bars.map((bar) => within(bar).getByRole("button").textContent)).toEqual(["Event 1", "Event 2"]);
    expect(screen.getByText("1 entity has no start or end and is not shown.")).toBeInTheDocument();
  });

  it("says when the type holds no date", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <TimelineView rows={[station(1)]} />
      </I18nextProvider>,
    );
    expect(screen.getByText(en.spaces.views.noDateTimeline)).toBeInTheDocument();
  });
});

describe("history and undo (T-3107)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  const STATUS = [
    { value: "working", title: "Working" },
    { value: "outOfService", title: "Out of service" },
  ];

  it("undoes and redoes the person's own move as compensating writes, by button and by Ctrl+Z", async () => {
    const patch = vi.fn((_id: string, _attrs: Record<string, unknown>) => Promise.resolve());
    const source: EntitySource = { query: vi.fn(), get: vi.fn(), patch };
    render(
      <I18nextProvider i18n={i18n}>
        <KanbanView rows={[station(1)]} source={source} enums={{ status: STATUS }} />
      </I18nextProvider>,
    );
    expect(screen.getByRole("button", { name: en.spaces.views.undoNone })).toHaveAttribute("aria-disabled", "true");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Move Station 1 to" }), "outOfService");
    const undo = screen.getByRole("button", { name: "Undo: Station 1 back to working" });
    await userEvent.click(undo);
    expect(patch).toHaveBeenLastCalledWith(station(1).id, { status: { type: "Property", value: "working" } }, undefined);
    expect(within(screen.getByTestId("kanban-column-working")).getAllByRole("listitem")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Redo: Station 1 to outOfService" }));
    expect(patch).toHaveBeenLastCalledWith(station(1).id, { status: { type: "Property", value: "outOfService" } }, undefined);

    screen.getByTestId("view-kanban").focus();
    fireEvent.keyDown(screen.getByTestId("view-kanban"), { key: "z", ctrlKey: true });
    await waitFor(() =>
      expect(patch).toHaveBeenLastCalledWith(station(1).id, { status: { type: "Property", value: "working" } }, undefined),
    );
    expect(patch).toHaveBeenCalledTimes(4);
  });

  it("keeps a refused undo where it was, with the policy's words", async () => {
    let refuse = false;
    const patch = vi.fn(() => (refuse ? Promise.reject(new SourceError(403, "no grant")) : Promise.resolve()));
    const source: EntitySource = { query: vi.fn(), get: vi.fn(), patch };
    render(
      <I18nextProvider i18n={i18n}>
        <KanbanView rows={[station(1)]} source={source} enums={{ status: STATUS }} />
      </I18nextProvider>,
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Move Station 1 to" }), "outOfService");
    refuse = true;
    await userEvent.click(screen.getByRole("button", { name: "Undo: Station 1 back to working" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Station 1 was not moved: no grant");
    expect(within(screen.getByTestId("kanban-column-outOfService")).getAllByRole("listitem")).toHaveLength(1);
  });

  it("shows an attribute's recorded values from the temporal API in the row", async () => {
    const history = vi.fn(() =>
      Promise.resolve([
        { at: "2026-10-06T10:00:00Z", value: 4 },
        { at: "2026-10-06T11:00:00Z", value: 1 },
      ]),
    );
    const source: EntitySource = { query: vi.fn(), get: vi.fn(), history };
    render(
      <I18nextProvider i18n={i18n}>
        <GalleryView rows={[station(1)]} source={source} />
      </I18nextProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Station 1" }));
    const dialog = await screen.findByRole("dialog", { name: "Station 1" });
    await userEvent.click(within(dialog).getByRole("button", { name: "History of availableBikeNumber" }));
    expect(history).toHaveBeenCalledWith(station(1).id, "availableBikeNumber", expect.anything());
    expect((await within(dialog).findAllByText("4")).length).toBeGreaterThan(0);
  });
});

describe("delete and the trash (T-3107)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
    );

  it("sends the entity back without the broker's own timestamps", () => {
    expect(
      writable({
        id: "urn:ngsi-ld:T:1",
        type: "T",
        createdAt: "x",
        modifiedAt: "y",
        a: { type: "Property", value: 1, createdAt: "x", observedAt: "z" },
      }),
    ).toEqual({ id: "urn:ngsi-ld:T:1", type: "T", a: { type: "Property", value: 1, observedAt: "z" } });
  });

  it("keeps the copy before the delete, and forgets it when the gateway refuses the delete", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const request = input as Request;
      return request.method === "POST" ? json({ id: 9, urn: "u", type: "T", entity: {}, deletedAt: "", expiresAt: "" }, 201) : json(null, 204);
    });
    vi.stubGlobal("fetch", fetchMock);
    const remove = vi.fn(() => Promise.resolve());
    await deleteRow("helsinki", "bikes", { query: vi.fn(), get: vi.fn(), remove }, station(1));
    const kept = sentTo(fetchMock, "/spaces/bikes/trash");
    expect(kept.map((call) => call.method)).toEqual(["POST"]);
    expect(((await kept[0].json()) as { entity: { id: string } }).entity.id).toBe(station(1).id);
    expect(remove).toHaveBeenCalledWith(station(1).id);

    const refused = vi.fn(() => Promise.reject(new SourceError(403, "no delete granted")));
    await expect(deleteRow("helsinki", "bikes", { query: vi.fn(), get: vi.fn(), remove: refused }, station(2))).rejects.toThrow(
      "no delete granted",
    );
    expect(sentTo(fetchMock, "/spaces/bikes/trash/9").map((call) => call.method)).toEqual(["DELETE"]);
    vi.unstubAllGlobals();
  });

  it("asks before deleting a row and says a refusal in the gateway's words", async () => {
    let refuse = false;
    const onDelete = vi.fn(() => (refuse ? Promise.reject(new Error("no delete granted")) : Promise.resolve()));
    render(
      <I18nextProvider i18n={i18n}>
        <GalleryView rows={[station(1)]} onDelete={onDelete} />
      </I18nextProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Station 1" }));
    const dialog = await screen.findByRole("dialog", { name: "Station 1" });
    refuse = true;
    await userEvent.click(within(dialog).getByRole("button", { name: en.spaces.views.delete }));
    const confirm = await screen.findByRole("alertdialog", { name: "Delete Station 1?" });
    await userEvent.click(within(confirm).getByRole("button", { name: en.spaces.views.delete }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(await within(screen.getByRole("dialog", { name: "Station 1" })).findByRole("alert")).toHaveTextContent(
      "Station 1 was not deleted: no delete granted",
    );
  });

  it("lists the person's deleted entities and puts one back with their own create", async () => {
    const item = { id: 4, urn: station(1).id, type: "BikeHireDockingStation", entity: { id: station(1).id, type: "BikeHireDockingStation", name: { type: "Property", value: "Station 1" } }, deletedAt: "2026-10-06T19:20:00Z", expiresAt: "2026-11-05T19:20:00Z" };
    let listed = [item];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.method === "DELETE") {
        listed = [];
        return json(null, 204);
      }
      return json(listed);
    });
    vi.stubGlobal("fetch", fetchMock);
    const restore = vi.fn(() => Promise.resolve());
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nextProvider i18n={i18n}>
          <TrashPanel project="helsinki" space="bikes" restore={restore} />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    const panel = await screen.findByTestId("view-trash");
    expect(within(panel).getByText("Deleted entities (1)")).toBeInTheDocument();
    await userEvent.click(within(panel).getByText("Deleted entities (1)"));
    await userEvent.click(within(panel).getByRole("button", { name: "Put back Station 1" }));
    expect(restore).toHaveBeenCalledWith(item.entity);
    await waitFor(() => expect(screen.queryByTestId("view-trash")).toBeNull());
    expect(sentTo(fetchMock, "/spaces/bikes/trash/4").map((call) => call.method)).toEqual(["DELETE"]);
    vi.unstubAllGlobals();
  });
});

describe("writes, reasons and phones (T-4884)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  const STATUS = [
    { value: "working", title: "Working" },
    { value: "outOfService", title: "Out of service" },
  ];
  const event = (n: number, start: string, end?: string) =>
    toRichRow(
      {
        id: `urn:ngsi-ld:Event:hel.fi:events:${n}`,
        type: "Event",
        name: { type: "Property", value: `Event ${n}` },
        startDate: { type: "Property", value: start },
        ...(end ? { endDate: { type: "Property", value: end } } : {}),
      },
      "en",
    );
  const wrap = (node: ReactNode) => render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

  it("lets a view write an attribute only through a source that writes and a grant naming it", () => {
    const patch = vi.fn();
    const source: EntitySource = { query: vi.fn(), get: vi.fn(), patch };
    expect(writes(source, undefined, "status")).toBe(true);
    expect(writes(source, ["status"], "status")).toBe(true);
    expect(writes(source, ["name"], "status")).toBe(false);
    expect(writes(source, [], "status")).toBe(false);
    expect(writes({ query: vi.fn(), get: vi.fn() }, ["status"], "status")).toBe(false);
    expect(writes(source, ["status"], "")).toBe(false);
  });

  it("shows a viewer the board without a drag or a move, and says why", () => {
    const patch = vi.fn();
    wrap(<KanbanView rows={[station(1)]} source={{ query: vi.fn(), get: vi.fn(), patch }} enums={{ status: STATUS }} editable={[]} />);
    expect(screen.getByText(en.spaces.views.boardReadOnly.replace("{attr}", "status"))).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Move Station 1/ })).toBeNull();
    expect(screen.queryByLabelText(en.spaces.views.moveReason)).toBeNull();
    expect(screen.getByTestId("kanban-column-working").querySelector("li")?.getAttribute("draggable")).toBe("false");
  });

  it("sends the reason the person typed with a board move", async () => {
    const patch = vi.fn().mockResolvedValue(undefined);
    wrap(<KanbanView rows={[station(1)]} source={{ query: vi.fn(), get: vi.fn(), patch }} enums={{ status: STATUS }} editable={["status"]} />);
    await userEvent.type(screen.getByLabelText(en.spaces.views.moveReason), "Broken lock");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Station 1/ }), "outOfService");
    expect(patch).toHaveBeenCalledWith(station(1).id, { status: { type: "Property", value: "outOfService" } }, "Broken lock");
  });

  it("keeps the calendar read-only for a date the person's grants do not name", () => {
    wrap(<CalendarView rows={[event(1, "2026-10-06")]} source={{ query: vi.fn(), get: vi.fn(), patch: vi.fn() }} editable={["name"]} today="2026-10-06" />);
    expect(screen.queryByLabelText(en.spaces.views.moveReason)).toBeNull();
    expect(within(screen.getByTestId("calendar-day-2026-10-06")).getByRole("button", { name: "Event 1" }).getAttribute("draggable")).toBe("false");
  });

  it("says on a phone when nothing falls in the month shown, and hides the empty days", () => {
    wrap(<CalendarView rows={[event(1, "2026-12-06")]} source={{ query: vi.fn(), get: vi.fn() }} today="2026-10-06" />);
    expect(screen.getByText(en.spaces.views.nothingThisSpan)).toHaveClass("sm:hidden");
    expect(screen.getByTestId("calendar-day-2026-10-06")).toHaveClass("hidden");
  });

  it("starts a calendar and a timeline from the key named as a start, not the first in name order", () => {
    expect(startKeyOf(["endDate", "startDate"])).toBe("startDate");
    expect(startKeyOf(["validFrom", "validTo"])).toBe("validFrom");
    expect(startKeyOf(["dateIssued", "dateModified"])).toBe("dateIssued");
    expect(startKeyOf([])).toBe("");
  });

  it("moves a timeline row's start and end by the same days, each in its own shape", () => {
    const row = event(1, "2026-10-06T18:00:00Z", "2026-10-08");
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(shifted(row, "startDate", "endDate", "2026-10-10")).toEqual({
      startDate: { type: "Property", value: "2026-10-10T18:00:00Z" },
      endDate: { type: "Property", value: "2026-10-12" },
    });
    expect(shifted(row, "startDate", "startDate", "2026-10-10")).toEqual({
      startDate: { type: "Property", value: "2026-10-10T18:00:00Z" },
    });
    expect(shifted(event(2, "2026-10-06"), "startDate", "endDate", "2026-10-10")).toBeUndefined();
    expect(shifted(row, "startDate", "endDate", "soon")).toBeUndefined();
  });

  it("moves a timeline row from its dialog with the reason, and shows it where it went", async () => {
    const patch = vi.fn().mockResolvedValue(undefined);
    const row = event(1, "2026-10-06", "2026-10-08");
    wrap(<TimelineView rows={[row]} source={{ query: vi.fn(), get: vi.fn(), patch }} editable={["startDate", "endDate"]} />);
    expect(screen.getByText(en.spaces.views.timelineDrag)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(en.spaces.views.moveReason), "Venue moved");
    await userEvent.click(screen.getByRole("button", { name: "Event 1" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/New startDate/), { target: { value: "2026-10-16" } });
    await userEvent.click(within(dialog).getByRole("button", { name: en.spaces.views.rescheduleSave }));
    expect(patch).toHaveBeenCalledWith(
      row.id,
      { startDate: { type: "Property", value: "2026-10-16" }, endDate: { type: "Property", value: "2026-10-18" } },
      "Venue moved",
    );
    expect(await screen.findByText(/Oct 16, 2026 – Oct 18, 2026/)).toBeInTheDocument();
  });

  it("offers a viewer no move on the timeline", async () => {
    wrap(<TimelineView rows={[event(1, "2026-10-06", "2026-10-08")]} source={{ query: vi.fn(), get: vi.fn(), patch: vi.fn() }} editable={[]} />);
    expect(screen.queryByText(en.spaces.views.timelineDrag)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Event 1" }));
    expect(within(await screen.findByRole("dialog")).queryByLabelText(/New startDate/)).toBeNull();
  });
});

describe("the map (T-4884)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    drawn.layers = [];
  });
  const placed = (n: number, location?: unknown) =>
    toRichRow(
      {
        id: `urn:ngsi-ld:Event:hel.fi:events:${n}`,
        type: "Event",
        name: { type: "Property", value: `Event ${n}` },
        ...(location ? { location: { type: "GeoProperty", value: location } } : {}),
      },
      "en",
    );
  const rows = [placed(1, { type: "Point", coordinates: [24.94, 60.17] }), placed(2)];

  it("offers the GeoProperties of the page, location first, and draws the rows that have one", () => {
    expect(geoAttributes(rows)).toEqual(["location"]);
    expect(geoAttributes([station(1)])).toEqual([]);
    const features = rowFeatures(rows, "location").features as { properties: { id: string; name: string } }[];
    expect(features.map((feature) => feature.properties)).toEqual([{ id: rows[0].id, name: "Event 1" }]);
  });

  it("places the rows, counts the unplaced, and opens a row from its point", async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MapOfRows project="helsinki" rows={rows} />
      </I18nextProvider>,
    );
    expect(screen.getByText(/1 row of 2 on the map/)).toBeInTheDocument();
    expect(await screen.findByRole("application", { name: "Map of the rows by location" })).toBeInTheDocument();
    expect(drawn.layers[0].cluster).toBe(true);
    act(() => drawn.layers[0].open?.onOpen(rows[0].id));
    expect(await screen.findByRole("dialog", { name: "Event 1" })).toBeInTheDocument();
  });

  it("names the field type a map needs when the rows have no place", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MapOfRows rows={[station(1)]} />
      </I18nextProvider>,
    );
    expect(screen.getByText(en.spaces.views.noGeo)).toBeInTheDocument();
  });
});
