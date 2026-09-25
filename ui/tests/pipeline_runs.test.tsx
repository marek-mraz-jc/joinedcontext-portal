/**
 * T-2710: a pipeline's runs and the log of each on the pipelines page (PL-62, ADR-N-034). The
 * row's menu opens them; each run says how many records it wrote, rejected and failed, the newest
 * run's log is open, another run opens by its button, and a log pages older and back. A run whose
 * lines aged out keeps its counts and says so; a list that could not be read says why.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { PipelineRunsDialog } from "../src/pages/pipelines/PipelineRuns";
import { expectAxeClean, jsonResponse, list, problem, renderRoute } from "./pageHarness";

const PATH = "/projects/helsinki/pipelines";
const RUNS = "/api/v1/projects/helsinki/pipelines/stations/runs";
const TICK = "2026-09-25T08:15:00Z";
const HOUR = "2026-09-25T07:00Z";

const pipeline = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Pipeline",
  metadata: { name: "stations", namespace: "helsinki" },
  spec: { class: "resident" },
  status: { phase: "Live" },
};

const run = (name: string, sent: number, rejected: number, failed: number) => ({
  run: name,
  firstAt: "2026-09-25T08:15:01Z",
  lastAt: "2026-09-25T08:15:02Z",
  sent,
  rejected,
  failed,
});

const line = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  at: "2026-09-25T08:15:02Z",
  run: TICK,
  recordId: `urn:ngsi-ld:BikeStation:hel.fi:helsinki:s-${id}`,
  outcome: "sent",
  message: "",
  ...over,
});

function answering(runs: unknown, logs: Record<string, Record<string, unknown>>) {
  return (path: string, request: Request): Response | undefined => {
    if (path.endsWith("/pipelines")) {
      return jsonResponse(list([pipeline]));
    }
    if (path === RUNS) {
      return jsonResponse(runs);
    }
    if (path.startsWith(`${RUNS}/`) && path.endsWith("/log")) {
      const name = decodeURIComponent(path.slice(RUNS.length + 1, -"/log".length));
      const before = new URL(request.url).searchParams.get("before") ?? "newest";
      return jsonResponse(logs[name]?.[before] ?? { items: [] });
    }
    return undefined;
  };
}

async function openRuns(): Promise<HTMLElement> {
  await userEvent.click(
    await screen.findByRole("button", { name: en.rowActions.more.replace("{name}", "stations") }),
  );
  await userEvent.click(await screen.findByRole("menuitem", { name: en.pipelines.runs.open }));
  return screen.findByRole("dialog");
}

describe("a pipeline's runs and log", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists_each_run_with_its_counts_and_opens_the_newest_runs_log", async () => {
    const { container } = await renderRoute({
      path: PATH,
      answer: answering(
        { items: [run(TICK, 12, 1, 1), run(HOUR, 40, 0, 0)] },
        {
          [TICK]: {
            newest: {
              items: [
                line(3, { outcome: "failed", step: 1, message: "step 2 threw: not a number" }),
                line(2, { outcome: "rejected", message: "capacity is not an integer" }),
                line(1),
              ],
            },
          },
        },
      ),
    });
    const dialog = await openRuns();
    expect(within(dialog).getByText(en.pipelines.runs.lead)).toBeInTheDocument();
    const runs = await within(dialog).findByRole("table", { name: en.pipelines.runs.caption });
    const rows = within(runs).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText("12")).toBeInTheDocument();
    expect(within(rows[2]).getByText(/^Hour from /)).toBeInTheDocument();

    const log = await within(dialog).findByRole("region", { name: /^Log of the run / });
    expect(await within(log).findByText("capacity is not an integer")).toBeInTheDocument();
    expect(within(log).getByText("In step 2")).toBeInTheDocument();
    expect(within(log).getByText("Failed")).toBeInTheDocument();
    expect(within(log).getByText("Rejected")).toBeInTheDocument();
    const [newest, older] = within(runs).getAllByRole("button");
    expect(newest).toHaveAttribute("aria-pressed", "true");
    expect(older).toHaveAttribute("aria-pressed", "false");
    await expectAxeClean(container);
  });

  it("opens_another_run_and_pages_its_log_older_and_back", async () => {
    await renderRoute({
      path: PATH,
      answer: answering(
        { items: [run(TICK, 1, 0, 0), run(HOUR, 3, 0, 0)] },
        {
          [TICK]: { newest: { items: [line(9)] } },
          [HOUR]: {
            newest: { items: [line(8, { recordId: "urn:hour-8" })], next: 8 },
            "8": { items: [line(4, { recordId: "urn:hour-4" })] },
          },
        },
      ),
    });
    const dialog = await openRuns();
    await within(dialog).findByText("urn:ngsi-ld:BikeStation:hel.fi:helsinki:s-9");
    const runs = within(dialog).getByRole("table", { name: en.pipelines.runs.caption });
    await userEvent.click(within(runs).getAllByRole("button")[1]);
    expect(await within(dialog).findByText("urn:hour-8")).toBeInTheDocument();
    expect(within(dialog).queryByText("urn:ngsi-ld:BikeStation:hel.fi:helsinki:s-9")).toBeNull();

    await userEvent.click(within(dialog).getByRole("button", { name: en.pipelines.runs.older }));
    expect(await within(dialog).findByText("urn:hour-4")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: en.pipelines.runs.older })).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: en.pipelines.runs.newest }));
    expect(await within(dialog).findByText("urn:hour-8")).toBeInTheDocument();
  });

  it("no_runs_says_when_the_first_comes_and_aged_out_lines_keep_the_counts", async () => {
    await renderRoute({ path: PATH, answer: answering({ items: [] }, {}) });
    const empty = await openRuns();
    expect(await within(empty).findByText(en.pipelines.runs.empty)).toBeInTheDocument();
    expect(within(empty).queryByRole("table")).toBeNull();
  });

  it("a_run_whose_lines_aged_out_keeps_its_counts_and_says_so", async () => {
    await renderRoute({
      path: PATH,
      answer: answering({ items: [run(TICK, 4000, 0, 0)] }, {}),
    });
    const dialog = await openRuns();
    expect(await within(dialog).findByText(en.pipelines.runs.noLines)).toBeInTheDocument();
    expect(within(dialog).getByText("4,000")).toBeInTheDocument();
  });

  it("runs_that_could_not_be_read_say_why_and_escape_closes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin)
          .pathname;
        return Promise.resolve(
          path.endsWith("/permissions/me")
            ? jsonResponse({ project: "helsinki", bootstrap: true, grants: [] })
            : problem(503, "The pipeline's runs could not be read; try again."),
        );
      }),
    );
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nextProvider i18n={i18n}>
          <PipelineRunsDialog project="helsinki" name="stations" onClose={onClose} />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The pipeline's runs could not be read; try again.",
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
