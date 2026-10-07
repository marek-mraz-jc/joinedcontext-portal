/**
 * T-3292: a person reads the change history from the Approvals page: what was merged or rejected,
 * who proposed and who decided it, and older pages on request; the filters ask the API once per
 * submit and never per keystroke.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { ApprovalsHistory } from "../src/routes/ApprovalsHistory";
import { json, renderPage } from "./page_contract";
import {
  expectAxeClean,
  jsonResponse,
  LOCALES,
  problem,
  renderRoute,
} from "./pageHarness";

const PATH = "/projects/helsinki/approvals";

const closed = (name: string, over: Record<string, unknown> = {}) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Change",
  metadata: { name, namespace: "helsinki" },
  summary: {
    key: "change.summary.create",
    params: { kind: "ContextSpace", name: "mobility", fields: 0 },
  },
  author: { name: "Jana Kováčová", email: "jana@hel.fi" },
  createdAt: "2026-10-01T09:00:00Z",
  status: {
    lane: "green",
    phase: "Merged",
    plan: { create: 0, update: 0, delete: 0 },
  },
  decision: { by: "eva.approver@hel.fi", at: "2026-10-01T10:00:00Z" },
  ...over,
});

const REJECTED = closed("chg-00000002", {
  summary: {
    key: "change.summary.update",
    params: { kind: "Endpoint", name: "public-air", fields: 0 },
  },
  status: {
    lane: "yellow",
    phase: "Rejected",
    plan: { create: 0, update: 0, delete: 0 },
  },
  decision: {
    by: "eva.approver@hel.fi",
    at: "2026-10-02T10:00:00Z",
    reason: "the URL is the old one",
  },
});

/** The history pages by `page`, recording each query the API was asked. */
function historyOf(pages: Record<string, { items: unknown[]; next?: number }>) {
  const asked: string[] = [];
  const answer = (path: string, request: Request) => {
    if (!path.endsWith("/changes/history")) return undefined;
    const url = new URL(request.url);
    asked.push(url.search);
    const page = pages[url.searchParams.get("page") ?? "1"] ?? { items: [] };
    return jsonResponse({
      apiVersion: "joinedcontext.com/v1alpha1",
      kind: "ChangeList",
      ...page,
    });
  };
  return { answer, asked };
}

async function openHistory() {
  await userEvent.click(
    await screen.findByRole("tab", { name: en.approvals.tabs.history }),
  );
  return screen.findByRole("table", { name: en.approvals.history.caption });
}

describe("the change history", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists_what_was_decided_by_whom_and_why_and_links_each_change", async () => {
    const { answer } = historyOf({
      "1": { items: [REJECTED, closed("chg-00000001")] },
    });
    const { container } = await renderRoute({ path: PATH, answer });
    const table = await openHistory();

    const rows = await within(table).findAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(
      within(rows[1]).getByRole("link", {
        name: 'Update Endpoint "public-air"',
      }),
    ).toHaveAttribute("href", "/projects/helsinki/approvals/chg-00000002");
    expect(within(rows[1]).getByText("Rejected")).toBeInTheDocument();
    expect(
      within(rows[1]).getByText("Reason: the URL is the old one"),
    ).toBeInTheDocument();
    expect(within(rows[2]).getByText("Merged")).toBeInTheDocument();
    expect(
      within(rows[2]).getByText("eva.approver@hel.fi"),
    ).toBeInTheDocument();
    expect(within(rows[2]).getByText("Jana Kováčová")).toBeInTheDocument();
    // The last page offers nothing older.
    expect(
      screen.queryByRole("button", { name: en.approvals.history.older }),
    ).toBeNull();
    await expectAxeClean(container);
  });

  it("a_change_closed_in_the_repository_says_so_instead_of_naming_nobody", async () => {
    const { answer } = historyOf({
      "1": { items: [closed("chg-00000003", { decision: undefined })] },
    });
    await renderRoute({ path: PATH, answer });
    const table = await openHistory();
    expect(
      await within(table).findByText(en.approvals.history.inForge),
    ).toBeInTheDocument();
  });

  it("asks_for_older_changes_only_when_the_person_does", async () => {
    const { answer, asked } = historyOf({
      "1": { items: [closed("chg-00000005")], next: 2 },
      "2": { items: [closed("chg-00000004")] },
    });
    await renderRoute({ path: PATH, answer });
    const table = await openHistory();
    await within(table).findByText("chg-00000005");
    expect(asked).toEqual(["?page=1"]);

    await userEvent.click(
      screen.getByRole("button", { name: en.approvals.history.older }),
    );
    expect(await within(table).findByText("chg-00000004")).toBeInTheDocument();
    expect(asked).toEqual(["?page=1", "?page=2"]);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: en.approvals.history.older }),
      ).toBeNull(),
    );
  });

  it("a_page_with_nothing_readable_still_offers_the_older_ones", async () => {
    const { answer } = historyOf({ "1": { items: [], next: 2 } });
    await renderRoute({ path: PATH, answer });
    await openHistory();
    expect(
      await screen.findByText(en.approvals.history.noneOnPage),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: en.approvals.history.older }),
    ).toBeInTheDocument();
  });

  it("filters_on_submit_and_never_per_keystroke_and_clears_back", async () => {
    const { answer, asked } = historyOf({ "1": { items: [] } });
    await renderRoute({ path: PATH, answer });
    await openHistory();
    await screen.findByText(en.approvals.history.empty);

    await userEvent.type(
      screen.getByLabelText(en.approvals.history.kind),
      " Endpoint ",
    );
    await userEvent.type(
      screen.getByLabelText(en.approvals.history.name),
      "air{Enter}",
    );
    await screen.findByText(en.approvals.noneMatch);
    expect(asked).toEqual(["?page=1", "?page=1&kind=Endpoint&name=air"]);

    await userEvent.click(
      screen.getByRole("button", { name: en.approvals.history.clear }),
    );
    expect(
      await screen.findByText(en.approvals.history.empty),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(en.approvals.history.kind)).toHaveValue("");
  });

  it("says_why_the_history_could_not_be_read", async () => {
    await renderRoute({
      path: PATH,
      answer: (path) =>
        path.endsWith("/changes/history")
          ? problem(503, "The forge does not answer.")
          : undefined,
    });
    await userEvent.click(
      await screen.findByRole("tab", { name: en.approvals.tabs.history }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The forge does not answer.",
    );
  });

  it("renders_a_reason_out_of_the_api_as_text_and_never_as_markup", async () => {
    const { answer } = historyOf({
      "1": {
        items: [
          closed("chg-00000006", {
            decision: { by: "x", reason: "<img src=x onerror=alert(1)>" },
          }),
        ],
      },
    });
    await renderRoute({ path: PATH, answer });
    const table = await openHistory();
    expect(
      await within(table).findByText("Reason: <img src=x onerror=alert(1)>"),
    ).toBeInTheDocument();
    expect(table.querySelector("img")).toBeNull();
  });

  it("the_tabs_are_walked_by_arrow_keys", async () => {
    const { answer } = historyOf({ "1": { items: [] } });
    await renderRoute({ path: PATH, answer });
    const open = await screen.findByRole("tab", {
      name: en.approvals.tabs.open,
    });
    open.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("tab", { name: en.approvals.tabs.history }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      await screen.findByRole("table", { name: en.approvals.history.caption }),
    ).toBeInTheDocument();
  });

  it("says_it_in_all_four_languages", async () => {
    for (const locale of LOCALES) {
      const { answer } = historyOf({ "1": { items: [] } });
      const { unmount } = await renderRoute({ path: PATH, locale, answer });
      await userEvent.click(
        await screen.findByRole("tab", {
          name: i18n.t("approvals.tabs.history"),
        }),
      );
      expect(
        await screen.findByText(i18n.t("approvals.history.empty")),
      ).toBeInTheDocument();
      unmount();
      vi.restoreAllMocks();
    }
  });

  it("mounted_on_its_own_it_asks_for_the_first_page_and_shows_who_decided", async () => {
    renderPage(<ApprovalsHistory project="helsinki" />, {
      answer: (url) =>
        url.pathname.endsWith("/changes/history")
          ? json({
              apiVersion: "joinedcontext.com/v1alpha1",
              kind: "ChangeList",
              items: [REJECTED],
            })
          : undefined,
      path: "/projects/helsinki/approvals",
    });
    expect(
      await screen.findByText("Reason: the URL is the old one"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("search", { name: en.approvals.history.filter }),
    ).toBeInTheDocument();
  });
});
