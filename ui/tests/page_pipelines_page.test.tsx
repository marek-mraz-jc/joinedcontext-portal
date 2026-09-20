/**
 * T-1793: the pipelines page meets the UI contract (UI-01, UI-11, UI-15, UI-16, UI-44, PF-50).
 *
 * The survey measured one `href` built from a value; it already goes through `SourceLink`, which
 * is `safeHref`, and the case below is what holds it there. The rest is the checklist: the four
 * states, a list that survives 0, 1 and 500 rows, the keyboard, four locales, and a secret name
 * out of a manifest that must never be rendered as markup or shown as a value.
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

const PATH = "/projects/helsinki/pipelines";

const pipeline = (name: string, over: Record<string, unknown> = {}) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Pipeline",
  metadata: { name, namespace: "helsinki" },
  spec: {
    class: "resident",
    secretRefs: [{ name: "mqtt-credentials", key: "password", envVar: "MQTT_PASSWORD" }],
  },
  status: { phase: "Live" },
  ...over,
});

const answering = (items: unknown[]) => (path: string) =>
  path.endsWith("/pipelines") ? jsonResponse(list(items)) : undefined;

describe("the pipelines page", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens_under_one_h1_with_its_lead_and_no_axe_violation", async () => {
    const { container } = await renderRoute({ path: PATH, answer: answering([pipeline("ingest")]) });
    await expectOneH1(en.pipelines.title);
    expect(screen.getByText(en.pipelines.lead)).toBeInTheDocument();
    await screen.findByRole("table");
    await expectAxeClean(container);
  });

  it("holds_its_layout_while_the_pipelines_are_on_their_way", async () => {
    await renderRoute({ path: PATH, pending: true });
    const table = await screen.findByRole("table");
    expect(table).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(en.pipelines.empty)).toBeNull();
  });

  it("says_why_the_pipelines_could_not_be_read_and_offers_one_more_try", async () => {
    const { calls } = await renderRoute({
      path: PATH,
      answer: (path) =>
        path.endsWith("/pipelines")
          ? problem(503, "The control plane is not answering.")
          : undefined,
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The control plane is not answering.");
    expect(screen.queryByText(en.pipelines.empty)).toBeNull();

    const before = calls().filter((call) => call.endsWith("/pipelines")).length;
    await userEvent.click(within(alert).getByRole("button", { name: en.app.error.retry }));
    await waitFor(() =>
      expect(calls().filter((call) => call.endsWith("/pipelines")).length).toBeGreaterThan(before),
    );
  });

  it("no_pipeline_yet_says_what_the_ways_in_are", async () => {
    await renderRoute({ path: PATH, answer: answering([]) });
    expect(await screen.findByText(en.pipelines.empty)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: en.pipelines.add }).length).toBeGreaterThan(0);
  });

  it("survives_0_1_and_500_rows", async () => {
    for (const count of [0, 1, 500]) {
      const items = Array.from({ length: count }, (_, index) => pipeline(`pipe-${index}`));
      const { unmount } = await renderRoute({ path: PATH, answer: answering(items) });
      const table = await screen.findByRole("table");
      await waitFor(() =>
        expect(within(table).getAllByRole("row").length).toBe(count === 0 ? 2 : count + 1),
      );
      unmount();
      vi.restoreAllMocks();
    }
  });

  it("the_add_action_is_reached_and_opened_from_the_keyboard", async () => {
    await renderRoute({ path: PATH, answer: answering([pipeline("ingest")]) });
    const add = await screen.findByRole("button", { name: en.pipelines.add });
    add.focus();
    expect(add).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a_source_address_out_of_a_manifest_is_a_link_only_when_it_could_navigate", async () => {
    await renderRoute({
      path: PATH,
      answer: answering([
        pipeline("ingest", { status: { phase: "Live", sourceUrl: "https://git.example.sk/hel/p.yaml" } }),
        pipeline("nasty", { status: { phase: "Live", sourceUrl: "javascript:alert(1)" } }),
      ]),
    });
    const table = await screen.findByRole("table");
    await within(table).findByText("ingest");
    expect(
      within(table)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"))
        .filter((href) => href?.startsWith("javascript:")),
    ).toEqual([]);
  });

  it("names_a_secret_without_ever_showing_one", async () => {
    const { container } = await renderRoute({
      path: PATH,
      answer: answering([
        pipeline("ingest", {
          spec: {
            class: "resident",
            secretRefs: [{ name: "mqtt-credentials", key: "password", envVar: "MQTT_PASSWORD" }],
          },
        }),
      ]),
    });
    await screen.findByRole("table");
    // A `secretRef` is a name; the value lives in the cluster and the reconciler resolves it.
    expect(container.textContent).not.toContain("password=");
    expect(container.textContent).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(window.localStorage.getItem("mqtt-credentials")).toBeNull();
  });

  it("says_everything_it_says_in_all_four_languages", async () => {
    for (const locale of LOCALES) {
      const { unmount } = await renderRoute({ path: PATH, locale, answer: answering([]) });
      await expectOneH1(i18n.t("pipelines.title"));
      expect(await screen.findByText(i18n.t("pipelines.empty"))).toBeInTheDocument();
      if (locale !== "en") {
        expect(screen.queryByText(en.pipelines.lead)).toBeNull();
      }
      unmount();
      vi.restoreAllMocks();
    }
  });

  it("paints_in_the_installations_own_colours_not_a_literal", async () => {
    const { container } = await renderRoute({
      path: PATH,
      brand: OTHER_BRAND,
      answer: answering([pipeline("ingest")]),
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
