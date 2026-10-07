/**
 * The explorer's export (T-3253, UI-33): the whole view, its filters, columns and order, in the
 * format a person picks. It pages through the endpoint with the person's own session in the
 * background while they keep working, says how far it is, and offers the file when it is done.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { fetchEntities } from "../../components/entities/filters";
import type { EntityQuery } from "../../components/entities/filters";
import { Button, Select } from "../../components/ui";
import { PageFailed } from "../../components/ui/PageState";
import { EXPORT_FORMATS, MAX_EXPORT_ROWS, andQ, collect, columnsOf, exportFile, sortEntities } from "./exportView";
import type { ExportFormat, ViewSort } from "./exportView";

type Job =
  | { state: "idle" }
  | { state: "running"; done: number; total?: number }
  | { state: "ready"; href: string; name: string; rows: number; truncated: boolean }
  | { state: "empty" }
  | { state: "failed"; error: unknown };

export function ExportView({
  slug,
  query,
  grid,
  sort,
}: {
  slug: string;
  /** What the page asks: the type, the chosen columns, its own filter. */
  query: EntityQuery;
  /** What the grid's filter row adds to it. */
  grid: { q?: string; idPattern?: string };
  sort: ViewSort | null;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const formatId = useId();
  const [format, setFormat] = useState<ExportFormat>(i18n.language === "en" ? "csv" : "csv-excel");
  const [job, setJob] = useState<Job>({ state: "idle" });
  const running = useRef<AbortController | null>(null);
  const href = job.state === "ready" ? job.href : null;

  // The file lives as long as its link: a new export, or leaving the page, lets it go.
  useEffect(() => () => {
    if (href) URL.revokeObjectURL(href);
  }, [href]);
  useEffect(() => () => running.current?.abort(), []);

  const start = async () => {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setJob({ state: "running", done: 0 });
    const asked: EntityQuery = { ...query, q: andQ(query.q, grid.q), idPattern: grid.idPattern };
    // A GeoJSON file needs the geometry even when the chosen columns leave it out.
    if (format === "geojson" && asked.attrs && asked.attrs.length > 0 && !asked.attrs.includes("location")) {
      asked.attrs = [...asked.attrs, "location"];
    }
    try {
      const { entities, truncated } = await collect(
        async (offset, limit) => {
          const page = await fetchEntities(slug, asked, { limit, offset, count: offset === 0 });
          return { rows: page.rows as Record<string, unknown>[], count: page.count };
        },
        {
          signal: controller.signal,
          progress: (done, total) => {
            if (running.current === controller) setJob({ state: "running", done, total });
          },
        },
      );
      if (running.current !== controller) return;
      const file = exportFile(format, sortEntities(entities, sort), columnsOf(entities, query.attrs), query.type ?? "entities");
      if (!file || entities.length === 0) {
        setJob({ state: "empty" });
        return;
      }
      const blob = new Blob([file.text], { type: file.type });
      setJob({ state: "ready", href: URL.createObjectURL(blob), name: file.name, rows: entities.length, truncated });
    } catch (error) {
      if (running.current !== controller) return;
      setJob(error instanceof DOMException && error.name === "AbortError" ? { state: "idle" } : { state: "failed", error });
    } finally {
      if (running.current === controller) running.current = null;
    }
  };

  const number = (n: number) => new Intl.NumberFormat(i18n.language).format(n);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={formatId} className="sr-only">
        {t("explore.exportView.format")}
      </label>
      <Select id={formatId} className="w-auto" value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}>
        {EXPORT_FORMATS.map((each) => (
          <option key={each} value={each}>
            {t(`explore.exportView.formats.${each}`)}
          </option>
        ))}
      </Select>
      {job.state === "running" ? (
        <>
          <span role="status" className="text-caption text-fg-muted">
            {job.total !== undefined
              ? t("explore.exportView.progressOf", { done: number(job.done), total: number(Math.min(job.total, MAX_EXPORT_ROWS)) })
              : t("explore.exportView.progress", { done: number(job.done) })}
          </span>
          <Button size="sm" variant="secondary" onClick={() => running.current?.abort()}>
            {t("explore.exportView.cancel")}
          </Button>
        </>
      ) : (
        <Button size="sm" onClick={() => void start()}>
          {t("explore.exportView.start")}
        </Button>
      )}
      {job.state === "ready" ? (
        <span role="status" className="text-caption text-fg">
          <a href={job.href} download={job.name} className="font-medium text-primary-soft-fg underline">
            {t("explore.exportView.download", { name: job.name, rows: job.rows })}
          </a>
          {job.truncated ? <span className="ml-1 text-warning">{t("explore.exportView.truncated", { max: number(MAX_EXPORT_ROWS) })}</span> : null}
        </span>
      ) : null}
      {job.state === "empty" ? (
        <span role="status" className="text-caption text-fg-muted">
          {format === "geojson" ? t("explore.exportView.noGeometry") : t("explore.exportView.empty")}
        </span>
      ) : null}
      {job.state === "failed" ? (
        <div className="w-full">
          <PageFailed error={job.error} onRetry={() => void start()} />
        </div>
      ) : null}
    </div>
  );
}
