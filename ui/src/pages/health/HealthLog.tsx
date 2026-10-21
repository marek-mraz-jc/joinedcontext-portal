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
  Card,
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
/** The checks with a label of their own (`src/health_log.rs`, `src/health_probe.rs`); a surface shows by its name. */
export const CHECKS = ["reconcile", "runs", "freshness", "entities", "storage", "validation", "reachable"] as const;
/** The message keys the server sends (`SAY` in `src/health_log.rs`), each under `health.say`. */
export const SAID = [
  "notApplied", "waitingApproval", "noNewData", "countFellToZero", "countHalved", "counted", "notCounted",
  "invalid", "valid", "staleType", "noReader", "readBy", "readerSaid", "answered", "slow", "anonymousRefused",
  "notServed", "noAnswer", "policyWrite", "policy", "token", "robots", "sourceDown", "serviceDown", "runLog",
  "manifest", "approve", "drift", "drop", "schedule", "countFell", "validation", "retention", "addReader",
  "publicRefused", "surfaceMissing", "slowSurface",
] as const;
const TONE: Record<Status, BadgeTone> = { error: "danger", warn: "warning", ok: "success" };
/** The label of each status; the key is the reader's word, not the server's (ui-writing). */
export const LABEL: Record<Status, string> = { error: "health.broken", warn: "health.look", ok: "health.working" };
/** Height says the status as well as colour does: full for broken, half for a warning, low for working. */
const BAR: Record<Status, string> = { error: "h-full bg-danger", warn: "h-1/2 bg-warning", ok: "h-1/4 bg-success" };

/** A message in the reader's language when the server named its key, else the component's words. */
function useSay(): (text: Check["detail"]) => string {
  const { t } = useTranslation();
  return (text) =>
    text.code === "" || !(SAID as readonly string[]).includes(text.code)
      ? text.text
      : t(`health.say.${text.code}`, { ...text.args, defaultValue: text.text });
}

/** The statuses of the last 7 days as a strip of bars, oldest first; read as a sentence. */
function History({ points, label }: { points: Check["history"]; label: string }): JSX.Element {
  if (points.length === 0) {
    return <span className="text-fg-muted">—</span>;
  }
  return (
    <span role="img" aria-label={label} className="flex h-4 items-end gap-px">
      {points.slice(-48).map((point) => (
        <span key={point.at} className={`w-1 rounded-sm ${BAR[point.status]}`} />
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
  const say = useSay();
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
        <TableSkeleton columns={5} />
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
        <>
          {/* A phone reads one card per check: a table at 400 px cut what was found (T-5067 review). */}
          <ul aria-label={t("health.caption")} className="flex flex-col gap-3 sm:hidden">
            {items.map((item) => (
              <Card as="li" padding="md" key={keyOf(item)} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <Resource item={item} project={project} />
                  <StatusOf item={item} time={time} />
                </div>
                <Found item={item} say={say} />
                <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-fg-muted">
                  <HistoryOf item={item} />
                  <span>
                    {t("health.lastOk")}: <LastOk item={item} time={time} />
                  </span>
                </div>
              </Card>
            ))}
          </ul>
          <div className="hidden sm:block">
            <Table caption={t("health.caption")}>
              <TableHead>
                <TableHeaderCell>{t("health.status")}</TableHeaderCell>
                <TableHeaderCell>{t("health.resource")}</TableHeaderCell>
                <TableHeaderCell>{t("health.found")}</TableHeaderCell>
                <TableHeaderCell>{t("health.history")}</TableHeaderCell>
                <TableHeaderCell>{t("health.lastOk")}</TableHeaderCell>
              </TableHead>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={keyOf(item)}>
                    <TableCell>
                      <StatusOf item={item} time={time} />
                    </TableCell>
                    <TableCell>
                      <Resource item={item} project={project} />
                    </TableCell>
                    <TableCell>
                      <Found item={item} say={say} />
                    </TableCell>
                    <TableCell>
                      <HistoryOf item={item} />
                    </TableCell>
                    <TableCell>
                      <LastOk item={item} time={time} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}

const keyOf = (item: Check): string => `${item.project}/${item.kind}/${item.name}/${item.check}`;

function StatusOf({ item, time }: { item: Check; time: Intl.DateTimeFormat }): JSX.Element {
  const { t } = useTranslation();
  return (
    <span className="flex flex-col items-start gap-1">
      <Badge tone={TONE[item.status]}>{t(LABEL[item.status])}</Badge>
      <span className="whitespace-nowrap text-caption text-fg-muted">
        {t("health.since", { at: time.format(new Date(item.since)) })}
      </span>
    </span>
  );
}

/** The resource's name as a link to its page, its kind and check, and its project in the admin view. */
function Resource({ item, project }: { item: Check; project?: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <span className="flex flex-col">
      <a href={safeHref(item.evidenceUrl)} className="focus-ring font-medium text-primary-soft-fg underline hover:no-underline">
        {item.name}
      </a>
      <span className="text-caption text-fg-muted">
        {t(`health.kinds.${item.kind}`)} · {(CHECKS as readonly string[]).includes(item.check) ? t(`health.checks.${item.check}`) : item.check}
      </span>
      {project ? null : (
        <span className="text-caption text-fg-muted">
          {t("health.project")}: {item.project}
        </span>
      )}
    </span>
  );
}

function Found({ item, say }: { item: Check; say: (text: Check["detail"]) => string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <span className="block max-w-md break-words">
      {item.detail.text === "" ? t("health.nothingFound") : say(item.detail)}
      {item.fix.text === "" ? null : (
        <span className="mt-1 block text-caption text-fg-muted">
          {t("health.fix")} {say(item.fix)}
        </span>
      )}
    </span>
  );
}

function HistoryOf({ item }: { item: Check }): JSX.Element {
  const { t } = useTranslation();
  return (
    <History
      points={item.history}
      label={t("health.historyLabel", {
        errors: item.history.filter((p) => p.status === "error").length,
        warnings: item.history.filter((p) => p.status === "warn").length,
        total: item.history.length,
      })}
    />
  );
}

function LastOk({ item, time }: { item: Check; time: Intl.DateTimeFormat }): JSX.Element {
  const { t } = useTranslation();
  return item.lastOk == null ? (
    <>{t("health.never")}</>
  ) : (
    <time dateTime={item.lastOk} className="whitespace-nowrap tabular-nums">
      {time.format(new Date(item.lastOk))}
    </time>
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
