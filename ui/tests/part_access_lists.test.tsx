/**
 * T-1827, T-1829: the groups and the service accounts of the Access page (UI-01, UI-15, UI-16,
 * UI-44, PF-50).
 *
 * Neither file was named by a test. Both carried the same two defects the checklist looks for:
 * a refusal that could not be read — the Propose button was hard-disabled with its reason wired
 * by `aria-describedby`, which is out of the tab order, so nobody could reach it to be told why
 * — and, on the keys, a list that could not be read drawn in the same grey as a list that is
 * genuinely empty. One of those two means a credential has to be rotated and the other does not.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { expectDenied } from "./checks";
import {
  expectAxeClean,
  jsonResponse,
  list,
  LOCALES,
  problem,
  renderRoute,
  VIEWER,
} from "./pageHarness";

const PATH = "/projects/helsinki/access";

const serviceAccount = (name: string) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "ServiceAccount",
  metadata: { name, namespace: "helsinki" },
  spec: { credentials: [{ name: "default" }] },
  status: { phase: "Live" },
});

const group = (name: string) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Group",
  metadata: { name, namespace: "org" },
  spec: { members: ["jana.kovacova@banskabystrica.sk"] },
  status: { phase: "Live" },
});

const answering =
  (over: (path: string) => Response | undefined = () => undefined) =>
  (path: string) => {
    const own = over(path);
    if (own) return own;
    if (path.endsWith("/serviceaccounts")) return jsonResponse(list([serviceAccount("harvester")]));
    if (path.endsWith("/groups")) return jsonResponse(list([group("stewards")]));
    return undefined;
  };

describe("the access page", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens_with_its_lists_and_no_axe_violation", async () => {
    const { container } = await renderRoute({ path: PATH, answer: answering(), identity: VIEWER });
    await screen.findByText("harvester");
    await expectAxeClean(container);
  });

  it("a_key_list_that_failed_says_the_apis_own_sentence_and_offers_one_more_try", async () => {
    const { calls } = await renderRoute({
      path: PATH,
      answer: answering((path) =>
        path.includes("/keys") ? problem(500, "The key store lost its connection.") : undefined,
      ),
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The key store lost its connection.");
    // Not "this account has no keys", which is the other thing that grey paragraph used to say.
    expect(screen.queryByText(en.access.keys.empty)).toBeNull();

    const before = calls().filter((call) => call.includes("/keys")).length;
    await userEvent.click(within(alert).getByRole("button", { name: en.app.error.retry }));
    await waitFor(() =>
      expect(calls().filter((call) => call.includes("/keys")).length).toBeGreaterThan(before),
    );
  });

  it("an_account_with_no_key_still_says_it_has_none", async () => {
    await renderRoute({
      path: PATH,
      answer: answering((path) => (path.includes("/keys") ? jsonResponse(list([])) : undefined)),
    });
    expect(await screen.findByText(en.access.keys.empty)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the_new_group_form_refuses_an_unnamed_example_on_the_button_and_stays_reachable", async () => {
    await renderRoute({ path: PATH, answer: answering() });

    await userEvent.click(await screen.findByRole("button", { name: en.access.groups.new }));
    const dialog = await screen.findByRole("dialog");
    const propose = within(dialog).getByRole("button", { name: en.access.groups.propose });

    // The reason used to hang off `aria-describedby` on a hard-disabled button: out of the tab
    // order, so it could never be read by the person it was written for.
    expectDenied(propose, en.access.nameFirst);
    propose.focus();
    expect(propose).toHaveFocus();
  });

  it("says_everything_it_says_in_all_four_languages", async () => {
    for (const locale of LOCALES) {
      const { unmount } = await renderRoute({ path: PATH, locale, answer: answering() });
      expect(
        await screen.findByRole("button", { name: i18n.t("access.groups.new") }),
      ).toBeInTheDocument();
      if (locale !== "en") {
        expect(screen.queryByRole("button", { name: en.access.groups.new })).toBeNull();
      }
      unmount();
      vi.restoreAllMocks();
    }
  });

  it("a_service_account_name_out_of_the_api_is_rendered_as_text", async () => {
    const { container } = await renderRoute({
      path: PATH,
      answer: answering((path) =>
        path.endsWith("/serviceaccounts")
          ? jsonResponse(list([serviceAccount("<img src=x onerror=alert(1)>")]))
          : undefined,
      ),
    });
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });
});
