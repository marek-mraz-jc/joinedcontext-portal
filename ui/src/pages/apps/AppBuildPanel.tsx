import type { JSX } from "react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, unwrap } from "../../api/client";
import type { components } from "../../api/schema";
import { Alert, Button, ExternalLink } from "../../components/ui";

type AppBuild = components["schemas"]["AppBuild"];
type WorkflowRun = components["schemas"]["WorkflowRun"];

/** The forge's run state in the words the catalog uses (AP-86). */
function runState(run: WorkflowRun): "building" | "succeeded" | "failed" | "cancelled" {
  if (run.status !== "completed") return "building";
  if (run.conclusion === "success") return "succeeded";
  if (run.conclusion === "cancelled" || run.conclusion === "skipped") return "cancelled";
  return "failed";
}

/**
 * Where an application built on the forge is built (AP-103, ADR-N-028): its repository, the
 * newest workflow run and the package of its build, each opening in the forge behind the forge's
 * sign-in (PF-81), and Rebuild, which dispatches the reviewed `build.yml` again. Rebuild stays
 * focusable when it is not offered, and says why (UI-44).
 *
 * Nothing is drawn for an App this person may not read, or one that is not published yet.
 */
export function AppBuildPanel({ project, name }: { project: string; name: string }): JSX.Element | null {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [started, setStarted] = useState(false);
  const queryKey = ["projects", project, "apps", name, "build"];
  const build = useQuery({
    queryKey,
    queryFn: async (): Promise<AppBuild> =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/apps/{name}/build", {
          params: { path: { project, name } },
        }),
      ),
    retry: false,
  });
  const rebuild = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/v1/projects/{project}/apps/{name}/rebuild", {
          params: { path: { project, name } },
        }),
      ),
    onSuccess: () => {
      setStarted(true);
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  if (build.isPending) return null;
  if (build.isError) {
    if (build.error instanceof ApiError && build.error.status === 404) return null;
    return <Alert tone="warning">{t("apps.build.unreadable")}</Alert>;
  }
  const data = build.data;
  if (!data.repositoryUrl) {
    return <p className="text-sm text-fg-muted">{t("apps.build.notOnForge")}</p>;
  }
  const run = data.run ?? null;
  const rebuildError = rebuild.error
    ? rebuild.error instanceof ApiError
      ? (rebuild.error.problem?.detail ?? rebuild.error.message)
      : t("app.error.generic")
    : null;

  return (
    <section aria-labelledby="app-build-heading" className="space-y-2 rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="app-build-heading" className="text-sm font-semibold">
          {t("apps.build.title")}
        </h2>
        <Button
          size="sm"
          loading={rebuild.isPending}
          disabled={!data.rebuild.allowed}
          disabledReason={data.rebuild.reason ?? undefined}
          onClick={() => {
            setStarted(false);
            rebuild.mutate();
          }}
        >
          {t("apps.build.rebuild")}
        </Button>
      </div>
      <p className="text-sm">
        {run
          ? t(`apps.build.run.${runState(run)}`, { commit: run.commit.slice(0, 7) })
          : t("apps.build.run.none")}
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <li>
          <ExternalLink href={data.repositoryUrl}>{t("apps.build.repository")}</ExternalLink>
        </li>
        {run ? (
          <li>
            <ExternalLink href={run.url}>{t("apps.build.runLink")}</ExternalLink>
          </li>
        ) : null}
        {data.packageUrl ? (
          <li>
            <ExternalLink href={data.packageUrl}>{t("apps.build.package")}</ExternalLink>
          </li>
        ) : null}
      </ul>
      <div aria-live="polite">
        {started ? <p className="text-sm">{t("apps.build.started")}</p> : null}
      </div>
      {rebuildError ? <Alert tone="danger">{rebuildError}</Alert> : null}
    </section>
  );
}
