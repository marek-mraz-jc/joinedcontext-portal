/**
 * A column's header filter, as Excel's autofilter and Baserow's column filter work (T-6328): the
 * column's values across the whole answer as a searchable tick list with Select all, and a
 * condition by what the column holds (contains, equals, a range, empty or not). Apply narrows the
 * endpoint's answer; nothing is filtered in the browser.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import type { GridLabels } from "./useEntityGrid";
import { listsValues, opsForKind, valuesNeeded } from "./filters";
import type { ColumnFilter, FilterColumn, FilterOp } from "./filters";
import type { ColumnValues } from "./columnValues";
import { usePlaceAtCell } from "./ColumnMenu";

export interface AutoFilterProps {
  column: FilterColumn;
  label: string;
  labels: GridLabels;
  filter: ColumnFilter | undefined;
  /** Reads the column's values for the tick list; absent where the column lists none. */
  load?: () => Promise<ColumnValues>;
  /** A value as the column's cells show it. */
  formatValue: (value: string) => string;
  onApply: (filter: ColumnFilter | undefined) => void;
  onClose: () => void;
}

type Loaded = { state: "loading" } | { state: "error"; message: string } | ({ state: "done" } & ColumnValues);

/** The ops a condition offers: the column's own, without the value list's `anyOf` and the id's pattern. */
function conditionOps(column: FilterColumn): FilterOp[] {
  return opsForKind(column.kind).filter((op) => op !== "anyOf" && op !== "pattern");
}

export function AutoFilter({ column, label, labels, filter, load, formatValue, onApply, onClose }: AutoFilterProps): React.JSX.Element {
  const id = useId();
  const box = usePlaceAtCell();
  const search = useRef<HTMLInputElement>(null);
  const lists = Boolean(load) && listsValues(column.kind);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [find, setFind] = useState("");
  // `null` is every value ticked, which is no filter by value at all.
  const [ticked, setTicked] = useState<Set<string> | null>(filter?.op === "anyOf" ? new Set(filter.values ?? []) : null);
  const ops = conditionOps(column);
  const [op, setOp] = useState<FilterOp | "">(filter && filter.op !== "anyOf" ? filter.op : "");
  const [value, setValue] = useState(filter && filter.op !== "anyOf" ? filter.value : "");
  const [value2, setValue2] = useState(filter?.value2 ?? "");

  useEffect(() => {
    (lists ? search.current : box.current?.querySelector<HTMLElement>("select"))?.focus();
    if (!lists || !load) return;
    let gone = false;
    load().then(
      (read) => !gone && setLoaded({ state: "done", ...read }),
      (err: unknown) => !gone && setLoaded({ state: "error", message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      gone = true;
    };
  }, [lists, load, box]);

  const all = loaded.state === "done" ? loaded.values : [];
  const shown = useMemo(() => {
    const needle = find.trim().toLocaleLowerCase();
    return needle === "" ? all : all.filter((each) => formatValue(each.value).toLocaleLowerCase().includes(needle) || each.value.toLocaleLowerCase().includes(needle));
  }, [all, find, formatValue]);
  const isTicked = (value: string) => ticked === null || ticked.has(value);
  const shownTicked = shown.filter((each) => isTicked(each.value)).length;
  const toggle = (value: string) => {
    const next = new Set(ticked ?? all.map((each) => each.value));
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setTicked(next);
  };
  const toggleShown = () => {
    const next = new Set(ticked ?? all.map((each) => each.value));
    const on = shownTicked < shown.length;
    for (const each of shown) {
      if (on) next.add(each.value);
      else next.delete(each.value);
    }
    setTicked(next);
  };

  const needed = op === "" ? 0 : valuesNeeded(op);
  const conditionReady = op !== "" && (needed === 0 || (value.trim() !== "" && (needed === 1 || value2.trim() !== "")));
  // A tick list where everything is ticked and nothing is left out asks for nothing.
  const everyValue = ticked === null || (loaded.state === "done" && !loaded.capped && all.every((each) => ticked.has(each.value)));
  const result: ColumnFilter | undefined | "none" = conditionReady
    ? { op: op as FilterOp, value, ...(needed === 2 ? { value2 } : {}) }
    : op !== ""
      ? "none"
      : everyValue
        ? undefined
        : ticked.size === 0
          ? "none"
          : { op: "anyOf", value: "", values: [...ticked] };
  const inputType = column.kind === "number" ? "number" : column.kind === "date" ? "date" : "text";
  const hint = column.kind === "number" ? labels.filterHintNumber : column.kind === "date" ? labels.filterHintDate : labels.filterHintText;

  return (
    <div
      className="jc-grid-meta-menu jc-grid-col-menu jc-grid-autofilter"
      ref={box}
      role="dialog"
      aria-label={`${labels.filter}: ${label}`}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
      }}
    >
      <p className="jc-grid-autofilter-title">{`${labels.filter}: ${label}`}</p>
      {lists && (
        <fieldset className="jc-grid-autofilter-values">
          <legend>{labels.filterValues}</legend>
          <input
            ref={search}
            type="search"
            className="jc-grid-col-menu-input"
            aria-label={`${labels.searchValues}: ${label}`}
            aria-describedby={`${id}-find`}
            placeholder={labels.searchValues}
            value={find}
            onChange={(e) => setFind(e.target.value)}
          />
          <span id={`${id}-find`} className="jc-grid-autofilter-hint">{labels.searchValuesHint}</span>
          {loaded.state === "loading" && <p role="status" className="jc-grid-autofilter-note">{labels.valuesLoading}</p>}
          {loaded.state === "error" && <p role="alert" className="jc-grid-autofilter-note jc-grid-error">{`${labels.valuesFailed} ${loaded.message}`}</p>}
          {loaded.state === "done" && all.length === 0 && <p className="jc-grid-autofilter-note">{labels.noValues}</p>}
          {loaded.state === "done" && all.length > 0 && (
            <>
              <label className="jc-grid-meta-item jc-grid-autofilter-all">
                <input
                  type="checkbox"
                  checked={shown.length > 0 && shownTicked === shown.length}
                  ref={(el) => {
                    if (el) el.indeterminate = shownTicked > 0 && shownTicked < shown.length;
                  }}
                  disabled={shown.length === 0}
                  onChange={toggleShown}
                />
                {labels.selectAll}
              </label>
              <ul className="jc-grid-autofilter-list" aria-label={labels.filterValues}>
                {shown.map((each) => (
                  <li key={each.value}>
                    <label className="jc-grid-meta-item" title={each.value}>
                      <input type="checkbox" checked={isTicked(each.value)} onChange={() => toggle(each.value)} />
                      <span className="jc-grid-autofilter-value">{formatValue(each.value)}</span>
                      <span className="jc-grid-autofilter-count">{each.count}</span>
                    </label>
                    {/* One click to this value alone, the old grid's one-click filter (T-6328). */}
                    <button
                      type="button"
                      className="jc-grid-autofilter-only"
                      aria-label={`${labels.onlyValue}: ${formatValue(each.value)}`}
                      onClick={() => onApply({ op: "anyOf", value: "", values: [each.value] })}
                    >
                      {labels.onlyValue}
                    </button>
                  </li>
                ))}
              </ul>
              {shown.length === 0 && <p className="jc-grid-autofilter-note">{labels.noValues}</p>}
              {loaded.capped && (
                <p className="jc-grid-autofilter-note">
                  {labels.valuesCapped.replace("{count}", String(loaded.scanned)).replace("{total}", loaded.total === undefined ? "?" : String(loaded.total))}
                </p>
              )}
            </>
          )}
        </fieldset>
      )}
      {ops.length > 0 && (
        <fieldset className="jc-grid-autofilter-condition">
          <legend>{labels.filterCondition}</legend>
          <select aria-label={`${labels.filterCondition}: ${label}`} aria-describedby={`${id}-hint`} value={op} onChange={(e) => setOp(e.target.value as FilterOp | "")}>
            <option value="">{labels.noFilter}</option>
            {ops.map((each) => (
              <option key={each} value={each}>
                {labels.ops[each] ?? each}
              </option>
            ))}
          </select>
          {needed >= 1 && (
            <input
              className="jc-grid-col-menu-input"
              aria-label={`${labels.value}: ${label}`}
              aria-describedby={`${id}-hint`}
              type={inputType}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && result !== "none") onApply(result);
              }}
            />
          )}
          {needed === 2 && (
            <input
              className="jc-grid-col-menu-input"
              aria-label={`${labels.upperValue}: ${label}`}
              type={inputType}
              value={value2}
              onChange={(e) => setValue2(e.target.value)}
            />
          )}
          <span id={`${id}-hint`} className="jc-grid-autofilter-hint">
            {column.unit && column.kind === "number" ? `${hint} ${labels.unit}: ${column.unit}.` : hint}
          </span>
        </fieldset>
      )}
      <div className="jc-grid-col-menu-row jc-grid-autofilter-actions">
        <button type="button" className="jc-grid-autofilter-apply" disabled={result === "none"} onClick={() => result !== "none" && onApply(result)}>
          {labels.applyFilter}
        </button>
        {filter && (
          <button type="button" className="jc-grid-meta-item" onClick={() => onApply(undefined)}>
            {labels.clearFilter}
          </button>
        )}
        <button type="button" className="jc-grid-meta-item" onClick={onClose}>
          {labels.close}
        </button>
      </div>
    </div>
  );
}
