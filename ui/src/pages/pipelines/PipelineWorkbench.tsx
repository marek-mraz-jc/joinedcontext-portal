import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { callOperation } from "../../api/operations";
import { asManifests, refName } from "../../api/manifest";
import type { Manifest } from "../../api/manifest";
import { api, queryKeys, unwrap } from "../../api/client";
import { useModelSource } from "../../components/entities/filters";
import { FormHeading } from "../../components/forms/FormRoute";
import {
  Alert,
  Badge,
  Field,
  FilePicker,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Textarea,
} from "../../components/ui";
import { classSlots, parseModel } from "../models/linkml";
import type { LinkmlModel, LinkmlSlot } from "../models/linkml";
import { entityTypesOf, spaceOf } from "../spaces/SpaceInside";
import type { PipelineForm } from "./PipelineEditor";
import { sampleUrlOf } from "./PipelineStudio";
import { MAX_SAMPLE_BYTES, draftFromSample, formatOf } from "./PipelineTest";
import type { SampleFormat } from "./PipelineTest";

/** How long the mapping rests before the workbench tries it again: one pause in typing. */
export const QUIET_MS = 600;
/** The most enum values a slot's hint lists before it says how many more. */
const ENUM_SHOWN = 8;

type Sample = { text: string; format: SampleFormat } | { url: string; format: SampleFormat };
type Source = { dataSource: string } | { sample: Sample };

interface SampleAnswer {
  records: Record<string, unknown>[];
  fields: string[];
  count: number;
  truncated: boolean;
  errors: TraceError[];
}

interface TraceError {
  stage: string;
  step?: number | null;
  line?: number | null;
  message: string;
}

interface MappingAnswer {
  records: unknown[];
  errors: TraceError[];
}

interface Problem {
  rule: string;
  path: string;
  message: string;
}

interface ValidationAnswer {
  space: string;
  model: string;
  version: string;
  valid: number;
  rejected: number;
  verdicts: { index: number; ok: boolean; problems: Problem[] }[];
}

/** The value a mapping writes most often for a slot's range, shown as its example. */
export function exampleOf(slot: Pick<LinkmlSlot, "range" | "kind">, enumFirst?: string): string {
  if (enumFirst) {
    return JSON.stringify(enumFirst);
  }
  if (slot.kind === "Relationship") {
    return '"urn:ngsi-ld:…"';
  }
  switch ((slot.range ?? "string").toLowerCase()) {
    case "integer":
      return "12";
    case "float":
    case "double":
    case "decimal":
      return "3.5";
    case "boolean":
      return "true";
    case "date":
      return '"2026-09-25"';
    case "datetime":
      return '"2026-09-25T08:00:00Z"';
    default:
      return '"…"';
  }
}

/** The class a mapping writes: the one its `root.type` names, else the model's first. */
export function classOfMapping(bloblang: string, classes: string[]): string | undefined {
  const named = /root\.type\s*=\s*"([A-Za-z][A-Za-z0-9_]*)"/.exec(bloblang)?.[1];
  return named && classes.includes(named) ? named : classes[0];
}

/** The sample the mapping is tried on, from the file the person gave or from the source. */
export function sampleFor(
  draft: PipelineForm | undefined,
  file: { text: string; format: SampleFormat } | null,
  dataSources: Manifest[],
  endpoints: Manifest[],
): Sample | undefined {
  if (file) {
    return { text: file.text, format: file.format };
  }
  const url = sampleUrlOf(draft, dataSources, endpoints);
  if (!url) {
    return undefined;
  }
  const path = url.split(/[?#]/)[0].toLowerCase();
  return { url, format: path.endsWith(".csv") ? "csv" : "json" };
}

/** What the sample step reads: a DataSource by name, the endpoint's page, or the file. */
function sourceFor(
  draft: PipelineForm | undefined,
  file: { text: string; format: SampleFormat } | null,
  sample: Sample | undefined,
): Source | undefined {
  if (file) {
    return { sample: { text: file.text, format: file.format } };
  }
  const dataSource = draft?.source?.dataSourceRef;
  if (dataSource) {
    return { dataSource };
  }
  return sample ? { sample } : undefined;
}

function useQuiet<T>(value: T, ms: number): T {
  const [quiet, setQuiet] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setQuiet(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return quiet;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const numberOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

function traceErrors(value: unknown): TraceError[] {
  return listOf(value)
    .filter(isObject)
    .map((error) => ({
      stage: textOf(error.stage),
      step: typeof error.step === "number" ? error.step : null,
      line: typeof error.line === "number" ? error.line : null,
      message: textOf(error.message),
    }));
}

/** The sample step's answer, read member by member: an answer of another shape is no sample. */
export function readSample(output: unknown): SampleAnswer {
  const answer = isObject(output) ? output : {};
  const records = listOf(answer.records).filter(isObject);
  return {
    records,
    fields: listOf(answer.fields).filter((field): field is string => typeof field === "string"),
    count: numberOf(answer.count) || records.length,
    truncated: answer.truncated === true,
    errors: traceErrors(answer.errors),
  };
}

/** The mapping step's answer, read member by member. */
export function readMapping(output: unknown): MappingAnswer {
  const answer = isObject(output) ? output : {};
  return { records: listOf(answer.records), errors: traceErrors(answer.errors) };
}

/** The validation step's answer, read member by member. */
export function readValidation(output: unknown): ValidationAnswer {
  const answer = isObject(output) ? output : {};
  const verdicts = listOf(answer.verdicts)
    .filter(isObject)
    .map((verdict) => ({
      index: numberOf(verdict.index),
      ok: verdict.ok === true,
      problems: listOf(verdict.problems)
        .filter(isObject)
        .map((problem) => ({ rule: textOf(problem.rule), path: textOf(problem.path), message: textOf(problem.message) })),
    }));
  return {
    space: textOf(answer.space),
    model: textOf(answer.model),
    version: textOf(answer.version),
    valid: numberOf(answer.valid),
    rejected: numberOf(answer.rejected),
    verdicts,
  };
}

async function run<T>(
  project: string,
  name: string,
  input: Record<string, unknown>,
  failed: string,
  read: (output: unknown) => T,
): Promise<T> {
  const answer = await callOperation(project, name, input);
  if (!answer.ok) {
    throw new Error(answer.reason ?? failed);
  }
  return read(answer.output);
}

function cell(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? "" : text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

function Step({
  number,
  id,
  title,
  hint,
  children,
}: {
  number: number;
  id: string;
  title: string;
  hint: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div>
        <FormHeading id={`${id}-title`} className="text-body font-semibold text-fg">
          <span className="mr-2 tabular-nums text-fg-subtle">{number}.</span>
          {title}
        </FormHeading>
        <p className="text-caption text-fg-muted">{hint}</p>
      </div>
      {children}
    </section>
  );
}

export interface PipelineWorkbenchProps {
  project: string;
  draft: PipelineForm | undefined;
  onChange: (form: PipelineForm) => void;
  dataSources: Manifest[];
  endpoints: Manifest[];
  /** The target endpoints a pipeline may write through, as the form offers them. */
  targets: { name: string; urn?: string }[];
  /** The manifest the form is right now, for the steps that run it (PL-43). */
  toManifest: (form: PipelineForm) => unknown;
  /** Whether the mapping in the editor wrote only valid records the last time it ran (PL-49). */
  onVerdict: (ok: boolean, bloblang: string) => void;
  /** More of the dialog under the six steps: the folded advanced editor. */
  children?: ReactNode;
}

/**
 * The pipeline workbench (ADR-N-034, PL-58): source, sample, mapping, mapped output, validation,
 * and target and save, in that order. Each step shows its output and a one-line hint, and runs
 * the operation an agent or the assistant runs for the same step (PL-63): the sample and the
 * mapping on the project's runner, the verdict against the target space's model. Nothing here is
 * written; Propose, under the steps, opens the Change.
 */
export function PipelineWorkbench({
  project,
  draft,
  onChange,
  dataSources,
  endpoints,
  targets,
  toManifest,
  onVerdict,
  children,
}: PipelineWorkbenchProps): JSX.Element {
  const { t } = useTranslation();
  const [file, setFile] = useState<{ name: string; text: string; format: SampleFormat } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const spaces = useQuery({
    queryKey: queryKeys.list(project, "spaces"),
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project, plural: "spaces" } },
        }),
      ),
  });
  const models = useQuery({
    queryKey: queryKeys.list(project, "datamodels"),
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project, plural: "datamodels" } },
        }),
      ),
  });
  const spaceList = useMemo(() => asManifests(spaces.data?.items ?? []), [spaces.data]);
  const modelList = useMemo(() => asManifests(models.data?.items ?? []), [models.data]);

  /** The model the space of an endpoint names (DM-61), by the endpoint's name. */
  const modelOfEndpoint = (name: string | undefined): Manifest | undefined => {
    const endpoint = endpoints.find((candidate) => candidate.metadata.name === name);
    const space = endpoint ? spaceList.find((s) => s.metadata.name === spaceOf(endpoint)) : undefined;
    const model = refName(space?.spec.dataModelRef);
    return model ? modelList.find((m) => m.metadata.name === model) : undefined;
  };

  // Step 1: where the records come from.
  const sourceValue = draft?.source?.dataSourceRef
    ? `datasource:${draft.source.dataSourceRef}`
    : draft?.source?.endpointRef
      ? `endpoint:${draft.source.endpointRef}`
      : "";
  const pickSource = (value: string) => {
    const [kind, ...rest] = value.split(":");
    const name = rest.join(":");
    const source =
      kind === "datasource" ? { dataSourceRef: name } : kind === "endpoint" ? { endpointRef: name } : undefined;
    onChange({ ...(draft ?? {}), source });
  };
  const readModel = modelOfEndpoint(draft?.source?.endpointRef);
  const readTypes = readModel ? entityTypesOf(readModel) : [];
  const queried = draft?.source?.query?.type;
  const readType = typeof queried === "string" && queried !== "" ? queried : undefined;
  const pickReadType = (type: string) =>
    onChange({
      ...(draft ?? {}),
      source: { ...(draft?.source ?? {}), query: { ...(draft?.source?.query ?? {}), type: type || undefined } },
    });

  const takeFile = async (picked: File) => {
    setFileError(null);
    if (picked.size > MAX_SAMPLE_BYTES) {
      setFileError(t("pipelines.test.tooLarge"));
      return;
    }
    const text = await picked.text();
    const format = formatOf(picked.name, text);
    setFile({ name: picked.name, text, format });
    // An empty mapping is drafted from the file, so the first try runs before anything is typed (PL-44).
    const target = targets.find((candidate) => candidate.urn === draft?.targetEndpoint);
    const space = target?.urn?.split(":")[4] ?? "";
    if (!draft?.compute?.bloblang?.trim()) {
      const drafted = draftFromSample(picked.name, text, space);
      if (drafted) {
        onChange({ ...(draft ?? {}), compute: { kind: "bloblang", bloblang: drafted.bloblang } });
      }
    }
  };

  // Step 2: the sample.
  const sample = sampleFor(draft, file, dataSources, endpoints);
  const source = sourceFor(draft, file, sample);
  const sampled = useQuery({
    queryKey: ["pipeline-workbench", project, "sample", source],
    enabled: source !== undefined,
    retry: false,
    queryFn: () =>
      run(project, "jc_pipeline_sample_source", source ?? {}, t("pipelines.workbench.failed"), readSample),
  });

  // Steps 3 and 4: the mapping, tried once typing rests.
  const bloblang = draft?.compute?.kind === "bloblang" || draft?.compute?.kind === undefined ? (draft?.compute?.bloblang ?? "") : "";
  const quiet = useQuiet(bloblang, QUIET_MS);
  // The manifest carries the rested mapping, not every keystroke: a query key is compared by
  // value, so a draft that changed nowhere else asks the runner nothing new.
  const manifest = useMemo(
    () => (draft ? toManifest({ ...draft, compute: { ...(draft.compute ?? {}), kind: "bloblang", bloblang: quiet } }) : undefined),
    [draft, quiet, toManifest],
  );
  const tried = useQuery({
    queryKey: ["pipeline-workbench", project, "mapping", manifest, sample],
    enabled: quiet.trim() !== "" && sample !== undefined && manifest !== undefined,
    retry: false,
    queryFn: () =>
      run(project, "jc_pipeline_try_mapping", { pipeline: manifest, sample }, t("pipelines.workbench.failed"), readMapping),
  });
  const records = (tried.data?.records ?? []).filter(
    (record): record is Record<string, unknown> => typeof record === "object" && record !== null && !Array.isArray(record),
  );

  // Step 5: the verdicts against the target space's model.
  const validated = useQuery({
    queryKey: ["pipeline-workbench", project, "validate", manifest, records],
    enabled: records.length > 0 && Boolean(draft?.targetEndpoint),
    retry: false,
    queryFn: () =>
      run(
        project,
        "jc_pipeline_validate",
        { pipeline: manifest, records: records.slice(0, 100) },
        t("pipelines.workbench.failed"),
        readValidation,
      ),
  });
  const verdictOf = (index: number) => validated.data?.verdicts.find((verdict) => verdict.index === index);

  const settled = tried.isSuccess && validated.isSuccess && quiet === bloblang;
  const ok =
    settled && tried.data?.errors.length === 0 && records.length > 0 && validated.data?.rejected === 0;
  // The verdict belongs to the mapping it ran on; a new callback from the dialog is no new verdict.
  const report = useRef(onVerdict);
  useEffect(() => {
    report.current = onVerdict;
  }, [onVerdict]);
  useEffect(() => {
    if (settled) {
      report.current(ok, quiet);
    }
  }, [settled, ok, quiet]);

  // Step 3's hints: the slots of the class the mapping writes, from the target space's model.
  const targetName = targets.find((candidate) => candidate.urn === draft?.targetEndpoint)?.name;
  const targetEndpoint = endpoints.find((candidate) => candidate.metadata.name === targetName);
  const targetSpace = targetEndpoint ? spaceOf(targetEndpoint) : undefined;
  const targetModel = modelOfEndpoint(targetName);
  const modelText = useModelSource(project, targetModel);
  const parsed = useMemo<LinkmlModel | undefined>(() => {
    if (!modelText) {
      return undefined;
    }
    try {
      return parseModel(modelText);
    } catch {
      return undefined;
    }
  }, [modelText]);
  const classNames = parsed?.classes.map((c) => c.name) ?? [];
  const writtenClass = classOfMapping(bloblang, classNames);
  const klass = parsed?.classes.find((c) => c.name === writtenClass);
  const slots = parsed && klass ? classSlots(parsed, klass).filter((slot) => !["id", "type"].includes(slot.name)) : [];

  const failedText = (error: unknown) => (error instanceof Error ? error.message : t("pipelines.workbench.failed"));

  return (
    <div className="flex flex-col gap-3" data-testid="pipeline-workbench">
      <Step number={1} id="workbench-source" title={t("pipelines.workbench.source.title")} hint={t("pipelines.workbench.source.hint")}>
        <Field id="workbench-source-pick" label={t("pipelines.workbench.source.pick")}>
          <Select id="workbench-source-pick" value={sourceValue} onChange={(event) => pickSource(event.target.value)}>
            <option value="">{t("pipelines.workbench.source.none")}</option>
            {dataSources.length > 0 ? (
              <optgroup label={t("nav.datasources")}>
                {dataSources.map((candidate) => (
                  <option key={candidate.metadata.name} value={`datasource:${candidate.metadata.name}`}>
                    {candidate.metadata.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {endpoints.length > 0 ? (
              <optgroup label={t("nav.endpoints")}>
                {endpoints.map((candidate) => (
                  <option key={candidate.metadata.name} value={`endpoint:${candidate.metadata.name}`}>
                    {candidate.metadata.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </Select>
        </Field>
        {draft?.source?.endpointRef ? (
          <Field id="workbench-read-type" label={t("pipelines.workbench.source.type")}>
            <Select id="workbench-read-type" value={readType ?? ""} onChange={(event) => pickReadType(event.target.value)}>
              <option value="">{t("pipelines.workbench.source.pickType")}</option>
              {[...new Set([...readTypes, ...(readType ? [readType] : [])])].map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <FilePicker
            label={t("pipelines.workbench.source.file")}
            accept=".csv,.json,.txt,text/csv,application/json,text/plain"
            onFile={(picked) => void takeFile(picked)}
            className="text-body"
          >
            <span className="rounded-md border border-dashed border-border px-3 py-2">
              {file ? t("pipelines.workbench.source.fileTaken", { name: file.name }) : t("pipelines.workbench.source.fileDrop")}
            </span>
          </FilePicker>
        </div>
        {fileError ? (
          <Alert role="alert" tone="danger">
            {fileError}
          </Alert>
        ) : null}
      </Step>

      <Step number={2} id="workbench-sample" title={t("pipelines.workbench.sample.title")} hint={t("pipelines.workbench.sample.hint")}>
        {source === undefined ? (
          <p className="text-caption text-fg-subtle">{t("pipelines.workbench.sample.waiting")}</p>
        ) : sampled.isPending ? (
          <p role="status" className="text-caption text-fg-subtle">
            {t("pipelines.workbench.running")}
          </p>
        ) : sampled.isError ? (
          <Alert role="alert" tone="danger">
            {failedText(sampled.error)}
          </Alert>
        ) : sampled.data.errors.length > 0 ? (
          <Alert role="alert" tone="danger">
            {sampled.data.errors[0].message}
          </Alert>
        ) : sampled.data.count === 0 ? (
          <p className="text-caption text-fg-subtle">{t("pipelines.workbench.sample.empty")}</p>
        ) : (
          <>
            <p className="text-caption text-fg-subtle">
              {t(sampled.data.truncated ? "pipelines.workbench.sample.countFirst" : "pipelines.workbench.sample.count", {
                count: sampled.data.count,
                fields: sampled.data.fields.length,
              })}
            </p>
            <Table caption={t("pipelines.workbench.sample.caption")} maxHeight="max-h-64">
              <TableHead>
                {sampled.data.fields.map((field) => (
                  <TableHeaderCell key={field}>
                    <span className="font-mono">{field}</span>
                  </TableHeaderCell>
                ))}
              </TableHead>
              <TableBody>
                {sampled.data.records.map((record, index) => (
                  <TableRow key={index}>
                    {sampled.data.fields.map((field) => (
                      <TableCell key={field}>
                        <span className="font-mono text-caption">{cell(record[field])}</span>
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Step>

      <Step number={3} id="workbench-mapping" title={t("pipelines.workbench.mapping.title")} hint={t("pipelines.workbench.mapping.hint")}>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Field id="workbench-bloblang" label={t("pipelines.field.bloblang")}>
            <Textarea
              id="workbench-bloblang"
              rows={14}
              spellCheck={false}
              className="font-mono"
              value={bloblang}
              onChange={(event) =>
                onChange({ ...(draft ?? {}), compute: { ...(draft?.compute ?? {}), kind: "bloblang", bloblang: event.target.value } })
              }
            />
          </Field>
          <div aria-labelledby="workbench-slots-title" role="region" className="flex flex-col gap-2">
            <FormHeading sub id="workbench-slots-title" className="text-caption font-semibold text-fg">
              {writtenClass
                ? t("pipelines.workbench.mapping.slotsOf", { type: writtenClass })
                : t("pipelines.workbench.mapping.slots")}
            </FormHeading>
            {slots.length === 0 ? (
              <p className="text-caption text-fg-subtle">
                {draft?.targetEndpoint ? t("pipelines.workbench.mapping.noModel") : t("pipelines.workbench.mapping.pickTarget")}
              </p>
            ) : (
              <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                {slots.map((slot) => {
                  const values = parsed?.enums.find((e) => e.name === slot.range)?.permissible_values.map((v) => v.name) ?? [];
                  return (
                    <li key={slot.name} className="rounded border border-border p-2 text-caption">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono font-medium text-fg">{slot.name}</span>
                        <Badge mono>{values.length > 0 ? "enum" : (slot.range ?? "string")}</Badge>
                        {slot.kind !== "Property" ? <Badge>{slot.kind}</Badge> : null}
                        {slot.required ? <Badge tone="warning">{t("pipelines.workbench.mapping.required")}</Badge> : null}
                        {slot.multivalued ? <Badge>{t("pipelines.workbench.mapping.many")}</Badge> : null}
                      </div>
                      {slot.description ? <p className="text-fg-muted">{slot.description}</p> : null}
                      {values.length > 0 ? (
                        <p className="text-fg-muted">
                          {t("pipelines.workbench.mapping.values", {
                            values: values.slice(0, ENUM_SHOWN).join(", "),
                            count: Math.max(values.length - ENUM_SHOWN, 0),
                          })}
                        </p>
                      ) : null}
                      <p className="font-mono text-fg-subtle">
                        {t("pipelines.workbench.mapping.example", {
                          example: `root.${slot.name} = { "type": "${slot.kind}", "${slot.kind === "Relationship" ? "object" : "value"}": ${exampleOf(slot, values[0])} }`,
                        })}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </Step>

      <Step number={4} id="workbench-output" title={t("pipelines.workbench.output.title")} hint={t("pipelines.workbench.output.hint")}>
        {!tried.isFetched && !tried.isFetching ? (
          <p className="text-caption text-fg-subtle">{t("pipelines.workbench.output.waiting")}</p>
        ) : tried.isFetching ? (
          <p role="status" className="text-caption text-fg-subtle">
            {t("pipelines.workbench.running")}
          </p>
        ) : tried.isError ? (
          <Alert role="alert" tone="danger">
            {failedText(tried.error)}
          </Alert>
        ) : (
          <>
            {(tried.data?.errors ?? []).map((error, index) => (
              <Alert key={index} role="alert" tone="danger">
                {[
                  error.step != null ? t("pipelines.rejected.step", { step: error.step + 1 }) : null,
                  error.line != null ? t("pipelines.workbench.output.line", { line: error.line }) : null,
                  error.message,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Alert>
            ))}
            <p className="text-caption text-fg-subtle">{t("pipelines.workbench.output.count", { count: records.length })}</p>
            {records.length > 0 ? (
              <Table caption={t("pipelines.workbench.output.caption")} maxHeight="max-h-80">
                <TableHead>
                  <TableHeaderCell>{t("pipelines.workbench.output.record")}</TableHeaderCell>
                  <TableHeaderCell>{t("pipelines.workbench.output.written")}</TableHeaderCell>
                  <TableHeaderCell>{t("pipelines.workbench.output.problems")}</TableHeaderCell>
                </TableHead>
                <TableBody>
                  {records.map((record, index) => {
                    const verdict = verdictOf(index);
                    return (
                      <TableRow key={index}>
                        <TableCell>
                          <span className="tabular-nums">{index + 1}</span>
                        </TableCell>
                        <TableCell>
                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-caption">
                            {JSON.stringify(record, null, 2)}
                          </pre>
                        </TableCell>
                        <TableCell>
                          {verdict === undefined ? null : verdict.ok ? (
                            <Badge tone="success">{t("pipelines.workbench.validation.valid")}</Badge>
                          ) : (
                            <ul className="flex flex-col gap-1">
                              {verdict.problems.map((problem, at) => (
                                <li key={at} className="text-caption">
                                  <Badge mono tone="danger">
                                    {problem.rule}
                                  </Badge>{" "}
                                  {problem.path ? <span className="font-mono">{problem.path}</span> : null}{" "}
                                  <span className="text-fg-muted">{problem.message}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : null}
          </>
        )}
      </Step>

      <Step number={5} id="workbench-validation" title={t("pipelines.workbench.validation.title")} hint={t("pipelines.workbench.validation.hint")}>
        {!draft?.targetEndpoint ? (
          <p className="text-caption text-fg-subtle">{t("pipelines.workbench.mapping.pickTarget")}</p>
        ) : records.length === 0 ? (
          <p className="text-caption text-fg-subtle">{t("pipelines.workbench.validation.waiting")}</p>
        ) : validated.isFetching ? (
          <p role="status" className="text-caption text-fg-subtle">
            {t("pipelines.workbench.running")}
          </p>
        ) : validated.isError ? (
          <Alert role="alert" tone="danger">
            {failedText(validated.error)}
          </Alert>
        ) : validated.data ? (
          <Alert role="status" tone={validated.data.rejected === 0 ? "success" : "warning"}>
            {validated.data.rejected === 0
              ? t("pipelines.workbench.validation.allValid", { count: validated.data.valid, model: validated.data.model, version: validated.data.version })
              : t("pipelines.workbench.validation.someRejected", {
                  count: validated.data.rejected,
                  valid: validated.data.valid,
                  model: validated.data.model,
                  version: validated.data.version,
                })}
          </Alert>
        ) : null}
      </Step>

      <Step number={6} id="workbench-target" title={t("pipelines.workbench.target.title")} hint={t("pipelines.workbench.target.hint")}>
        <Field id="workbench-target-pick" label={t("pipelines.field.targetEndpoint")} description={t("pipelines.field.targetEndpointHint")}>
          <Select
            id="workbench-target-pick"
            value={draft?.targetEndpoint ?? ""}
            onChange={(event) => onChange({ ...(draft ?? {}), targetEndpoint: event.target.value || undefined })}
          >
            <option value="">{t("form.choose")}</option>
            {targets
              .filter((candidate) => candidate.urn)
              .map((candidate) => (
                <option key={candidate.urn} value={candidate.urn}>
                  {candidate.name}
                </option>
              ))}
          </Select>
        </Field>
        {targetSpace ? (
          <p className="text-caption text-fg-muted">
            {targetModel
              ? t("pipelines.workbench.target.lands", { space: targetSpace, model: targetModel.metadata.name })
              : t("pipelines.workbench.target.landsUnmodelled", { space: targetSpace })}
          </p>
        ) : null}
        <p className="text-caption text-fg-subtle">{t("pipelines.workbench.target.save")}</p>
      </Step>

      {children}
    </div>
  );
}
