import { useState } from "react";
import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../api/client";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
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
import { knowledgeKeys, listSources, recrawl, timeText } from "./knowledge";
import type { KnowledgeSourceRow } from "./knowledge";

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
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.sources(project) });
    },
  });
  const rows = sources.data ?? [];

  return (
    <section aria-label={t("knowledge.title")} className="space-y-6">
      <PageHeader title={t("knowledge.title")} description={t("knowledge.intro")} />
      {sources.isError ? (
        <Alert role="alert" tone="danger">
          {t("knowledge.failed", { reason: reasonOf(sources.error, t("app.error.generic")) })}
        </Alert>
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
        <EmptyState title={t("knowledge.empty")} description={t("knowledge.emptyHint")} icon="search" />
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
                      {row.type === "website" ? row.startUrls.join(", ") : (row.ckanInstanceRef ?? "")}
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
    </section>
  );
}
