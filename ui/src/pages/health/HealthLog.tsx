import type { JSX } from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, unwrap } from "../../api/client";
import type { components } from "../../api/schema";
import type { BadgeTone } from "../../components/ui/Badge";
import {
  Alert,
  Badge,
  EmptyState,
  Field,
  PageFailed,
  PageHeader,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableSkeleton,
  safeHref,
} from "../../components/ui";

type Check = components["schemas"]["HealthCheck"];
type Kind = components["schemas"]["HealthCheckKind"];
type Status = components["schemas"]["HealthCheckStatus"];

export const KINDS: readonly Kind[] = ["pipeline", "space", "endpoint", "model", "datasource"];
/** The checks the leader writes today (`src/health_log.rs`); another one shows by its name. */
export const CHECKS = ["reconcile", "runs", "freshness"] as const;
const TONE: Record<Status, BadgeTone> = { error: "danger", warn: "warning", ok: "success" };
/** The label of each status; the key is the reader's word, not the server's (ui-writing). */
export const LABEL: Record<Status, string> = { error: "health.broken", warn: "health.look", ok: "health.working" };
const BAR: Record<Status, string> = { error: "bg-danger", warn: "bg-warning", ok: "bg-success" };

/** The statuses of the last 7 days as a strip of bars, oldest first; read as a sentence. */
function History({ points, label }: { points: Check["history"]; label: string }): JSX.Element {
  if (points.length === 0) {
    return <span className="text-fg-muted">—</span>;
  }
  return (
    <span role="img" aria-label={label} className="flex h-4 items-end gap-px">
      {points.slice(-48).map((point) => (
        <span key={point.at} className={`h-full w-1 rounded-sm ${BAR[point.status]}`} />
      ))}
    </span>
  );
}

/**
 * The health log (T-5067): every check of the project's pipelines, Context Spaces, Endpoints,
 * models and data sources, errors first, with since when it holds, what it found and how to fix
 * it. Without `project` it is the administrator's view across projects, with a project column.
 */
export function HealthLog({ project }: { project?: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "sk";
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });
  const [kind, setKind] = useState<Kind | "">("");
  const checks = useQuery({
    queryKey: project ? ["projects", project, "health-checks"] : ["organization", "health-checks"],
    queryFn: async () =>
      unwrap(
        project
          ? await api.GET("/api/v1/projects/{project}/health-checks", { params: { path: { project } } })
          : await api.GET("/api/v1/organization/health-checks"),
      ),
    refetchInterval: 60_000,
  });

  if (checks.isError) {
    return <PageFailed error={checks.error} onRetry={() => void checks.refetch()} />;
  }
  if (checks.isPending) {
    return (
      <Table caption={t("health.caption")} status={t("app.loading")}>
        <TableSkeleton columns={project ? 5 : 6} />
      </Table>
    );
  }
  const all = checks.data.items;
  if (all.length === 0) {
    return <EmptyState icon="refresh" title={t("health.empty")} description={t("health.emptyHint")} />;
  }
  const items = kind === "" ? all : all.filter((item) => item.kind === kind);
  const errors = all.filter((item) => item.status === "error").length;
  const warnings = all.filter((item) => item.status === "warn").length;
  return (
    <div className="flex flex-col gap-4">
      {errors + warnings > 0 ? (
        <Alert tone={errors > 0 ? "danger" : "warning"} role="status">
          {t("health.summary", { errors, warnings, total: all.length })}
        </Alert>
      ) : (
        <Alert tone="success" role="status">
          {t("health.allWell", { total: all.length })}
        </Alert>
      )}
      <Field id="health-kind" label={t("health.kind")} description={t("health.kindHint")} className="max-w-xs">
        <Select id="health-kind" value={kind} onChange={(event) => setKind(event.target.value as Kind | "")}>
          <option value="">{t("health.allKinds")}</option>
          {KINDS.map((value) => (
            <option key={value} value={value}>
              {t(`health.kinds.${value}`)}
            </option>
          ))}
        </Select>
      </Field>
      {items.length === 0 ? (
        <EmptyState bare icon="refresh" title={t("health.noneOfKind")} description={t("health.noneOfKindHint")} />
      ) : (
        <Table caption={t("health.caption")}>
          <TableHead>
            <TableHeaderCell>{t("health.status")}</TableHeaderCell>
            {project ? null : <TableHeaderCell>{t("health.project")}</TableHeaderCell>}
            <TableHeaderCell>{t("health.resource")}</TableHeaderCell>
            <TableHeaderCell>{t("health.found")}</TableHeaderCell>
            <TableHeaderCell>{t("health.history")}</TableHeaderCell>
            <TableHeaderCell>{t("health.lastOk")}</TableHeaderCell>
          </TableHead>
          <TableBody>
            {items.map((item) => (
              <TableRow key={`${item.project}/${item.kind}/${item.name}/${item.check}`}>
                <TableCell>
                  <span className="flex flex-col items-start gap-1">
                    <Badge tone={TONE[item.status]}>{t(LABEL[item.status])}</Badge>
                    <span className="whitespace-nowrap text-caption text-fg-muted">
                      {t("health.since", { at: time.format(new Date(item.since)) })}
                    </span>
                  </span>
                </TableCell>
                {project ? null : <TableCell>{item.project}</TableCell>}
                <TableCell>
                  <a
                    href={safeHref(item.evidenceUrl)}
                    className="focus-ring font-medium text-primary-soft-fg underline hover:no-underline"
                  >
                    {item.name}
                  </a>
                  <span className="block text-caption text-fg-muted">
                    {t(`health.kinds.${item.kind}`)} · {t(`health.checks.${item.check}`, { defaultValue: item.check })}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="block max-w-md break-words">
                    {item.detail === "" ? t("health.nothingFound") : item.detail}
                    {item.fixHint === "" ? null : (
                      <span className="mt-1 block text-caption text-fg-muted">
                        {t("health.fix")} {item.fixHint}
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <History
                    points={item.history}
                    label={t("health.historyLabel", {
                      errors: item.history.filter((p) => p.status === "error").length,
                      warnings: item.history.filter((p) => p.status === "warn").length,
                      total: item.history.length,
                    })}
                  />
                </TableCell>
                <TableCell>
                  {item.lastOk == null ? (
                    t("health.never")
                  ) : (
                    <time dateTime={item.lastOk} className="whitespace-nowrap tabular-nums">
                      {time.format(new Date(item.lastOk))}
                    </time>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** What is broken in this project and what to do about it (T-5067). */
export function HealthPage({ project }: { project: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-section">
      <PageHeader title={t("health.title")} description={t("health.lead")} />
      <HealthLog project={project} />
    </div>
  );
}
