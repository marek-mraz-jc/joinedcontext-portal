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

function formatValue(val: unknown): string {
  if (val === undefined || val === null) {
    return "";
  }
  return typeof val === "string" ? val : JSON.stringify(val);
}

function toLocalInputString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Attribute history timeline, version inspector and change forms (T-4667, DM-114).
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

  const queryKey = ["attribute-history", slug, entityId, attribute, before] as const;
  const historyQuery = useQuery({
    queryKey,
    retry: false,
    queryFn: () => readHistory(slug, entityId, attribute, { before }),
  });

  const measurements = useMemo(() => historyQuery.data?.measurements ?? [], [historyQuery.data]);
  const sample = measurements[0]?.current.value;

  // Edit current state: the field shows the current value until the person types.
  const [typedValue, setCurrentValueText] = useState<string | undefined>(undefined);
  const [currentReason, setCurrentReason] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [isSavingCurrent, setIsSavingCurrent] = useState(false);

  // The newest page holds the current value; an older page never stands in for it.
  const [newest, setNewest] = useState<unknown>(undefined);
  if (before === undefined && measurements[0] && measurements[0].current.value !== newest) {
    setNewest(measurements[0].current.value);
  }
  const currentValueText = typedValue ?? formatValue(newest);

  const parsedCurrentValue = useMemo(
    () => valueOf(currentValueText, sample),
    [currentValueText, sample],
  );
  const currentReasonValid =
    currentReason.trim().length > 0 && currentReason.trim().length <= 500;

  // Add old value state
  const [oldDateTime, setOldDateTime] = useState("");
  const [oldValueText, setOldValueText] = useState("");
  const [oldReason, setOldReason] = useState("");
  const [oldError, setOldError] = useState<string | null>(null);
  const [isSavingOld, setIsSavingOld] = useState(false);

  const parsedOldInstant = instantOf(oldDateTime);
  const parsedOldValue = useMemo(() => valueOf(oldValueText, sample), [oldValueText, sample]);
  const oldReasonValid = oldReason.trim().length > 0 && oldReason.trim().length <= 500;

  // CSV Import state
  const [importRows, setImportRows] = useState<CsvRow[]>([]);
  const [importProblems, setImportProblems] = useState<CsvProblem[]>([]);
  const [importReason, setImportReason] = useState("");
  const [importProgress, setImportProgress] = useState<{ sent: number; total: number } | null>(
    null,
  );
  const [importResult, setImportResult] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  // Fewer than a page of measurements on the newest page is the whole history: every row compares.
  const complete = before === undefined && measurements.length < 9;
  const importPlan = useMemo(
    () => planImport(importRows, measurements, complete),
    [importRows, measurements, complete],
  );
  const importCount = importPlan.added.length + importPlan.unchecked.length + importPlan.corrections.length;
  const importReasonValid =
    importReason.trim().length > 0 && importReason.trim().length <= 500;

  // Revert & Correct Dialog states
  const [reverting, setReverting] = useState<{
    measurement: Measurement;
    version: Version;
  } | null>(null);
  const [revertReason, setRevertReason] = useState("");
  const [revertError, setRevertError] = useState<string | null>(null);
  const [isReverting, setIsReverting] = useState(false);

  const [correcting, setCorrecting] = useState<Measurement | null>(null);
  const [correctValueText, setCorrectValueText] = useState("");
  const [correctReason, setCorrectReason] = useState("");
  const [correctError, setCorrectError] = useState<string | null>(null);
  const [isCorrecting, setIsCorrecting] = useState(false);

  const parsedCorrectValue = useMemo(
    () => valueOf(correctValueText, sample),
    [correctValueText, sample],
  );

  async function handleSaveCurrent() {
    if (!currentReasonValid || parsedCurrentValue === undefined) return;
    setIsSavingCurrent(true);
    setEditError(null);
    try {
      await editCurrent(slug, entityId, attribute, parsedCurrentValue, currentReason);
      setCurrentReason("");
      setCurrentValueText(undefined);
      await queryClient.invalidateQueries({
        queryKey: ["attribute-history", slug, entityId, attribute],
      });
    } catch (err) {
      setEditError(err instanceof Error ? err.message : t("app.error.generic"));
    } finally {
      setIsSavingCurrent(false);
    }
  }

  async function handleSaveOld() {
    if (!oldReasonValid || !parsedOldInstant || parsedOldValue === undefined) return;
    setIsSavingOld(true);
    setOldError(null);
    try {
      await addOldValue(slug, entityId, attribute, parsedOldValue, parsedOldInstant, oldReason);
      setOldReason("");
      setOldValueText("");
      setOldDateTime("");
      await queryClient.invalidateQueries({
        queryKey: ["attribute-history", slug, entityId, attribute],
      });
    } catch (err) {
      setOldError(err instanceof Error ? err.message : t("app.error.generic"));
    } finally {
      setIsSavingOld(false);
    }
  }

  async function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportResult(null);
    setImportError(null);
    try {
      const text = await file.text();
      const parsed = parseCsv(text, sample);
      setImportRows(parsed.rows);
      setImportProblems(parsed.problems);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : t("app.error.generic"));
    }
  }

  async function handleRunImport() {
    if (!importReasonValid || importCount === 0) {
      return;
    }
    setIsImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const res = await runImport(
        slug,
        entityId,
        attribute,
        importPlan,
        importReason,
        (p) => setImportProgress(p),
      );
      if (res.failed) {
        setImportError(
          t("attributeHistory.importFailed", {
            line: res.failed.line,
            reason: res.failed.message,
          }),
        );
      } else {
        setImportResult(t("attributeHistory.importResult", { sent: res.sent }));
        setImportRows([]);
        setImportProblems([]);
        setImportReason("");
        setImportProgress(null);
        await queryClient.invalidateQueries({
          queryKey: ["attribute-history", slug, entityId, attribute],
        });
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : t("app.error.generic"));
    } finally {
      setIsImporting(false);
    }
  }

  async function handleConfirmRevert() {
    if (!reverting || !revertReason.trim()) return;
    setIsReverting(true);
    setRevertError(null);
    try {
      await correct(
        slug,
        entityId,
        attribute,
        reverting.measurement.current.instanceId ?? "",
        reverting.version.value,
        reverting.measurement.observedAt,
        revertReason,
      );
      setReverting(null);
      setRevertReason("");
      await queryClient.invalidateQueries({
        queryKey: ["attribute-history", slug, entityId, attribute],
      });
    } catch (err) {
      setRevertError(err instanceof Error ? err.message : t("app.error.generic"));
    } finally {
      setIsReverting(false);
    }
  }

  async function handleConfirmCorrect() {
    if (!correcting || !correctReason.trim() || parsedCorrectValue === undefined) return;
    setIsCorrecting(true);
    setCorrectError(null);
    try {
      await correct(
        slug,
        entityId,
        attribute,
        correcting.current.instanceId ?? "",
        parsedCorrectValue,
        correcting.observedAt,
        correctReason,
      );
      setCorrecting(null);
      setCorrectReason("");
      setCorrectValueText("");
      await queryClient.invalidateQueries({
        queryKey: ["attribute-history", slug, entityId, attribute],
      });
    } catch (err) {
      setCorrectError(err instanceof Error ? err.message : t("app.error.generic"));
    } finally {
      setIsCorrecting(false);
    }
  }

  const oldestObservedAt = measurements[measurements.length - 1]?.observedAt;

  return (
    <div className="flex flex-col gap-4 text-body">
      {canEdit ? (
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
              errors={
                currentValueText !== "" && parsedCurrentValue === undefined
                  ? [t("attributeHistory.value")]
                  : undefined
              }
            >
              <Input
                id="history-current-val"
                value={currentValueText}
                onChange={(e) => setCurrentValueText(e.target.value)}
              />
            </Field>
            <Field
              id="history-current-reason"
              label={t("attributeHistory.reason")}
              help={t("attributeHistory.reasonHint")}
            >
              <Input
                id="history-current-reason"
                value={currentReason}
                onChange={(e) => setCurrentReason(e.target.value)}
              />
            </Field>
          </div>
          {editError ? <InlineError className="mt-2">{editError}</InlineError> : null}
          <div className="mt-3 flex justify-end">
            <Button
              variant="primary"
              size="sm"
              loading={isSavingCurrent}
              disabled={!currentReasonValid || parsedCurrentValue === undefined}
              onClick={() => void handleSaveCurrent()}
            >
              {t("attributeHistory.save")}
            </Button>
          </div>
        </section>
      ) : null}

      {canEditHistory ? (
        <>
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
                  value={oldDateTime}
                  onChange={(e) => setOldDateTime(e.target.value)}
                />
              </Field>
              <Field id="history-old-val" label={t("attributeHistory.value")}>
                <Input
                  id="history-old-val"
                  value={oldValueText}
                  onChange={(e) => setOldValueText(e.target.value)}
                />
              </Field>
              <Field
                id="history-old-reason"
                label={t("attributeHistory.reason")}
                help={t("attributeHistory.reasonHint")}
              >
                <Input
                  id="history-old-reason"
                  value={oldReason}
                  onChange={(e) => setOldReason(e.target.value)}
                />
              </Field>
            </div>
            {oldError ? <InlineError className="mt-2">{oldError}</InlineError> : null}
            <div className="mt-3 flex justify-end">
              <Button
                variant="primary"
                size="sm"
                loading={isSavingOld}
                disabled={!oldReasonValid || !parsedOldInstant || parsedOldValue === undefined}
                onClick={() => void handleSaveOld()}
              >
                {t("attributeHistory.save")}
              </Button>
            </div>
          </section>

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
                  onChange={(e) => void handleFileSelect(e)}
                />
              </Field>
              <Field
                id="history-import-reason"
                label={t("attributeHistory.reason")}
                help={t("attributeHistory.reasonHint")}
              >
                <Input
                  id="history-import-reason"
                  value={importReason}
                  onChange={(e) => setImportReason(e.target.value)}
                />
              </Field>
            </div>
            {importRows.length > 0 ? (
              <p className="mt-2 font-medium text-fg">
                {t("attributeHistory.csvPreview", {
                  added: importPlan.added.length,
                  duplicates: importPlan.duplicates.length,
                  corrections: importPlan.corrections.length,
                })}
              </p>
            ) : null}
            {importPlan.unchecked.length > 0 ? (
              <p className="mt-1 text-caption text-fg-muted">
                {t("attributeHistory.csvUnchecked", { count: importPlan.unchecked.length })}
              </p>
            ) : null}
            {importProblems.length > 0 ? (
              <ul className="mt-1 list-disc pl-5 text-caption text-danger">
                {importProblems.map((prob) => (
                  <li key={`${prob.line}-${prob.reason}`}>
                    {t("attributeHistory.csvProblems", { line: prob.line, reason: prob.reason })}
                  </li>
                ))}
              </ul>
            ) : null}
            {importProgress ? (
              <p className="mt-2 text-caption text-fg-muted">
                {t("attributeHistory.importProgress", importProgress)}
              </p>
            ) : null}
            {importResult ? (
              <p className="mt-2 text-caption text-fg font-medium">{importResult}</p>
            ) : null}
            {importError ? <InlineError className="mt-2">{importError}</InlineError> : null}
            <div className="mt-3 flex justify-end">
              <Button
                variant="primary"
                size="sm"
                loading={isImporting}
                disabled={!importReasonValid || importCount === 0}
                onClick={() => void handleRunImport()}
              >
                {t("attributeHistory.confirmImport")}
              </Button>
            </div>
          </section>
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
            {measurements.length > 0 && oldestObservedAt ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setBefore(oldestObservedAt)}
              >
                {t("attributeHistory.older")}
              </Button>
            ) : null}
          </div>
        </div>

        {historyQuery.isPending ? (
          <div role="status" aria-busy="true" aria-label={t("app.loading")}>
            <Skeleton className="h-32 w-full" />
          </div>
        ) : null}

        {historyQuery.isError ? (
          <InlineError className="flex flex-wrap items-center gap-2">
            {historyQuery.error instanceof Error
              ? historyQuery.error.message
              : t("app.error.generic")}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void historyQuery.refetch();
              }}
            >
              {t("app.error.retry")}
            </Button>
          </InlineError>
        ) : null}

        {!historyQuery.isPending && !historyQuery.isError && measurements.length === 0 ? (
          <p role="status" className="text-caption text-fg-muted">
            {t("attributeHistory.noHistory")}
          </p>
        ) : null}

        {historyQuery.data && !historyQuery.data.versions ? (
          <p className="mb-2 text-caption text-fg-muted">
            {t("attributeHistory.versionsRestricted")}
          </p>
        ) : null}

        {measurements.length > 0 ? (
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
              {measurements.flatMap((m) =>
                m.versions.map((ver, idx) => {
                  const isCurrent = ver === m.current && !ver.supersededAt;
                  return (
                    <TableRow key={`${m.observedAt}-${ver.instanceId ?? idx}`}>
                      <TableCell className="font-mono text-caption">
                        {idx === 0 ? (
                          <span>{new Date(m.observedAt).toLocaleString()}</span>
                        ) : (
                          <span className="text-fg-muted">↳</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-caption">
                        <div className="flex items-center gap-1.5">
                          <span>{formatValue(ver.value)}</span>
                          {ver.unitCode ? (
                            <span className="text-fg-muted">{ver.unitCode}</span>
                          ) : null}
                          {isCurrent ? (
                            <Badge tone="success">{t("attributeHistory.current")}</Badge>
                          ) : (
                            <Badge tone="neutral">{t("attributeHistory.superseded")}</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-caption">{ver.provenance?.channel ?? "—"}</TableCell>
                      <TableCell className="font-mono text-caption">
                        {ver.provenance?.actor ?? "—"}
                      </TableCell>
                      <TableCell className="text-caption">{ver.provenance?.operation ?? "—"}</TableCell>
                      <TableCell className="text-caption">{ver.provenance?.reason ?? "—"}</TableCell>
                      <TableCell className="text-caption">
                        {ver.provenance?.writtenAt
                          ? new Date(ver.provenance.writtenAt).toLocaleString()
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {canEditHistory && isCurrent ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              setCorrecting(m);
                              setCorrectValueText(formatValue(ver.value));
                              setCorrectReason("");
                              setCorrectError(null);
                            }}
                          >
                            {t("attributeHistory.correct")}
                          </Button>
                        ) : null}
                        {canEditHistory && !isCurrent ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              setReverting({ measurement: m, version: ver });
                              setRevertReason("");
                              setRevertError(null);
                            }}
                          >
                            {t("attributeHistory.revert")}
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                }),
              )}
            </TableBody>
          </Table>
        ) : null}
      </section>

      {/* Correct Dialog */}
      <Dialog
        open={correcting !== null}
        onOpenChange={(open) => {
          if (!open) setCorrecting(null);
        }}
        title={t("attributeHistory.correctTitle")}
        description={correcting ? new Date(correcting.observedAt).toLocaleString() : undefined}
        closeLabel={t("attributeHistory.cancel")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCorrecting(null)}>
              {t("attributeHistory.cancel")}
            </Button>
            <Button
              variant="primary"
              loading={isCorrecting}
              disabled={!correctReason.trim() || parsedCorrectValue === undefined}
              onClick={() => void handleConfirmCorrect()}
            >
              {t("attributeHistory.save")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field id="correct-modal-val" label={t("attributeHistory.value")}>
            <Input
              id="correct-modal-val"
              value={correctValueText}
              onChange={(e) => setCorrectValueText(e.target.value)}
            />
          </Field>
          <Field
            id="correct-modal-reason"
            label={t("attributeHistory.reason")}
            help={t("attributeHistory.reasonHint")}
          >
            <Input
              id="correct-modal-reason"
              value={correctReason}
              onChange={(e) => setCorrectReason(e.target.value)}
            />
          </Field>
          {correctError ? <InlineError>{correctError}</InlineError> : null}
        </div>
      </Dialog>

      {/* Revert Dialog */}
      <Dialog
        open={reverting !== null}
        onOpenChange={(open) => {
          if (!open) setReverting(null);
        }}
        title={t("attributeHistory.revertTitle")}
        description={reverting ? new Date(reverting.measurement.observedAt).toLocaleString() : undefined}
        closeLabel={t("attributeHistory.cancel")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReverting(null)}>
              {t("attributeHistory.cancel")}
            </Button>
            <Button
              variant="primary"
              loading={isReverting}
              disabled={!revertReason.trim()}
              onClick={() => void handleConfirmRevert()}
            >
              {t("attributeHistory.revert")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field
            id="revert-modal-reason"
            label={t("attributeHistory.reason")}
            help={t("attributeHistory.reasonHint")}
          >
            <Input
              id="revert-modal-reason"
              value={revertReason}
              onChange={(e) => setRevertReason(e.target.value)}
            />
          </Field>
          {revertError ? <InlineError>{revertError}</InlineError> : null}
        </div>
      </Dialog>
    </div>
  );
}
