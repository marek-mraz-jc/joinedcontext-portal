/**
 * The page behind an MCP call's question (AG-63, T-5699): the person whose AI client asked reads
 * what the call would do, opens what it would change, and accepts or declines it here with their
 * own session. The client's next call reads this decision; nothing the client says accepts.
 */
import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError, unwrap } from "../../api/client";
import { Alert, Button, EmptyState, PageHeader, PageLoading, safeHref } from "../../components/ui";
import { ResourcePageFailed } from "../../components/ui/PageState";

type Decision = "accept" | "decline";

export function McpElicitationPage({ project, id }: { project: string; id: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const key = ["mcp-elicitation", project, id];
  const question = useQuery({
    queryKey: key,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/mcp-elicitations/{id}", {
          params: { path: { project, id } },
        }),
      ),
    retry: false,
  });
  const decide = useMutation({
    mutationFn: async (decision: Decision) =>
      unwrap(
        await api.POST("/api/v1/projects/{project}/mcp-elicitations/{id}/decision", {
          params: { path: { project, id } },
          body: { decision },
        }),
      ),
    onSuccess: (answered) => queryClient.setQueryData(key, answered),
  });
  const title = t("mcpElicitation.title");
  const home = (
    <Link to="/projects/$project/home" params={{ project }} className="focus-ring text-body text-primary-soft-fg underline hover:no-underline">
      {t("mcpElicitation.home")}
    </Link>
  );
  const header = <PageHeader title={title} description={t("mcpElicitation.lead")} />;

  if (question.isPending) {
    return (
      <section aria-label={title} className="space-y-6">
        {header}
        <PageLoading label={t("app.loading")} />
      </section>
    );
  }
  if (question.isError) {
    if (question.error instanceof ApiError && question.error.status === 404) {
      return (
        <section aria-label={title} className="space-y-6">
          {header}
          <EmptyState
            heading={2}
            icon="inbox"
            title={t("mcpElicitation.gone")}
            description={t("mcpElicitation.goneHint")}
          />
        </section>
      );
    }
    return (
      <section aria-label={title}>
        <ResourcePageFailed
          title={title}
          description={t("mcpElicitation.lead")}
          error={question.error}
          onRetry={() => {
            void question.refetch();
          }}
          back={home}
        />
      </section>
    );
  }

  const asked = question.data;
  const expires = new Date(asked.expiresAt * 1000).toLocaleTimeString(i18n.resolvedLanguage ?? "sk", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <section aria-label={title} className="space-y-6">
      {header}
      <div className="space-y-4 rounded-lg border border-border p-4">
        <p className="text-body" data-testid="mcp-elicitation-message">
          {asked.message}
        </p>
        <dl className="grid gap-2 text-body sm:grid-cols-[auto_1fr]">
          <dt className="text-fg-muted">{t("mcpElicitation.operation")}</dt>
          <dd>
            <code>{asked.operation}</code>
          </dd>
          <dt className="text-fg-muted">{t("mcpElicitation.expires")}</dt>
          <dd>{expires}</dd>
        </dl>
        <a href={safeHref(asked.resource)} className="focus-ring text-body text-primary-soft-fg underline hover:no-underline">
          {t("mcpElicitation.look")}
        </a>
      </div>
      {asked.decision ? (
        <Alert
          tone={asked.decision === "accept" ? "success" : "info"}
          title={t(asked.decision === "accept" ? "mcpElicitation.accepted" : "mcpElicitation.declined")}
        >
          {t("mcpElicitation.backToClient")}
        </Alert>
      ) : null}
      {decide.isError ? (
        <Alert tone="danger" title={t("mcpElicitation.failed")}>
          {decide.error.message}
        </Alert>
      ) : null}
      <div className="space-y-2">
        <p className="text-body text-fg-muted">{t("mcpElicitation.hint")}</p>
        <div className="flex flex-wrap gap-3">
          <Button
            variant="primary"
            onClick={() => decide.mutate("accept")}
          >
            {t("mcpElicitation.accept")}
          </Button>
          <Button
            onClick={() => decide.mutate("decline")}
          >
            {t("mcpElicitation.decline")}
          </Button>
        </div>
      </div>
      {home}
    </section>
  );
}
