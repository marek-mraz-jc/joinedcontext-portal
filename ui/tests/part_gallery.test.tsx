/**
 * T-1844: the flow gallery, against the UI contract (UI-15, UI-16, UI-11).
 *
 * The survey of 2026-09-18 found no test in `ui/tests` or `ui/e2e` naming this file and no axe
 * run covering it: the first screen of the primary way a person configures anything (CC-30) was
 * unheld. It also found a hand-made filter chip, which is the shared `Button` now.
 *
 * What this owns: the three states of the list (waiting, refused, empty), the filter chips as a
 * screen reader hears them, a card's heading level under the page's own, and every string the
 * gallery draws from a blueprint being text.
 */
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { FlowGallery } from "../src/pages/flows/Gallery";
import { expectNoRawKeys } from "./checks";
import {
  expectHeadingOutline,
  expectNoAxeViolations,
  inEveryLocale,
  json,
  list,
  problem,
  renderPage,
} from "./page_contract";

const PROJECT = "helsinki";

function blueprint(
  name: string,
  spec: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
) {
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "Blueprint",
    metadata: { name, title: { en: name }, description: { en: `What ${name} sets up` }, ...metadata },
    spec: { version: "1.2.0", ...spec },
  };
}

const AIR = blueprint("air-quality", { category: "Environment", riskClass: "green" });
const TRAFFIC = blueprint("traffic", { category: "Mobility", riskClass: "red" });
const LOOSE = blueprint("odds-and-ends", {});

function gallery(blueprints: unknown[] | { fails: { status: number; detail: string } }) {
  return renderPage(<FlowGallery project={PROJECT} />, {
    answer: (url) => {
      if (!url.pathname.endsWith("/blueprints")) return undefined;
      return Array.isArray(blueprints)
        ? json(list(blueprints))
        : problem(blueprints.fails.status, blueprints.fails.detail);
    },
  });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the gallery while it has nothing to show yet", () => {
  // The heading used to arrive with the blueprints, so the page a screen reader was reading
  // changed its first line under it once the answer came.
  it("keeps its heading while the blueprints are being read, and says it is waiting", async () => {
    // The answer is held until the wait has been read, so the waiting state is asserted rather
    // than raced: without the hold the query settles inside the first `find`.
    let answer!: () => void;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    renderPage(<FlowGallery project={PROJECT} />, {
      answer: async (url) => {
        if (!url.pathname.endsWith("/blueprints")) return undefined;
        await held;
        return json(list([AIR]));
      },
    });

    expect(await screen.findByRole("heading", { level: 1, name: en.flows.title })).toBeInTheDocument();
    const waiting = await screen.findByRole("status");
    expect(waiting).toHaveAttribute("aria-busy", "true");
    expect(within(waiting).getByText(en.app.loading)).toBeInTheDocument();

    answer();
    expect(await screen.findByRole("button", { name: en.flows.run })).toBeInTheDocument();
    // And the heading is the same one, not a second h1 written by the loaded page.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("gives the server's own reason when the blueprints are refused, and a way to ask again", async () => {
    gallery({ fails: { status: 403, detail: "Your role may not list blueprints." } });

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Your role may not list blueprints.")).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: en.app.error.retry })).toBeInTheDocument();
    // The heading stays: the page is the gallery either way.
    expect(screen.getByRole("heading", { level: 1, name: en.flows.title })).toBeInTheDocument();
  });

  it("explains an empty gallery instead of drawing an empty grid", async () => {
    gallery([]);

    expect(await screen.findByText(en.flows.empty)).toBeInTheDocument();
    expect(screen.getByText(en.flows.emptyHint)).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).toBeNull();
  });
});

describe("the cards and the chips", () => {
  it("draws one card per blueprint, with its title, its lane and its version", async () => {
    const { container } = gallery([AIR, TRAFFIC]);

    const cards = await screen.findAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByRole("heading", { level: 2, name: "air-quality" })).toBeInTheDocument();
    expect(within(cards[0]).getByText(en.flows.risk.green)).toBeInTheDocument();
    expect(within(cards[1]).getByText(en.flows.risk.red)).toBeInTheDocument();
    expect(
      within(cards[0]).getByText(en.flows.version.replace("{version}", "1.2.0")),
    ).toBeInTheDocument();
    // One h1 for the page, an h2 per card: no level is skipped.
    expectHeadingOutline(container);
  });

  // UI-15/UI-16: a chip is a toggle, so what it says and whether it is on are both read.
  it("filters by category with pressed toggles, and says when a filter leaves nothing", async () => {
    const user = userEvent.setup();
    gallery([AIR, TRAFFIC, LOOSE]);

    const chips = await screen.findByRole("group", { name: en.flows.title });
    const all = within(chips).getByRole("button", { name: en.flows.category.all });
    expect(all).toHaveAttribute("aria-pressed", "true");

    await user.click(within(chips).getByRole("button", { name: "Mobility" }));
    expect(within(chips).getByRole("button", { name: "Mobility" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(all).toHaveAttribute("aria-pressed", "false");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);

    // A blueprint with no category of its own is the last chip, named rather than blank.
    await user.click(within(chips).getByRole("button", { name: en.flows.category.uncategorised }));
    expect(screen.getByRole("heading", { level: 2, name: "odds-and-ends" })).toBeInTheDocument();
  });

  it("offers no chips at all when every blueprint is in the same category", async () => {
    gallery([AIR, blueprint("air-rest", { category: "Environment" })]);

    await screen.findAllByRole("listitem");
    expect(screen.queryByRole("group", { name: en.flows.title })).toBeNull();
  });

  it("opens the blueprint's form on Set up, and comes back to the gallery", async () => {
    const user = userEvent.setup();
    gallery([AIR]);

    await user.click(await screen.findByRole("button", { name: en.flows.run }));
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: en.flows.instantiate.title.replace("{name}", "air-quality"),
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: en.flows.back }));
    expect(await screen.findByRole("heading", { level: 1, name: en.flows.title })).toBeInTheDocument();
  });
});

describe("what a blueprint says is data", () => {
  // CC-59: a blueprint is a manifest somebody else wrote. Its title and description are drawn.
  it("draws a title and a description that arrive as markup as text", async () => {
    const { container } = gallery([
      blueprint("evil", {}, {
        title: { en: "<img src=x onerror=alert(1)>" },
        description: { en: "<script>alert(2)</script>" },
      }),
    ]);

    await screen.findAllByRole("listitem");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "<img src=x onerror=alert(1)>" })).toBeInTheDocument();
  });

  it("draws no lane chip for a risk class it does not know", async () => {
    gallery([blueprint("odd", { riskClass: "chartreuse" })]);

    const card = (await screen.findAllByRole("listitem"))[0];
    expect(within(card).queryByTitle(en.flows.riskLabel)).toBeNull();
  });
});

describe("the gallery as a screen reader and a translator find it", () => {
  it("has no axe violations with cards and chips on the screen", async () => {
    const { container } = gallery([AIR, TRAFFIC]);

    await screen.findAllByRole("listitem");
    await expectNoAxeViolations(container);
  });

  it("draws every string of its own in all four locales", async () => {
    await inEveryLocale(async () => {
      const { container, unmount } = gallery([AIR, TRAFFIC]);
      await screen.findAllByRole("listitem");
      expectNoRawKeys(container);
      expect(
        screen.getByRole("heading", { level: 1, name: i18n.t("flows.title") }),
      ).toBeInTheDocument();
      unmount();
    });
  });
});
