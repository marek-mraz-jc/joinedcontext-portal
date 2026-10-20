/**
 * "When do entities go away?" in the output mapper (T-4822, PL-64, PL-65, TS 104 175 4.22): never,
 * at a time the source gives (the step writes each entity's `expiresAt`), or once the source
 * stops sending one for a while (the pipeline's `spec.expiry` sweep). One choice, so a person
 * never writes Bloblang for the bus recipe and never sets both by accident.
 */
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { RecordLink } from "../../components/RecordLink";
import { RetentionGuide } from "../../components/RetentionGuide";
import { Field, Input, RadioGroup, Select } from "../../components/ui";
import { fromIso, toIso, UNITS } from "../spaces/retention";
import type { Unit } from "../spaces/retention";
import type { Expires } from "./outputMapper";

/** The pipeline's stale-entity sweep as the manifest holds it (PL-64). */
export interface Expiry {
  after?: string;
  types?: string[];
}

export type ExpiryMode = "never" | "source" | "stale";

/** The mode a step and a manifest are in: an own `expiresAt` first, then the sweep. */
export function modeOf(expires: Expires | undefined, expiry: Expiry | undefined): ExpiryMode {
  if (expires) return "source";
  return expiry?.after || expiry?.types?.length ? "stale" : "never";
}

/** The field a time most likely comes from: `observedAt`, then a name with time or date in it. */
export function timeFieldOf(fields: string[]): string | undefined {
  return fields.find((field) => field === "observedAt") ?? fields.find((field) => /time|date|observed|timestamp/i.test(field));
}

/** `after` of the sweep as amount and unit; the manifest writes whole hours or days (PL-64). */
function afterOf(after: string | undefined): { amount: string; unit: "h" | "d" } {
  const match = /^([1-9][0-9]*)([hd])$/.exec(after ?? "");
  return match ? { amount: match[1], unit: match[2] as "h" | "d" } : { amount: after ?? "", unit: "d" };
}

export interface ExpiryChoiceProps {
  project: string;
  space: string;
  type: string;
  fields: string[];
  expires: Expires | undefined;
  expiry: Expiry | undefined;
  /** A problem with the time field the sample shows, in words. */
  problem?: string;
  /** Changes the mode: the step's `expiresAt` and the manifest's sweep together, never one alone. */
  onMode: (expires: Expires | undefined, expiry: Expiry | undefined) => void;
  onExpires: (expires: Expires) => void;
  /** Absent where the form holds no `spec.expiry`: the sweep is then not offered. */
  onExpiry?: (expiry: Expiry) => void;
}

export function ExpiryChoice({ project, space, type, fields, expires, expiry, problem, onMode, onExpires, onExpiry }: ExpiryChoiceProps): JSX.Element {
  const { t } = useTranslation();
  const mode = modeOf(expires, expiry);
  const plus = expires?.plus === undefined ? undefined : fromIso(expires.plus);
  const after = afterOf(expiry?.after);
  const setPlus = (amount: string, unit: Unit) =>
    onExpires({ ...expires, plus: amount === "" || amount === "0" ? undefined : (toIso({ amount: Number(amount), unit }) ?? expires?.plus) });
  const choose = (next: ExpiryMode) => {
    if (next === "never") onMode(undefined, undefined);
    if (next === "source") onMode({ field: timeFieldOf(fields), plus: "PT10M" }, undefined);
    if (next === "stale") onMode(undefined, { after: "14d", types: [type] });
  };
  const options = [
    { value: "never" as const, label: t("pipelines.mapper.expiry.never"), description: t("pipelines.mapper.expiry.neverHint") },
    { value: "source" as const, label: t("pipelines.mapper.expiry.source"), description: t("pipelines.mapper.expiry.sourceHint") },
    ...(onExpiry
      ? [{ value: "stale" as const, label: t("pipelines.mapper.expiry.stale"), description: t("pipelines.mapper.expiry.staleHint") }]
      : []),
  ];

  return (
    <section aria-labelledby="mapper-expiry" className="flex flex-col gap-2 rounded border border-border p-2" data-testid="mapper-expiry">
      <h4 id="mapper-expiry" className="text-caption font-semibold text-fg">
        {t("pipelines.mapper.expiry.title")}
      </h4>
      <RadioGroup name="mapper-expiry-mode" legend={t("pipelines.mapper.expiry.legend")} value={mode} options={options} onChange={choose} />

      {mode === "source" ? (
        <div className="flex flex-wrap items-end gap-3">
          <Field id="mapper-expiry-field" label={t("pipelines.mapper.expiry.from")} errors={problem ? [problem] : undefined}>
            <Select
              id="mapper-expiry-field"
              value={expires?.field ?? ""}
              onChange={(event) => onExpires({ ...expires, field: event.target.value || undefined })}
            >
              <option value="">{t("pipelines.mapper.expiry.written")}</option>
              {[...new Set([...fields, ...(expires?.field ? [expires.field] : [])])].map((field) => (
                <option key={field} value={field}>
                  {field}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="mapper-expiry-plus" label={t("pipelines.mapper.expiry.plus")}>
            <span className="flex gap-2">
              <Input
                id="mapper-expiry-plus"
                type="number"
                min={0}
                className="w-20"
                value={plus === undefined ? "0" : String(plus.amount)}
                onChange={(event) => setPlus(event.target.value, plus?.unit ?? "minutes")}
              />
              <Select
                aria-label={t("pipelines.mapper.expiry.plusUnit")}
                value={plus?.unit ?? "minutes"}
                onChange={(event) => setPlus(String(plus?.amount ?? 1), event.target.value as Unit)}
              >
                {UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {t(`spaces.retention.unit.${unit}`)}
                  </option>
                ))}
              </Select>
            </span>
          </Field>
        </div>
      ) : null}

      {mode === "stale" && onExpiry ? (
        <>
          <Field id="mapper-expiry-after" label={t("pipelines.mapper.expiry.after")} description={t("pipelines.mapper.expiry.afterHint", { type })}>
            <span className="flex gap-2">
              <Input
                id="mapper-expiry-after"
                type="number"
                min={1}
                className="w-20"
                value={after.amount}
                onChange={(event) => onExpiry({ ...expiry, after: `${event.target.value}${after.unit}` })}
              />
              <Select
                aria-label={t("pipelines.mapper.expiry.afterUnit")}
                value={after.unit}
                onChange={(event) => onExpiry({ ...expiry, after: `${after.amount || "1"}${event.target.value}` })}
              >
                <option value="h">{t("spaces.retention.unit.hours")}</option>
                <option value="d">{t("spaces.retention.unit.days")}</option>
              </Select>
            </span>
          </Field>
          <p className="text-caption text-fg-muted">{t("pipelines.mapper.expiry.refusals")}</p>
        </>
      ) : null}

      <p className="text-caption text-fg-muted">
        {t("pipelines.mapper.expiry.history", { type })}{" "}
        <RecordLink project={project} plural="spaces" name={space}>
          {t("pipelines.mapper.expiry.spaceRules", { space })}
        </RecordLink>{" "}
        <RetentionGuide section="4-recipe-buses-and-live-vehicles" />
      </p>
    </section>
  );
}
