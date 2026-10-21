/**
 * T-5067: the project's Health page and the administrator's view across projects. Errors come
 * first with what was found and how to fix it, the kind filter narrows the list, an empty log and
 * a refusal say what next.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import cs from "../src/locales/cs.json";
import de from "../src/locales/de.json";
import en from "../src/locales/en.json";
import sk from "../src/locales/sk.json";
import { CHECKS as CHECK_NAMES, KINDS, LABEL } from "../src/pages/health/HealthLog";
import { expectAxeClean, jsonResponse, problem, renderRoute } from "./pageHarness";

const check = (over: Record<string, unknown>) => ({
  project: "bbsk",
  kind: "pipeline",
  name: "podujatia-zvolen",
  check: "runs",
  status: "ok",
  since: "2026-10-21T06:00:00Z",
  lastOk: "2026-10-21T08:00:00Z",
  checkedAt: "2026-10-21T08:00:00Z",
  detail: "",
  fixHint: "",
  evidenceUrl: "/projects/bbsk/pipelines/podujatia-zvolen",
  history: [
    { at: "2026-10-20T06:00:00Z", status: "ok" },
    { at: "2026-10-21T06:00:00Z", status: "error" },
  ],
  ...over,
});

const CHECKS = [
  check({
    status: "error",
    lastOk: undefined,
    detail: "3 runs in a row sent nothing: 403 no policy grants this operation",
    fixHint: "The broker refused the write: the target Endpoint's Policy must grant pl-podujatia-zvolen create and update.",
  }),
  check({ kind: "endpoint", name: "air-api", check: "reconcile", status: "warn", detail: "waiting for approval", evidenceUrl: "/projects/bbsk/endpoints/air-api" }),
  check({ kind: "space", name: "air", check: "reconcile", evidenceUrl: "/projects/bbsk/spaces/air", history: [] }),
];

const answering = (health: () => Response) => (path: string): Response | undefined =>
  path.endsWith("/health-checks") ? health() : undefined;

describe("the health log", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists_errors_first_with_the_fix_and_filters_by_kind", async () => {
    const { container, calls } = await renderRoute({
      path: "/projects/bbsk/health",
      answer: answering(() => jsonResponse({ items: CHECKS })),
    });
    await screen.findByRole("columnheader", { name: en.health.found });
    const table = screen.getByRole("table", { name: en.health.caption });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText(en.health.broken)).toBeInTheDocument();
    expect(within(rows[0]).getByText(/403 no policy grants/)).toBeInTheDocument();
    expect(within(rows[0]).getByText(/pl-podujatia-zvolen create and update/)).toBeInTheDocument();
    expect(within(rows[0]).getByRole("link", { name: "podujatia-zvolen" })).toHaveAttribute(
      "href",
      "/projects/bbsk/pipelines/podujatia-zvolen",
    );
    expect(within(rows[0]).getByRole("img", { name: "2 readings in the last 7 days: 1 errors, 0 warnings." })).toBeInTheDocument();
    expect(within(rows[0]).getByText(en.health.never)).toBeInTheDocument();
    expect(screen.getByText("1 error and 1 warning among 3 checks: read the fix under each.")).toBeInTheDocument();
    expect(calls()).toContain("GET /api/v1/projects/bbsk/health-checks");
    await expectAxeClean(container);

    await userEvent.selectOptions(screen.getByLabelText(en.health.kind), "endpoint");
    const filtered = within(screen.getByRole("table", { name: en.health.caption })).getAllByRole("row").slice(1);
    expect(filtered).toHaveLength(1);
    expect(within(filtered[0]).getByText("air-api")).toBeInTheDocument();
    expect(screen.getByText(en.health.kindHint)).toBeInTheDocument();
  });

  it("says_what_to_do_when_nothing_was_checked", async () => {
    await renderRoute({ path: "/projects/bbsk/health", answer: answering(() => jsonResponse({ items: [] })) });
    expect(await screen.findByText(en.health.empty)).toBeInTheDocument();
    expect(screen.getByText(en.health.emptyHint)).toBeInTheDocument();
  });

  it("says_all_is_well_when_every_check_is_ok", async () => {
    await renderRoute({
      path: "/projects/bbsk/health",
      answer: answering(() => jsonResponse({ items: [CHECKS[2]] })),
    });
    expect(await screen.findByText("All 1 checks are ok.")).toBeInTheDocument();
  });

  it("shows_the_server_s_refusal_in_words", async () => {
    const said = "project 'bbsk' not found";
    await renderRoute({ path: "/projects/bbsk/health", answer: answering(() => problem(404, said)) });
    expect(await screen.findByRole("alert")).toHaveTextContent(said);
  });

  it("gives_the_administrator_every_project_with_a_project_column", async () => {
    const { calls } = await renderRoute({
      path: "/organization/health",
      answer: (path: string) =>
        path.endsWith("/organization/health-checks")
          ? jsonResponse({ items: [CHECKS[0], { ...CHECKS[2], project: "helsinki" }] })
          : path.endsWith("/organization/health")
            ? jsonResponse({ checks: [] })
            : undefined,
    });
    expect(await screen.findByRole("columnheader", { name: en.health.project })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: en.health.caption });
    expect(within(table).getByText("helsinki")).toBeInTheDocument();
    expect(calls()).toContain("GET /api/v1/organization/health-checks");
  });

  it("names_every_kind_check_and_status_in_every_locale", () => {
    for (const locale of [en, sk, cs, de]) {
      for (const kind of KINDS) expect(locale.health.kinds[kind]).toBeTruthy();
      for (const name of CHECK_NAMES) expect(locale.health.checks[name]).toBeTruthy();
      for (const key of Object.values(LABEL)) expect(locale.health[key.replace("health.", "") as "broken"]).toBeTruthy();
    }
  });
});
