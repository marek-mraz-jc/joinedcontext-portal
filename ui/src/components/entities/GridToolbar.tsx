/**
 * The parts of the grid's one toolbar row (T-4883): a button that opens a panel under it, the row
 * sizes, and the footer's per-column aggregation, each counted by the endpoint over the whole
 * filtered set with the reader's session, never over the loaded page.
 */
import { useEffect, useRef } from "react";
import type { JSX, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { andQ } from "@joinedcontext/sdk";
import type { EntitySource } from "@joinedcontext/sdk";
import { buttonClass, Select } from "../ui";

export const ROW_SIZES = ["small", "medium", "large"] as const;
export type RowSize = (typeof ROW_SIZES)[number];

export const AGGREGATIONS = ["none", "count", "filled", "empty", "percentFilled", "percentEmpty"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

/**
 * A toolbar button with its panel: a `<details>` element, so the browser gives it a keyboard, a
 * role and a state a screen reader announces; Escape and a click outside close it. On a phone the
 * panel is a sheet at the bottom of the screen rather than a box running off its edge.
 */
export function ToolbarPopover({
  label,
  count,
  wide,
  end,
  children,
}: {
  label: string;
  /** How many settings the panel holds, shown beside the label so a set filter is visible. */
  count?: number;
  wide?: boolean;
  /** At the row's right end: the panel opens leftwards so it stays on the screen. */
  end?: boolean;
  children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const box = ref.current;
      if (box?.open && !box.contains(event.target as Node)) box.open = false;
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);
  return (
    <details
      ref={ref}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && ref.current?.open) {
          ref.current.open = false;
          ref.current.querySelector("summary")?.focus();
        }
      }}
    >
      <summary
        className={buttonClass(
          count ? "secondary" : "ghost",
          "sm",
          clsx("cursor-pointer list-none [&::-webkit-details-marker]:hidden", count ? "border-primary text-primary-soft-fg" : undefined),
        )}
      >
        {label}
        {count ? <span className="ml-1 rounded-full bg-primary-soft px-1.5 text-caption">{count}</span> : null}
      </summary>
      <div
        className={clsx(
          "z-30 overflow-auto rounded-lg border border-border bg-surface-raised p-3 text-body shadow-2",
          "max-h-96 max-sm:fixed max-sm:inset-x-4 max-sm:bottom-4",
          end ? "sm:absolute sm:right-0 sm:mt-1" : "sm:absolute sm:left-0 sm:mt-1",
          wide ? "sm:w-max sm:max-w-2xl" : "sm:w-72",
        )}
      >
        {children}
      </div>
    </details>
  );
}

/** The share of `part` in `whole` as a person reads it, `null` without a whole to divide by. */
export function percent(part: number, whole: number): string | null {
  if (whole <= 0) return null;
  return `${Math.round((part / whole) * 1000) / 10} %`;
}

/**
 * One column's footer: the aggregation picked for it, counted by the endpoint (`count=true`) over
 * the view's whole query. A filled count is the query with the attribute present (`q=attr`), so a
 * reader's grant narrows it exactly as it narrows the rows.
 */
export function FooterAggregate({
  source,
  type,
  attr,
  label,
  q,
  value,
  onChange,
}: {
  source: EntitySource;
  type: string;
  attr: string;
  label: string;
  q?: string;
  value: Aggregation;
  onChange: (next: Aggregation) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const needsTotal = value !== "none" && value !== "filled";
  const needsFilled = value !== "none" && value !== "count";
  const count = async (asked: string | undefined) => (await source.query({ type, q: asked }, { offset: 0, limit: 1 })).total ?? null;
  const total = useQuery({
    queryKey: ["grid-aggregate", type, "total", q ?? ""],
    enabled: needsTotal,
    retry: false,
    staleTime: 30_000,
    queryFn: () => count(q),
  });
  const filled = useQuery({
    queryKey: ["grid-aggregate", type, attr, q ?? ""],
    enabled: needsFilled,
    retry: false,
    staleTime: 30_000,
    queryFn: () => count(andQ(q, attr)),
  });
  const failed = (needsTotal && total.isError) || (needsFilled && filled.isError);
  const waiting = (needsTotal && total.isPending) || (needsFilled && filled.isPending);
  const whole = total.data ?? null;
  const some = filled.data ?? null;
  let shown: string | null = null;
  if (value === "count") shown = whole === null ? null : String(whole);
  if (value === "filled") shown = some === null ? null : String(some);
  if (value === "empty") shown = whole === null || some === null ? null : String(whole - some);
  if (value === "percentFilled") shown = whole === null || some === null ? null : percent(some, whole);
  if (value === "percentEmpty") shown = whole === null || some === null ? null : percent(whole - some, whole);
  return (
    <div className="flex items-center gap-1">
      {/* Baserow's quiet "Summarize" (T-5093): a text button under the column, its choice the
          browser's own list, so a keyboard, a phone and a screen reader open it as any select. */}
      <Select
        quiet
        aria-label={t("spaces.toolbar.aggregateOf", { field: label })}
        className="max-w-32"
        value={value}
        onChange={(event) => onChange(event.target.value as Aggregation)}
      >
        {AGGREGATIONS.map((each) => (
          <option key={each} value={each}>
            {t(`spaces.toolbar.aggregate.${each}`)}
          </option>
        ))}
      </Select>
      {value === "none" ? null : failed ? (
        <span className="text-caption text-danger" title={t("spaces.toolbar.aggregateFailed")}>
          {t("spaces.toolbar.aggregateFailedShort")}
        </span>
      ) : waiting ? (
        <span className="text-caption text-fg-muted" role="status">
          …
        </span>
      ) : (
        <output className="text-caption font-semibold tabular-nums">{shown ?? t("spaces.toolbar.aggregateNone")}</output>
      )}
    </div>
  );
}
