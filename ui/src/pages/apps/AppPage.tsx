import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, unwrap } from "../../api/client";
import { Button, PageFailed, PageHeader, PageLoading } from "../../components/ui";
import { AgentRunPage } from "./AgentRunPage";
import { AppBuildPanel } from "./AppBuildPanel";
import { AppCheckChip, useAppChecks } from "./AppCheckChip";
import { AppGenerator } from "./AppGenerator";
import { OpenAppButton } from "./AppOpenPage";
import { appDisplayName } from "./appTitle";
import { RolesAndMembers } from "./RolesAndMembers";
import type { AgentRun } from "./useAgentRun";

/**
 * An application and its runs (AP-68, AP-69, T-0559).
 *
 * Loads the application's runs, showing the newest with `AgentRunPage` which replays the
 * conversation and attaches the live stream. If no run exists yet, shows `AppGenerator`
 * prefilled with the application name.
 *
 * Each of the four states is a whole page rather than one line of text: the application is named
 * in the heading and in the tab before its runs are known, waiting draws the shape of what is
 * coming, and a failure carries the API's own sentence, a retry and the way back — a person who
 * opened an application by its address used to get "Loading..." on blank white, then a red line
 * with no heading and nothing to press (UI-15, UI-16).
 */
export function AppPage({ project, name }: { project: string; name: string }): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["projects", project, "agent-runs", name],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/agent-runs", {
          params: { path: { project }, query: { app: name } },
        }),
      ),
  });

  const back = () => {
    void navigate({ to: "/projects/$project/$plural", params: { project, plural: "apps" } });
  };

  // The name read as words until a run or an endpoint says what the application is called: the
  // heading and the tab say which application this is from the first paint (AP-69).
  const title = appDisplayName({ appName: name });
  const check = useAppChecks(project).get(name);

  if (isPending) {
    return (
      <div className="space-y-4">
        <PageHeader title={title} actions={<Button onClick={back}>{t("apps.back")}</Button>} />
        <PageLoading label={t("app.loading")} />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-4">
        <PageHeader title={title} actions={<Button onClick={back}>{t("apps.back")}</Button>} />
        <PageFailed
          error={error}
          onRetry={() => {
            void refetch();
          }}
        />
      </div>
    );
  }

  const items = (data?.items ?? []) as unknown as AgentRun[];
  const newest = items[0];

  // Where the published application is built and who holds its roles, above its runs (AP-103,
  // AP-99).
  if (newest) {
    return (
      <div className="space-y-3">
        {/* `empty:` because the button is not there before the App is read or once it is retired,
            and an empty row would still push the page down by the column's gap (T-2850). */}
        <div className="flex items-center justify-end gap-3 empty:hidden">
          <AppCheckChip check={check} />
          <OpenAppButton project={project} name={name} />
        </div>
        <AppBuildPanel project={project} name={name} />
        <RolesAndMembers project={project} name={name} />
        <AgentRunPage project={project} runId={newest.id} onClose={back} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap justify-between gap-2">
        <Button onClick={back}>{t("apps.back")}</Button>
        <span className="flex items-center gap-3">
          <AppCheckChip check={check} />
          <OpenAppButton project={project} name={name} />
        </span>
      </div>
      <AppBuildPanel project={project} name={name} />
      <RolesAndMembers project={project} name={name} />
      <AppGenerator project={project} initialName={name} />
    </div>
  );
}
