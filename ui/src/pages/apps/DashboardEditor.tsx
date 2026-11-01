import type { JSX } from "react";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, unwrap } from "../../api/client";
import type { components } from "../../api/schema";
import { Alert, Button, Card, EmptyState, Field, Input, Select, Skeleton } from "../../components/ui";
import { ChangeFollowCard } from "./ChangeFollowCard";
import {
  AGGS,
  errorsByPath,
  lineDiff,
  OPS,
  readableNames,
  replaced,
  TONES,
  typedValue,
  type Agg,
  type Band,
  type Column,
  type DashboardFile,
  type Filter,
  type Kpi,
  type Op,
  type Tone,
} from "./dashboardForm";

type AppDashboard = components["schemas"]["AppDashboard"];
type Proposal = components["schemas"]["DashboardProposal"];
type Errors = Map<string, string[]>;

export interface SectionProps {
  file: DashboardFile;
  onChange: (file: DashboardFile) => void;
  /** The attributes of the App's type the person may read, as the server listed them. */
  attributes: string[];
  errors: Errors;
}

const at = (errors: Errors, path: string) => errors.get(path);

/** A dropdown of the attributes the server offered; nothing else can be picked (T-6402). */
export function AttrSelect({
  id,
  value,
  names,
  onChange,
  optional,
  ...wired
}: {
  id: string;
  value: string | undefined;
  names: string[];
  onChange: (value: string) => void;
  optional?: boolean;
  /** What `Field` hangs on its control: the hint, the error and the invalid mark. */
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <Select {...wired} id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled={!optional}>
        {optional ? t("apps.dashboard.none") : t("apps.dashboard.choose")}
      </option>
      {names.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </Select>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }): JSX.Element {
  const { t } = useTranslation();
  return (
    <Button size="sm" variant="ghost" aria-label={t("apps.dashboard.remove", { what: label })} onClick={onClick}>
      {t("apps.dashboard.removeShort")}
    </Button>
  );
}

/** The grid's columns: an attribute each, or a computed one from a formula (T-6384). */
export function ColumnsSection({ file, onChange, attributes, errors }: SectionProps): JSX.Element {
  const { t } = useTranslation();
  const columns = file.grid.columns ?? [];
  const set = (i: number, next: Column | null) => onChange({ ...file, grid: { ...file.grid, columns: replaced(columns, i, next) } });
  return (
    <fieldset className="space-y-3">
      <legend className="font-medium">{t("apps.dashboard.columns")}</legend>
      {columns.length === 0 ? <p className="text-fg-muted">{t("apps.dashboard.columnsEmpty")}</p> : null}
      {columns.map((column, i) => {
        const base = `/grid/columns/${i}`;
        const computed = column.formula !== undefined;
        return (
          <div key={i} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
            {computed ? (
              <Field id={`col-${i}-name`} label={t("apps.dashboard.computedName")} help={t("apps.dashboard.computedNameHint")} errors={at(errors, `${base}/attr`)}>
                <Input id={`col-${i}-name`} value={column.attr} onChange={(e) => set(i, { ...column, attr: e.target.value })} />
              </Field>
            ) : (
              <Field id={`col-${i}-attr`} label={t("apps.dashboard.attribute")} help={t("apps.dashboard.attributeHint")} errors={at(errors, `${base}/attr`)}>
                <AttrSelect id={`col-${i}-attr`} value={column.attr} names={attributes} onChange={(attr) => set(i, { ...column, attr })} />
              </Field>
            )}
            <Field id={`col-${i}-label`} label={t("apps.dashboard.label")} help={t("apps.dashboard.labelHint")} errors={at(errors, `${base}/label`)}>
              <Input id={`col-${i}-label`} value={column.label ?? ""} onChange={(e) => set(i, { ...column, label: e.target.value || undefined })} />
            </Field>
            <RemoveButton label={column.label || column.attr} onClick={() => set(i, null)} />
            {computed ? (
              <Field id={`col-${i}-formula`} className="sm:col-span-3" label={t("apps.dashboard.formula")} help={t("apps.dashboard.formulaHint")} errors={at(errors, `${base}/formula`)}>
                <Input id={`col-${i}-formula`} value={column.formula} spellCheck={false} onChange={(e) => set(i, { ...column, formula: e.target.value })} />
              </Field>
            ) : null}
          </div>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => set(columns.length, { attr: "" })}>
          {t("apps.dashboard.addColumn")}
        </Button>
        <Button size="sm" onClick={() => set(columns.length, { attr: "", formula: "" })}>
          {t("apps.dashboard.addComputed")}
        </Button>
      </div>
    </fieldset>
  );
}

/** The filters the App asks its Endpoint with: attribute, comparison, value. */
export function FiltersSection({ file, onChange, attributes, errors }: SectionProps): JSX.Element {
  const { t } = useTranslation();
  const filters = file.filters ?? [];
  const set = (i: number, next: Filter | null) => {
    const list = replaced(filters, i, next);
    onChange({ ...file, filters: list.length > 0 ? list : undefined });
  };
  return (
    <fieldset className="space-y-3">
      <legend className="font-medium">{t("apps.dashboard.filters")}</legend>
      {filters.length === 0 ? <p className="text-fg-muted">{t("apps.dashboard.filtersEmpty")}</p> : null}
      {filters.map((filter, i) => (
        <div key={i} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[1fr_8rem_1fr_auto] sm:items-start">
          <Field id={`filter-${i}-attr`} label={t("apps.dashboard.attribute")} help={t("apps.dashboard.filterAttrHint")} errors={at(errors, `/filters/${i}/attr`)}>
            <AttrSelect id={`filter-${i}-attr`} value={filter.attr} names={attributes} onChange={(attr) => set(i, { ...filter, attr })} />
          </Field>
          <Field id={`filter-${i}-op`} label={t("apps.dashboard.op")} help={t("apps.dashboard.opHint")} errors={at(errors, `/filters/${i}/op`)}>
            <Select id={`filter-${i}-op`} value={filter.op} onChange={(e) => set(i, { ...filter, op: e.target.value as Op })}>
              {OPS.map((op) => (
                <option key={op} value={op}>
                  {t(`apps.dashboard.ops.${OPS.indexOf(op)}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={`filter-${i}-value`} label={t("apps.dashboard.value")} help={t("apps.dashboard.valueHint")} errors={at(errors, `/filters/${i}/value`)}>
            <Input id={`filter-${i}-value`} value={String(filter.value)} onChange={(e) => set(i, { ...filter, value: typedValue(e.target.value) })} />
          </Field>
          <RemoveButton label={filter.attr} onClick={() => set(i, null)} />
        </div>
      ))}
      <Button size="sm" onClick={() => set(filters.length, { attr: "", op: "==", value: "" })}>
        {t("apps.dashboard.addFilter")}
      </Button>
    </fieldset>
  );
}

function BandRow({ band, i, onChange, errors }: { band: Band; i: number; onChange: (next: Band | null) => void; errors: Errors }): JSX.Element {
  const { t } = useTranslation();
  const base = `/colour/bands/${i}`;
  return (
    <div className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[8rem_10rem_1fr_auto] sm:items-start">
      <Field id={`band-${i}-below`} label={t("apps.dashboard.below")} help={t("apps.dashboard.belowHint")} errors={at(errors, `${base}/below`)}>
        <Input
          id={`band-${i}-below`}
          inputMode="decimal"
          value={band.below ?? ""}
          onChange={(e) => onChange({ ...band, below: e.target.value === "" ? undefined : Number(e.target.value) })}
        />
      </Field>
      <Field id={`band-${i}-tone`} label={t("apps.dashboard.tone")} help={t("apps.dashboard.toneHint")} errors={at(errors, `${base}/tone`)}>
        <Select id={`band-${i}-tone`} value={band.tone} onChange={(e) => onChange({ ...band, tone: e.target.value as Tone })}>
          {TONES.map((tone) => (
            <option key={tone} value={tone}>
              {t(`apps.dashboard.tones.${tone}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field id={`band-${i}-label`} label={t("apps.dashboard.label")} help={t("apps.dashboard.bandLabelHint")} errors={at(errors, `${base}/label`)}>
        <Input id={`band-${i}-label`} value={band.label} onChange={(e) => onChange({ ...band, label: e.target.value })} />
      </Field>
      <RemoveButton label={band.label} onClick={() => onChange(null)} />
    </div>
  );
}

/** One colour rule: an attribute and the bands its value falls in, lowest first. */
export function ColourSection({ file, onChange, attributes, errors }: SectionProps): JSX.Element {
  const { t } = useTranslation();
  const names = readableNames(attributes, file);
  const colour = file.colour;
  const setBand = (i: number, next: Band | null) => colour && onChange({ ...file, colour: { ...colour, bands: replaced(colour.bands, i, next) } });
  return (
    <fieldset className="space-y-3">
      <legend className="font-medium">{t("apps.dashboard.colour")}</legend>
      <Field id="colour-attr" label={t("apps.dashboard.colourAttr")} help={t("apps.dashboard.colourAttrHint")} errors={at(errors, "/colour/attr")}>
        <AttrSelect
          id="colour-attr"
          optional
          value={colour?.attr}
          names={names}
          onChange={(attr) =>
            onChange({ ...file, colour: attr === "" ? undefined : { attr, bands: colour?.bands ?? [{ tone: "success", label: t("apps.dashboard.defaultBand") }] } })
          }
        />
      </Field>
      {colour ? (
        <>
          {colour.bands.map((band, i) => (
            <BandRow key={i} band={band} i={i} errors={errors} onChange={(next) => setBand(i, next)} />
          ))}
          {at(errors, "/colour/bands") ? <Alert tone="danger">{at(errors, "/colour/bands")?.join(" ")}</Alert> : null}
          <Button size="sm" onClick={() => onChange({ ...file, colour: { ...colour, bands: [{ below: 0, tone: "danger", label: "" }, ...colour.bands] } })}>
            {t("apps.dashboard.addBand")}
          </Button>
        </>
      ) : null}
    </fieldset>
  );
}

/** The bar chart: one bar per value of x, its height the aggregate of y. */
export function ChartSection({ file, onChange, attributes, errors }: SectionProps): JSX.Element {
  const { t } = useTranslation();
  const names = readableNames(attributes, file);
  const chart = file.chart;
  return (
    <fieldset className="grid gap-2 sm:grid-cols-3 sm:items-start">
      <legend className="mb-2 font-medium">{t("apps.dashboard.chart")}</legend>
      <Field id="chart-x" label={t("apps.dashboard.chartX")} help={t("apps.dashboard.chartXHint")} errors={at(errors, "/chart/x")}>
        <AttrSelect id="chart-x" optional value={chart?.x} names={names} onChange={(x) => onChange({ ...file, chart: x === "" ? undefined : { agg: "sum", ...chart, x } })} />
      </Field>
      {chart ? (
        <>
          <Field id="chart-agg" label={t("apps.dashboard.agg")} help={t("apps.dashboard.aggHint")} errors={at(errors, "/chart/agg")}>
            <Select id="chart-agg" value={chart.agg} onChange={(e) => onChange({ ...file, chart: { ...chart, agg: e.target.value as Agg } })}>
              {AGGS.map((agg) => (
                <option key={agg} value={agg}>
                  {t(`apps.dashboard.aggs.${agg}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="chart-y" label={t("apps.dashboard.chartY")} help={t("apps.dashboard.chartYHint")} errors={at(errors, "/chart/y")}>
            <AttrSelect id="chart-y" optional={chart.agg === "count"} value={chart.y} names={names} onChange={(y) => onChange({ ...file, chart: { ...chart, y: y || undefined } })} />
          </Field>
        </>
      ) : null}
    </fieldset>
  );
}

function KpiRow({ kpi, i, names, onChange, errors }: { kpi: Kpi; i: number; names: string[]; onChange: (next: Kpi | null) => void; errors: Errors }): JSX.Element {
  const { t } = useTranslation();
  const base = `/kpis/${i}`;
  return (
    <div className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[1fr_9rem_1fr_auto] sm:items-start">
      <Field id={`kpi-${i}-label`} label={t("apps.dashboard.label")} help={t("apps.dashboard.kpiLabelHint")} errors={at(errors, `${base}/label`)}>
        <Input id={`kpi-${i}-label`} value={kpi.label} onChange={(e) => onChange({ ...kpi, label: e.target.value })} />
      </Field>
      <Field id={`kpi-${i}-agg`} label={t("apps.dashboard.agg")} help={t("apps.dashboard.aggHint")} errors={at(errors, `${base}/agg`)}>
        <Select id={`kpi-${i}-agg`} value={kpi.agg} onChange={(e) => onChange({ ...kpi, agg: e.target.value as Agg })}>
          {AGGS.map((agg) => (
            <option key={agg} value={agg}>
              {t(`apps.dashboard.aggs.${agg}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field id={`kpi-${i}-attr`} label={t("apps.dashboard.attribute")} help={t("apps.dashboard.kpiAttrHint")} errors={at(errors, `${base}/attr`)}>
        <AttrSelect id={`kpi-${i}-attr`} optional={kpi.agg === "count"} value={kpi.attr} names={names} onChange={(attr) => onChange({ ...kpi, attr: attr || undefined })} />
      </Field>
      <RemoveButton label={kpi.label} onClick={() => onChange(null)} />
      <Field id={`kpi-${i}-where`} className="sm:col-span-4" label={t("apps.dashboard.where")} help={t("apps.dashboard.whereHint")} errors={at(errors, `${base}/where`)}>
        <Input id={`kpi-${i}-where`} spellCheck={false} value={kpi.where ?? ""} onChange={(e) => onChange({ ...kpi, where: e.target.value || undefined })} />
      </Field>
    </div>
  );
}

/** The KPI tiles above the grid. */
export function KpisSection({ file, onChange, attributes, errors }: SectionProps): JSX.Element {
  const { t } = useTranslation();
  const names = readableNames(attributes, file);
  const kpis = file.kpis ?? [];
  const set = (i: number, next: Kpi | null) => {
    const list = replaced(kpis, i, next);
    onChange({ ...file, kpis: list.length > 0 ? list : undefined });
  };
  return (
    <fieldset className="space-y-3">
      <legend className="font-medium">{t("apps.dashboard.kpis")}</legend>
      {kpis.length === 0 ? <p className="text-fg-muted">{t("apps.dashboard.kpisEmpty")}</p> : null}
      {kpis.map((kpi, i) => (
        <KpiRow key={i} kpi={kpi} i={i} names={names} errors={errors} onChange={(next) => set(i, next)} />
      ))}
      <Button size="sm" onClick={() => set(kpis.length, { label: "", agg: "count" })}>
        {t("apps.dashboard.addKpi")}
      </Button>
    </fieldset>
  );
}

/** The file before and after, line by line: what the Change will hold. */
export function PreviewDiff({ before, after }: { before: string; after: string }): JSX.Element {
  const { t } = useTranslation();
  const lines = lineDiff(before, after).filter((line, i, all) => line.sign !== " " || all.slice(Math.max(0, i - 2), i + 3).some((l) => l.sign !== " "));
  return (
    <figure className="space-y-2">
      <figcaption className="font-medium">{t("apps.dashboard.previewTitle")}</figcaption>
      <pre className="max-h-80 overflow-auto rounded-md border border-border bg-surface-muted p-3 text-caption" tabIndex={0}>
        {lines.map((line, i) => (
          <div key={i} className={line.sign === "+" ? "text-success" : line.sign === "-" ? "text-danger" : "text-fg-muted"}>
            <span aria-label={line.sign === "+" ? t("apps.dashboard.added") : line.sign === "-" ? t("apps.dashboard.removed") : undefined}>{line.sign}</span> {line.text}
          </div>
        ))}
      </pre>
    </figure>
  );
}

function refusals(error: unknown): string[] {
  if (error instanceof ApiError) return error.problem?.errors ?? [error.message];
  return [String(error)];
}

/**
 * A dashboard App edited without code (T-6402): its columns and computed columns, filters, colour
 * rule, chart and tiles, from the App's `src/dashboard.json`. Preview shows the file before and
 * after; Propose makes it a Change of the App, which the approver reads and applies. Every
 * attribute is picked from the ones the server lists for the person, and checked again there.
 */
export function DashboardEditor({ project, name }: { project: string; name: string }): JSX.Element {
  const { t } = useTranslation();
  const loaded = useQuery({
    queryKey: ["projects", project, "apps", name, "dashboard"],
    queryFn: async (): Promise<AppDashboard> => unwrap(await api.GET("/api/v1/projects/{project}/apps/{name}/dashboard", { params: { path: { project, name } } })),
    retry: false,
  });
  // What the person changed; until then the file as the server read it.
  const [edited, setFile] = useState<DashboardFile | null>(null);
  const file = edited ?? ((loaded.data?.config ?? null) as unknown as DashboardFile | null);
  const send = useMutation({
    mutationFn: async (dryRun: boolean): Promise<Proposal> =>
      unwrap(await api.POST("/api/v1/projects/{project}/apps/{name}/dashboard", { params: { path: { project, name } }, body: { config: file ?? {}, dryRun } })),
  });
  if (loaded.isPending) return <Skeleton className="h-40" />;
  if (loaded.isError) return <Alert tone="danger">{loaded.error.message}</Alert>;
  const offer = loaded.data;
  if (!offer.edit.allowed || !file) return <EmptyState title={t("apps.dashboard.unavailable")} description={offer.edit.reason ?? t("apps.dashboard.noFile")} />;
  const attributes = offer.attributes.map((attr) => attr.name);
  const errors = send.isError ? errorsByPath(refusals(send.error)) : new Map<string, string[]>();
  const props: SectionProps = { file, attributes, errors, onChange: (next) => (send.reset(), setFile(next)) };
  const proposed = send.data?.change;
  return (
    <Card className="space-y-6">
      <p className="text-fg-muted">{t("apps.dashboard.intro", { path: offer.path, type: offer.entityType ?? "" })}</p>
      <ColumnsSection {...props} />
      <FiltersSection {...props} />
      <ColourSection {...props} />
      <ChartSection {...props} />
      <KpisSection {...props} />
      {errors.get("") ? <Alert tone="danger">{errors.get("")?.join(" ")}</Alert> : null}
      {send.isError && errors.size > 0 && !errors.get("") ? <Alert tone="danger">{t("apps.dashboard.refused", { n: [...errors.values()].flat().length })}</Alert> : null}
      {send.data && !proposed ? <PreviewDiff before={send.data.before} after={send.data.after} /> : null}
      {proposed ? (
        <ChangeFollowCard project={project} followed={{ changeId: proposed.metadata.name, kind: "App", name }} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => send.mutate(true)} loading={send.isPending && send.variables}>
            {t("apps.dashboard.preview")}
          </Button>
          <Button variant="primary" onClick={() => send.mutate(false)} loading={send.isPending && !send.variables} disabled={!send.data || send.isPending}>
            {t("apps.dashboard.propose")}
          </Button>
        </div>
      )}
      {!send.data && !proposed ? <p className="text-caption text-fg-muted">{t("apps.dashboard.previewFirst")}</p> : null}
    </Card>
  );
}
