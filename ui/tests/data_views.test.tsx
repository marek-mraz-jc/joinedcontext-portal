/**
 * The views beside the grid (ADR-N-042 §3.2): one page of the type, read through the space's
 * source, drawn as cards (T-3100); a click opens the row whole.
 */
// covers (T-2137, the module gate in gate_modules.test.ts): src/pages/spaces/DataViews.tsx.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourceError, toRichRow } from "@joinedcontext/sdk";
import type { EntitySource } from "@joinedcontext/sdk";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import {
  CARD_FIELDS,
  CalendarView,
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
} from "../src/pages/spaces/DataViews";
import { expectNoViolations } from "./checks";

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
    expect(patch).toHaveBeenCalledWith(rows[0].id, { status: { type: "Property", value: "outOfService" } });
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
    expect(patch).toHaveBeenCalledWith(rows[0].id, { startDate: { type: "Property", value: "2026-10-09T18:00:00Z" } });
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
    });
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
    expect(screen.getByText(en.spaces.views.noDate)).toBeInTheDocument();
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
    expect(patch).toHaveBeenLastCalledWith(station(1).id, { status: { type: "Property", value: "working" } });
    expect(within(screen.getByTestId("kanban-column-working")).getAllByRole("listitem")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Redo: Station 1 to outOfService" }));
    expect(patch).toHaveBeenLastCalledWith(station(1).id, { status: { type: "Property", value: "outOfService" } });

    screen.getByTestId("view-kanban").focus();
    fireEvent.keyDown(screen.getByTestId("view-kanban"), { key: "z", ctrlKey: true });
    await waitFor(() =>
      expect(patch).toHaveBeenLastCalledWith(station(1).id, { status: { type: "Property", value: "working" } }),
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
