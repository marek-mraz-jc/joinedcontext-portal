/**
 * A space's retention in plain units (DM-82, DM-85, ADR-N-046): the manifest holds ISO 8601
 * durations in days, hours, minutes and seconds (`PT5M`, `PT8H`, `P30D`), the form "5 minutes",
 * "8 hours", "keep forever".
 */

export type Unit = "minutes" | "hours" | "days";
export const UNITS: Unit[] = ["minutes", "hours", "days"];

/** How long something is kept; `undefined` anywhere it is used means forever. */
export interface Keep {
  amount: number;
  unit: Unit;
}

/** One rule of `spec.retention`. */
export interface RetentionRule {
  entityType: string;
  current?: string;
  /** A duration, `off` (current state only, T-4275) or `forever` with a `reason`. */
  history?: string;
  /** Why the type keeps its whole history: only with `history: forever`. */
  reason?: string;
}

/** The `entityType` of the space's default rule: history of every type without its own (DM-97). */
export const ANY_TYPE = "*";

/** The history of a type that keeps its current state only (T-4275). */
export const HISTORY_OFF = "off";
/** The history of a type that keeps it all, which the manifest states with a reason. */
export const HISTORY_FOREVER = "forever";

const SECONDS: Record<Unit, number> = { minutes: 60, hours: 3600, days: 86_400 };
const LONGEST = 3650 * 86_400;
const ISO = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** Seconds of a duration the broker reads; `undefined` for anything else, the empty `P` too. */
export function seconds(iso: string): number | undefined {
  const match = ISO.exec(iso);
  if (!match || iso === "P" || iso.endsWith("T")) return undefined;
  const [, d, h, m, s] = match.map((part) => Number(part ?? 0));
  const total = d * 86_400 + h * 3600 + m * 60 + s;
  return total >= 60 && total <= LONGEST ? total : undefined;
}

/** The manifest's duration for `keep`, or `undefined` when it is not one the broker runs. */
export function toIso(keep: Keep): string | undefined {
  if (!Number.isInteger(keep.amount) || keep.amount < 1) return undefined;
  const iso = keep.unit === "days" ? `P${keep.amount}D` : `PT${keep.amount}${keep.unit === "hours" ? "H" : "M"}`;
  return seconds(iso) === undefined ? undefined : iso;
}

/** A stored duration in the largest unit that holds it exactly; `undefined` when unreadable. */
export function fromIso(iso: string): Keep | undefined {
  const total = seconds(iso);
  if (total === undefined) return undefined;
  const unit = [...UNITS].reverse().find((one) => total % SECONDS[one] === 0) ?? "minutes";
  return { amount: Math.max(1, Math.floor(total / SECONDS[unit])), unit };
}

/** Whether `draft` keeps anything shorter than `held` does: a confirmation is owed (DM-85). */
export function shortens(held: RetentionRule[], draft: RetentionRule[]): boolean {
  const forever = Number.POSITIVE_INFINITY;
  const length = (iso?: string) =>
    iso === HISTORY_OFF ? 0 : iso === undefined ? forever : (seconds(iso) ?? forever);
  return draft.some((rule) => {
    const before = held.find((one) => one.entityType === rule.entityType);
    return (
      length(rule.current) < length(before?.current) || length(rule.history) < length(before?.history)
    );
  });
}

/** The rules as the manifest writes them: a type kept forever in both has no rule. */
export function written(rules: RetentionRule[]): RetentionRule[] {
  return rules
    .filter((rule) => rule.current !== undefined || rule.history !== undefined)
    .map(({ entityType, current, history, reason }) => ({
      entityType,
      ...(current === undefined ? {} : { current }),
      ...(history === undefined ? {} : { history }),
      ...(history === HISTORY_FOREVER && reason !== undefined ? { reason } : {}),
    }));
}
