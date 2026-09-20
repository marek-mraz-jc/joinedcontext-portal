/**
 * T-1795: the Context Spaces page meets the UI contract (UI-01, UI-11, UI-15, UI-16, UI-44, PF-50).
 *
 * The survey measured one `href` out of a manifest; it already goes through `SourceLink`, which
 * is `safeHref`, so the case below holds that rather than changing it. What the checklist found
 * instead: the Add button went hard-disabled when the project's quota was full, with the reason
 * only in a banner above it — out of reach of anybody who cannot see the button go grey.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { expectDenied } from "./checks";
import {
  expectAxeClean,
  expectOneH1,
  jsonResponse,
  list,
  LOCALES,
  OTHER_BRAND,
  problem,
  renderRoute,
} from "./pageHarness";

const PATH = "/projects/helsinki/spaces";

const space = (name: string, over: Record<string, unknown> = {}) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "ContextSpace",
  metadata: { name, namespace: "helsinki" },
  spec: { dataModelRef: "AirQualityObserved" },
  status: { phase: "Live", ...(over.status as object) },
  ...over,
});

/** `GET /api/v1/projects/{project}` is where the counts come from (PF-75). */
const project = (used: number, limit?: number) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Project",
  metadata: { name: "helsinki" },
  status: {
    usage: {
      contextSpaces: { used, limit },
      residentPipelines: { used: 1, limit: 4 },
      publicEndpoints: { used: 1, limit: 3 },
    },
  },
});

const answering =
  (items: unknown[], detail = project(1)) =>
  (path: string) => {
    if (path.endsWith("/spaces")) return jsonResponse(list(items));
    if (path === "/api/v1/projects/helsinki") return jsonResponse(detail);
    return undefined;
  };

describe("the Context Spaces page", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens_under_one_h1_with_its_lead_and_no_axe_violation", async () => {
    const { container } = await renderRoute({ path: PATH, answer: answering([space("air")]) });
    await expectOneH1(en.spaces.title);
    expect(screen.getByText(en.spaces.lead)).toBeInTheDocument();
    await screen.findByRole("table");
    await expectAxeClean(container);
  });

  it("a_full_quota_refuses_the_add_button_on_the_button_and_keeps_it_reachable", async () => {
    await renderRoute({ path: PATH, answer: answering([space("air")], project(3, 3)) });
    const add = await screen.findByRole("button", { name: en.spaces.add });
    await waitFor(() => expectDenied(add, i18n.t("quota.exceeded", { limit: 3 })));
    // The banner stays too, for whoever reads the page rather than the control.
    expect(screen.getAllByRole("status").some((node) => node.textContent?.includes("3"))).toBe(true);
  });

  it("a_quota_with_room_leaves_the_add_button_alone", async () => {
    await renderRoute({ path: PATH, answer: answering([space("air")], project(1, 3)) });
    const add = await screen.findByRole("button", { name: en.spaces.add });
    await waitFor(() => expect(add).toBeEnabled());
    expect(add).not.toHaveAttribute("aria-disabled");
  });

  it("holds_its_layout_while_the_spaces_are_on_their_way", async () => {
    await renderRoute({ path: PATH, pending: true });
    const table = await screen.findByRole("table");
    expect(table).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(en.spaces.empty)).toBeNull();
  });

  it("says_why_the_spaces_could_not_be_read_and_offers_one_more_try", async () => {
    const { calls } = await renderRoute({
      path: PATH,
      answer: (path) =>
        path.endsWith("/spaces") ? problem(403, "You may not read this project's spaces.") : undefined,
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You may not read this project's spaces.");
    expect(screen.queryByText(en.spaces.empty)).toBeNull();

    const before = calls().filter((call) => call.endsWith("/spaces")).length;
    await userEvent.click(within(alert).getByRole("button", { name: en.app.error.retry }));
    await waitFor(() =>
      expect(calls().filter((call) => call.endsWith("/spaces")).length).toBeGreaterThan(before),
    );
  });

  it("no_space_yet_offers_the_same_add_action_as_the_header", async () => {
    await renderRoute({ path: PATH, answer: answering([]) });
    expect(await screen.findByText(en.spaces.empty)).toBeInTheDocument();
    // The same control twice, so the first one is where a person is looking (UI-01).
    expect(screen.getAllByRole("button", { name: en.spaces.add })).toHaveLength(2);
  });

  it("survives_0_1_and_500_rows", async () => {
    for (const count of [0, 1, 500]) {
      const items = Array.from({ length: count }, (_, index) => space(`space-${index}`));
      const { unmount } = await renderRoute({ path: PATH, answer: answering(items) });
      const table = await screen.findByRole("table");
      await waitFor(() =>
        expect(within(table).getAllByRole("row").length).toBe(count === 0 ? 2 : count + 1),
      );
      unmount();
      vi.restoreAllMocks();
    }
  });

  it("a_source_address_out_of_a_manifest_is_a_link_only_when_it_could_navigate", async () => {
    await renderRoute({
      path: PATH,
      answer: answering([
        space("air", { status: { phase: "Live", sourceUrl: "https://git.example.sk/hel/x.yaml" } }),
        space("traffic", { status: { phase: "Live", sourceUrl: "javascript:alert(1)" } }),
      ]),
    });
    const table = await screen.findByRole("table");
    await within(table).findByText("air");
    // http and https navigate; anything else is data a forge could have written (PF-50).
    expect(
      within(table)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"))
        .filter((href) => href?.startsWith("javascript:")),
    ).toEqual([]);
  });

  it("says_everything_it_says_in_all_four_languages", async () => {
    for (const locale of LOCALES) {
      const { unmount } = await renderRoute({ path: PATH, locale, answer: answering([]) });
      await expectOneH1(i18n.t("spaces.title"));
      expect(await screen.findByText(i18n.t("spaces.empty"))).toBeInTheDocument();
      if (locale !== "en") {
        expect(screen.queryByText(en.spaces.lead)).toBeNull();
      }
      unmount();
      vi.restoreAllMocks();
    }
  });

  it("paints_in_the_installations_own_colours_not_a_literal", async () => {
    const { container } = await renderRoute({
      path: PATH,
      brand: OTHER_BRAND,
      answer: answering([space("air")]),
    });
    await screen.findByRole("table");
    const literal = [...container.querySelectorAll<HTMLElement>("[style]")].filter((element) =>
      /#[0-9a-f]{3,8}|\brgba?\(/i.test(element.getAttribute("style") ?? ""),
    );
    expect(
      literal.filter((element) => element.getAttribute("aria-hidden") !== "true").map((e) => e.outerHTML.slice(0, 120)),
    ).toEqual([]);
  });
});
