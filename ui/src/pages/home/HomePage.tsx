/**
 * A project's home page (T-3233, T-3235): the first-run checklist while the person has not put it
 * away, and the cards of what their role can do next. Every step and every card reads the
 * project's own state under the person's session, and every card is one click to its place.
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap } from "../../api/client";
import { mayRead, usePermissions } from "../../api/permissions";
import { spaceUsageQuery } from "../../api/spaceUsage";
import { useSampleProjects } from "../../api/projects";
import { Alert, Badge, Button, PageHeader } from "../../components/ui";
import { cardsFor, draftPage, firstRunSteps, roleOf, sampleToTry, welcomeStep } from "./home";
import type { Facts } from "./home";
import { useFirstRun } from "./firstRun";

interface Listed {
  items?: { metadata?: { name?: string }; kind?: string; name?: string; status?: { phase?: string }; requiredActions?: unknown[] }[];
}

function useList(project: string, plural: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.list(project, plural),
    enabled,
    retry: false,
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/projects/{project}/{plural}", { params: { path: { project, plural } } })) as Listed,
  });
}

/** How many spaces are counted for entities, so a project of many spaces asks a few. */
const COUNTED_SPACES = 5;

export function HomePage({
  project,
  welcome = false,
  onWelcomeClosed,
}: {
  project: string;
  /** Greets a person an invitation brought here (PF-108). */
  welcome?: boolean;
  onWelcomeClosed?: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const permissions = usePermissions(project);
  const role = roleOf(permissions.data);
  // No grant here yet: the role an invitation proposed waits for its approval.
  const holdsNothing =
    permissions.data !== undefined && permissions.data.bootstrap !== true && (permissions.data.grants ?? []).length === 0;
  const reads = (kind: string) => mayRead(permissions.data, kind) === true;

  const spaces = useList(project, "spaces", reads("ContextSpace"));
  const datasources = useList(project, "datasources", reads("DataSource"));
  const pipelines = useList(project, "pipelines", reads("Pipeline"));
  const endpoints = useList(project, "endpoints", reads("Endpoint"));
  const dashboards = useList(project, "dashboards", role === "viewer" && reads("Dashboard"));
  const changes = useQuery({
    queryKey: queryKeys.changes(project),
    enabled: role === "steward",
    retry: false,
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/projects/{project}/changes", { params: { path: { project } } })) as unknown as Listed,
  });
  const drafts = useQuery({
    queryKey: ["projects", project, "drafts"],
    enabled: role === "editor",
    retry: false,
    queryFn: async () => unwrap(await api.GET("/api/v1/projects/{project}/drafts", { params: { path: { project } } })) as unknown as Listed,
  });
  // Only an organization administrator may list the people; anyone else's card is not shown.
  const people = useQuery({
    queryKey: ["organization", "people"],
    enabled: role === "steward",
    retry: false,
    queryFn: async () => unwrap(await api.GET("/api/v1/organization/people", {})) as unknown as Listed,
  });

  const spaceNames = (spaces.data?.items ?? []).map((item) => item.metadata?.name ?? "").filter(Boolean);
  const usage = useQueries({ queries: spaceNames.slice(0, COUNTED_SPACES).map((space) => spaceUsageQuery(project, space)) });
  const spaceWithData = spaceNames.slice(0, COUNTED_SPACES).find((_, at) => (usage[at]?.data?.entities ?? 0) > 0);
  const phases = (pipelines.data?.items ?? []).map((item) => (item.status?.phase ?? "").toLowerCase());

  const firstRun = useFirstRun();
  const steps = firstRunSteps(project, {
    spaces: spaceNames,
    datasources: datasources.data?.items?.length ?? 0,
    pipelinePhases: phases,
    endpoints: endpoints.data?.items?.length ?? 0,
    spaceWithData,
  });
  const doneCount = steps.filter((step) => step.done).length;

  const firstDraft = drafts.data?.items?.[0];
  const facts: Facts = {
    approvalsWaiting: changes.data?.items?.filter((change) => change.status?.phase === "PendingApproval").length,
    failingPipelines: phases.filter((phase) => phase === "error").length,
    invitesPending: people.error instanceof ApiError ? undefined : people.data?.items?.filter((person) => (person.requiredActions ?? []).length > 0).length,
    drafts:
      firstDraft && firstDraft.kind && firstDraft.name
        ? { count: drafts.data?.items?.length ?? 0, to: draftPage(project, firstDraft.kind, firstDraft.name) ?? `/projects/${project}` }
        : undefined,
    spaceWithData,
    dashboards: (dashboards.data?.items ?? []).map((item) => item.metadata?.name ?? "").filter(Boolean),
  };
  const cards = role ? cardsFor(project, role, facts) : [];
  const samples = useSampleProjects().data ?? [];
  const isSample = samples.includes(project);
  const trySample = sampleToTry(project, samples);
  // Offered while the person keeps the first-run guidance (PF-109): inside the checklist while it
  // is open, on its own once every step is done, and nowhere after it was put away.
  const checklistOpen = firstRun.shown && doneCount < steps.length;
  const sampleLine =
    firstRun.shown && trySample ? (
      <p className="text-body text-fg-muted">
        {t("home.sample.lead")}{" "}
        <Link to="/projects/$project/home" params={{ project: trySample }} className="font-medium text-primary-soft-fg underline">
          {t("home.sample.try")}
        </Link>
      </p>
    ) : null;

  return (
    <section className="space-y-8" aria-label={t("home.title")}>
      <PageHeader
        title={t("home.title")}
        description={role ? t(`home.lead.${role}`) : t("home.leadLoading")}
        aside={isSample ? <Badge tone="info">{t("home.sample.badge")}</Badge> : undefined}
      />

      {isSample ? <Alert title={t("home.sample.title")}>{t("home.sample.body")}</Alert> : null}

      {welcome && permissions.data !== undefined ? (
        <section aria-labelledby="welcome-heading" className="space-y-3 rounded-lg border border-primary bg-surface p-4">
          <h2 id="welcome-heading" className="text-title font-semibold text-fg">
            {t("home.welcome.title", { project })}
          </h2>
          <p className="text-body text-fg">{holdsNothing || !role ? t("home.welcome.unknown") : t(`home.welcome.role.${role}`)}</p>
          <div className="flex flex-wrap items-center gap-3">
            {holdsNothing || !role ? null : (
              <Link to={welcomeStep(project, role)} className="text-body font-medium text-primary-soft-fg underline">
                {t(`home.welcome.first.${role}`)}
              </Link>
            )}
            {onWelcomeClosed ? (
              <Button variant="secondary" size="sm" onClick={onWelcomeClosed}>
                {t("home.welcome.close")}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      {checklistOpen ? null : sampleLine}

      {checklistOpen ? (
        <section aria-labelledby="first-run-heading" className="space-y-3 rounded-lg border border-border bg-surface p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="first-run-heading" className="text-title font-semibold text-fg">
              {t("home.firstRun.title")}
            </h2>
            <p className="text-body text-fg-muted" role="status">
              {t("home.firstRun.progress", { done: doneCount, total: steps.length })}
            </p>
          </div>
          <ol className="space-y-2">
            {steps.map((step, at) => (
              <li key={step.key} className="flex flex-wrap items-center gap-3 text-body" data-done={step.done}>
                <span className={step.done ? "text-success" : "text-fg-muted"} aria-hidden="true">
                  {step.done ? "✓" : at + 1}
                </span>
                <span className={step.done ? "text-fg-muted line-through" : "text-fg"}>{t(`home.firstRun.step.${step.key}`)}</span>
                <span className="sr-only">{step.done ? t("home.firstRun.done") : t("home.firstRun.todo")}</span>
                {step.done ? null : (
                  <Link to={step.to} className="text-body font-medium text-primary-soft-fg underline">
                    {t(`home.firstRun.go.${step.key}`)}
                  </Link>
                )}
              </li>
            ))}
          </ol>
          {sampleLine}
          <Button variant="secondary" size="sm" onClick={() => firstRun.dismiss()}>
            {t("home.firstRun.dismiss")}
          </Button>
        </section>
      ) : null}

      {cards.length > 0 ? (
        <section aria-labelledby="home-next-heading" className="space-y-3">
          <h2 id="home-next-heading" className="text-title font-semibold text-fg">
            {t("home.next")}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {cards.map((card) => (
              <li key={card.key}>
                <Link
                  to={card.to}
                  className="focus-ring block rounded-lg border border-border bg-surface p-4 hover:bg-surface-subtle"
                >
                  <span className="block text-body font-semibold text-fg">{t(`home.card.${card.key}.title`, { count: card.count })}</span>
                  <span className="block text-caption text-fg-muted">{t(`home.card.${card.key}.action`)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
