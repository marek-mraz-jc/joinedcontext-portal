import React, { useCallback, useMemo, useRef, useState } from "react";
import type { RichRow, RichCell } from "./model";
import { cellText } from "./model";
import type { MetaKey, UseEntityGridOptions, VisibleColumn } from "./useEntityGrid";
import { useEntityGrid } from "./useEntityGrid";
import { opsForKind, valuesNeeded } from "./filters";
import type { ColumnFilter, FilterColumn } from "./filters";
import { applyChanges, MAX_ENTITIES } from "./apply";
import type { Observed, Refusal } from "./apply";
import { EntityHistory } from "./EntityHistory";
import { GridMap } from "./GridMap";
import { unitTitle } from "../sdk/units";
import type { GridMapLabels } from "./GridMap";
import { mapAttrOf } from "./mapRows";
import type { DrawEngine, GeoLabels } from "../geo/GeoEditor";
import type { GeometryType } from "../geo/validate";
import { optionLabel } from "../enums";
import type { EnumOption } from "../enums";
import { objectsOf, pointingAt, searchTargets } from "../relations";
import type { TargetOption } from "../relations";
import { NGSI_LD_NULL, RelationPicker } from "./RelationPicker";
import { RowDetail } from "./RowDetail";
import { parseClipboard, planPaste } from "./paste";
import { problemOf } from "./rules";
import type { ValueRule } from "./rules";
import "./grid.css";

export interface EntityGridProps extends UseEntityGridOptions {
  /**
   * How one column's cells are drawn, by attribute name, by cell kind, or `id` for the pinned
   * identifier column — which is how a host makes a row open something of its own (a detail pane,
   * a row action) without a second table of its own.
   */
  renderers?: Record<string, (cell: RichCell | RichCell[] | undefined, row: RichRow) => React.ReactNode>;
  onOpenRelationship?: (urn: string) => void;
  /**
   * The page of rows as the source answered it, with the offset it starts at, for a host that
   * exports or counts what is shown.
   */
  onRows?: (rows: RichRow[], offset: number) => void;
  /**
   * What is different about a row or a column, and why, in the host's own words: a comparison marks
   * what the other side does not answer (T-1435). Each value is the sentence a person reads on it.
   */
  marks?: { rows?: Record<string, string>; columns?: Record<string, string> };
  /**
   * The map beside the rows, where `config.map.enabled` asked for one (UI-72). The drawing library
   * is injected the way `GeoEditor` takes it, so a host that never draws ships none of it, and the
   * geometries a type accepts come from the DataModel's range where the space has one.
   */
  mapEngine?: DrawEngine;
  mapAllowed?: readonly GeometryType[];
  mapLabels?: Partial<GridMapLabels>;
  geoLabels?: Partial<GeoLabels>;
  basemap?: string;
  /** What the host adds under a row's detail, such as its comments (T-3106). */
  detailExtra?: (row: RichRow) => React.ReactNode;
  toolbar?: React.ReactNode;
  /** The bounds the "Draw area" action asks about; the host owns the map's viewport. */
  mapBounds?: () => [number, number, number, number] | null;
  empty?: React.ReactNode;
  /**
   * Each attribute's rule as its model states it (range, bounds, pattern, required), by name: a
   * pending value that breaks it is marked at its cell and holds Apply back (T-3097).
   */
  rules?: Record<string, ValueRule>;
  className?: string;
  classNames?: Partial<Record<"root" | "table" | "header" | "row" | "cell" | "pager", string>>;
}

/** Whether a pending value is a geometry, so a geo cell stays a geo cell while it is changed. */
function isGeometry(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    (value as { coordinates?: unknown }).coordinates !== undefined
  );
}

export function EntityGrid(props: EntityGridProps): React.JSX.Element {
  const {
    renderers,
    onOpenRelationship,
    onRows,
    marks,
    toolbar,
    detailExtra,
    mapEngine,
    mapAllowed,
    mapLabels,
    geoLabels,
    basemap,
    mapBounds,
    empty: emptySlot,
    rules,
    className,
    classNames,
    ...hookOptions
  } = props;

  const grid = useEntityGrid(hookOptions);
  const { rows, columns, loading, error, labels, state, cellOf, toggleMeta, setOffset, setSort, setFilter, setFilterText, filterColumns, askedQuery, setEdit, clearEdits, pendingChanges, reload, setEdits, getGridProps, getHeaderProps, getRowProps, getCellProps } = grid;

  // A column offers a filter when it holds something `q` can ask about and the config allows it:
  // `filters.allowed` is the list a dashboard narrows its grid to.
  const allowed = hookOptions.config.filters?.allowed;
  const filterable = useMemo(() => {
    const byKey = new Map<string, FilterColumn>();
    for (const column of filterColumns) {
      if (allowed && column.attr !== null && !allowed.includes(column.attr)) {
        continue;
      }
      byKey.set(column.key, column);
    }
    return byKey;
  }, [filterColumns, allowed]);
  const asText = state.filterText !== null;
  // Edit mode needs a place to write: without one the grid is a reader, whatever the config says.
  // A source that takes no writes switches the feature off, whatever the config says (SDK-29).
  const editing = hookOptions.config.mode === "edit" && Boolean(hookOptions.source.patch);
  // Which columns open: the config's own list, which `parseGridConfig` requires in edit mode, so a
  // grid never opens a column nobody named.
  const editable = useMemo(() => {
    const allowed = hookOptions.config.editableAttrs;
    return (column: VisibleColumn): boolean =>
      // The attribute's own column only: a metadata column shows when the value was observed or
      // what it is measured in, and neither is corrected by typing over it.
      editing && column.attr !== null && column.meta === null && allowed.includes(column.attr);
  }, [editing, hookOptions.config.editableAttrs]);
  const [open, setOpen] = useState(false);
  const [observed, setObserved] = useState<Observed>("keep");
  const [applying, setApplying] = useState(false);
  const [history, setHistory] = useState<{ attr: string; id: string; heading: string } | null>(null);
  // The row whose detail panel is open, by id, so a new page closes it rather than showing a row
  // that is no longer listed (T-3097).
  const [detailId, setDetailId] = useState<string | null>(null);
  // The primary column is the first one when it is an attribute: the config pinned it (T-3097).
  const primaryKey = columns[0]?.attr !== null && columns[0]?.pinned ? columns[0].key : null;
  const isPrimary = useCallback(
    (column: VisibleColumn): boolean => column.key === primaryKey && column.pinned && column.meta === null,
    [primaryKey],
  );
  /** What a row is called: its primary field, else its name or title, else its id. */
  const rowName = useCallback(
    (row: RichRow): string => {
      const primary = primaryKey ? cellText(row.cells[primaryKey]) : "";
      return primary || cellText(row.cells.name) || cellText(row.cells.title) || row.id;
    },
    [primaryKey],
  );
  const tableRef = useRef<HTMLTableElement>(null);
  // Scrolling instead of pages (T-3097): the rows in sight, between two spacers that stand for the
  // rest, so ten thousand rows cost the DOM a screenful.
  const virtual = hookOptions.virtual === true;
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = useRef(FALLBACK_ROW_HEIGHT);
  const [windowStart, setWindowStart] = useState(0);
  const [windowSize, setWindowSize] = useState(FALLBACK_VIEWPORT_ROWS);
  // What the last paste did, said once in a status line (T-3097).
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const [refused, setRefused] = useState<Refusal[]>([]);
  // What the pending values break of their model's rules, by `id\u0000attr` (T-3097).
  const ruleProblems = useMemo(() => {
    const found = new Map<string, string>();
    for (const [id, attrs] of Object.entries(state.edits)) {
      for (const [attr, value] of Object.entries(attrs)) {
        const problem = problemOf(rules?.[attr], value, labels);
        if (problem) found.set(`${id}\u0000${attr}`, problem);
      }
    }
    return found;
  }, [state.edits, rules, labels]);
  const refusedOf = useMemo(() => new Map(refused.map((one) => [one.id, one.detail])), [refused]);
  // A refusal that names its attribute belongs on that cell too, beside the value (DM-70).
  const refusedCell = useMemo(
    () => new Map(refused.flatMap((one) => (one.slot ? [[`${one.id}\u0000${one.slot}`, one.detail] as const] : []))),
    [refused],
  );

  // The computed ends of the page: one read per end for every row on it, through the grid's own
  // source, so only what the person may read is listed (DM-67, UI-84).
  const relations = hookOptions.relations;
  const computed = useMemo(
    () => Object.entries(relations ?? {}).filter(([, end]) => end.inverseOf !== undefined),
    [relations],
  );
  const pageIds = rows.map((row) => row.id).join("\n");
  const [inverse, setInverse] = useState<Record<string, { byId: Record<string, TargetOption[]>; full: boolean } | null>>({});
  React.useEffect(() => {
    if (computed.length === 0 || pageIds === "") {
      setInverse({});
      return;
    }
    let live = true;
    const ids = pageIds.split("\n");
    Promise.all(
      computed.map(([attr, end]) =>
        pointingAt(hookOptions.source, end.target, end.inverseOf!, ids).then(
          (found) => [attr, found] as const,
          () => [attr, null] as const,
        ),
      ),
    ).then((all) => {
      if (live) setInverse(Object.fromEntries(all));
    });
    return () => {
      live = false;
    };
  }, [computed, pageIds, hookOptions.source]);
  // One search per target class for as long as the source stays: a new function each render
  // would ask the endpoint again every time the grid draws.
  const searchOf = useMemo(() => {
    const made = new Map<string, (text: string) => Promise<TargetOption[]>>();
    return (target: string) => {
      let search = made.get(target);
      if (!search) {
        search = (text: string) => searchTargets(hookOptions.source, target, text);
        made.set(target, search);
      }
      return search;
    };
  }, [hookOptions.source]);
  const pickerLabels = useMemo(
    () => ({
      search: labels.relationSearch,
      none: labels.relationNone,
      remove: labels.relationRemove,
      loading: labels.loading,
      failed: labels.relationFailed,
    }),
    [labels.relationSearch, labels.relationNone, labels.relationRemove, labels.loading, labels.relationFailed],
  );
  const rowTitle = useCallback(
    (id: string): string | undefined => {
      const detail = refusedOf.get(id);
      return detail ? `${labels.refusedHere}: ${detail}` : undefined;
    },
    [refusedOf, labels.refusedHere],
  );

  /**
   * Applies the pending cells through the endpoint. What landed is forgotten and re-read, so the
   * grid shows the endpoint's own answer; what was refused stays pending with its reason, because
   * the person's value is the only copy of it (UI-67).
   */
  const apply = useCallback(async () => {
    setApplying(true);
    try {
      const result = await applyChanges({
        source: hookOptions.source,
        entities: pendingChanges,
        observed,
        fallback: labels.error,
      });
      // Every applied value leaves the pending list in one step: one call per value would keep
      // all but the last pending.
      setEdits(
        result.applied.flatMap((id) =>
          Object.keys(state.edits[id] ?? {}).map((attr) => ({ id, attr, value: undefined })),
        ),
      );
      setRefused(result.refused);
      if (result.refused.length === 0) {
        setOpen(false);
      }
      reload();
    } finally {
      setApplying(false);
    }
  }, [hookOptions.source, pendingChanges, observed, labels.error, state.edits, setEdits, reload]);

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const totalPages = useMemo(() => {
    if (grid.total !== undefined) {
      return Math.max(1, Math.ceil(grid.total / hookOptions.config.pageSize));
    }
    // Without total, we can't know; show only next/previous
    return undefined;
  }, [grid.total, hookOptions.config.pageSize]);

  const currentPage = useMemo(() => {
    return Math.floor(state.offset / hookOptions.config.pageSize) + 1;
  }, [state.offset, hookOptions.config.pageSize]);

  const renderCellContent = useCallback((row: RichRow, column: VisibleColumn): React.ReactNode => {
    const { text, cell } = cellOf(row, column);

    // Custom renderer by attribute name first, then by cell kind
    if (column.attr && renderers?.[column.attr]) {
      return renderers[column.attr](cell, row);
    }
    // The identifier column carries no attribute, so a host addresses it by its key.
    if (column.attr === null && renderers?.[column.key]) {
      return renderers[column.key](cell, row);
    }
    // The primary field, or the identifier where the config names none, opens the row's detail
    // panel (T-3097): the person reads the row by its name and opens it from there.
    if (column.key === "id" || isPrimary(column)) {
      const name = rowName(row);
      return (
        <button
          type="button"
          className="jc-grid-open"
          aria-label={`${labels.openRow}: ${name}`}
          title={row.id}
          onClick={(e) => {
            e.stopPropagation();
            setDetailId(row.id);
          }}
        >
          {column.key === "id" ? text : text || row.id}
        </button>
      );
    }
    if (cell && !Array.isArray(cell) && renderers?.[cell.kind]) {
      return renderers[cell.kind](cell, row);
    }

    const end = column.attr && column.meta === null ? relations?.[column.attr] : undefined;
    // A computed end: the entities pointing back, as links, never an input (DM-67).
    if (end?.inverseOf !== undefined && column.attr) {
      const read = inverse[column.attr];
      if (read === undefined) return <>{labels.loading}</>;
      if (read === null) return <>{labels.error}</>;
      const pointing = read.byId[row.id] ?? [];
      return (
        <span className="jc-grid-rel-list">
          {pointing.map((one) =>
            onOpenRelationship ? (
              <button key={one.id} type="button" className="jc-grid-rel-btn" title={one.id} onClick={(e) => { e.stopPropagation(); onOpenRelationship(one.id); }}>
                {one.name ?? one.id}
              </button>
            ) : (
              <span key={one.id} title={one.id}>{one.name ?? one.id}</span>
            ),
          )}
          {read.full && <span className="jc-grid-rel-more">{labels.relationMore}</span>}
        </span>
      );
    }
    // A stored end in edit mode: a picker of the target's entities (UI-84).
    if (end && column.attr && editable(column)) {
      const attr = column.attr;
      const pending = state.edits[row.id]?.[attr];
      const stored = objectsOf(cell);
      const now = pending === undefined ? stored : pending === NGSI_LD_NULL ? [] : Array.isArray(pending) ? (pending as string[]) : [String(pending)];
      return (
        <RelationPicker
          label={`${labels.edit} ${column.label}`}
          value={now}
          end={end}
          search={searchOf(end.target)}
          labels={pickerLabels}
          changed={pending !== undefined}
          invalid={refusedCell.get(`${row.id}\u0000${attr}`)}
          onChange={(next) => {
            const same = next.length === stored.length && next.every((id, at) => id === stored[at]);
            // An emptied end is written as NGSI-LD's null, so the attribute goes.
            const after = next.length === 0 ? NGSI_LD_NULL : end.many ? next : next[0];
            setEdit(row.id, attr, same ? undefined : after);
          }}
        />
      );
    }

    // Relationship button
    if (column.attr && cell && !Array.isArray(cell) && cell.kind === "relationship" && onOpenRelationship) {
      const urn = typeof cell.object === "string" ? cell.object : Array.isArray(cell.object) ? cell.object.join(", ") : text;
      return (
        <button
          type="button"
          className="jc-grid-rel-btn"
          onClick={(e) => {
            e.stopPropagation();
            if (typeof cell.object === "string") onOpenRelationship(cell.object);
          }}
        >
          {urn}
        </button>
      );
    }

    if (column.attr && editable(column)) {
      const pending = state.edits[row.id]?.[column.attr];
      const one = Array.isArray(cell) ? cell[0] : cell;
      // A geometry is not typed over. Its editor is the map panel, and a text box here would put
      // `[object Object]` in front of a person and write that string back as the value (T-1443).
      // The cell still says what it holds and marks a pending change, so the table stays the
      // record of what will be sent.
      if (one?.kind === "geo" || (pending !== undefined && isGeometry(pending))) {
        const geometry = (pending ?? one?.value) as { type?: unknown } | undefined;
        const kind = typeof geometry?.type === "string" ? geometry.type : labels.empty;
        return (
          <span className={`jc-grid-geo-cell${pending !== undefined ? " jc-grid-cell--changed" : ""}`}>
            {kind}
            {pending !== undefined ? " *" : ""}
          </span>
        );
      }
      // The value itself, not the text the cell shows: a person edits `5`, not `5 C62` — the unit
      // is what the value is measured in and is kept, never typed over.
      const own = one?.kind === "relationship" ? one.object : one?.value;
      const shown = own === undefined || own === null ? "" : String(own);
      const rule = rules?.[column.attr];
      const options =
        one?.kind === "relationship"
          ? undefined
          : (hookOptions.enums?.[column.attr] ??
            (rule?.kind === "boolean"
              ? [
                  { value: "true", title: labels.yes },
                  { value: "false", title: labels.no },
                ]
              : undefined));
      if (options && options.length > 0) {
        return (
          <EnumCell
            label={`${labels.edit} ${column.label}`}
            value={pending === undefined ? shown : String(pending)}
            options={options}
            changed={pending !== undefined}
            notInList={labels.notInList}
            onChange={(next) => setEdit(row.id, column.attr!, next === shown ? undefined : coerce(next, shown, rule))}
          />
        );
      }
      const key = `${row.id}\u0000${column.attr}` as const;
      return (
        <EditableCell
          label={`${labels.edit} ${column.label}`}
          value={pending === undefined ? shown : String(pending)}
          changed={pending !== undefined}
          invalid={ruleProblems.get(key) ?? refusedCell.get(key)}
          kind={inputKindOf(rule, own)}
          onChange={(next) => {
            // Back to the endpoint's own value is not a change: it leaves the pending list.
            setEdit(row.id, column.attr!, next === shown ? undefined : coerce(next, shown, rule));
          }}
        />
      );
    }

    return <>{text}</>;
  }, [cellOf, renderers, onOpenRelationship, editable, state.edits, labels.edit, labels.empty, labels.notInList, labels.loading, labels.error, labels.relationMore, labels.openRow, isPrimary, rowName, hookOptions.enums, setEdit, relations, inverse, searchOf, pickerLabels, refusedCell, ruleProblems, rules, labels.yes, labels.no]);

  // Metadata menu toggle
  const toggleMenu = useCallback((attr: string) => {
    setOpenMenu((prev) => (prev === attr ? null : attr));
  }, []);

  const handleMetaCheck = useCallback((attr: string, meta: MetaKey) => {
    toggleMeta(attr, meta);
  }, [toggleMeta]);

  // Close menu on outside click
  React.useEffect(() => {
    if (!openMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openMenu]);

  // What the source answered, handed to the host as it arrives: the page a person is looking at is
  // what they mean by "this page" when they export it.
  React.useEffect(() => {
    onRows?.(rows, state.offset);
  }, [rows, state.offset, onRows]);

  // The map is a second view of the same page: it is offered only where the config asked for one
  // AND the rows actually carry a geometry, so a type without one gets no panel and no action.
  const mapConfig = hookOptions.config.map;
  const mapAttr = mapConfig?.enabled ? mapAttrOf(rows, mapConfig.attr) : null;
  const mapPosition = mapConfig?.position ?? "right";
  const activeRowId = rows[state.activeCell?.row ?? -1]?.id ?? null;
  const detailRow = detailId === null ? undefined : rows.find((row) => row.id === detailId);

  // The table is the grid's one tab stop. Enter or F2 goes into the active cell's own control (its
  // input, list or picker), Escape comes back to the grid, and the active cell is kept in view.
  const gridProps = getGridProps() as Record<string, unknown> & { onKeyDown: (e: React.KeyboardEvent) => void };
  const activeCellId = gridProps["aria-activedescendant"] as string | undefined;
  React.useEffect(() => {
    if (!activeCellId) return;
    document.getElementById(activeCellId)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeCellId]);
  const onGridKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTableElement>) => {
      const onGrid = e.target === e.currentTarget;
      if (!onGrid && e.key === "Escape") {
        e.preventDefault();
        e.currentTarget.focus();
        return;
      }
      if (onGrid && (e.key === "Enter" || e.key === "F2") && activeCellId) {
        const control = document
          .getElementById(activeCellId)
          ?.querySelector<HTMLElement>("input, select, textarea, button");
        if (control) {
          e.preventDefault();
          control.focus();
          return;
        }
      }
      gridProps.onKeyDown(e);
    },
    [activeCellId, gridProps],
  );

  /**
   * A range copied from a spreadsheet, laid over the grid from the active cell in edit mode
   * (T-3097). Only editable, typed cells of listed rows take a value, an enum only a value it lists;
   * every other cell is skipped and counted. What lands is pending like any edit.
   */
  const onGridPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTableElement>) => {
      if (!editing || e.target !== e.currentTarget) return;
      const text = e.clipboardData.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      const start = state.activeCell ?? { row: 0, col: 0 };
      const plan = planPaste(parseClipboard(text), (r, c) => {
        const row = rows[start.row + r];
        const column = columns[start.col + c];
        if (!row || !column || !editable(column) || column.attr === null) {
          return { id: row?.id, attr: undefined, current: null };
        }
        const cell = row.cells[column.attr];
        const one = Array.isArray(cell) ? cell[0] : cell;
        // A geometry is drawn on the map and a relationship picked: neither is typed over.
        if (one?.kind === "geo" || one?.kind === "relationship" || relations?.[column.attr]) {
          return { id: row.id, attr: column.attr, current: null };
        }
        const pending = state.edits[row.id]?.[column.attr];
        const stored = one?.value === undefined || one?.value === null ? "" : String(one.value);
        const options = hookOptions.enums?.[column.attr];
        return {
          id: row.id,
          attr: column.attr,
          current: pending === undefined ? stored : String(pending),
          allowed: options && options.length > 0 ? options.map((option) => option.value) : undefined,
        };
      });
      if (plan.tooLarge) {
        setPasteNote(labels.pasteTooLarge);
        return;
      }
      setEdits(
        plan.edits.map((edit) => {
          const cell = rows.find((row) => row.id === edit.id)?.cells[edit.attr];
          const one = Array.isArray(cell) ? cell[0] : cell;
          const stored = one?.value === undefined || one?.value === null ? "" : String(one.value);
          return {
            id: edit.id,
            attr: edit.attr,
            value: edit.text === stored ? undefined : coerce(edit.text, stored, rules?.[edit.attr]),
          };
        }),
      );
      setPasteNote(`${plan.edits.length} ${labels.pasted}${plan.skipped > 0 ? `, ${plan.skipped} ${labels.skipped}` : ""}`);
    },
    [editing, state.activeCell, state.edits, rows, columns, editable, relations, hookOptions.enums, labels.pasteTooLarge, labels.pasted, labels.skipped, setEdits, rules],
  );

  /** The window of rows in sight, read off the scroll position; past its end the next page loads. */
  const onScroll = useCallback(() => {
    const box = scrollRef.current;
    if (!virtual || !box) return;
    const first = box.querySelector<HTMLTableRowElement>("tbody tr:not(.jc-grid-spacer)");
    if (first && first.offsetHeight > 0) rowHeight.current = first.offsetHeight;
    const height = rowHeight.current;
    const inSight = box.clientHeight > 0 ? Math.ceil(box.clientHeight / height) : FALLBACK_VIEWPORT_ROWS;
    const start = Math.max(0, Math.floor(box.scrollTop / height) - OVERSCAN);
    setWindowStart(start);
    setWindowSize(inSight + 2 * OVERSCAN);
    if (grid.more && start + inSight + 2 * OVERSCAN >= rows.length - OVERSCAN) {
      grid.loadMore();
    }
  }, [virtual, grid, rows.length]);
  // A key that moves the active cell out of the window scrolls to it; the scroll moves the window.
  React.useEffect(() => {
    const row = state.activeCell?.row;
    const box = scrollRef.current;
    if (!virtual || row === undefined || !box) return;
    if (row < windowStart || row >= windowStart + windowSize) {
      box.scrollTop = row * rowHeight.current;
      onScroll();
    }
  }, [virtual, state.activeCell?.row, windowStart, windowSize, onScroll]);
  const shownFrom = virtual ? Math.min(windowStart, Math.max(0, rows.length - 1)) : 0;
  const shownRows = virtual ? rows.slice(shownFrom, shownFrom + windowSize) : rows;
  const spacerAbove = virtual ? shownFrom * rowHeight.current : 0;
  const spacerBelow = virtual ? Math.max(0, rows.length - shownFrom - shownRows.length) * rowHeight.current : 0;

  const rootClass = `jc-grid${className ? ` ${className}` : ""}${classNames?.root ? ` ${classNames.root}` : ""}${mapAttr ? ` jc-grid--map-${mapPosition}` : ""}${virtual ? " jc-grid--virtual" : ""}`;

  return (
    <div className={rootClass} data-density={hookOptions.config.density}>
      {toolbar && <div className="jc-grid-toolbar">{toolbar}</div>}

      {pasteNote && (
        <p className="jc-grid-paste-note" role="status">
          {pasteNote}
        </p>
      )}

      {editing && pendingChanges.length > 0 && (
        <div className="jc-grid-pending" role="status">
          <span>{`${pendingChanges.length} ${labels.pending}`}</span>
          {ruleProblems.size > 0 && <span className="jc-grid-to-correct">{`${ruleProblems.size} ${labels.toCorrect}`}</span>}
          <button type="button" disabled={ruleProblems.size > 0} onClick={() => setOpen(true)}>
            {labels.review}
          </button>
          <button type="button" onClick={() => { clearEdits(); setRefused([]); }}>
            {labels.discard}
          </button>
        </div>
      )}

      <div className="jc-grid-scroll" ref={scrollRef} onScroll={virtual ? onScroll : undefined}>
        <table
          ref={tableRef}
          className={`jc-grid-table${classNames?.table ? ` ${classNames.table}` : ""}`}
          {...gridProps}
          onKeyDown={onGridKeyDown}
          onPaste={onGridPaste}
        >
          <thead className={`jc-grid-thead${classNames?.header ? ` ${classNames.header}` : ""}`}>
            <tr>
              {columns.map((col, i) => (
                <th
                  key={col.key}
                  className={`jc-grid-th${col.pinned ? " jc-grid-pinned" : ""}`}
                  style={col.attr && hookOptions.config.columns?.find((c) => c.attr === col.attr)?.width ? { width: hookOptions.config.columns.find((c) => c.attr === col.attr)!.width } : undefined}
                  {...getHeaderProps(col, i)}
                >
                  <button
                    type="button"
                    className="jc-grid-sort-btn"
                    // The order is of the loaded page: the endpoint decides which rows are on it,
                    // so the label says "this page" and never promises the whole set (UI-66).
                    title={`${labels.sortPage} ${col.label}`}
                    aria-label={`${labels.sortPage} ${col.label}`}
                    onClick={() => setSort(col.attr ?? col.key)}
                  >
                    {col.label}
                    {state.sort?.attr === (col.attr ?? col.key) ? (state.sort.dir === "asc" ? " ↑" : " ↓") : ""}
                  </button>
                  {col.attr && !col.meta && (
                    <button
                      type="button"
                      className="jc-grid-meta-btn"
                      aria-label={`${labels.showMetadata} ${col.attr}`}
                      onClick={() => toggleMenu(col.attr!)}
                    >
                      ⋮
                    </button>
                  )}
                  {col.attr && !col.meta && openMenu === col.attr && (
                    <div className="jc-grid-meta-menu" ref={menuRef}>
                      {/* How this attribute got to its value, where its metadata already is: the
                          entry is absent when the source cannot answer a temporal read or the
                          config switched history off (T-1431). */}
                      {hookOptions.source.history && hookOptions.config.history.enabled !== false && (
                        <button
                          type="button"
                          className="jc-grid-meta-item"
                          onClick={() => {
                            // The row the person is on, else the first: history belongs to one
                            // entity, and the panel names which.
                            const row = rows[state.activeCell?.row ?? 0] ?? rows[0];
                            // Named as a person reads it: the column's label and the row's name,
                            // never the id (T-2991).
                            const name = cellText(row?.cells.name);
                            const title = hookOptions.labels?.historyLabels?.title ?? labels.history;
                            setHistory({
                              attr: col.attr!,
                              id: row?.id ?? "",
                              heading: `${title}: ${col.label}${name ? ` — ${name}` : ""}`,
                            });
                            setOpenMenu(null);
                          }}
                        >
                          {labels.history}
                        </button>
                      )}
                      {(["observedAt", "unit", "datasetId", "createdAt", "modifiedAt"] as MetaKey[]).map((meta) => {
                        const checked = (state.shown[col.attr!] ?? []).includes(meta);
                        const metaLabel = meta === "observedAt" ? labels.observedAt : meta === "unit" ? labels.unit : meta === "datasetId" ? labels.datasetId : meta === "createdAt" ? labels.createdAt : labels.modifiedAt;
                        return (
                          <label key={meta} className="jc-grid-meta-item">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => handleMetaCheck(col.attr!, meta)}
                            />
                            {metaLabel}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </th>
              ))}
            </tr>
            {filterable.size > 0 && (
              <tr className="jc-grid-filter-row" aria-label={labels.filterRow}>
                {columns.map((col) => {
                  const column = filterable.get(col.key);
                  return (
                    <th key={`filter-${col.key}`} className={`jc-grid-filter${col.pinned ? " jc-grid-pinned" : ""}`}>
                      {column && !asText ? (
                        <FilterCell
                          column={column}
                          label={col.label}
                          labels={labels}
                          filter={state.filters[col.key]}
                          onChange={(next) => setFilter(col.key, next)}
                        />
                      ) : null}
                    </th>
                  );
                })}
              </tr>
            )}
          </thead>
          <tbody className={`jc-grid-tbody${classNames?.row ? ` ${classNames.row}` : ""}`}>
            {spacerAbove > 0 && (
              <tr className="jc-grid-spacer" aria-hidden="true">
                <td colSpan={columns.length} style={{ height: spacerAbove }} />
              </tr>
            )}
            {shownRows.map((row, shownIndex) => {
              const rowIndex = shownFrom + shownIndex;
              return (
              <tr
                key={row.id}
                className={`jc-grid-tr${classNames?.row ? ` ${classNames.row}` : ""}`}
                // A refused update stays visible on its own row, not only in the panel the person
                // may have closed: the value there is still theirs and still unapplied.
                data-refused={refusedOf.has(row.id) ? "true" : undefined}
                data-mark={marks?.rows?.[row.id] ? "row" : undefined}
                title={marks?.rows?.[row.id] ?? rowTitle(row.id)}
                {...getRowProps(row, rowIndex)}
              >
                {columns.map((col, colIndex) => (
                  <td
                    key={`${row.id}-${col.key}`}
                    className={`jc-grid-td${col.pinned ? " jc-grid-pinned" : ""}${classNames?.cell ? ` ${classNames.cell}` : ""}`}
                    {...getCellProps(row, rowIndex, col, colIndex)}
                    data-mark={col.attr && marks?.columns?.[col.attr] ? "column" : undefined}
                    title={
                      (col.attr ? marks?.columns?.[col.attr] : undefined) ??
                      (col.pinned ? cellOf(row, col).text : undefined) ??
                      unitHover(cellOf(row, col).cell, col.meta)
                    }
                  >
                    {renderCellContent(row, col)}
                  </td>
                ))}
              </tr>
              );
            })}
            {spacerBelow > 0 && (
              <tr className="jc-grid-spacer" aria-hidden="true">
                <td colSpan={columns.length} style={{ height: spacerBelow }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {mapAttr && (
        <GridMap
          rows={rows}
          attr={mapAttr}
          activeId={activeRowId}
          onActivate={(id) => {
            const index = rows.findIndex((row) => row.id === id);
            if (index >= 0) {
              // The shape and the row are one selection: clicking a shape moves the grid's active
              // cell to that row, which is what the keyboard and the screen reader follow.
              grid.setActive(index, state.activeCell?.col ?? 0);
            }
          }}
          edits={state.edits}
          onEdit={editing ? setEdit : undefined}
          mode={editing ? "edit" : "view"}
          allowed={mapAllowed}
          area={grid.area}
          onArea={grid.setArea}
          boundsNow={mapBounds}
          labels={mapLabels}
          basemap={basemap}
          engine={mapEngine}
          geoLabels={geoLabels}
          position={mapPosition}
        />
      )}

      {!loading && rows.length === 0 && !error && (
        <div className="jc-grid-empty">{emptySlot ?? labels.empty}</div>
      )}

      {loading && <div className="jc-grid-loading">{labels.loading}</div>}

      {error && <div className="jc-grid-error">{labels.error}: {error}</div>}

      {detailRow && (
        <RowDetail
          row={detailRow}
          name={rowName(detailRow)}
          columns={columns}
          renderValue={renderCellContent}
          labels={{ rowDetail: labels.rowDetail, close: labels.close }}
          onClose={() => {
            setDetailId(null);
            tableRef.current?.focus();
          }}
        >
          {detailExtra?.(detailRow)}
        </RowDetail>
      )}

      {history && (
        <EntityHistory
          source={hookOptions.source}
          id={history.id}
          attr={history.attr}
          heading={history.heading}
          maxPoints={hookOptions.config.history.maxPoints}
          labels={hookOptions.labels?.historyLabels}
          onClose={() => setHistory(null)}
        />
      )}

      {open && (
        <section className="jc-grid-review" aria-label={labels.review}>
          {/* Scrolls sideways on a phone, so the keyboard can reach it as well (WCAG 2.1.1). */}
          <div className="jc-grid-review-rows" tabIndex={0} role="group" aria-label={labels.review}>
            <table>
              <thead>
                <tr>
                  <th>{labels.id}</th>
                  <th>{labels.attribute}</th>
                  <th>{labels.before}</th>
                  <th>{labels.after}</th>
                </tr>
              </thead>
              <tbody>
                {pendingChanges.flatMap((entity) =>
                  entity.changes.map((change) => (
                    <tr key={`${entity.id}-${change.attribute}`}>
                      <td title={entity.id}>{entity.id}</td>
                      <td>{change.attribute}</td>
                      <td>{change.before === undefined ? "—" : String(change.before)}</td>
                      <td>{String(change.after)}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
          {/* What happens to `observedAt`, chosen once for the batch: a corrected value that keeps
              the old timestamp claims to have been observed then (UI-67). */}
          <fieldset>
            <label>
              <input
                type="radio"
                name="jc-grid-observed"
                checked={observed === "keep"}
                onChange={() => setObserved("keep")}
              />
              {labels.observedKeep}
            </label>
            <label>
              <input
                type="radio"
                name="jc-grid-observed"
                checked={observed === "now"}
                onChange={() => setObserved("now")}
              />
              {labels.observedNow}
            </label>
          </fieldset>
          {pendingChanges.length > MAX_ENTITIES && (
            <p className="jc-grid-error">{`${labels.error}: ${MAX_ENTITIES}`}</p>
          )}
          {refused.map((one) => (
            <p key={one.id} className="jc-grid-error">{`${one.id}: ${one.detail}`}</p>
          ))}
          <button
            type="button"
            disabled={applying || pendingChanges.length > MAX_ENTITIES}
            onClick={() => void apply()}
          >
            {applying ? labels.applying : labels.apply}
          </button>
        </section>
      )}

      {filterable.size > 0 && (
        <div className="jc-grid-query">
          <label className="jc-grid-query-text">
            <span>{labels.query}</span>
            {asText ? (
              // The person owns the query from here: the row cannot show every `q` NGSI-LD allows
              // (a `|`, a bracket), so taking it over is how those are written at all.
              <input
                className="jc-grid-query-input"
                value={state.filterText ?? ""}
                onChange={(e) => setFilterText(e.target.value)}
              />
            ) : (
              <output className="jc-grid-query-value">{queryText(askedQuery)}</output>
            )}
          </label>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(queryText(askedQuery));
            }}
          >
            {labels.copyQuery}
          </button>
          <label className="jc-grid-query-switch">
            <input
              type="checkbox"
              checked={asText}
              onChange={(e) => setFilterText(e.target.checked ? (askedQuery.q ?? "") : null)}
            />
            {labels.editAsText}
          </label>
        </div>
      )}

      {virtual ? (
        <div className={`jc-grid-pager${classNames?.pager ? ` ${classNames.pager}` : ""}`} role="status">
          <span className="jc-grid-total">
            {grid.total !== undefined
              ? `${rows.length} ${labels.of} ${grid.total} ${labels.loaded}`
              : `${rows.length} ${labels.loaded}`}
          </span>
          {grid.loadingMore && <span className="jc-grid-loading-more">{labels.loading}</span>}
        </div>
      ) : (
      <div className={`jc-grid-pager${classNames?.pager ? ` ${classNames.pager}` : ""}`}>
        <button
          type="button"
          disabled={state.offset === 0}
          onClick={() => setOffset(Math.max(0, state.offset - hookOptions.config.pageSize))}
        >
          {labels.previous}
        </button>
        <span className="jc-grid-page-info">{`${labels.page} ${currentPage}`}</span>
        {totalPages !== undefined && <span className="jc-grid-page-count">{`/ ${totalPages}`}</span>}
        {/* The endpoint's own count, not the page's: an answer the gateway narrowed carries none,
            and then the footer says nothing rather than a number it guessed (R22). */}
        {grid.total !== undefined && (
          <span className="jc-grid-total">{`${grid.total} ${labels.matching}`}</span>
        )}
        <button
          type="button"
          disabled={totalPages !== undefined ? currentPage >= totalPages : rows.length < hookOptions.config.pageSize}
          onClick={() => setOffset(state.offset + hookOptions.config.pageSize)}
        >
          {labels.next}
        </button>
      </div>
      )}
    </div>
  );
}

/** A row's height until one is measured, and the rows drawn when the box has no height yet. */
const FALLBACK_ROW_HEIGHT = 36;
const FALLBACK_VIEWPORT_ROWS = 30;
/** Rows drawn beyond the window on each side, so a scroll shows rows rather than blank space. */
const OVERSCAN = 10;

/** The query as a person reads and copies it: the `q`, and the id pattern when one is asked. */
function queryText(asked: { q?: string; idPattern?: string }): string {
  const parts: string[] = [];
  if (asked.q) {
    parts.push(`q=${asked.q}`);
  }
  if (asked.idPattern) {
    parts.push(`idPattern=${asked.idPattern}`);
  }
  return parts.join("&");
}

/**
 * One column's filter: the operators its content allows, and the value(s) the chosen one needs.
 * A filter is sent only once it is complete, so nothing narrows while it is being typed.
 */
function FilterCell({
  column,
  label,
  labels,
  filter,
  onChange,
}: {
  column: FilterColumn;
  label: string;
  labels: { filter: string; value: string; upperValue: string; ops: Record<string, string> };
  filter: ColumnFilter | undefined;
  onChange: (next: ColumnFilter | undefined) => void;
}): React.JSX.Element {
  const ops = opsForKind(column.kind);
  const op = filter?.op ?? ops[0];
  const needed = valuesNeeded(op);
  const type = column.kind === "number" ? "number" : column.kind === "date" ? "date" : "text";
  // An enum's values are picked, several at once: the query asks for any of them (UI-86).
  const picking = column.kind === "enum" && op === "anyOf";
  return (
    <div className="jc-grid-filter-cell">
      <select
        aria-label={`${labels.filter}: ${label}`}
        value={filter ? op : ""}
        onChange={(e) => {
          const next = e.target.value as ColumnFilter["op"] | "";
          if (next === "") {
            onChange(undefined);
            return;
          }
          onChange({ op: next, value: filter?.value ?? "", value2: filter?.value2 });
        }}
      >
        <option value="">—</option>
        {ops.map((each) => (
          <option key={each} value={each}>
            {labels.ops[each] ?? each}
          </option>
        ))}
      </select>
      {filter && picking && (
        <select
          multiple
          aria-label={`${labels.value}: ${label}`}
          value={filter.values ?? []}
          size={Math.min(5, column.options?.length ?? 1)}
          onChange={(e) =>
            onChange({ ...filter, values: Array.from(e.target.selectedOptions, (option) => option.value) })
          }
        >
          {(column.options ?? []).map((option) => (
            <option key={option.value} value={option.value} title={option.description}>
              {optionLabel(option)}
            </option>
          ))}
        </select>
      )}
      {filter && needed >= 1 && !picking && (
        <input
          aria-label={`${labels.value}: ${label}`}
          type={type}
          value={filter.value}
          onChange={(e) => onChange({ ...filter, value: e.target.value })}
        />
      )}
      {filter && needed === 2 && (
        <input
          aria-label={`${labels.upperValue}: ${label}`}
          type={type}
          value={filter.value2 ?? ""}
          onChange={(e) => onChange({ ...filter, value2: e.target.value })}
        />
      )}
    </div>
  );
}

/**
 * A value typed into a cell, in the shape the cell had: a column of numbers stays numbers, so the
 * endpoint is not sent a string where it stored a measurement.
 */
/**
 * The typed text as the value it is sent as. With the attribute's rule the model decides: a number
 * slot sends a number, a boolean one `true`/`false`, a text, date or address slot the text as typed
 * (so "007" or "true" in a name stays text). Text the rule refuses is kept as typed, for the cell
 * to say why. Without a rule the stored value's shape is the guide.
 */
function coerce(next: string, before: string, rule?: ValueRule): unknown {
  switch (rule?.kind) {
    case "integer":
    case "number":
      return next.trim() !== "" && Number.isFinite(Number(next)) ? Number(next) : next;
    case "boolean":
      return next === "true" ? true : next === "false" ? false : next;
    case "string":
    case "date":
    case "datetime":
    case "uri":
      return next;
  }
  if (before !== "" && Number.isFinite(Number(before)) && Number.isFinite(Number(next))) {
    return Number(next);
  }
  if (next === "true" || next === "false") {
    return next === "true";
  }
  return next;
}

/**
 * An enum cell: a picker of exactly the permissible values, showing each one's title and storing
 * the value (UI-86). A stored value the enum does not list stays selected and is marked invalid,
 * so looking at a row never rewrites it; only picking another value is a change.
 */
function EnumCell({
  label,
  value,
  options,
  changed,
  notInList,
  onChange,
}: {
  label: string;
  value: string;
  options: EnumOption[];
  changed: boolean;
  notInList: string;
  onChange: (next: string) => void;
}): React.JSX.Element {
  const outside = value !== "" && !options.some((option) => option.value === value);
  return (
    <select
      aria-label={label}
      aria-invalid={outside || undefined}
      className={`jc-grid-cell-input${changed ? " jc-grid-cell-changed" : ""}${outside ? " jc-grid-cell-invalid" : ""}`}
      data-changed={changed ? "true" : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {value === "" && <option value="">—</option>}
      {outside && <option value={value}>{`${value} (${notInList})`}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value} title={option.description}>
          {optionLabel(option)}
        </option>
      ))}
    </select>
  );
}

/** The input a value is typed in: the model's range first, else the stored value's shape. */
function inputKindOf(rule: ValueRule | undefined, own: unknown): CellInputKind {
  switch (rule?.kind) {
    case "integer":
    case "number":
      return "number";
    case "date":
      return "date";
    case "uri":
      return "url";
    case "string":
    case "datetime":
      // A datetime is typed as ISO text: the browser's datetime-local drops the zone NGSI-LD keeps.
      return "text";
  }
  return typeof own === "number" ? "number" : "text";
}

type CellInputKind = "text" | "number" | "date" | "url";

/** One cell a person may correct: an input that says what it belongs to, marked while pending. */
function EditableCell({
  label,
  value,
  changed,
  kind,
  invalid,
  onChange,
}: {
  label: string;
  value: string;
  changed: boolean;
  kind: CellInputKind;
  /** Why the value cannot be sent as it is: its model's rule, or the gateway's refusal. */
  invalid?: string;
  onChange: (next: string) => void;
}): React.JSX.Element {
  const messageId = React.useId();
  return (
    <>
      <input
        aria-label={label}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={invalid ? messageId : undefined}
        className={`jc-grid-cell-input${changed ? " jc-grid-cell-changed" : ""}${invalid ? " jc-grid-cell-invalid" : ""}`}
        data-changed={changed ? "true" : undefined}
        type={kind}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {invalid && (
        <span id={messageId} className="jc-grid-cell-message">
          {invalid}
        </span>
      )}
    </>
  );
}

/** The hover of a value in a unit: its unit's name and code, `microgram per cubic metre (GQ)` (DM-06). */
function unitHover(cell: RichCell | RichCell[] | undefined, meta: string | null): string | undefined {
  if (meta || !cell || Array.isArray(cell) || cell.kind !== "property" || !cell.unitCode) return undefined;
  return unitTitle(cell.unitCode);
}
