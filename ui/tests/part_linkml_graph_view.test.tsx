/**
 * T-1846: the model drawn as a graph, against the UI contract (UI-15, UI-16, UI-11).
 *
 * `linkml_editor.test.tsx` owns the shape of the graph — which class sits where, which line
 * joins what — and reaches it through the editor's third tab. This file mounts the view on its
 * own and owns what the survey of 2026-09-18 measured and what reading it found beside that:
 *
 * - the three text sizes were Tailwind arbitrary values on a drawing whose own units they are,
 *   and the minimum height an inline `style`. They are `BOX` and `min-h-48` now;
 * - the class box is a focusable button that carried `focus:outline-none`, so a keyboard had
 *   nothing to follow;
 * - the drawing was `role="img"`, whose contents are presentational: the boxes were reachable
 *   by Tab and invisible to the screen reader that had just been told this was one picture.
 */
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { LinkmlGraphView } from "../src/pages/models/LinkmlGraphView";
import { expectNoRawKeys, focusables } from "./checks";
import { expectNoAxeViolations, inEveryLocale, renderPart } from "./page_contract";

const MODEL = `name: mobility
classes:
  Thing:
    slots: []
  Traceable:
    slots: []
  Vehicle:
    is_a: Thing
    mixins: [Traceable]
    slots: [refDevice, speed]
  Device:
    slots: []
slots:
  refDevice:
    range: Device
  speed:
    range: float
`;

/** A class with more slots than a box draws, to see the box stop rather than grow. */
const LONG = `name: long
classes:
  Wide:
    slots: [a, b, c, d, e, f, g, h, i]
slots:
  a: { range: string }
  b: { range: string }
  c: { range: string }
  d: { range: string }
  e: { range: string }
  f: { range: string }
  g: { range: string }
  h: { range: string }
  i: { range: string }
`;

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

describe("the drawing as a screen reader and a keyboard find it", () => {
  // The defect this file was opened for: an image's children are presentational.
  it("is a named group of class buttons, not one picture", async () => {
    renderPart(<LinkmlGraphView source={MODEL} />);

    const canvas = screen.getByRole("group", { name: en.models.graph.title });
    expect(screen.queryByRole("img")).toBeNull();
    const boxes = within(canvas).getAllByRole("button");
    expect(boxes.map((box) => box.getAttribute("aria-label"))).toEqual(
      ["Thing", "Traceable", "Device", "Vehicle"].map((name) =>
        en.models.graph.openClass.replace("{name}", name),
      ),
    );
  });

  it("keeps every class box in the tab order, with a focus ring to follow", async () => {
    const user = userEvent.setup();
    const { container } = renderPart(<LinkmlGraphView source={MODEL} />);

    const boxes = screen.getAllByRole("button");
    expect(focusables(container)).toEqual(boxes);
    for (const box of boxes) {
      // `className` on an SVG element is an `SVGAnimatedString`, so the attribute is what reads.
      expect(box.getAttribute("class")).toContain("focus-ring");
      expect(box.getAttribute("class")).not.toContain("outline-none");
    }

    boxes[0].focus();
    expect(boxes[0]).toHaveFocus();
    await user.tab();
    expect(boxes[1]).toHaveFocus();
  });

  it("opens a class by click, by Enter and by Space, and never twice for one press", async () => {
    const user = userEvent.setup();
    const onOpenClass = vi.fn();
    renderPart(<LinkmlGraphView source={MODEL} onOpenClass={onOpenClass} />);

    const vehicle = screen.getByRole("button", {
      name: en.models.graph.openClass.replace("{name}", "Vehicle"),
    });
    await user.click(vehicle);
    expect(onOpenClass).toHaveBeenCalledExactlyOnceWith("Vehicle");

    onOpenClass.mockClear();
    vehicle.focus();
    await user.keyboard("{Enter}");
    expect(onOpenClass).toHaveBeenCalledExactlyOnceWith("Vehicle");

    onOpenClass.mockClear();
    await user.keyboard(" ");
    expect(onOpenClass).toHaveBeenCalledExactlyOnceWith("Vehicle");
  });

  it("draws nothing to click when the drawing is only being read", async () => {
    const user = userEvent.setup();
    renderPart(<LinkmlGraphView source={MODEL} />);

    // Without a handler the boxes still carry their names; pressing one simply does nothing.
    await user.click(screen.getAllByRole("button")[0]);
    expect(screen.getAllByRole("button").length).toBe(4);
  });

  it("has no axe violations", async () => {
    const { container } = renderPart(<LinkmlGraphView source={MODEL} />);
    await expectNoAxeViolations(container);
  });
});

describe("what a box shows", () => {
  it("says a model with no class has nothing to draw, and draws no frame", () => {
    renderPart(<LinkmlGraphView source={"name: empty\n"} />);

    const said = screen.getByRole("status");
    expect(said).toHaveTextContent(en.models.graph.empty);
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("lists a class's own slots inside its box", () => {
    renderPart(<LinkmlGraphView source={MODEL} />);

    const vehicle = screen.getByRole("button", {
      name: en.models.graph.openClass.replace("{name}", "Vehicle"),
    });
    expect(vehicle.textContent).toContain("refDevice");
    expect(vehicle.textContent).toContain("speed");
  });

  // 0/1/many: a class with more slots than the box draws stops and counts the rest, so a wide
  // model stays a drawing instead of a column of text.
  it("stops at six slots and counts the rest", () => {
    renderPart(<LinkmlGraphView source={LONG} />);

    const wide = screen.getByRole("button", {
      name: en.models.graph.openClass.replace("{name}", "Wide"),
    });
    expect(wide.textContent).toContain("f");
    expect(wide.textContent).not.toContain("gh");
    expect(wide.textContent).toContain(en.models.graph.more.replace("{count}", "3"));
  });

  // The three kinds of line are told apart by more than their dash pattern: the legend says
  // which is which, and a slot's line carries the slot's name.
  it("labels a line that is a slot's range with the slot's name", () => {
    const { container } = renderPart(<LinkmlGraphView source={MODEL} />);

    // Twice: once as Vehicle's own slot inside its box, once as the name of the line to Device.
    const labels = within(container).getAllByText("refDevice", { selector: "text" });
    expect(labels).toHaveLength(2);
    expect(labels.some((label) => label.getAttribute("text-anchor") === "middle")).toBe(true);
    expect(screen.getByText(en.models.graph.legend)).toBeInTheDocument();
    const dashes = [...container.querySelectorAll("line")].map((line) =>
      line.getAttribute("stroke-dasharray"),
    );
    // One solid (`is_a`), one long-dashed (mixin), one dotted (range).
    expect(new Set(dashes)).toEqual(new Set([null, "6 4", "2 3"]));
  });

  // The class and slot names come from a document somebody uploaded.
  it("draws a class name that arrives as markup as text", () => {
    const { container } = renderPart(
      <LinkmlGraphView source={'name: x\nclasses:\n  "<script>bad</script>":\n    slots: []\n'} />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: en.models.graph.openClass.replace("{name}", "<script>bad</script>"),
      }),
    ).toBeInTheDocument();
  });

  it("sizes its text in the drawing's own units, not in page pixels", () => {
    const { container } = renderPart(<LinkmlGraphView source={MODEL} />);

    // Every `<text>` carries a `font-size` attribute, which a `viewBox` scales with the picture;
    // a class of the page's type scale would not scale and would break the row height the
    // layout counts with.
    const texts = [...container.querySelectorAll("text")];
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text.getAttribute("font-size")).toMatch(/^\d+$/);
      expect(text.getAttribute("class") ?? "").not.toMatch(/text-\[/);
    }
    expect(container.querySelector("svg")?.getAttribute("style")).toBeNull();
  });
});

describe("the graph in every locale", () => {
  it("translates the legend, the names and the overflow count", async () => {
    await inEveryLocale(async () => {
      const { container, unmount } = renderPart(<LinkmlGraphView source={LONG} />);
      expectNoRawKeys(container);
      expect(screen.getByText(i18n.t("models.graph.legend"))).toBeInTheDocument();
      expect(
        screen.getByRole("group", { name: i18n.t("models.graph.title") }),
      ).toBeInTheDocument();
      unmount();
    });
  });
});
