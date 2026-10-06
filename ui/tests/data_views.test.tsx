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
import { CARD_FIELDS, GalleryView, KanbanView, columnsOf, imageOf, linkAttributes, primaryOf } from "../src/pages/spaces/DataViews";
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
