import { useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap } from "../../api/client";
import type { components } from "../../api/schema";
import type { BadgeTone } from "../../components/ui/Badge";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableSkeleton,
} from "../../components/ui";

type Run = components["schemas"]["PipelineRun"];
type LogLine = components["schemas"]["PipelineLogLine"];

const PAGE = 100;

const TONE: Record<LogLine["outcome"], BadgeTone> = {
  sent: "success",
  rejected: "warning",
  failed: "danger",
};

/**
 * A pipeline's latest runs with how many records each sent, how many the model rejected and how
 * many failed in a step, and the log of the run a person opens: one line per record, newest first
 * (PL-62, ADR-N-034). A run is one tick of the pipeline's clock, or one UTC hour for a source
 * that never ends. Record ids and messages arrive masked where they look like a credential.
 */
export function PipelineRunsDialog({
  project,
  name,
  onClose,
}: {
  project: string;
  name: string;
  onClose: () => void;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "sk";
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" });
  const [picked, setPicked] = useState<string | null>(null);

  const runsKey = [...queryKeys.resource(project, "pipelines", name), "runs"];
  const runs = useQuery({
    queryKey: runsKey,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/pipelines/{name}/runs", {
          params: { path: { project, name } },
        }),
      ),
  });
  const items: Run[] = runs.data?.items ?? [];
  // The newest run is open until a person picks another.
  const open = picked ?? items[0]?.run ?? null;

  const label = (run: string): string => {
    const at = new Date(run);
    if (Number.isNaN(at.getTime())) {
      return run;
    }
    // A run named by its hour is a source that never ends: the hour it read in.
    return /T\d{2}:00Z$/.test(run)
      ? t("pipelines.runs.hour", { at: time.format(at) })
      : time.format(at);
  };

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onClose();
        }
      }}
      title={t("pipelines.runs.title", { name })}
      description={t("pipelines.runs.lead")}
      size="xl"
      closeLabel={t("pipelines.runs.close")}
    >
      <div className="flex flex-col gap-4">
        {runs.isError ? (
          <Alert role="alert" tone="danger">
            {runs.error instanceof ApiError ? runs.error.message : t("app.error.generic")}
          </Alert>
        ) : runs.isPending ? (
          <Table caption={t("pipelines.runs.caption")} status={t("app.loading")}>
            <TableSkeleton columns={5} />
          </Table>
        ) : items.length === 0 ? (
          <EmptyState
            bare
            icon="pipelines"
            title={t("pipelines.runs.empty")}
            description={t("pipelines.runs.emptyHint")}
          />
        ) : (
          <>
            <Table caption={t("pipelines.runs.caption")} maxHeight="max-h-64">
              <TableHead>
                <TableHeaderCell>{t("pipelines.runs.run")}</TableHeaderCell>
                <TableHeaderCell>{t("pipelines.runs.sent")}</TableHeaderCell>
                <TableHeaderCell>{t("pipelines.runs.rejected")}</TableHeaderCell>
                <TableHeaderCell>{t("pipelines.runs.failed")}</TableHeaderCell>
                <TableHeaderCell>
                  <span className="sr-only">{t("pipelines.runs.log")}</span>
                </TableHeaderCell>
              </TableHead>
              <TableBody>
                {items.map((run) => (
                  <TableRow key={run.run}>
                    <TableCell>
                      <time dateTime={run.lastAt} className="whitespace-nowrap tabular-nums">
                        {label(run.run)}
                      </time>
                    </TableCell>
                    <TableCell>
                      <span className="tabular-nums">{run.sent.toLocaleString(locale)}</span>
                    </TableCell>
                    <TableCell>
                      <span className={run.rejected > 0 ? "tabular-nums text-warning" : "tabular-nums"}>
                        {run.rejected.toLocaleString(locale)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={run.failed > 0 ? "tabular-nums text-danger" : "tabular-nums"}>
                        {run.failed.toLocaleString(locale)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        aria-pressed={open === run.run}
                        onClick={() => setPicked(run.run)}
                      >
                        {t("pipelines.runs.show", { run: label(run.run) })}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {open !== null ? (
              <RunLog
                key={open}
                project={project}
                name={name}
                run={open}
                title={label(open)}
                time={time}
              />
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}

/** One run's log, newest line first, a page at a time. */
function RunLog({
  project,
  name,
  run,
  title,
  time,
}: {
  project: string;
  name: string;
  run: string;
  title: string;
  time: Intl.DateTimeFormat;
}): JSX.Element {
  const { t } = useTranslation();
  // The pages walked so far, as their `before`: the first is the newest page.
  const [cursors, setCursors] = useState<(number | undefined)[]>([undefined]);
  const before = cursors[cursors.length - 1];
  const page = useQuery({
    queryKey: [...queryKeys.resource(project, "pipelines", name), "runs", run, before ?? "newest"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/pipelines/{name}/runs/{run}/log", {
          params: { path: { project, name, run }, query: { limit: PAGE, before } },
        }),
      ),
  });
  const caption = t("pipelines.runs.logCaption", { run: title });
  const lines: LogLine[] = page.data?.items ?? [];

  return (
    <section aria-label={caption} className="flex flex-col gap-2">
      <h3 className="text-body font-medium text-fg">{caption}</h3>
      {page.isError ? (
        <Alert role="alert" tone="danger">
          {page.error instanceof ApiError ? page.error.message : t("app.error.generic")}
        </Alert>
      ) : page.isPending ? (
        <Table caption={caption} status={t("app.loading")}>
          <TableSkeleton columns={4} />
        </Table>
      ) : lines.length === 0 ? (
        <p className="text-caption text-fg-subtle">{t("pipelines.runs.noLines")}</p>
      ) : (
        <>
          <Table caption={caption} maxHeight="max-h-96">
            <TableHead>
              <TableHeaderCell>{t("pipelines.runs.at")}</TableHeaderCell>
              <TableHeaderCell>{t("pipelines.runs.record")}</TableHeaderCell>
              <TableHeaderCell>{t("pipelines.runs.outcome")}</TableHeaderCell>
              <TableHeaderCell>{t("pipelines.runs.message")}</TableHeaderCell>
            </TableHead>
            <TableBody>
              {lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell>
                    <time dateTime={line.at} className="whitespace-nowrap tabular-nums">
                      {time.format(new Date(line.at))}
                    </time>
                  </TableCell>
                  <TableCell>
                    <span className="break-all font-mono text-caption">
                      {line.recordId || t("pipelines.runs.noId")}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <Badge tone={TONE[line.outcome]}>{t(`pipelines.runs.outcomes.${line.outcome}`)}</Badge>
                      {line.step != null ? (
                        <span className="text-caption text-fg-subtle">
                          {t("pipelines.rejected.step", { step: line.step + 1 })}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <p className="text-body text-fg">{line.message}</p>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center gap-2">
            {cursors.length > 1 ? (
              <Button size="sm" onClick={() => setCursors([undefined])}>
                {t("pipelines.runs.newest")}
              </Button>
            ) : null}
            {page.data.next != null ? (
              <Button
                size="sm"
                onClick={() => setCursors((current) => [...current, page.data.next ?? undefined])}
              >
                {t("pipelines.runs.older")}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
