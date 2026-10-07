/**
 * Import and export on a space's data (T-3109, ADR-N-042 §3.6). The import is a wizard: a file,
 * its columns mapped to the type's slots, the rows checked, then created in batches through the
 * gateway with the person's session; what was refused is listed and can be downloaded. The export
 * is a link to an Endpoint's file of the type, narrowed to the view's filter.
 */
import { useMemo, useState } from "react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { download } from "@joinedcontext/sdk";
import { Alert, Button, Dialog, Field, FilePicker, Select } from "../../components/ui";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "../../components/ui/Table";
import type { Manifest } from "../../api/manifest";
import {
  EXPORTS,
  ID,
  createInBatches,
  exportUrl,
  readTable,
  rejectedCsv,
  suggestMapping,
  toEntities,
} from "./importRows";
import type { ImportSlot, Mapping, Rejected, Send, Table as Rows, Target } from "./importRows";

/** How many rows the mapping step shows of the file. */
const PREVIEW = 5;

/** How many refused rows the report lists on screen; the download holds them all. */
const LISTED = 50;

type Step =
  | { kind: "file" }
  | { kind: "map"; table: Rows; mapping: Mapping; name: string }
  | { kind: "writing"; sent: number; total: number }
  | { kind: "done"; created: number; rejected: Rejected[] };

export function ImportRowsDialog({
  open,
  onOpenChange,
  target,
  slots,
  send,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: Target;
  slots: ImportSlot[];
  /** The person's own transport to the gateway, the one every edit of the page uses. */
  send: Send;
  /** Called once rows were created, so the page reads the type again. */
  onImported: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>({ kind: "file" });
  const [problem, setProblem] = useState<string | null>(null);

  const checked = useMemo(
    () => (step.kind === "map" ? toEntities(step.table, step.mapping, slots, target) : null),
    [step, slots, target],
  );

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setStep({ kind: "file" });
      setProblem(null);
    }
  };

  const choose = async (file: File) => {
    setProblem(null);
    try {
      const table = await readTable(file);
      if (table.rows.length === 0) {
        setProblem(t("spaces.import.empty"));
        return;
      }
      setStep({ kind: "map", table, mapping: suggestMapping(table.columns, slots), name: file.name });
    } catch (error) {
      setProblem(t("spaces.import.unreadable", { reason: error instanceof Error ? error.message : String(error) }));
    }
  };

  const write = async () => {
    if (step.kind !== "map" || !checked) return;
    const total = checked.entities.length;
    setStep({ kind: "writing", sent: 0, total });
    const answer = await createInBatches(send, target.space, checked.entities, (sent) =>
      setStep({ kind: "writing", sent, total }),
    );
    const rejected = [...checked.rejected, ...answer.rejected].sort((a, b) => a.row - b.row);
    setStep({ kind: "done", created: answer.created, rejected });
    if (answer.created > 0) onImported();
  };

  const footer =
    step.kind === "map" && checked ? (
      <>
        <Button variant="secondary" onClick={() => setStep({ kind: "file" })}>
          {t("spaces.import.back")}
        </Button>
        <Button onClick={() => void write()} disabled={checked.entities.length === 0}>
          {t("spaces.import.create", { count: checked.entities.length })}
        </Button>
      </>
    ) : step.kind === "done" ? (
      <Button onClick={() => close(false)}>{t("spaces.import.close")}</Button>
    ) : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      size="lg"
      title={t("spaces.import.title", { type: target.type })}
      description={t("spaces.import.lead")}
      closeLabel={t("spaces.import.close")}
      footer={footer}
    >
      {problem ? (
        <Alert role="alert" tone="danger">
          {problem}
        </Alert>
      ) : null}
      {step.kind === "file" ? (
        <FilePicker
          label={t("spaces.import.choose")}
          accept=".csv,.tsv,.txt,.xlsx,.json,.geojson,.xml"
          onFile={(file) => void choose(file)}
        >
          <span className="inline-flex items-center rounded-md border border-dashed border-border px-4 py-3 text-body">
            {t("spaces.import.choose")}
          </span>
        </FilePicker>
      ) : null}
      {step.kind === "map" && checked ? (
        <MapStep
          step={step}
          slots={slots}
          valid={checked.entities.length}
          refused={checked.rejected}
          onMapping={(mapping) => setStep({ ...step, mapping })}
        />
      ) : null}
      {step.kind === "writing" ? (
        <p role="status" className="text-body">
          {t("spaces.import.writing", { sent: step.sent, total: step.total })}
        </p>
      ) : null}
      {step.kind === "done" ? <Report created={step.created} rejected={step.rejected} type={target.type} /> : null}
    </Dialog>
  );
}

function MapStep({
  step,
  slots,
  valid,
  refused,
  onMapping,
}: {
  step: { table: Rows; mapping: Mapping; name: string };
  slots: ImportSlot[];
  valid: number;
  refused: Rejected[];
  onMapping: (mapping: Mapping) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { table, mapping } = step;
  const used = new Set(Object.values(mapping).filter(Boolean));
  const missing = slots.filter((slot) => slot.required && !used.has(slot.name)).map((slot) => slot.name);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-body text-fg-muted">
        {t("spaces.import.read", { name: step.name, rows: table.rows.length, columns: table.columns.length })}
      </p>
      <Table caption={t("spaces.import.mapping")} maxHeight="max-h-80">
        <TableHead>
          <TableRow>
            <TableHeaderCell>{t("spaces.import.column")}</TableHeaderCell>
            <TableHeaderCell>{t("spaces.import.field")}</TableHeaderCell>
            <TableHeaderCell>{t("spaces.import.sample")}</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {table.columns.map((column, at) => {
            const id = `import-map-${at}`;
            return (
              <TableRow key={column}>
                <TableCell>
                  <label htmlFor={id} className="font-mono">
                    {column}
                  </label>
                </TableCell>
                <TableCell>
                  <Select
                    id={id}
                    value={mapping[column] ?? ""}
                    onChange={(event) => onMapping({ ...mapping, [column]: event.target.value })}
                  >
                    <option value="">{t("spaces.import.skip")}</option>
                    <option value={ID} disabled={used.has(ID) && mapping[column] !== ID}>
                      {t("spaces.import.id")}
                    </option>
                    {slots.map((slot) => (
                      <option key={slot.name} value={slot.name} disabled={used.has(slot.name) && mapping[column] !== slot.name}>
                        {slot.required ? t("spaces.import.required", { name: slot.name }) : slot.name}
                      </option>
                    ))}
                  </Select>
                </TableCell>
                <TableCell className="max-w-[16rem] truncate text-fg-muted">
                  {table.rows
                    .slice(0, PREVIEW)
                    .map((row) => row[column])
                    .filter(Boolean)
                    .join(" · ")}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {missing.length > 0 ? (
        <Alert tone="warning">{t("spaces.import.missing", { names: missing.join(", ") })}</Alert>
      ) : null}
      <p role="status" className="text-body">
        {t("spaces.import.checked", { valid, refused: refused.length })}
      </p>
      {refused.length > 0 ? <RefusedList rejected={refused} /> : null}
    </div>
  );
}

function RefusedList({ rejected }: { rejected: Rejected[] }): JSX.Element {
  const { t } = useTranslation();
  return (
    <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto text-body" aria-label={t("spaces.import.refusedList")}>
      {rejected.slice(0, LISTED).map((item, at) => (
        <li key={`${item.row}-${at}`}>
          <span className="font-medium">{t("spaces.import.row", { row: item.row })}</span> {item.reason}
        </li>
      ))}
      {rejected.length > LISTED ? <li className="text-fg-muted">{t("spaces.import.more", { count: rejected.length - LISTED })}</li> : null}
    </ul>
  );
}

function Report({ created, rejected, type }: { created: number; rejected: Rejected[]; type: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <Alert role="status" tone={rejected.length === 0 ? "success" : created > 0 ? "warning" : "danger"}>
        {t("spaces.import.done", { created, refused: rejected.length })}
      </Alert>
      {rejected.length > 0 ? (
        <>
          <RefusedList rejected={rejected} />
          <Button
            variant="secondary"
            className="w-fit"
            onClick={() => download(new Blob([rejectedCsv(rejected)], { type: "text/csv" }), `${type}-refused.csv`)}
          >
            {t("spaces.import.downloadRefused")}
          </Button>
        </>
      ) : null}
    </div>
  );
}

/**
 * The type's rows as a file, from one of the space's Endpoints that serves it: CSV, Excel or
 * JSON, narrowed to the view's filter and the type's fields. Read by the gateway with the
 * person's own session, so the file holds what this person may read and no more.
 */
export function ExportLinks({
  endpoints,
  type,
  q,
  attrs,
}: {
  endpoints: Manifest[];
  type: string;
  q: string | undefined;
  attrs: string[];
}): JSX.Element | null {
  const { t } = useTranslation();
  const offering = endpoints
    .map((endpoint) => {
      const spec = (endpoint.spec ?? {}) as { slug?: string; enabledRepresentations?: string[] };
      const formats = EXPORTS.filter((format) => (spec.enabledRepresentations ?? []).includes(format));
      return { name: endpoint.metadata.name, slug: spec.slug ?? "", formats };
    })
    .filter((endpoint) => endpoint.slug && endpoint.formats.length > 0);
  const [chosen, setChosen] = useState("");
  const endpoint = offering.find((e) => e.name === chosen) ?? offering[0];
  if (!endpoint) {
    return <p className="text-body text-fg-muted">{t("spaces.export.none")}</p>;
  }
  return (
    <div className="flex flex-wrap items-end gap-2">
      {offering.length > 1 ? (
        <Field id="space-export-endpoint" label={t("spaces.export.endpoint")} className="w-fit">
          <Select id="space-export-endpoint" value={endpoint.name} onChange={(event) => setChosen(event.target.value)}>
            {offering.map((each) => (
              <option key={each.name} value={each.name}>
                {each.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <span className="text-body text-fg-muted">{t("spaces.export.label")}</span>
      {endpoint.formats.map((format) => (
        <a
          key={format}
          className="focus-ring rounded-md border border-border px-3 py-1.5 text-body hover:bg-surface-muted"
          href={exportUrl(endpoint.slug, format, type, q, attrs)}
          download
        >
          {t(`spaces.export.format.${format}`)}
        </a>
      ))}
    </div>
  );
}
