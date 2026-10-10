import { useState } from "react";
import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap } from "../../api/client";
import { startJob } from "../../jobs";
import { RecordLink } from "../../components/RecordLink";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  PageFailed,
  PageHeader,
  PermissionGuard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../components/ui";
import type { BadgeTone } from "../../components/ui";
import { knowledgeKeys, listSources, listUsage, recrawl, timeText } from "./knowledge";
import type { KnowledgeSourceRow } from "./knowledge";
import { AssistantChat, EmbedSnippet } from "./AssistantChat";

/** The sentence an `ApiError` carries, or the generic one. */
export function reasonOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.problem?.detail ?? error.message) : fallback;
}

/** How a source stands: never crawled, waiting, being read, read, or failed with its reason. */
function standing(row: KnowledgeSourceRow): { key: string; tone: BadgeTone } {
  if (row.state === "not-crawled" && !row.job) return { key: "knowledge.state.notCrawled", tone: "neutral" };
  switch (row.job?.state) {
    case "queued":
      return { key: "knowledge.state.queued", tone: "info" };
    case "running":
      return { key: "knowledge.state.running", tone: "info" };
    case "failed":
      return { key: "knowledge.state.failed", tone: "danger" };
    default:
      return { key: "knowledge.state.crawled", tone: "success" };
  }
}

/**
 * The knowledge assistant's sources of one project (T-3057, API/01 §34): every
 * `KnowledgeSource` the project declares and what the assistant holds of it, with the page that
 * shows its pages and documents, and a crawl started now rather than at its schedule.
 */
export function KnowledgePage({ project }: { project: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [queued, setQueued] = useState<string | null>(null);
  const sources = useQuery({
    queryKey: knowledgeKeys.sources(project),
    queryFn: () => listSources(project),
  });
  const crawl = useMutation({
    mutationFn: (source: string) => recrawl(project, source),
    onSuccess: (_, source) => {
      setQueued(source);
      // The person may leave: the Shell says when the crawl is done (T-3245).
      startJob({ kind: "knowledgeCrawl", project, name: source });
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.sources(project) });
    },
  });
  const rows = sources.data ?? [];
  const navigate = useNavigate();
  // The page's one action, in its header and in its empty state (T-3246).
  const addSource = (
    <PermissionGuard project={project} kind="KnowledgeSource" verb="propose">
      <Button
        variant="primary"
        size="sm"
        onClick={() =>
          void navigate({ to: "/projects/$project/$plural/new", params: { project, plural: "knowledgesources" } })
        }
      >
        {t("knowledge.addSource")}
      </Button>
    </PermissionGuard>
  );

  return (
    <section aria-label={t("knowledge.title")} className="space-y-6">
      <PageHeader
        title={t("knowledge.title")}
        description={t("knowledge.intro")}
        actions={addSource}
      />
      {sources.isError ? (
        <PageFailed
          error={sources.error}
          onRetry={() => {
            void sources.refetch();
          }}
        >
          {t("knowledge.failed", { reason: reasonOf(sources.error, t("app.error.generic")) })}
        </PageFailed>
      ) : null}
      {crawl.isError ? (
        <Alert role="alert" tone="danger">
          {reasonOf(crawl.error, t("app.error.generic"))}
        </Alert>
      ) : null}
      {queued && !crawl.isError ? (
        <Alert role="status" tone="success">
          {t("knowledge.queued", { source: queued })}
        </Alert>
      ) : null}
      {sources.isLoading ? <p role="status">{t("app.loading")}</p> : null}
      {!sources.isLoading && !sources.isError && rows.length === 0 ? (
        <EmptyState title={t("knowledge.empty")} description={t("knowledge.emptyHint")} icon="search" action={addSource} />
      ) : null}
      {rows.length > 0 ? (
        <Table data-records="" caption={t("knowledge.sources")}>
          <TableHead>
            <TableHeaderCell>{t("knowledge.column.source")}</TableHeaderCell>
            <TableHeaderCell>{t("knowledge.column.type")}</TableHeaderCell>
            <TableHeaderCell>{t("knowledge.column.state")}</TableHeaderCell>
            <TableHeaderCell>{t("knowledge.column.lastCrawl")}</TableHeaderCell>
            <TableHeaderCell align="right">{t("knowledge.column.pages")}</TableHeaderCell>
            <TableHeaderCell align="right">{t("knowledge.column.documents")}</TableHeaderCell>
            <TableHeaderCell align="right">{t("knowledge.column.passages")}</TableHeaderCell>
            <TableHeaderCell align="right">
              <span className="sr-only">{t("approvals.actions")}</span>
            </TableHeaderCell>
          </TableHead>
          <TableBody>
            {rows.map((row) => {
              const state = standing(row);
              return (
                <TableRow key={row.source}>
                  <TableCell className="font-mono">
                    {row.state === "crawled" ? (
                      <Link
                        to="/projects/$project/knowledge/$source"
                        params={{ project, source: row.source }}
                        className="focus-ring rounded-sm text-primary-soft-fg underline underline-offset-2"
                      >
                        {row.source}
                      </Link>
                    ) : (
                      row.source
                    )}
                  </TableCell>
                  <TableCell>
                    {t(`knowledge.type.${row.type}`)}
                    <span className="block text-caption text-fg-muted [overflow-wrap:anywhere]">
                      {row.type === "website"
                        ? row.startUrls.join(", ")
                        : row.type === "catalogue"
                          ? (row.contextSpaces ?? []).length > 0
                            ? (row.contextSpaces ?? []).join(", ")
                            : t("knowledge.everySpace")
                          : row.type === "guide"
                            ? t("knowledge.userGuide")
                            : (row.ckanInstanceRef ?? "")}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge tone={state.tone}>{t(state.key)}</Badge>
                    {row.job?.state === "failed" && row.job.error ? (
                      <span className="block text-caption text-fg-muted [overflow-wrap:anywhere]">{row.job.error}</span>
                    ) : null}
                  </TableCell>
                  <TableCell>{timeText(row.lastCrawl, i18n.language)}</TableCell>
                  <TableCell align="right">
                    {row.state === "crawled"
                      ? t("knowledge.ofTotal", { part: row.pagesIncluded ?? 0, total: row.pages ?? 0 })
                      : "—"}
                  </TableCell>
                  <TableCell align="right">{row.state === "crawled" ? (row.documents ?? 0) : "—"}</TableCell>
                  <TableCell align="right">
                    {row.state === "crawled"
                      ? t("knowledge.embeddedOf", { embedded: row.embedded ?? 0, total: row.passages ?? 0 })
                      : "—"}
                  </TableCell>
                  <TableCell align="right">
                    <PermissionGuard project={project} kind="KnowledgeSource" verb="propose">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={crawl.isPending || row.job?.state === "queued" || row.job?.state === "running"}
                        disabledReason={
                          row.job?.state === "queued" || row.job?.state === "running"
                            ? t("knowledge.alreadyQueued")
                            : t("knowledge.recrawlSending")
                        }
                        aria-label={t("knowledge.recrawlOf", { source: row.source })}
                        onClick={() => crawl.mutate(row.source)}
                      >
                        {t("knowledge.recrawl")}
                      </Button>
                    </PermissionGuard>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : null}
      <Assistants project={project} />
    </section>
  );
}

interface DeploymentItem {
  metadata: { name: string };
  spec: {
    publicId?: string;
    channel?: string;
    sources?: string[];
    connectors?: { endpoint: string }[];
  };
}

/**
 * The project's assistant deployments: where each answers, from which sources and Endpoints, and
 * what it spent over the last 30 days (T-3057). Each is created and edited as a manifest on its
 * list, like every other kind.
 */
function Assistants({ project }: { project: string }): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [usageOf, setUsageOf] = useState<string | null>(null);
  const [chatWith, setChatWith] = useState<DeploymentItem | null>(null);
  const [embedOf, setEmbedOf] = useState<DeploymentItem | null>(null);
  const list = useQuery({
    queryKey: queryKeys.list(project, "assistantdeployments"),
    queryFn: async () =>
      unwrap(await api.GET("/api/v1/projects/{project}/{plural}", { params: { path: { project, plural: "assistantdeployments" } } })),
  });
  const items = (list.data?.items ?? []) as unknown as DeploymentItem[];
  const addAssistant = (
    <PermissionGuard project={project} kind="AssistantDeployment" verb="propose">
      <Button
        variant="secondary"
        size="sm"
        onClick={() =>
          void navigate({ to: "/projects/$project/$plural/new", params: { project, plural: "assistantdeployments" } })
        }
      >
        {t("knowledge.assistants.add")}
      </Button>
    </PermissionGuard>
  );
  return (
    <section aria-labelledby="knowledge-assistants" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="knowledge-assistants" className="text-lg font-semibold">
          {t("knowledge.assistants.title")}
        </h2>
        {addAssistant}
      </div>
      {list.isError ? (
        <PageFailed
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      ) : null}
      {!list.isLoading && !list.isError && items.length === 0 ? (
        <EmptyState
          title={t("knowledge.assistants.empty")}
          description={t("knowledge.assistants.emptyHint")}
          icon="chat"
          action={addAssistant}
        />
      ) : null}
      {items.length > 0 ? (
        <Table data-records="" caption={t("knowledge.assistants.title")}>
          <TableHead>
            <TableHeaderCell>{t("knowledge.field.name")}</TableHeaderCell>
            <TableHeaderCell>{t("knowledge.field.publicId")}</TableHeaderCell>
            <TableHeaderCell>{t("knowledge.field.channel")}</TableHeaderCell>
            <TableHeaderCell>{t("knowledge.field.sources")}</TableHeaderCell>
            <TableHeaderCell>{t("knowledge.field.connectors")}</TableHeaderCell>
            <TableHeaderCell align="right">
              <span className="sr-only">{t("approvals.actions")}</span>
            </TableHeaderCell>
          </TableHead>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.metadata.name}>
                <TableCell className="font-mono">
                  <RecordLink project={project} plural="assistantdeployments" name={item.metadata.name} />
                </TableCell>
                <TableCell className="font-mono">{item.spec.publicId ?? "—"}</TableCell>
                <TableCell>{item.spec.channel ? t(`knowledge.channel.${item.spec.channel}`) : "—"}</TableCell>
                <TableCell>{(item.spec.sources ?? []).join(", ") || "—"}</TableCell>
                <TableCell>{(item.spec.connectors ?? []).map((c) => c.endpoint).join(", ") || "—"}</TableCell>
                <TableCell align="right">
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("knowledge.chat.askOf", { name: item.metadata.name })}
                      onClick={() => setChatWith(item)}
                    >
                      {t("knowledge.chat.ask")}
                    </Button>
                    {item.spec.channel && item.spec.channel !== "internal" && item.spec.publicId ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t("knowledge.embed.of", { name: item.metadata.name })}
                        onClick={() => setEmbedOf(item)}
                      >
                        {t("knowledge.embed.title")}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("knowledge.assistants.usageOf", { name: item.metadata.name })}
                      onClick={() => setUsageOf(item.metadata.name)}
                    >
                      {t("knowledge.assistants.usage")}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      <Dialog
        open={usageOf !== null}
        onOpenChange={(open) => (open ? undefined : setUsageOf(null))}
        title={t("knowledge.assistants.usageOf", { name: usageOf ?? "" })}
        closeLabel={t("app.close")}
      >
        {usageOf ? <Usage project={project} deployment={usageOf} /> : null}
      </Dialog>
      <Dialog
        open={chatWith !== null}
        onOpenChange={(open) => (open ? undefined : setChatWith(null))}
        title={t("knowledge.chat.askOf", { name: chatWith?.metadata.name ?? "" })}
        description={chatWith?.spec.channel === "internal" ? t("knowledge.chat.asYou") : t("knowledge.chat.asVisitor")}
        closeLabel={t("app.close")}
        size="lg"
      >
        {chatWith ? (
          <AssistantChat
            key={chatWith.metadata.name}
            project={project}
            deployment={chatWith.metadata.name}
            connectors={(chatWith.spec.connectors ?? []).map((c) => c.endpoint)}
          />
        ) : null}
      </Dialog>
      <Dialog
        open={embedOf !== null}
        onOpenChange={(open) => (open ? undefined : setEmbedOf(null))}
        title={t("knowledge.embed.of", { name: embedOf?.metadata.name ?? "" })}
        closeLabel={t("app.close")}
      >
        {embedOf?.spec.publicId ? <EmbedSnippet publicId={embedOf.spec.publicId} title={embedOf.metadata.name} /> : null}
      </Dialog>
    </section>
  );
}

function Usage({ project, deployment }: { project: string; deployment: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const usage = useQuery({
    queryKey: ["projects", project, "knowledge", "deployments", deployment, "usage"],
    queryFn: () => listUsage(project, deployment),
  });
  if (usage.isLoading) return <p role="status">{t("app.loading")}</p>;
  if (usage.isError) {
    return (
      <PageFailed
        error={usage.error}
        onRetry={() => {
          void usage.refetch();
        }}
      />
    );
  }
  const days = usage.data ?? [];
  if (days.length === 0) return <p>{t("knowledge.assistants.noUsage")}</p>;
  const number = new Intl.NumberFormat(i18n.language);
  return (
    <Table data-records="" caption={t("knowledge.assistants.usage")}>
      <TableHead>
        <TableHeaderCell>{t("knowledge.assistants.day")}</TableHeaderCell>
        <TableHeaderCell align="right">{t("knowledge.assistants.requests")}</TableHeaderCell>
        <TableHeaderCell align="right">{t("knowledge.assistants.tokensIn")}</TableHeaderCell>
        <TableHeaderCell align="right">{t("knowledge.assistants.tokensOut")}</TableHeaderCell>
      </TableHead>
      <TableBody>
        {days.map((day) => (
          <TableRow key={day.day}>
            <TableCell>{day.day}</TableCell>
            <TableCell align="right">{number.format(day.requests)}</TableCell>
            <TableCell align="right">{number.format(day.tokensIn)}</TableCell>
            <TableCell align="right">{number.format(day.tokensOut)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
