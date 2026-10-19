import { useMemo, useState } from "react";
import type { ChangeEvent, JSX } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Dialog,
  Field,
  InlineError,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../ui";
import {
  addOldValue,
  correct,
  editCurrent,
  instantOf,
  parseCsv,
  planImport,
  readHistory,
  runImport,
  valueOf,
} from "./historyApi";
import type { CsvProblem, CsvRow, Measurement, Version } from "./historyApi";

/** One page of measurements, as many as the broker serves per attribute (temporal.md). */
const PAGE = 9;

function formatValue(val: unknown): string {
  if (val === undefined || val === null) {
    return "";
  }
  return typeof val === "string" ? val : JSON.stringify(val);
}

/** An instant in the person's language, never the browser's (UI-15). */
function when(iso: string, language: string): string {
  return new Date(iso).toLocaleString(language, { dateStyle: "medium", timeStyle: "medium" });
}

function toLocalInputString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A reason the gateway takes: something written, at most 500 characters (DM-113). */
function reasonOk(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length > 0 && trimmed.length <= 500;
}

/** The attribute every form writes to, and what to do once a write landed. */
interface Target {
  slug: string;
  entityId: string;
  attribute: string;
  /** The current value: a typed field reads its text as the same type. */
  sample: unknown;
  written: () => Promise<void>;
}

/** One write at a time: busy while it runs, the gateway's message when it fails. */
function useWrite(target: Target) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (write: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await write();
      await target.written();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.error.generic"));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function ReasonField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <Field id={id} label={t("attributeHistory.reason")} help={t("attributeHistory.reasonHint")}>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/** The current value, replaced through the Endpoint with a reason (DM-113). */
function EditCurrent({ target, current }: { target: Target; current: unknown }): JSX.Element {
  const { t } = useTranslation();
  // The field shows the current value until the person types.
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState("");
  const write = useWrite(target);
  const text = typed ?? formatValue(current);
  const value = valueOf(text, target.sample);

  const save = async () => {
    const done = await write.run(() =>
      editCurrent(target.slug, target.entityId, target.attribute, value, reason),
    );
    if (done) {
      setReason("");
      setTyped(undefined);
    }
  };

  return (
    <section
      aria-labelledby="history-edit-current-title"
      className="rounded-lg border border-border bg-surface p-4"
    >
      <h3 id="history-edit-current-title" className="font-semibold text-fg">
        {t("attributeHistory.editCurrent")}
      </h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field
          id="history-current-val"
          label={t("attributeHistory.value")}
          errors={text !== "" && value === undefined ? [t("attributeHistory.value")] : undefined}
        >
          <Input id="history-current-val" value={text} onChange={(e) => setTyped(e.target.value)} />
        </Field>
        <ReasonField id="history-current-reason" value={reason} onChange={setReason} />
      </div>
      {write.error ? <InlineError className="mt-2">{write.error}</InlineError> : null}
      <div className="mt-3 flex justify-end">
        <Button
          variant="primary"
          size="sm"
          loading={write.busy}
          disabled={!reasonOk(reason) || value === undefined}
          title={!reasonOk(reason) || value === undefined ? t("attributeHistory.needsReason") : undefined}
          onClick={() => void save()}
        >
          {t("attributeHistory.save")}
        </Button>
      </div>
    </section>
  );
}

/** A value of an instant gone by, into history only: a backfill (ADR-N-054 2.1). */
function AddOldValue({ target }: { target: Target }): JSX.Element {
  const { t } = useTranslation();
  const [local, setLocal] = useState("");
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const write = useWrite(target);
  const instant = instantOf(local);
  const value = valueOf(text, target.sample);

  const save = async () => {
    if (!instant) {
      return;
    }
    const done = await write.run(() =>
      addOldValue(target.slug, target.entityId, target.attribute, value, instant, reason),
    );
    if (done) {
      setLocal("");
      setText("");
      setReason("");
    }
  };

  return (
    <section
      aria-labelledby="history-add-old-title"
      className="rounded-lg border border-border bg-surface p-4"
    >
      <h3 id="history-add-old-title" className="font-semibold text-fg">
        {t("attributeHistory.addOldValue")}
      </h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field id="history-old-date" label={t("attributeHistory.observedAt")}>
          <Input
            id="history-old-date"
            type="datetime-local"
            max={toLocalInputString(new Date())}
            value={local}
            onChange={(e) => setLocal(e.target.value)}
          />
        </Field>
        <Field id="history-old-val" label={t("attributeHistory.value")}>
          <Input id="history-old-val" value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <ReasonField id="history-old-reason" value={reason} onChange={setReason} />
      </div>
      {write.error ? <InlineError className="mt-2">{write.error}</InlineError> : null}
      <div className="mt-3 flex justify-end">
        <Button
          variant="primary"
          size="sm"
          loading={write.busy}
          disabled={!reasonOk(reason) || !instant || value === undefined}
          title={!reasonOk(reason) || !instant || value === undefined ? t("attributeHistory.needsReason") : undefined}
          onClick={() => void save()}
        >
          {t("attributeHistory.save")}
        </Button>
      </div>
    </section>
  );
}

/** Old values from a CSV file: a preview of what is new, the same or a correction, then one run (DM-81). */
function CsvImport({
  target,
  measurements,
  complete,
}: {
  target: Target;
  measurements: Measurement[];
  complete: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [problems, setProblems] = useState<CsvProblem[]>([]);
  const [reason, setReason] = useState("");
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const write = useWrite(target);
  const plan = useMemo(() => planImport(rows, measurements, complete), [rows, measurements, complete]);
  const count = plan.added.length + plan.unchecked.length + plan.corrections.length;

  const choose = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }
    setResult(null);
    const parsed = parseCsv(await file.text(), target.sample);
    setRows(parsed.rows);
    setProblems(parsed.problems);
  };

  const confirm = async () => {
    setResult(null);
    const done = await write.run(async () => {
      const ran = await runImport(
        target.slug,
        target.entityId,
        target.attribute,
        plan,
        reason,
        setProgress,
      );
      if (ran.failed) {
        throw new Error(
          t("attributeHistory.importFailed", { line: ran.failed.line, reason: ran.failed.message }),
        );
      }
      setResult(t("attributeHistory.importResult", { sent: ran.sent }));
    });
    if (done) {
      setRows([]);
      setProblems([]);
      setReason("");
      setProgress(null);
    }
  };

  return (
    <section
      aria-labelledby="history-import-csv-title"
      className="rounded-lg border border-border bg-surface p-4"
    >
      <h3 id="history-import-csv-title" className="font-semibold text-fg">
        {t("attributeHistory.importCsv")}
      </h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field id="history-import-file" label={t("attributeHistory.file")}>
          <Input
            id="history-import-file"
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void choose(e)}
          />
        </Field>
        <ReasonField id="history-import-reason" value={reason} onChange={setReason} />
      </div>
      {rows.length > 0 ? (
        <p className="mt-2 font-medium text-fg">
          {t("attributeHistory.csvPreview", {
            added: plan.added.length,
            duplicates: plan.duplicates.length,
            corrections: plan.corrections.length,
          })}
        </p>
      ) : null}
      {plan.unchecked.length > 0 ? (
        <p className="mt-1 text-caption text-fg-muted">
          {t("attributeHistory.csvUnchecked", { count: plan.unchecked.length })}
        </p>
      ) : null}
      {problems.length > 0 ? (
        <ul className="mt-1 list-disc pl-5 text-caption text-danger">
          {problems.map((problem) => (
            <li key={`${problem.line}-${problem.reason}`}>
              {t("attributeHistory.csvProblems", { line: problem.line, reason: problem.reason })}
            </li>
          ))}
        </ul>
      ) : null}
      {progress ? (
        <p className="mt-2 text-caption text-fg-muted">
          {t("attributeHistory.importProgress", progress)}
        </p>
      ) : null}
      {result ? <p className="mt-2 text-caption font-medium text-fg">{result}</p> : null}
      {write.error ? <InlineError className="mt-2">{write.error}</InlineError> : null}
      <div className="mt-3 flex justify-end">
        <Button
          variant="primary"
          size="sm"
          loading={write.busy}
          disabled={!reasonOk(reason) || count === 0}
          title={!reasonOk(reason) || count === 0 ? t("attributeHistory.needsReason") : undefined}
          onClick={() => void confirm()}
        >
          {t("attributeHistory.confirmImport")}
        </Button>
      </div>
    </section>
  );
}

/** A past measurement's new version: a correction with its value, or a revert to an older one (DM-115). */
function VersionDialog({
  target,
  measurement,
  revertTo,
  close,
}: {
  target: Target;
  measurement: Measurement;
  /** The older version a revert writes again; absent, the person types the corrected value. */
  revertTo?: Version;
  close: () => void;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const [text, setText] = useState(formatValue(measurement.current.value));
  const [reason, setReason] = useState("");
  const write = useWrite(target);
  const value = revertTo ? revertTo.value : valueOf(text, target.sample);

  const save = async () => {
    const done = await write.run(() =>
      correct(
        target.slug,
        target.entityId,
        target.attribute,
        measurement.current.instanceId ?? "",
        value,
        measurement.observedAt,
        reason,
      ),
    );
    if (done) {
      close();
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t(revertTo ? "attributeHistory.revertTitle" : "attributeHistory.correctTitle")}
      description={when(measurement.observedAt, i18n.language)}
      closeLabel={t("attributeHistory.cancel")}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            {t("attributeHistory.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={write.busy}
            disabled={!reasonOk(reason) || value === undefined}
            title={!reasonOk(reason) || value === undefined ? t("attributeHistory.needsReason") : undefined}
            onClick={() => void save()}
          >
            {t(revertTo ? "attributeHistory.revert" : "attributeHistory.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {revertTo ? null : (
          <Field id="correct-modal-val" label={t("attributeHistory.value")}>
            <Input id="correct-modal-val" value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        )}
        <ReasonField
          id={revertTo ? "revert-modal-reason" : "correct-modal-reason"}
          value={reason}
          onChange={setReason}
        />
        {write.error ? <InlineError>{write.error}</InlineError> : null}
      </div>
    </Dialog>
  );
}

/** One version's row: when, what, and who wrote it why (ADR-N-054 2.3). */
function VersionRow({
  measurement,
  version,
  first,
  canEditHistory,
  open,
}: {
  measurement: Measurement;
  version: Version;
  first: boolean;
  canEditHistory: boolean;
  open: (revertTo?: Version) => void;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const current = version === measurement.current && !version.supersededAt;
  const written = version.provenance?.writtenAt;
  return (
    <TableRow>
      <TableCell className="font-mono text-caption">
        {first ? (
          <span>{when(measurement.observedAt, i18n.language)}</span>
        ) : (
          <span className="text-fg-muted">↳</span>
        )}
      </TableCell>
      <TableCell className="font-mono text-caption">
        <div className="flex items-center gap-1.5">
          <span>{formatValue(version.value)}</span>
          {version.unitCode ? <span className="text-fg-muted">{version.unitCode}</span> : null}
          <Badge tone={current ? "success" : "neutral"}>
            {t(current ? "attributeHistory.current" : "attributeHistory.superseded")}
          </Badge>
        </div>
      </TableCell>
      <TableCell className="text-caption">{version.provenance?.channel ?? "—"}</TableCell>
      <TableCell className="font-mono text-caption">{version.provenance?.actor ?? "—"}</TableCell>
      <TableCell className="text-caption">{version.provenance?.operation ?? "—"}</TableCell>
      <TableCell className="text-caption">{version.provenance?.reason ?? "—"}</TableCell>
      <TableCell className="text-caption">
        {written ? when(written, i18n.language) : "—"}
      </TableCell>
      <TableCell className="text-right">
        {canEditHistory ? (
          <Button size="xs" variant="ghost" onClick={() => open(current ? undefined : version)}>
            {t(current ? "attributeHistory.correct" : "attributeHistory.revert")}
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

/** The measurements of one page, each with its versions oldest first. */
function Timeline({
  measurements,
  canEditHistory,
  open,
}: {
  measurements: Measurement[];
  canEditHistory: boolean;
  open: (measurement: Measurement, revertTo?: Version) => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <Table caption={t("attributeHistory.timeline")}>
      <TableHead>
        <TableHeaderCell>{t("attributeHistory.observedAt")}</TableHeaderCell>
        <TableHeaderCell>{t("attributeHistory.value")}</TableHeaderCell>
        <TableHeaderCell>{t("attributeHistory.channel")}</TableHeaderCell>
        <TableHeaderCell>{t("attributeHistory.actor")}</TableHeaderCell>
        <TableHeaderCell>{t("attributeHistory.operation")}</TableHeaderCell>
        <TableHeaderCell>{t("attributeHistory.reason")}</TableHeaderCell>
        <TableHeaderCell>{t("attributeHistory.writtenAt")}</TableHeaderCell>
        <TableHeaderCell className="text-right" />
      </TableHead>
      <TableBody>
        {measurements.flatMap((measurement) =>
          measurement.versions.map((version, index) => (
            <VersionRow
              key={`${measurement.observedAt}-${version.instanceId ?? index}`}
              measurement={measurement}
              version={version}
              first={index === 0}
              canEditHistory={canEditHistory}
              open={(revertTo) => open(measurement, revertTo)}
            />
          )),
        )}
      </TableBody>
    </Table>
  );
}

/**
 * One attribute's history through the Endpoint (T-4667, ADR-N-054 2.4, DM-114): every version
 * with who wrote it and why, and, where the grant allows, the current value edited, an old value
 * added, a measurement corrected or reverted, and old values imported from CSV, each with a reason.
 */
export function AttributeHistory({
  slug,
  entityId,
  attribute,
  canEdit,
  canEditHistory,
}: {
  slug: string;
  entityId: string;
  attribute: string;
  canEdit: boolean;
  canEditHistory: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [before, setBefore] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<{ measurement: Measurement; revertTo?: Version } | null>(
    null,
  );
  const history = useQuery({
    queryKey: ["attribute-history", slug, entityId, attribute, before],
    retry: false,
    queryFn: () => readHistory(slug, entityId, attribute, { before }),
  });
  const measurements = useMemo(() => history.data?.measurements ?? [], [history.data]);

  // The newest page holds the current value; an older page never stands in for it.
  const [newest, setNewest] = useState<unknown>(undefined);
  if (before === undefined && measurements[0] && measurements[0].current.value !== newest) {
    setNewest(measurements[0].current.value);
  }
  const target: Target = {
    slug,
    entityId,
    attribute,
    sample: newest,
    written: () =>
      queryClient.invalidateQueries({ queryKey: ["attribute-history", slug, entityId, attribute] }),
  };
  // Fewer than a page on the newest page is the whole history: every CSV row compares.
  const complete = before === undefined && measurements.length < PAGE;
  const oldest = measurements.at(-1)?.observedAt;

  return (
    <div className="flex flex-col gap-4 text-body">
      {canEdit ? <EditCurrent target={target} current={newest} /> : null}
      {canEditHistory ? (
        <>
          <AddOldValue target={target} />
          <CsvImport target={target} measurements={measurements} complete={complete} />
        </>
      ) : null}

      <section
        aria-labelledby="history-timeline-title"
        className="rounded-lg border border-border bg-surface p-4"
      >
        <div className="flex items-center justify-between gap-2 pb-3">
          <h3 id="history-timeline-title" className="font-semibold text-fg">
            {t("attributeHistory.timeline")}
          </h3>
          <div className="flex gap-2">
            {before ? (
              <Button size="sm" variant="secondary" onClick={() => setBefore(undefined)}>
                {t("attributeHistory.newest")}
              </Button>
            ) : null}
            {oldest ? (
              <Button size="sm" variant="secondary" onClick={() => setBefore(oldest)}>
                {t("attributeHistory.older")}
              </Button>
            ) : null}
          </div>
        </div>
        {history.isPending ? (
          <div role="status" aria-busy="true" aria-label={t("app.loading")}>
            <Skeleton className="h-32 w-full" />
          </div>
        ) : null}
        {/* An unreadable history is not an empty one: it says so and offers a retry. */}
        {history.isError ? (
          <InlineError className="flex flex-wrap items-center gap-2">
            {history.error instanceof Error ? history.error.message : t("app.error.generic")}
            <Button size="sm" variant="ghost" onClick={() => void history.refetch()}>
              {t("app.error.retry")}
            </Button>
          </InlineError>
        ) : null}
        {history.isSuccess && measurements.length === 0 ? (
          <p role="status" className="text-caption text-fg-muted">
            {t("attributeHistory.noHistory")}
          </p>
        ) : null}
        {history.data && !history.data.versions ? (
          <p className="mb-2 text-caption text-fg-muted">{t("attributeHistory.versionsRestricted")}</p>
        ) : null}
        {measurements.length > 0 ? (
          <Timeline
            measurements={measurements}
            canEditHistory={canEditHistory}
            open={(measurement, revertTo) => setEditing({ measurement, revertTo })}
          />
        ) : null}
      </section>

      {editing ? (
        <VersionDialog
          key={`${editing.measurement.observedAt}-${editing.revertTo?.instanceId ?? "correct"}`}
          target={target}
          measurement={editing.measurement}
          revertTo={editing.revertTo}
          close={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
