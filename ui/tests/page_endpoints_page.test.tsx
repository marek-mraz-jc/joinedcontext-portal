/**
 * T-1791: the endpoints page meets the UI contract (UI-01, UI-11, UI-15, UI-16, UI-44, PF-50).
 *
 * The survey measured five `href`s built from values. All five are `SourceLink` or the page's own
 * `EndpointLink`, and both go through `safeHref`; the cases below are what holds them there
 * rather than a change nobody needed. The one suppressed check that stays is `?edit=<name>`
 * opening the editor from an effect — deriving it during render would mint a fresh slug on every
 * render for an endpoint that has none, so the rule's remedy would be the defect.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
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
import { findFormPage, queryFormPage } from "./formPage";

const PATH = "/projects/helsinki/endpoints";

const endpoint = (name: string, over: Record<string, unknown> = {}) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Endpoint",
  metadata: { name, namespace: "helsinki" },
  spec: {
    contextSpaceRef: "air",
    slug: "k7m2qz4tv6xh3n5jb2ryd3wcfa",
    audience: "public",
    enabledRepresentations: ["ngsi-ld"],
  },
  status: { phase: "Live" },
  ...over,
});

const answering =
  (items: unknown[], extra?: (path: string) => Response | undefined) =>
  (path: string) => {
    if (path.endsWith("/endpoints")) return jsonResponse(list(items));
    if (path.endsWith("/spaces")) {
      return jsonResponse(
        list([
          {
            apiVersion: "joinedcontext.com/v1alpha1",
            kind: "ContextSpace",
            metadata: { name: "air", namespace: "helsinki" },
            spec: {},
            status: { phase: "Live" },
          },
        ]),
      );
    }
    return extra?.(path);
  };

describe("the endpoints page", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens_under_one_h1_with_its_lead_and_no_axe_violation", async () => {
    const { container } = await renderRoute({ path: PATH, answer: answering([endpoint("public-air")]) });
    await expectOneH1(en.endpoints.title);
    expect(screen.getByText(en.endpoints.lead)).toBeInTheDocument();
    await screen.findAllByRole("table");
    await expectAxeClean(container);
  });

  // T-2759: an App's endpoint showed `app-bikes` and nothing else.
  it("says_which_app_an_apps_endpoint_serves", async () => {
    await renderRoute({
      path: PATH,
      answer: answering([
        endpoint("app-bikes", {
          metadata: {
            name: "app-bikes",
            namespace: "helsinki",
            title: { en: "City bikes" },
            annotations: { "joinedcontext.com/generated-by": "portal/app-reconciler" },
          },
        }),
        endpoint("public-air"),
      ]),
    });
    expect(await screen.findByRole("link", { name: "City bikes" })).toBeInTheDocument();
    expect(screen.getByText("The endpoint of the app bikes")).toBeInTheDocument();
    expect(screen.getAllByText(/The endpoint of the app/)).toHaveLength(1);
  });

  it("holds_its_layout_while_the_endpoints_are_on_their_way", async () => {
    await renderRoute({ path: PATH, pending: true });
    const tables = await screen.findAllByRole("table");
    expect(tables[0]).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(en.endpoints.empty)).toBeNull();
  });

  it("says_why_the_endpoints_could_not_be_read_and_offers_one_more_try", async () => {
    const { calls } = await renderRoute({
      path: PATH,
      answer: (path) =>
        path.endsWith("/endpoints")
          ? problem(403, "You may not read this project's endpoints.")
          : undefined,
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You may not read this project's endpoints.");
    expect(screen.queryByText(en.endpoints.empty)).toBeNull();

    const before = calls().filter((call) => call.endsWith("/endpoints")).length;
    await userEvent.click(within(alert).getByRole("button", { name: en.app.error.retry }));
    await waitFor(() =>
      expect(calls().filter((call) => call.endsWith("/endpoints")).length).toBeGreaterThan(before),
    );
  });

  // T-2490, EP-87: one connector URL for all of them, beside the per-endpoint ones.
  it("offers_one_connector_url_for_every_endpoint_and_copies_it", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderRoute({ path: PATH, answer: answering([endpoint("public-air")]) });
    const section = (await screen.findByRole("heading", { name: en.endpoints.hub.title })).closest("section");
    expect(section).not.toBeNull();
    // On the platform host the gateway names as the hub's resource (the harness's branding domain),
    // not the Portal's own: an MCP client refuses metadata naming another URL (RFC 9728, T-3019).
    const hub = "https://portal.hel.fi/api/mcp";
    expect(within(section as HTMLElement).getByText(hub)).toBeInTheDocument();
    expect(within(section as HTMLElement).getByText(en.endpoints.hub.lead)).toBeInTheDocument();
    await userEvent.click(within(section as HTMLElement).getByRole("button", { name: en.endpoints.copyUrl }));
    expect(writeText).toHaveBeenCalledWith(hub);
    expect(await within(section as HTMLElement).findByRole("button", { name: en.endpoints.copied })).toBeInTheDocument();
  });

  it("offers_no_connector_url_while_nothing_is_published", async () => {
    await renderRoute({ path: PATH, answer: answering([]) });
    await screen.findByText(en.endpoints.empty);
    expect(screen.queryByRole("heading", { name: en.endpoints.hub.title })).not.toBeInTheDocument();
  });

  it("nothing_published_yet_offers_the_way_to_the_first_endpoint", async () => {
    await renderRoute({ path: PATH, answer: answering([]) });
    expect(await screen.findByText(en.endpoints.empty)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: en.endpoints.add }).length).toBeGreaterThan(0);
  });

  it("survives_0_1_and_500_rows", async () => {
    for (const count of [0, 1, 500]) {
      const items = Array.from({ length: count }, (_, index) => endpoint(`endpoint-${index}`));
      const { unmount } = await renderRoute({ path: PATH, answer: answering(items) });
      const table = (await screen.findAllByRole("table"))[0];
      await waitFor(() =>
        expect(within(table).getAllByRole("row").length).toBe(count === 0 ? 2 : count + 1),
      );
      unmount();
      vi.restoreAllMocks();
    }
  });

  it("a_source_address_out_of_a_manifest_is_a_link_only_when_it_could_navigate", async () => {
    const { container } = await renderRoute({
      path: PATH,
      answer: answering([
        endpoint("public-air", {
          status: { phase: "Live", sourceUrl: "https://git.example.sk/hel/e.yaml" },
        }),
        endpoint("nasty", { status: { phase: "Live", sourceUrl: "javascript:alert(1)" } }),
      ]),
    });
    await screen.findAllByRole("table");
    // Every href on the page at once: not one of them may carry a scheme that runs code (PF-50).
    const schemes = [...container.querySelectorAll("a[href]")]
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => /^[a-z][a-z0-9+.-]*:/i.test(href))
      .map((href) => href.slice(0, href.indexOf(":") + 1).toLowerCase());
    expect([...new Set(schemes)].filter((scheme) => !["http:", "https:", "mailto:"].includes(scheme))).toEqual([]);
  });

  it("opens_the_editor_on_the_endpoint_the_url_names_and_only_once_the_list_has_it", async () => {
    await renderRoute({
      path: `${PATH}?edit=public-air`,
      answer: answering([endpoint("public-air")]),
    });
    const dialog = await findFormPage();
    expect(dialog).toHaveTextContent("public-air");
  });

  it("a_name_the_url_asks_for_that_nobody_publishes_opens_nothing", async () => {
    // Not an empty form that would propose a new endpoint under a name off the address bar.
    await renderRoute({
      path: `${PATH}?edit=no-such-endpoint`,
      answer: answering([endpoint("public-air")]),
    });
    await screen.findAllByRole("table");
    expect(queryFormPage()).toBeNull();
  });

  it("says_everything_it_says_in_all_four_languages", async () => {
    for (const locale of LOCALES) {
      const { unmount } = await renderRoute({ path: PATH, locale, answer: answering([]) });
      await expectOneH1(i18n.t("endpoints.title"));
      expect(await screen.findByText(i18n.t("endpoints.empty"))).toBeInTheDocument();
      if (locale !== "en") {
        expect(screen.queryByText(en.endpoints.lead)).toBeNull();
      }
      unmount();
      vi.restoreAllMocks();
    }
  });

  it("paints_in_the_installations_own_colours_not_a_literal", async () => {
    const { container } = await renderRoute({
      path: PATH,
      brand: OTHER_BRAND,
      answer: answering([endpoint("public-air")]),
    });
    await screen.findAllByRole("table");
    const literal = [...container.querySelectorAll<HTMLElement>("[style]")].filter((element) =>
      /#[0-9a-f]{3,8}|\brgba?\(/i.test(element.getAttribute("style") ?? ""),
    );
    expect(
      literal.filter((element) => element.getAttribute("aria-hidden") !== "true").map((e) => e.outerHTML.slice(0, 120)),
    ).toEqual([]);
  });
});
