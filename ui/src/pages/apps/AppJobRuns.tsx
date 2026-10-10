import { useId } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, queryKeys, unwrap } from "../../api/client";
import { Badge, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, TableRowHeaderCell } from "../../components/ui";
import type { BadgeTone } from "../../components/ui/Badge";

/** One declared job, `spec.server.jobs[]` (AP-154). */
interface Job {
  name: string;
  schedule: string;
}

/** Its last run, `status.jobs[]`, as the reconciler read it from the App's shard. */
interface JobRun {
  name: string;
  lastRun: string;
  outcome: string;
  message?: string;
  durationMs: number;
  failuresInARow: number;
}

const TONES: Record<string, BadgeTone> = {
  succeeded: "success",
  failed: "danger",
  timedOut: "danger",
  skipped: "warning",
};
const OUTCOMES = new Set(Object.keys(TONES));

/** The declared jobs and the last runs of an App's manifest, or nothing it does not hold. */
export function jobsOf(manifest: unknown): { jobs: Job[]; runs: JobRun[] } {
  const app = (manifest ?? {}) as { spec?: { server?: { jobs?: unknown } }; status?: { jobs?: unknown } };
  const jobs = Array.isArray(app.spec?.server?.jobs)
    ? (app.spec.server.jobs as Partial<Job>[]).filter(
        (job): job is Job => typeof job.name === "string" && typeof job.schedule === "string",
      )
    : [];
  const runs = Array.isArray(app.status?.jobs)
    ? (app.status.jobs as Partial<JobRun>[]).filter(
        (run): run is JobRun => typeof run.name === "string" && typeof run.lastRun === "string",
      )
    : [];
  return { jobs, runs };
}

/**
 * The scheduled jobs of a `wasm` App and how each last ran (AP-154, AP-155, T-3372): its
 * schedule in UTC, when it last ran, the outcome in words beside its colour, how long it took and,
 * for a run that did not succeed, the job's own sentence. An App without jobs shows nothing.
 */
export function AppJobRuns({ project, name }: { project: string; name: string }): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const heading = useId();
  const app = useQuery({
    queryKey: queryKeys.resource(project, "apps", name),
    queryFn: async () =>
      unwrap<unknown>(
        await api.GET("/api/v1/projects/{project}/{plural}/{name}", {
          params: { path: { project, plural: "apps", name } },
        }),
      ),
    retry: false,
  });
  const { jobs, runs } = jobsOf(app.data);
  if (jobs.length === 0) return null;
  const time = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short", timeZone: "UTC" });
  const when = (iso: string) => {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? iso : `${time.format(at)} UTC`;
  };

  return (
    <section aria-labelledby={heading} className="space-y-2 rounded-lg border border-border bg-surface p-3">
      <h2 id={heading} className="text-sm font-semibold">
        {t("apps.jobs.title")}
      </h2>
      <Table caption={t("apps.jobs.caption", { name })}>
        <TableHead>
          <TableHeaderCell>{t("apps.jobs.job")}</TableHeaderCell>
          <TableHeaderCell>{t("apps.jobs.schedule")}</TableHeaderCell>
          <TableHeaderCell>{t("apps.jobs.lastRun")}</TableHeaderCell>
          <TableHeaderCell>{t("apps.jobs.outcome")}</TableHeaderCell>
          <TableHeaderCell>{t("apps.jobs.duration")}</TableHeaderCell>
        </TableHead>
        <TableBody>
          {jobs.map((job) => {
            const run = runs.find((candidate) => candidate.name === job.name);
            const outcome = run && OUTCOMES.has(run.outcome) ? run.outcome : null;
            return (
              <TableRow key={job.name}>
                <TableRowHeaderCell className="font-mono text-caption">{job.name}</TableRowHeaderCell>
                <TableCell className="font-mono text-caption">{job.schedule}</TableCell>
                <TableCell>{run ? when(run.lastRun) : t("apps.jobs.notRun")}</TableCell>
                <TableCell>
                  {outcome ? (
                    <span className="space-y-1">
                      <Badge tone={TONES[outcome]}>{t(`apps.jobs.outcomes.${outcome}`)}</Badge>
                      {run?.message ? <span className="block text-caption text-fg-muted">{run.message}</span> : null}
                      {run && run.failuresInARow >= 3 ? (
                        <span className="block text-caption text-danger-fg">
                          {t("apps.jobs.inARow", { count: run.failuresInARow })}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-fg-muted">{t("apps.jobs.notRun")}</span>
                  )}
                </TableCell>
                <TableCell>{run && outcome !== "skipped" ? t("apps.jobs.ms", { count: run.durationMs }) : ""}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="text-caption text-fg-muted">{t("apps.jobs.note")}</p>
    </section>
  );
}
