/**
 * T-5048: the pipelines page's Source health tab. A steward reads each source's state, its last
 * delivery, the change against its 7-day median and its last error, worst first, and opens the
 * runs of one; a reader is never offered the tab, and a refusal or an empty project says what next.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { byUrgency } from "../src/pages/pipelines/PipelineHealth";
import { expectAxeClean, jsonResponse, list, problem, renderRoute } from "./pageHarness";

const PATH = "/projects/helsinki/pipelines";

const pipeline = (name: string) => ({
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Pipeline",
  metadata: { name, namespace: "helsinki" },
  spec: { class: "scheduled" },
  status: { phase: "Live" },
});

const HEALTH = [
  {
    pipeline: "podujatia-detva",
    state: "ok",
    lastSuccessAt: "2026-10-21T06:00:00Z",
    lastRunAt: "2026-10-21T06:00:00Z",
    lastSent: 41,
    medianSent: 40,
    changePercent: 3,
    failedRuns: 0,
    alert: false,
  },
  {
    pipeline: "podujatia-zvolen",
    state: "failing",
    lastSuccessAt: "2026-10-18T06:00:00Z",
    lastRunAt: "2026-10-21T06:00:00Z",
    lastSent: 0,
    medianSent: 12,
    changePercent: -100,
    failedRuns: 3,
    lastError: "GET https://zvolen.example/rss answered 404",
    lastErrorAt: "2026-10-21T06:00:01Z",
    alert: true,
  },
  { pipeline: "podujatia-revuca", state: "empty", lastRunAt: "2026-10-21T06:00:00Z", lastSent: 0, failedRuns: 0, alert: false },
  { pipeline: "podujatia-new", state: "never", failedRuns: 0, alert: false },
];

const answering =
  (health: () => Response) =>
  (path: string): Response | undefined => {
    if (path.endsWith("/pipeline-health")) return health();
    if (path.endsWith("/pipelines")) return jsonResponse(list(HEALTH.map((h) => pipeline(h.pipeline))));
    if (path.endsWith("/runs")) return jsonResponse({ items: [] });
    return undefined;
  };

async function openHealthTab(): Promise<void> {
  await userEvent.click(await screen.findByRole("tab", { name: en.pipelines.map.view.health }));
}

describe("the source health tab", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists_every_source_worst_first_with_its_error_and_opens_its_runs", async () => {
    const { container, calls } = await renderRoute({
      path: PATH,
      answer: answering(() => jsonResponse({ items: HEALTH })),
    });
    await openHealthTab();
    const table = await screen.findByRole("table", { name: en.pipelines.health.caption });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual([
      "podujatia-zvolen",
      "podujatia-revuca",
      "podujatia-new",
      "podujatia-detva",
    ]);
    expect(within(rows[0]).getByText(en.pipelines.health.states.failing)).toBeInTheDocument();
    expect(within(rows[0]).getByText("3 failed runs in a row")).toBeInTheDocument();
    expect(within(rows[0]).getByText(en.pipelines.health.alerted)).toBeInTheDocument();
    expect(within(rows[0]).getByText(/zvolen\.example\/rss answered 404/)).toBeInTheDocument();
    expect(within(rows[0]).getByText(/100 %/)).toBeInTheDocument();
    expect(within(rows[2]).getByText(en.pipelines.health.states.never)).toBeInTheDocument();
    expect(screen.getByText("1 of 4 sources needs a look; 1 is alerted.")).toBeInTheDocument();
    expect(window.location.search).toBe("?view=health");
    await expectAxeClean(container);

    await userEvent.click(within(rows[0]).getByRole("button", { name: "Runs and log of podujatia-zvolen" }));
    expect(await screen.findByRole("dialog", { name: "Runs of podujatia-zvolen" })).toBeInTheDocument();
    await waitFor(() =>
      expect(calls()).toContain("GET /api/v1/projects/helsinki/pipelines/podujatia-zvolen/runs"),
    );
  });

  it("is_not_offered_to_a_person_who_approves_no_pipeline", async () => {
    await renderRoute({
      path: PATH,
      permissions: { project: "helsinki", bootstrap: false, grants: [{ rule: { kinds: ["Pipeline"], verbs: ["read"] } }] },
      answer: answering(() => jsonResponse({ items: HEALTH })),
    });
    await screen.findByRole("tab", { name: en.pipelines.map.view.list });
    await screen.findByText("podujatia-zvolen");
    expect(screen.queryByRole("tab", { name: en.pipelines.map.view.health })).toBeNull();
  });

  it("says_what_to_do_in_a_project_without_pipelines", async () => {
    await renderRoute({ path: PATH, answer: answering(() => jsonResponse({ items: [] })) });
    await openHealthTab();
    expect(await screen.findByText(en.pipelines.health.empty)).toBeInTheDocument();
    expect(screen.getByText(en.pipelines.health.emptyHint)).toBeInTheDocument();
  });

  it("shows_the_server_s_refusal_in_words", async () => {
    const said = "the pipelines' health is for stewards: it needs approve on Pipeline in project helsinki";
    await renderRoute({ path: PATH, answer: answering(() => problem(403, said)) });
    await openHealthTab();
    expect(await screen.findByRole("alert")).toHaveTextContent(said);
  });

  it("orders_alerted_sources_before_the_rest", () => {
    const sorted = byUrgency([
      { pipeline: "b", state: "drift", failedRuns: 0, alert: false },
      { pipeline: "a", state: "ok", failedRuns: 0, alert: false },
      { pipeline: "c", state: "failing", failedRuns: 1, alert: false },
      { pipeline: "d", state: "drift", failedRuns: 0, alert: true },
    ]);
    expect(sorted.map((h) => h.pipeline)).toEqual(["d", "c", "b", "a"]);
  });
});
