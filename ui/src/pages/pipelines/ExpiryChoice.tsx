/**
 * "When do entities go away?" in the output mapper (T-4822, T-4839, PL-64, PL-80, TS 104 175
 * 4.22): never, at a time the entity holds or the write time plus a while (the pipeline's
 * `spec.lifetime`, which the runner applies after the mapping), or once the source stops sending
 * one for a while (the pipeline's `spec.expiry` sweep). One choice, so a person never writes
 * Bloblang for the bus recipe and never sets both by accident.
 */
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { RecordLink } from "../../components/RecordLink";
import { RetentionGuide } from "../../components/RetentionGuide";
import { Field, Input, RadioGroup, Select } from "../../components/ui";
import { fromIso, toIso, UNITS } from "../spaces/retention";
import type { Unit } from "../spaces/retention";

/** The pipeline's stale-entity sweep as the manifest holds it (PL-64). */
export interface Expiry {
  after?: string;
  types?: string[];
}

/** One end time as `spec.lifetime` holds it (PL-80): `from` a slot plus a while, `rolling`, or `at`. */
export interface LifetimeMode {
  from?: string;
  plus?: string;
  notAfter?: string;
  rolling?: string;
  at?: string;
}

/** One entry of `spec.lifetime` (PL-80): the type, the whole entity's end, chosen attributes' ends. */
export interface Lifetime {
  type: string;
  entity?: LifetimeMode;
  attributes?: (LifetimeMode & { names: string[] })[];
}

export type ExpiryMode = "never" | "source" | "stale";

/** The mode an entity lifetime and a manifest are in: an own `expiresAt` first, then the sweep. */
export function modeOf(lifetime: LifetimeMode | undefined, expiry: Expiry | undefined): ExpiryMode {
  if (lifetime) return "source";
  return expiry?.after || expiry?.types?.length ? "stale" : "never";
}

/** The slot a time most likely comes from: `observedAt`, then a name with time or date in it. */
export function timeFieldOf(fields: string[]): string | undefined {
  return fields.find((field) => field === "observedAt") ?? fields.find((field) => /time|date|observed|timestamp/i.test(field));
}

/** The entity lifetime counted from `from` (a slot), or from the write time when it is empty. */
export function withFrom(lifetime: LifetimeMode | undefined, from: string | undefined): LifetimeMode {
  const span = lifetime?.plus ?? lifetime?.rolling ?? "PT10M";
  return from ? { from, plus: span } : { rolling: span };
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
  /** The type's date-time attributes the step maps, the times an end can count from. */
  slots: string[];
  /** The entity's end in `spec.lifetime` for this type. */
  lifetime: LifetimeMode | undefined;
  expiry: Expiry | undefined;
  /** A problem with the time field the sample shows, in words. */
  problem?: string;
  /** Changes the mode: the lifetime and the manifest's sweep together, never one alone. */
  onMode: (lifetime: LifetimeMode | undefined, expiry: Expiry | undefined) => void;
  onLifetime: (lifetime: LifetimeMode) => void;
  /** Absent where the form holds no `spec.expiry`: the sweep is then not offered. */
  onExpiry?: (expiry: Expiry) => void;
}

export function ExpiryChoice({ project, space, type, slots, lifetime, expiry, problem, onMode, onLifetime, onExpiry }: ExpiryChoiceProps): JSX.Element {
  const { t } = useTranslation();
  const mode = modeOf(lifetime, expiry);
  const rolling = lifetime !== undefined && lifetime.from === undefined;
  const span = lifetime?.from !== undefined ? lifetime.plus : lifetime?.rolling;
  const plus = span === undefined ? undefined : fromIso(span);
  const after = afterOf(expiry?.after);
  // A `rolling` end needs a while of its own (PT1M at least): a zero keeps the one it has.
  const setPlus = (amount: string, unit: Unit) => {
    const iso = amount === "" || amount === "0" ? undefined : (toIso({ amount: Number(amount), unit }) ?? span);
    if (rolling) onLifetime({ rolling: iso ?? lifetime?.rolling ?? "PT10M" });
    else onLifetime({ ...lifetime, plus: iso });
  };
  const choose = (next: ExpiryMode) => {
    if (next === "never") onMode(undefined, undefined);
    if (next === "source") onMode(withFrom(undefined, timeFieldOf(slots)), undefined);
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
          <Field
            id="mapper-expiry-field"
            label={t("pipelines.mapper.expiry.from")}
            description={slots.length === 0 ? t("pipelines.mapper.expiry.noTimeSlot", { type }) : undefined}
            errors={problem ? [problem] : undefined}
          >
            <Select
              id="mapper-expiry-field"
              value={lifetime?.from ?? ""}
              onChange={(event) => onLifetime(withFrom(lifetime, event.target.value || undefined))}
            >
              <option value="">{t("pipelines.mapper.expiry.written")}</option>
              {[...new Set([...slots, ...(lifetime?.from ? [lifetime.from] : [])])].map((field) => (
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
                min={rolling ? 1 : 0}
                className="w-20"
                value={plus === undefined ? "0" : String(plus.amount)}
                onChange={(event) => setPlus(event.target.value, plus?.unit ?? "minutes")}
              />
              {/* The unit keeps its words whole beside the amount, at any width. */}
              <span className="min-w-32 shrink-0">
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
