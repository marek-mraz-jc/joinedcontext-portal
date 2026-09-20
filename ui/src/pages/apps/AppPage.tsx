import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError, unwrap } from "../../api/client";
import { Alert, Button, Icon, PageHeader, Skeleton } from "../../components/ui";
import { AgentRunPage } from "./AgentRunPage";
import { AppGenerator } from "./AppGenerator";
import { appDisplayName } from "./appTitle";
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
          params: { path: { project }, query: { app: name } as never },
        }),
      ),
  });

  const back = () => {
    void navigate({ to: "/projects/$project/$plural", params: { project, plural: "apps" } });
  };

  // The name read as words until a run or an endpoint says what the application is called: the
  // heading and the tab say which application this is from the first paint (AP-69).
  const title = appDisplayName({ appName: name });

  if (isPending) {
    return (
      <div className="space-y-4">
        <PageHeader title={title} actions={<Button onClick={back}>{t("apps.back")}</Button>} />
        <div role="status" aria-busy="true" className="space-y-3">
          <span className="sr-only">{t("app.loading")}</span>
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-4 w-96" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-4">
        <PageHeader title={title} actions={<Button onClick={back}>{t("apps.back")}</Button>} />
        <Alert
          tone="danger"
          actions={
            <Button
              size="sm"
              icon={<Icon name="refresh" className="size-4" />}
              onClick={() => {
                void refetch();
              }}
            >
              {t("app.error.retry")}
            </Button>
          }
        >
          {error instanceof ApiError
            ? (error.problem?.detail ?? error.message)
            : t("app.error.generic")}
        </Alert>
      </div>
    );
  }

  const items = (data?.items ?? []) as unknown as AgentRun[];
  const newest = items[0];

  if (newest) {
    return <AgentRunPage project={project} runId={newest.id} onClose={back} />;
  }

  return (
    <div className="space-y-3">
      <Button onClick={back}>{t("apps.back")}</Button>
      <AppGenerator project={project} initialName={name} />
    </div>
  );
}
