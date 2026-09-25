import { useMemo, useState } from "react";
import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, forPeople, unwrap } from "../../api/client";
import { rememberRun, requestOpen } from "../../assistant/state";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  PageHeader,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../components/ui";
import { ListFailed, reasonOf } from "../../components/forms/widgets/ListFailed";
import { PermissionGuard } from "../../components/ui/PermissionGuard";
import { appDisplayName, useEndpointTitles } from "../apps/appTitle";
import { TERMINAL_STATES } from "../apps/useAgentRun";
import { AgentAccess } from "./AgentAccess";

interface RunRecord {
  id: string;
  project: string;
  appName?: string;
  title?: string | null;
  endpointName?: string;
  kind?: string;
  unattended?: boolean;
  continues?: string | null;
  /** `journey` for a run of the Portal's own live journeys (AG-93). */
  origin?: string;
  status: string;
  prompt: string;
  createdAt: string;
  firstFrameMs?: number | null;
  firstVersionMs?: number | null;
  error?: string;
}

/** An application reads by its title, or its name as words; a conversation by its first message. */
function formatTitle(run: RunRecord, endpointTitles: Map<string, string>): string {
  if (run.kind && run.kind !== "conversation" && (run.title || run.appName)) {
    return appDisplayName({
      title: run.title,
      appName: run.appName,
      endpointTitle: run.endpointName ? endpointTitles.get(run.endpointName) : undefined,
    });
  }
  return run.prompt.length > 80 ? `${run.prompt.slice(0, 80)}…` : run.prompt;
}

const RUNS_PER_PAGE = 20;

/**
 * The central assistant page listing conversations and autonomous work runs (UI-54, AG-71).
 *
 * Displays all visible runs newest first with lifecycle state, performance timings, and continuation
 * links. Supports interactive filtering by kind, state, and ownership ("mine"), and opens active or
 * past runs into the assistant panel. Work starts from the assistant's paths, never from a form here
 * (UI-55, T-2745).
 */
export function AssistantPage({ project }: { project: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const endpointTitles = useEndpointTitles(project);
  const queryClient = useQueryClient();

  const [kindFilter, setKindFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  // One page of runs at a time (T-2760): every conversation ever held, listed at once, made the
  // page ten thousand pixels tall.
  const [shown, setShown] = useState(RUNS_PER_PAGE);
  const [mineFilter, setMineFilter] = useState<boolean>(false);
  // The live journeys' test runs are left out unless asked for (AG-93, T-2816): they crowded the
  // history people read. Nothing is deleted; this only asks the server for them too.
  const [testRuns, setTestRuns] = useState<boolean>(false);

  const runsKey = ["projects", project, "agent-runs", { kind: kindFilter, mine: mineFilter, testRuns }];

  const runsQuery = useQuery({
    queryKey: runsKey,
    queryFn: async () => {
      const result = await api.GET("/api/v1/projects/{project}/agent-runs", {
        params: {
          path: { project },
          query: {
            limit: 100,
            kind: kindFilter || undefined,
            mine: mineFilter || undefined,
            origin: testRuns ? "all" : undefined,
          },
        },
      });
      return unwrap(result);
    },
    refetchInterval: (query) => {
      const items = (query.state.data?.items ?? []) as RunRecord[];
      const anyLive = items.some((item) => !TERMINAL_STATES.includes(item.status));
      return anyLive ? 5000 : false;
    },
  });

  const filteredRuns = useMemo(() => {
    const runs = (runsQuery.data?.items ?? []) as RunRecord[];
    return runs.filter((run) => {
      if (statusFilter === "live") {
        return !TERMINAL_STATES.includes(run.status);
      }
      if (statusFilter === "ended") {
        return TERMINAL_STATES.includes(run.status);
      }
      return true;
    });
  }, [runsQuery.data, statusFilter]);

  const continueMutation = useMutation({
    mutationFn: async (priorRunId: string) => {
      const result = await api.POST("/api/v1/projects/{project}/assistant/conversations", {
        params: { path: { project } },
        body: { message: t("assistantPage.continueMessage"), continues: priorRunId },
      });
      return unwrap(result);
    },
    onSuccess: (created) => {
      rememberRun({ project, runId: created.id });
      requestOpen();
      void queryClient.invalidateQueries({ queryKey: ["projects", project, "agent-runs"] });
    },
  });

  const handleOpen = (run: RunRecord) => {
    rememberRun({ project, runId: run.id });
    requestOpen();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("assistantPage.title")}
        description={t("assistantPage.lead")}
      />

      <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <label htmlFor="filter-kind" className="text-caption font-medium text-fg-muted">
              {t("assistantPage.filters.kind")}
            </label>
            <Select
              id="filter-kind"
              aria-label={t("assistantPage.filters.kind")}
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
              className="w-40"
            >
              <option value="">{t("assistantPage.filters.all")}</option>
              <option value="conversation">{t("assistantPage.kinds.conversation")}</option>
              <option value="application">{t("assistantPage.kinds.application")}</option>
              <option value="dashboard">{t("assistantPage.kinds.dashboard")}</option>
              <option value="analysis">{t("assistantPage.kinds.analysis")}</option>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="filter-status" className="text-caption font-medium text-fg-muted">
              {t("assistantPage.filters.status")}
            </label>
            <Select
              id="filter-status"
              aria-label={t("assistantPage.filters.status")}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-32"
            >
              <option value="all">{t("assistantPage.filters.all")}</option>
              <option value="live">{t("assistantPage.filters.live")}</option>
              <option value="ended">{t("assistantPage.filters.ended")}</option>
            </Select>
          </div>

          {/* Was a bare input reimplementing the size, the tick colour and the focus treatment
              by hand, with `focus:ring-*` rather than the shared `focus-ring` utility — so this
              one filter had a different keyboard focus from every control beside it. */}
          <Checkbox
            checked={mineFilter}
            onChange={(e) => setMineFilter(e.target.checked)}
            label={t("assistantPage.filters.mine")}
          />
          <Checkbox
            checked={testRuns}
            onChange={(e) => setTestRuns(e.target.checked)}
            label={t("assistantPage.filters.testRuns")}
          />
        </div>
      </Card>

      {runsQuery.isPending ? (
        <p role="status" className="text-body text-fg-muted">
          {t("app.loading")}
        </p>
      ) : runsQuery.isError ? (
        // `isError` was never checked, so a failed request fell through to the empty state and
        // told the person, confidently and wrongly, that their conversations and unattended runs
        // were gone — with no reason and nothing to press.
        <ListFailed
          what={t("assistantPage.title")}
          reason={reasonOf(runsQuery.error, t("app.error.generic"))}
          onRetry={() => void runsQuery.refetch()}
        />
      ) : filteredRuns.length === 0 ? (
        // The way to the first run is the assistant itself (T-2745 took the New work form away).
        <EmptyState
          icon="chat"
          title={t("assistantPage.empty")}
          action={<Button onClick={() => requestOpen()}>{t("assistant.open")}</Button>}
        />
      ) : (
        <>
        <Table caption={t("assistantPage.title")}>
          <TableHead>
            <TableHeaderCell>{t("assistantPage.table.name")}</TableHeaderCell>
            <TableHeaderCell>{t("assistantPage.filters.status")}</TableHeaderCell>
            <TableHeaderCell className="hidden md:table-cell">
              {t("assistantPage.timings")}
            </TableHeaderCell>
            <TableHeaderCell className="hidden sm:table-cell">
              {t("assistantPage.started")}
            </TableHeaderCell>
            <TableHeaderCell align="right">{t("assistantPage.actions")}</TableHeaderCell>
          </TableHead>
          <TableBody>
            {filteredRuns.slice(0, shown).map((run) => {
              const ended = TERMINAL_STATES.includes(run.status);
              const isEndedConversation = run.kind === "conversation" && ended;
              const title = formatTitle(run, endpointTitles);
              return (
                <TableRow key={run.id}>
                  <TableCell className="max-w-[28rem]">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-semibold text-fg" title={title}>
                        {title}
                      </span>
                      <span className="text-caption text-fg-muted">
                        <span>
                          {t(`assistantPage.kinds.${run.kind ?? "conversation"}`, {
                            defaultValue: run.kind,
                          })}
                        </span>
                        {run.continues ? (
                          <> · <span className="italic">{t("assistantPage.continues")}</span></>
                        ) : null}
                        {run.origin === "journey" ? (
                          <>
                            {" · "}
                            <Badge>{t("assistantPage.testRun")}</Badge>
                          </>
                        ) : null}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      tone={run.status === "failed" ? "danger" : ended ? "neutral" : "primary"}
                    >
                      {ended ? null : (
                        <span aria-hidden className="size-1.5 rounded-full bg-current" />
                      )}
                      {t(`assistantPage.states.${run.status}`, {
                        defaultValue: t(`agentRun.states.${run.status}`, {
                          defaultValue: run.status,
                        }),
                      })}
                    </Badge>
                    {/* `error` is declared on every run record and was rendered nowhere: the
                        only signal of a failed run was the Badge's colour, so someone whose
                        unattended build failed could see THAT it failed and nothing about why,
                        on the page whose job is to report it. */}
                    {run.status === "failed" && run.error ? (
                      <p className="mt-1 max-w-prose text-caption text-danger">{forPeople(run.error)}</p>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-caption text-fg-muted md:table-cell">
                    {run.firstFrameMs != null || run.firstVersionMs != null ? (
                      <dl className="grid grid-cols-[auto_auto] gap-x-2">
                        {run.firstFrameMs != null ? (
                          <>
                            <dt>{t("agentRun.timing.firstFrame")}</dt>
                            <dd className="text-right tabular-nums">
                              {t("agentRun.timing.seconds", {
                                seconds: (run.firstFrameMs / 1000).toFixed(1),
                              })}
                            </dd>
                          </>
                        ) : null}
                        {run.firstVersionMs != null ? (
                          <>
                            <dt>{t("agentRun.timing.firstVersion")}</dt>
                            <dd className="text-right tabular-nums">
                              {t("agentRun.timing.seconds", {
                                seconds: (run.firstVersionMs / 1000).toFixed(1),
                              })}
                            </dd>
                          </>
                        ) : null}
                      </dl>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-caption text-fg-muted sm:table-cell">
                    {new Date(run.createdAt).toLocaleString(i18n.language, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </TableCell>
                  <TableCell align="right">
                    <div className="flex items-center justify-end gap-2">
                      {isEndedConversation ? (
                        // Continuing a conversation starts another run, so the same verb (UI-44).
                        <PermissionGuard project={project} kind="App" verb="propose">
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={
                              continueMutation.isPending && continueMutation.variables === run.id
                            }
                            disabled={continueMutation.isPending}
                            onClick={() => continueMutation.mutate(run.id)}
                          >
                            {t("assistantPage.continue")}
                          </Button>
                        </PermissionGuard>
                      ) : null}
                      <Button size="sm" variant="secondary" onClick={() => handleOpen(run)}>
                        {t("assistantPage.open")}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {filteredRuns.length > shown ? (
          <div className="mt-3 flex justify-center">
            <Button onClick={() => setShown((count) => count + RUNS_PER_PAGE)}>
              {t("assistantPage.showMore", { count: Math.min(RUNS_PER_PAGE, filteredRuns.length - shown), left: filteredRuns.length - shown })}
            </Button>
          </div>
        ) : null}
        </>
      )}

      <AgentAccess project={project} />
    </div>
  );
}
