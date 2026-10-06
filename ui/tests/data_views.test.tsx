/**
 * The views beside the grid (ADR-N-042 §3.2): one page of the type, read through the space's
 * source, drawn as cards (T-3100); a click opens the row whole.
 */
// covers (T-2137, the module gate in gate_modules.test.ts): src/pages/spaces/DataViews.tsx.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it } from "vitest";
import { toRichRow } from "@joinedcontext/sdk";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { CARD_FIELDS, GalleryView, imageOf, linkAttributes, primaryOf } from "../src/pages/spaces/DataViews";
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
