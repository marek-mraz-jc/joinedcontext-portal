import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RichRow, RichCell } from "./model";
import { cellText } from "./model";
import type { ColumnLayout, MetaKey, UseEntityGridOptions, VisibleColumn } from "./useEntityGrid";
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH, readableName, useEntityGrid } from "./useEntityGrid";
import { CellView, cellDisplayText, columnKind, formatDate, targetName } from "./cells";
import type { CellLabels, ColumnKind } from "./cells";
import { ColumnMenu } from "./ColumnMenu";
import { opsForKind, valuesNeeded } from "./filters";
import type { ColumnFilter, FilterColumn } from "./filters";
import { applyChanges, MAX_ENTITIES, MAX_REASON, reasonOk } from "./apply";
import type { EntityChange, Observed, Refusal } from "./apply";
import { EntityHistory } from "./EntityHistory";
import { GridMap } from "./GridMap";
import { unitTitle } from "../sdk/units";
import { useEntitySelection } from "../sdk/panel";
import type { GridMapLabels } from "./GridMap";
import { mapAttrOf } from "./mapRows";
import { TILE_THRESHOLD, useTileTemplate } from "../geo/tiles";
import type { DrawEngine, GeoLabels } from "../geo/GeoEditor";
import type { GeometryType } from "../geo/validate";
import { optionLabel } from "../enums";
import type { EnumOption } from "../enums";
import { objectsOf, pointingAt, searchTargets } from "../relations";
import type { TargetOption } from "../relations";
import { NGSI_LD_NULL, RelationPicker } from "./RelationPicker";
import { RowDetail } from "./RowDetail";
import { AttributeMetadata } from "./AttributeMetadata";
import type { RowDetailTab } from "./RowDetail";
import { parseClipboard, planPaste } from "./paste";
import { problemOf } from "./rules";
import { queryExample } from "./queryExample";
import type { ValueRule } from "./rules";
import "./grid.css";

/** The text boxes a typed character starts editing; a date or a picker opens with Enter instead. */
const TYPED_INPUTS = new Set(["text", "number", "url", "search"]);

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
   * The query the person's filters ask the source for, the typed one or the filter row's, each
   * time it changes: what a host saves as a view's filter (API/01 §30).
   */
  onQuery?: (query: { q?: string; idPattern?: string }) => void;
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
  /** What the host adds under a row's fields in its detail (T-3106). */
  detailExtra?: (row: RichRow) => React.ReactNode;
  /** The host's own tabs in a row's detail after Fields and History, such as its comments (T-4828). */
  detailTabs?: (row: RichRow) => RowDetailTab[];
  /**
   * The row whose detail is open, by id, for a host that keeps it in the address (`?row=<urn>`,
   * T-4828): `undefined` leaves it to the grid, `null` closes it. A row not on the loaded page is
   * read by its id and shown without editors until the grid loads it.
   */
  openRow?: string | null;
  onOpenRow?: (id: string | null) => void;
  /** The open row's tab and History attribute, for a host that keeps them in the address (T-5602). */
  detailPlace?: { tab?: string | null; attr?: string | null };
  onDetailPlace?: (place: { tab: string; attr: string }) => void;
  toolbar?: React.ReactNode;
  /** The bounds the "Draw area" action asks about; the host owns the map's viewport. */
  mapBounds?: () => [number, number, number, number] | null;
  empty?: React.ReactNode;
  /**
   * Each attribute's rule as its model states it (range, bounds, pattern, required), by name: a
   * pending value that breaks it is marked at its cell and holds Apply back (T-3097).
   */
  rules?: Record<string, ValueRule>;
  /**
   * The tone a row is marked with and why, as a view's colour rules decide it (API/01 §30): drawn
   * as a swatch in the row's first cell that names the reason, so the colour is never the only
   * way the row says it.
   */
  rowTone?: (row: RichRow) => { tone: string; label: string } | undefined;
  /** Each new value reads the rows again where they are, keeping the scroll and the checked rows: a host's live change. */
  reloadKey?: number;
  className?: string;
  classNames?: Partial<Record<"root" | "table" | "header" | "row" | "cell" | "pager", string>>;
  /** The reader's language tag, for numbers and dates (`fi`, `en-GB`); the browser's without it. */
  locale?: string;
  /**
   * Every change the header menu makes to the order, widths or labels (T-4827), for a host that
   * keeps them in a saved view; without it the grid keeps them itself until it unmounts.
   */
  onLayout?: (next: ColumnLayout) => void;
  /** "Hide field" in the header menu, for a host that holds `hidden`; without it the grid hides it itself. */
  onHide?: (attr: string) => void;
  /**
   * The per-column filter row; `false` for a host that asks through a filter panel of its own and
   * hands the query in as `query` (T-4883).
   */
  filterRow?: boolean;
  /** The box under the rows that shows the asked query; `false` for a host that opens it from its own toolbar. */
  queryBox?: boolean;
  /** Every column the endpoint can be asked about, with its kind, for a host's own filter panel. */
  onFilterColumns?: (columns: FilterColumn[]) => void;
  /**
   * A leading column with the row's number, a checkbox and an expand button (T-4883), with the
   * names a screen reader hears; the checked rows are the host's (`selected`).
   */
  rowNumbers?: { selectRow: string; selectAll: string };
  selected?: readonly string[];
  onSelectedChange?: (ids: string[]) => void;
  /** Rows of one line (`small`), two or four (T-4883); without it a cell keeps the grid's own wrapping. */
  rowSize?: "small" | "medium" | "large";
  /** What a column's footer cell shows, such as the host's aggregation of the whole filtered set. */
  footer?: (column: VisibleColumn) => React.ReactNode;
  /** What a group's header shows after its name and value (T-5188), such as the group's count. */
  groupHeader?: (group: GridGroup) => React.ReactNode;
}

/** One group header of a grid grouped by `groupBy` (T-5188): its level and the values it is in. */
export interface GridGroup {
  /** 0 for the outermost group. */
  level: number;
  attr: string;
  /** The values of this group and the groups around it, outermost first; `undefined` for an absent value. */
  path: { attr: string; value: unknown }[];
}

/** The glyph a header shows for what its column holds; the kind's name is what a screen reader hears. */
const KIND_ICON: Record<ColumnKind, string> = {
  text: "Aa",
  number: "#",
  boolean: "✓",
  datetime: "◷",
  geo: "⌖",
  relationship: "↗",
  language: "文",
  structured: "{}",
  list: "≡",
};

const KIND_LABEL: Record<ColumnKind, keyof GridLabelsAll> = {
  text: "kindText",
  number: "kindNumber",
  boolean: "kindBoolean",
  datetime: "kindDatetime",
  geo: "kindGeo",
  relationship: "kindRelationship",
  language: "kindLanguage",
  structured: "kindStructured",
  list: "kindList",
};
type GridLabelsAll = import("./useEntityGrid").GridLabels;

/** `list` with `attr` moved to `index`, every other name in its order. */
export function moveTo(list: readonly string[], attr: string, index: number): string[] {
  const rest = list.filter((each) => each !== attr);
  const at = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, at), attr, ...rest.slice(at)];
}

const DRAG_TYPE = "application/x-jc-grid-column";
const EMPTY_IDS: readonly string[] = [];
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

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
    onQuery,
    marks,
    toolbar,
    detailExtra,
    detailTabs,
    openRow,
    onOpenRow,
    detailPlace,
    onDetailPlace,
    mapEngine,
    mapAllowed,
    mapLabels,
    geoLabels,
    basemap,
    mapBounds,
    empty: emptySlot,
    rules,
    rowTone,
    reloadKey,
    className,
    classNames,
    locale,
    onLayout,
    onHide,
    filterRow = true,
    queryBox = true,
    onFilterColumns,
    rowNumbers,
    selected = EMPTY_IDS,
    onSelectedChange,
    rowSize,
    footer,
    groupHeader,
    ...hookOptions
  } = props;

  // The header menu's order, widths and labels: the host's when it keeps them, else the grid's own.
  const [ownLayout, setOwnLayout] = useState<ColumnLayout>(() => hookOptions.layout ?? {});
  const [ownHidden, setOwnHidden] = useState<string[]>([]);
  const layout = onLayout ? (hookOptions.layout ?? {}) : ownLayout;
  const setLayout = useCallback((next: ColumnLayout) => (onLayout ? onLayout(next) : setOwnLayout(next)), [onLayout]);
  const hostHidden = hookOptions.hidden;
  const hiddenNow = useMemo(
    () => (onHide || ownHidden.length === 0 ? hostHidden : [...(hostHidden ?? []), ...ownHidden]),
    [onHide, hostHidden, ownHidden],
  );
  const grid = useEntityGrid({ ...hookOptions, layout, hidden: hiddenNow });
  const reloadGrid = grid.reload;
  const reloadedFor = useRef(reloadKey);
  useEffect(() => {
    if (reloadedFor.current === reloadKey) return;
    reloadedFor.current = reloadKey;
    reloadGrid();
  }, [reloadKey, reloadGrid]);
  const where = locale ?? (typeof navigator !== "undefined" ? navigator.language : "en");
  const selection = useEntitySelection();
  const queryHintId = React.useId();
  const { rows, columns, loading, error, labels, state, cellOf, toggleMeta, setOffset, setSort, setFilter, setFilterText, filterColumns, askedQuery, setEdit, clearEdits, pendingChanges, reload, setEdits, getGridProps, getHeaderProps, getRowProps, getCellProps } = grid;
  // The entity's own timestamps sort the page even where the source orders the answer (useEntityGrid).
  const sortLabel = (col: { key: string }): string =>
    grid.sortsAll && !col.key.startsWith("entity:") ? labels.sortAll : labels.sortPage;

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
  const example = useMemo(
    () => queryExample(columns.filter((c) => c.attr !== null && c.meta === null).map((c) => c.attr!), rows[0]),
    [columns, rows],
  );
  // "Copied" for two seconds after the query reached the clipboard.
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  // On a phone the filter row folds under one button (T-5415); wider screens always show it.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters = Object.keys(state.filters).length;
  useEffect(() => {
    onFilterColumns?.([...filterable.values()]);
  }, [filterable, onFilterColumns]);
  // Shift-click checks the range from the row clicked before (T-4883).
  const lastChecked = useRef<number | null>(null);
  const checkRow = (rowIndex: number, id: string, range: boolean) => {
    if (!onSelectedChange) return;
    const on = !selected.includes(id);
    const from = range && lastChecked.current !== null ? Math.min(lastChecked.current, rowIndex) : rowIndex;
    const to = range && lastChecked.current !== null ? Math.max(lastChecked.current, rowIndex) : rowIndex;
    const ids = rows.slice(from, to + 1).map((row) => row.id);
    lastChecked.current = rowIndex;
    onSelectedChange(on ? [...new Set([...selected, ...ids])] : selected.filter((each) => !ids.includes(each)));
  };
  const allChecked = rows.length > 0 && rows.every((row) => selected.includes(row.id));
  const lead = rowNumbers ? 1 : 0;
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
  // Why the person writes, sent with each update (DM-113): a default they can change, never empty.
  const [reason, setReason] = useState<string | null>(null);
  const reasonText = reason ?? labels.reasonDefault;
  // What the last apply wrote, with the values it replaced, so Undo can write those back.
  const [lastApplied, setLastApplied] = useState<{ entities: EntityChange[]; reason: string } | null>(null);
  const [undoNote, setUndoNote] = useState<string | null>(null);
  const reasonHintId = React.useId();
  const [history, setHistory] = useState<{ attr: string; id: string; heading: string } | null>(null);
  // The row whose detail panel is open, by id, so a new page closes it rather than showing a row
  // that is no longer listed (T-3097).
  const [ownDetailId, setOwnDetailId] = useState<string | null>(null);
  const detailId = openRow === undefined ? ownDetailId : openRow;
  const setDetailId = useCallback(
    (id: string | null) => {
      setOwnDetailId(id);
      onOpenRow?.(id);
    },
    [onOpenRow],
  );
  // Inside an App's shell a row opens in the shell's one entity panel (SDK-40), else in the grid's own.
  const openDetail = useCallback(
    (row: RichRow) => (selection.inShell ? selection.select({ id: row.id, type: row.type }) : setDetailId(row.id)),
    [selection, setDetailId],
  );
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
  // Columns waiting beyond the right edge: the table says so in words as well as by its shadow (T-5415).
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const box = scrollRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const measure = () => setOverflows(box.scrollWidth > box.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (box.firstElementChild) observer.observe(box.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, []);
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
  // A refusal that names its attribute belongs on that cell, beside the value (DM-70); one that
  // names none, a 403 of the Policy, on every cell of the entity still pending, since each of
  // them is what did not land.
  const refusedCell = useMemo(
    () =>
      new Map(
        refused.flatMap((one) =>
          (one.slot ? [one.slot] : Object.keys(state.edits[one.id] ?? {})).map(
            (attr) => [`${one.id}\u0000${attr}`, one.detail] as const,
          ),
        ),
      ),
    [refused, state.edits],
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
        reason: reasonText,
        observed,
        fallback: labels.error,
      });
      const landed = pendingChanges.filter((entity) => result.applied.includes(entity.id));
      setLastApplied(landed.length > 0 ? { entities: landed, reason: reasonText.trim() } : null);
      setUndoNote(null);
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
  }, [hookOptions.source, pendingChanges, reasonText, observed, labels.error, state.edits, setEdits, reload]);

  /**
   * Writes back what the last apply replaced, as a correction with its own reason (DM-113): an
   * attribute the apply added is written as NGSI-LD's null, so it goes again. What the endpoint
   * refuses is said at its row, as any refusal.
   */
  const undo = useCallback(async () => {
    if (!lastApplied) return;
    setApplying(true);
    try {
      const back: EntityChange[] = lastApplied.entities.map((entity) => ({
        id: entity.id,
        changes: entity.changes.map((change) => ({ ...change, before: change.after, after: change.before ?? NGSI_LD_NULL })),
      }));
      const result = await applyChanges({
        source: hookOptions.source,
        entities: back,
        reason: `${labels.undoReason}: ${lastApplied.reason}`.slice(0, MAX_REASON),
        fallback: labels.error,
      });
      setRefused(result.refused);
      setLastApplied(null);
      if (result.refused.length === 0) setUndoNote(labels.undone);
      reload();
    } finally {
      setApplying(false);
    }
  }, [lastApplied, hookOptions.source, labels.undoReason, labels.error, labels.undone, reload]);

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const cellLabels = useMemo<CellLabels>(
    () => ({ yes: labels.yes, no: labels.no, points: labels.points, openTarget: labels.openTarget }),
    [labels.yes, labels.no, labels.points, labels.openTarget],
  );

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

  // A value as it reads, without an editor: the grid's cells and a row opened by its id alone (T-5600).
  const readValue = useCallback((row: RichRow, column: VisibleColumn): React.ReactNode => {
    const { text, cell } = cellOf(row, column);
    // An enum's value reads as its label, the one its filter and its editor already offer (T-4200).
    const options = column.attr ? hookOptions.enums?.[column.attr] : undefined;
    const one = Array.isArray(cell) ? undefined : cell;
    const option = options && one?.kind !== "relationship" ? options.find((o) => o.value === String(one?.value)) : undefined;
    if (option) return <>{optionLabel(option)}</>;
    // The value by what it holds: a number with its unit, a local date, a point, a chip (T-4827).
    if (column.attr !== null && column.meta === null) {
      return <CellView cell={cell} locale={where} labels={cellLabels} onOpen={onOpenRelationship} />;
    }
    // A timestamp column (observed, created, modified) in the reader's own time.
    return <>{ISO_TIMESTAMP.test(text) ? formatDate(text, where) : text}</>;
  }, [where, cellLabels, cellOf, onOpenRelationship, hookOptions.enums]);
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
    // panel (T-3097): the person reads the row by its name and opens it from there. Inside an
    // App's shell that is the shell's one entity panel (SDK-40, T-3396), else the grid's own.
    if (column.key === "id" || isPrimary(column)) {
      // A row named by nothing but its id is called by the id's last part, as its detail heading
      // and its chips are: every id of a type starts `urn:ngsi-ld:Type:…` (T-4265, T-5619).
      const named = rowName(row);
      const name = named === row.id ? targetName(row.id).name : named;
      return (
        <button
          type="button"
          className="jc-grid-open"
          aria-label={`${labels.openRow}: ${name}`}
          title={row.id}
          onClick={(e) => {
            e.stopPropagation();
            openDetail(row);
          }}
        >
          {column.key === "id" ? targetName(text).name : text || row.id}
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

    // A relationship is a chip naming its target, which opens it (T-4827).
    if (column.attr && column.meta === null && cell && !Array.isArray(cell) && cell.kind === "relationship" && onOpenRelationship) {
      return <CellView cell={cell} locale={where} labels={cellLabels} onOpen={onOpenRelationship} />;
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

    return readValue(row, column);
  }, [readValue, where, cellLabels, cellOf, renderers, onOpenRelationship, editable, state.edits, labels.edit, labels.empty, labels.notInList, labels.loading, labels.error, labels.relationMore, labels.openRow, isPrimary, rowName, openDetail, hookOptions.enums, setEdit, relations, inverse, searchOf, pickerLabels, refusedCell, ruleProblems, rules, labels.yes, labels.no]);

  // One attribute in the row's detail (T-5599): an editor where the row is on the page and the
  // grant writes it, else the value as a reader sees it, an enum by its label, and an attribute
  // with no value says "not set" instead of nothing. An edit is written against the row as the page
  // loaded it, so a row read on its own shows its values without editors.
  const detailValue = useCallback(
    (row: RichRow, column: VisibleColumn): React.ReactNode => {
      const listed = rows.some((one) => one.id === row.id);
      if (listed && editable(column)) return renderCellContent(row, column);
      const cell = column.attr ? row.cells[column.attr] : undefined;
      if (cellDisplayText(cell, where, cellLabels).trim() === "") return <span className="jc-grid-detail-empty">{labels.rowNotSet}</span>;
      return listed ? renderCellContent(row, column) : readValue(row, column);
    },
    [rows, editable, renderCellContent, readValue, where, cellLabels, labels.rowNotSet],
  );

  // Metadata menu toggle
  const toggleMenu = useCallback((attr: string) => {
    setOpenMenu((prev) => (prev === attr ? null : attr));
  }, []);

  const handleMetaCheck = useCallback((attr: string, meta: MetaKey) => {
    toggleMeta(attr, meta);
  }, [toggleMeta]);

  /** The attributes in the order the header shows them: what Move and a drop rearrange. */
  const order = useMemo(() => columns.filter((c) => c.attr !== null && c.meta === null).map((c) => c.attr!), [columns]);
  // The primary column stays first: nothing moves in front of it.
  const firstMovable = columns.some((c) => c.pinned && c.attr !== null) ? 1 : 0;
  const [dragOver, setDragOver] = useState<string | null>(null);
  const formatOf = useMemo(() => new Map(hookOptions.config.columns.map((column) => [column.attr, column.format])), [hookOptions.config.columns]);
  const kindOf = useMemo(() => {
    const kinds = new Map<string, ColumnKind>();
    const sample = rows.slice(0, 50);
    for (const col of columns) {
      if (col.meta === "observedAt" || col.meta === "createdAt" || col.meta === "modifiedAt" || col.key.startsWith("entity:")) kinds.set(col.key, "datetime");
      else if (col.attr === null || col.meta !== null) kinds.set(col.key, "text");
      else kinds.set(col.key, columnKind(sample.map((row) => row.cells[col.attr!]), rules?.[col.attr]?.kind, Boolean(relations?.[col.attr])));
    }
    return kinds;
  }, [columns, rows, rules, relations]);
  /** A column's label without the unit the grid adds: what Rename starts from. */
  const baseLabel = (col: VisibleColumn): string => col.label.replace(/ \([^()]*\)$/, "");
  const closeMenu = useCallback(() => {
    const attr = openMenu;
    setOpenMenu(null);
    // Back to the button that opened the menu, so a keyboard carries on where it was.
    if (attr) tableRef.current?.querySelector<HTMLElement>(`th[data-col-attr="${attr.replace(/["\\]/g, "\\$&")}"] .jc-grid-meta-btn`)?.focus();
  }, [openMenu]);
  const focusFilter = useCallback((key: string) => {
    setOpenMenu(null);
    const cells = tableRef.current?.querySelectorAll<HTMLElement>("[data-filter-for]") ?? [];
    for (const cell of cells) {
      if (cell.dataset.filterFor === key) cell.querySelector<HTMLElement>("select, input")?.focus();
    }
  }, []);
  const hideColumn = useCallback((attr: string) => {
    setOpenMenu(null);
    if (onHide) onHide(attr);
    else setOwnHidden((before) => [...before, attr]);
  }, [onHide]);
  // The way back from "Hide field" where the grid holds the hide itself (T-5620); a host that holds
  // `hidden` offers its own, and the host's own `hidden` (an Endpoint's projection) is not the person's.
  const [shownAgain, setShownAgain] = useState<string | null>(null);
  const showColumns = (attrs: readonly string[]) => {
    const left = ownHidden.filter((attr) => !attrs.includes(attr));
    setOwnHidden(left);
    // With none left the control goes: focus moves to the restored column's menu button once drawn.
    if (left.length === 0) setShownAgain(attrs[0] ?? null);
  };
  useEffect(() => {
    if (shownAgain === null) return;
    setShownAgain(null);
    tableRef.current?.querySelector<HTMLElement>(`th[data-col-attr="${shownAgain.replace(/["\\]/g, "\\$&")}"] .jc-grid-meta-btn`)?.focus();
  }, [shownAgain]);
  const hiddenLabel = (attr: string): string =>
    layout.labels?.[attr] ?? hookOptions.config.columns.find((column) => column.attr === attr)?.label ?? readableName(attr);
  const renameColumn = useCallback((attr: string, text: string | undefined) => {
    const { [attr]: _gone, ...rest } = layout.labels ?? {};
    setLayout({ ...layout, labels: text === undefined ? rest : { ...rest, [attr]: text } });
  }, [layout, setLayout]);
  const widthOf = (attr: string, fallback?: number): number =>
    fallback ?? tableRef.current?.querySelector<HTMLElement>(`th[data-col-attr="${attr.replace(/["\\]/g, "\\$&")}"]`)?.offsetWidth ?? 0;
  const widen = (attr: string, current: number | undefined, delta: number) => {
    const from = widthOf(attr, current) || 160;
    const next = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(from + delta)));
    setLayout({ ...layout, width: { ...(layout.width ?? {}), [attr]: next } });
  };
  /** Dragging a header's edge: the column follows the pointer and keeps its width when let go. */
  const startResize = (e: React.PointerEvent<HTMLElement>, attr: string) => {
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.closest("th");
    if (!th) return;
    const startX = e.clientX;
    const startWidth = th.offsetWidth;
    let width = startWidth;
    const move = (ev: PointerEvent) => {
      width = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(startWidth + ev.clientX - startX)));
      th.style.width = th.style.minWidth = th.style.maxWidth = `${width}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (width !== startWidth) setLayout({ ...layout, width: { ...(layout.width ?? {}), [attr]: width } });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

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

  const { q: askedQ, idPattern: askedIdPattern } = grid.askedQuery;
  React.useEffect(() => {
    onQuery?.({ q: askedQ, idPattern: askedIdPattern });
  }, [askedQ, askedIdPattern, onQuery]);

  // The map is a second view of the same page: it is offered only where the config asked for one
  // AND the rows actually carry a geometry, so a type without one gets no panel and no action.
  const mapConfig = hookOptions.config.map;
  const mapAttr = mapConfig?.enabled ? mapAttrOf(rows, mapConfig.attr) : null;
  const mapPosition = mapConfig?.position ?? "right";
  // Past a count the map also draws the whole type from the Endpoint's tiles (T-5195). A tile takes
  // no query, so a narrowed answer stays on the page's shapes, and only `location` is tiled.
  const tileTemplate = useTileTemplate(
    hookOptions.source.tilesAt ?? null,
    hookOptions.config.type,
    mapAttr === "location" && !grid.narrowed && (grid.total ?? 0) > TILE_THRESHOLD,
  );
  const activeRowId = rows[state.activeCell?.row ?? -1]?.id ?? null;
  const listedRow = detailId === null ? undefined : rows.find((row) => row.id === detailId);
  // A deep link to a row the page has not loaded: read by its id, through the same source and Policy.
  const [linked, setLinked] = useState<RichRow | null>(null);
  const getRow = hookOptions.source.get;
  React.useEffect(() => {
    if (detailId === null || listedRow || loading) return;
    let live = true;
    // Gone, or not readable by this person: the same answer either way, and the link closes.
    const missing = () => live && setDetailId(null);
    getRow(detailId).then(
      (row) => (row ? live && setLinked(row) : missing()),
      missing,
    );
    return () => {
      live = false;
    };
  }, [detailId, listedRow, loading, getRow, setDetailId]);
  const detailRow = listedRow ?? (linked && linked.id === detailId ? linked : undefined);
  const historyOn = Boolean(hookOptions.source.history) && hookOptions.config.history.enabled !== false;

  // What is typed and not applied yet, with Review and Discard: under the toolbar, and inside the row
  // dialog too, where the page behind is inert; Review there closes the dialog first (T-4828).
  const pendingBar = (inDialog: boolean): React.ReactNode =>
    editing && pendingChanges.length > 0 ? (
      <div className="jc-grid-pending" role="status">
        <span>{`${pendingChanges.length} ${labels.pending}`}</span>
        {ruleProblems.size > 0 && <span className="jc-grid-to-correct">{`${ruleProblems.size} ${labels.toCorrect}`}</span>}
        <button
          type="button"
          disabled={ruleProblems.size > 0}
          onClick={() => {
            if (inDialog) setDetailId(null);
            setOpen(true);
          }}
        >
          {labels.review}
        </button>
        <button type="button" onClick={() => { clearEdits(); setRefused([]); }}>
          {labels.discard}
        </button>
      </div>
    ) : null;

  // The table is the grid's one tab stop. Enter or F2 goes into the active cell's own control (its
  // input, list or picker), Escape comes back to the grid, and the active cell is kept in view.
  const gridProps = getGridProps() as Record<string, unknown> & { onKeyDown: (e: React.KeyboardEvent) => void };
  const activeCellId = gridProps["aria-activedescendant"] as string | undefined;
  React.useEffect(() => {
    if (!activeCellId) return;
    document.getElementById(activeCellId)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeCellId]);
  // The cell being edited and its pending value when editing began, so Escape puts that back.
  const entered = useRef<{ id: string; attr: string; before: unknown } | null>(null);
  const cellAt = useCallback(
    (row: number, col: number) => {
      const id = rows[row]?.id;
      const column = columns[col];
      return id !== undefined && column && editable(column) && column.attr !== null ? { id, attr: column.attr } : null;
    },
    [rows, columns, editable],
  );
  const onGridFocus = useCallback(
    (e: React.FocusEvent<HTMLTableElement>) => {
      if (e.target === e.currentTarget) return;
      // A cell's own id ends in -r{row}-c{col}: the control focused, by key or click, is that cell's.
      const where = /-r(\d+)-c(\d+)$/.exec(e.target.closest('[role="gridcell"]')?.id ?? "");
      if (!where) return;
      // Tab goes from cell to cell in the page's own order and out of the grid after the last, so
      // the active cell follows the focus rather than holding the key (WCAG 2.1.2).
      const [row, col] = [Number(where[1]), Number(where[2])];
      if (state.activeCell?.row !== row || state.activeCell.col !== col) grid.setActive(row, col);
      const cell = cellAt(row, col);
      if (cell && (entered.current?.id !== cell.id || entered.current.attr !== cell.attr)) {
        entered.current = { ...cell, before: state.edits[cell.id]?.[cell.attr] };
      }
    },
    [cellAt, state.edits, state.activeCell, grid],
  );
  /** Leaves a cell's control for the grid; Enter then goes one row down, as in a spreadsheet. */
  const leaveCell = useCallback(
    (table: HTMLTableElement, key: string) => {
      entered.current = null;
      table.focus();
      if (key === "Enter") grid.moveActive("ArrowDown");
    },
    [grid],
  );
  const onGridKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTableElement>) => {
      const onGrid = e.target === e.currentTarget;
      if (!onGrid) {
        const control = e.target as HTMLElement;
        if (e.key === "Escape") {
          // Escape cancels what was typed since the cell was entered, then comes back to the grid.
          e.preventDefault();
          const was = entered.current;
          if (was) setEdit(was.id, was.attr, was.before);
          leaveCell(e.currentTarget, "Escape");
          return;
        }
        // In a cell's text box, Enter keeps the value and goes on, as in a spreadsheet; a picker's
        // own button or list keeps its keys.
        if (control.tagName === "INPUT" && control.closest('[role="gridcell"]') && e.key === "Enter") {
          e.preventDefault();
          leaveCell(e.currentTarget, e.key);
          return;
        }
      }
      const control = activeCellId
        ? document.getElementById(activeCellId)?.querySelector<HTMLElement>("input, select, textarea, button")
        : null;
      if (onGrid && (e.key === "Enter" || e.key === "F2") && control) {
        e.preventDefault();
        control.focus();
        return;
      }
      // Typing on an editable cell starts editing it with that character, as Baserow and every
      // spreadsheet do: the value is replaced, Escape brings it back.
      const typed = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
      const at = state.activeCell;
      const cell = at ? cellAt(at.row, at.col) : null;
      if (onGrid && typed && cell && control instanceof HTMLInputElement && TYPED_INPUTS.has(control.type)) {
        e.preventDefault();
        control.focus();
        const stored = storedText(rows[at!.row]?.cells[cell.attr]);
        setEdit(cell.id, cell.attr, e.key === stored ? undefined : coerce(e.key, stored, rules?.[cell.attr]));
        return;
      }
      gridProps.onKeyDown(e);
    },
    [activeCellId, gridProps, setEdit, leaveCell, state.activeCell, cellAt, rows, rules],
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

  /**
   * The window of rows in sight, read off the scroll position. Once its end passes 60 % of the
   * loaded rows the next page is asked for, so it is there before the person reaches the end
   * (T-5623).
   */
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
    if (grid.more && start + inSight + 2 * OVERSCAN >= rows.length * PREFETCH_AT) {
      grid.loadMore();
    }
  }, [virtual, grid, rows.length]);
  // A page that lands while the window is still past the mark asks for the next one: a person who
  // scrolled to the end waits for no further scroll event, which a scroll box at its end never sends.
  React.useEffect(() => {
    if (virtual && !grid.loadingMore) onScroll();
  }, [virtual, grid.loadingMore, rows.length, onScroll]);
  // A key that moves the active cell out of the window scrolls to it; the scroll moves the window.
  // Only a move of the cell does: a person scrolling away from it is not pulled back (T-5623).
  const scrolledTo = useRef<number | undefined>(undefined);
  React.useEffect(() => {
    const row = state.activeCell?.row;
    const box = scrollRef.current;
    if (!virtual || row === undefined || !box || row === scrolledTo.current) return;
    scrolledTo.current = row;
    if (row < windowStart || row >= windowStart + windowSize) {
      box.scrollTop = row * rowHeight.current;
      onScroll();
    }
  }, [virtual, state.activeCell?.row, windowStart, windowSize, onScroll]);
  const shownFrom = virtual ? Math.min(windowStart, Math.max(0, rows.length - 1)) : 0;
  const shownRows = virtual ? rows.slice(shownFrom, shownFrom + windowSize) : rows;
  const spacerAbove = virtual ? shownFrom * rowHeight.current : 0;
  const spacerBelow = virtual ? Math.max(0, rows.length - shownFrom - shownRows.length) * rowHeight.current : 0;
  // A group starts where a row's group value differs from the row before it (T-5188): the rows
  // come ordered by the group keys, so each group's rows are together.
  const groupBy = hookOptions.groupBy ?? [];
  const groupValue = (row: RichRow, attr: string): unknown => {
    const cell = row.cells[attr];
    const one = Array.isArray(cell) ? cell[0] : cell;
    return one?.kind === "relationship" ? one.object : one?.value;
  };
  const groupsBefore = (row: RichRow, rowIndex: number): GridGroup[] => {
    const before = rowIndex > 0 ? rows[rowIndex - 1] : undefined;
    const path = groupBy.map((attr) => ({ attr, value: groupValue(row, attr) }));
    const first = before === undefined ? 0 : groupBy.findIndex((attr) => cellText(before.cells[attr]) !== cellText(row.cells[attr]));
    return first < 0 ? [] : path.slice(first).map((step, at) => ({ level: first + at, attr: step.attr, path: path.slice(0, first + at + 1) }));
  };

  const rootClass = `jc-grid${className ? ` ${className}` : ""}${classNames?.root ? ` ${classNames.root}` : ""}${mapAttr ? ` jc-grid--map-${mapPosition}` : ""}${virtual ? " jc-grid--virtual" : ""}`;

  return (
    // `data-jc-sdk`: the grid's own controls are the SDK suite's to test, not each App's (T-3373).
    <div className={rootClass} data-density={hookOptions.config.density} data-row-size={rowSize} data-row-numbers={rowNumbers ? "" : undefined} data-jc-sdk="grid" data-filters={filtersOpen ? "open" : undefined}>
      {toolbar && <div className="jc-grid-toolbar">{toolbar}</div>}

      {pasteNote && (
        <p className="jc-grid-paste-note" role="status">
          {pasteNote}
        </p>
      )}

      {editing && (lastApplied || undoNote) && pendingChanges.length === 0 && (
        <div className="jc-grid-pending" role="status">
          {lastApplied ? (
            <>
              <span>{`${labels.saved} ${lastApplied.entities.reduce((sum, entity) => sum + entity.changes.length, 0)}`}</span>
              <button type="button" disabled={applying} onClick={() => void undo()}>
                {labels.undo}
              </button>
            </>
          ) : (
            <span>{undoNote}</span>
          )}
        </div>
      )}

      {pendingBar(false)}

      {filterRow && filterable.size > 0 && !asText && (
        <button type="button" className="jc-grid-filter-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}>
          {activeFilters > 0 ? `${labels.filterRow} (${activeFilters})` : labels.filterRow}
        </button>
      )}
      {!onHide && ownHidden.length > 0 && <HiddenFields attrs={ownHidden} labels={labels} labelOf={hiddenLabel} onShow={showColumns} />}
      {overflows && <p className="jc-grid-scroll-hint">{labels.scrollHint}</p>}
      {grid.sortedLoadedOnly && rows.length > 0 && (
        <p className="jc-grid-sort-note" role="status">{labels.sortedLoaded.replace("{count}", String(rows.length))}</p>
      )}
      <div className="jc-grid-scroll" ref={scrollRef} onScroll={virtual ? onScroll : undefined}>
        <table
          ref={tableRef}
          className={`jc-grid-table${classNames?.table ? ` ${classNames.table}` : ""}`}
          {...gridProps}
          // The rows of the last answer stay, dimmed, while the next question is read (T-5623).
          aria-busy={loading && rows.length > 0 ? true : undefined}
          onKeyDown={onGridKeyDown}
          onFocus={onGridFocus}
          onPaste={onGridPaste}
        >
          <thead className={`jc-grid-thead${classNames?.header ? ` ${classNames.header}` : ""}`}>
            <tr>
              {rowNumbers && (
                <th className="jc-grid-rownum" scope="col">
                  {/* The label is the finger's target: 44 px on a touch screen, the box keeps its size (T-5596). */}
                  <label className="jc-grid-check">
                    <input
                      type="checkbox"
                      aria-label={rowNumbers.selectAll}
                      checked={allChecked}
                      disabled={!onSelectedChange || rows.length === 0}
                      onChange={() => onSelectedChange?.(allChecked ? [] : rows.map((row) => row.id))}
                    />
                  </label>
                </th>
              )}
              {columns.map((col, i) => {
                const kind = kindOf.get(col.key) ?? "text";
                const kindLabel = labels[KIND_LABEL[kind]] as string;
                const own = col.attr !== null && col.meta === null ? col.attr : null;
                const at = own === null ? -1 : order.indexOf(own);
                const movable = own !== null && !col.pinned;
                return (
                <th
                  key={col.key}
                  className={`jc-grid-th${col.pinned ? " jc-grid-pinned" : ""}${dragOver === col.key ? " jc-grid-th--drop" : ""}`}
                  style={col.width ? { width: col.width, minWidth: col.width, maxWidth: col.width } : undefined}
                  data-col-attr={own ?? undefined}
                  draggable={movable}
                  onDragStart={movable ? (e) => { e.dataTransfer.setData(DRAG_TYPE, own!); e.dataTransfer.effectAllowed = "move"; } : undefined}
                  onDragOver={movable ? (e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setDragOver(col.key); } } : undefined}
                  onDragLeave={movable ? () => setDragOver(null) : undefined}
                  onDrop={movable ? (e) => {
                    e.preventDefault();
                    setDragOver(null);
                    const dragged = e.dataTransfer.getData(DRAG_TYPE);
                    if (dragged && dragged !== own) setLayout({ ...layout, order: moveTo(order, dragged, order.indexOf(own!)) });
                  } : undefined}
                  {...getHeaderProps(col, i)}
                >
                  {/* The glyph is drawn by CSS from data-icon, so the header's text stays its label. */}
                  <span className="jc-grid-kind" data-icon={KIND_ICON[kind]} data-kind={kind} role="img" aria-label={kindLabel} title={kindLabel} />
                  <button
                    type="button"
                    className="jc-grid-sort-btn"
                    // A source that orders the whole answer sorts every row; elsewhere the order
                    // is of the loaded page, and the label never promises the whole set (UI-66).
                    title={`${sortLabel(col)} ${col.label}`}
                    aria-label={`${sortLabel(col)} ${col.label}`}
                    onClick={() => setSort(col.attr ?? col.key)}
                  >
                    {col.label}
                    {state.sort?.attr === (col.attr ?? col.key) ? (state.sort.dir === "asc" ? " ↑" : " ↓") : ""}
                  </button>
                  {own !== null && (
                    <button
                      type="button"
                      className="jc-grid-meta-btn"
                      aria-label={`${labels.columnMenu}: ${col.label}`}
                      aria-haspopup="dialog"
                      aria-expanded={openMenu === own}
                      onClick={() => toggleMenu(own)}
                    >
                      ⋮
                    </button>
                  )}
                  {own !== null && openMenu === own && (
                    <ColumnMenu
                      ref={menuRef}
                      label={layout.labels?.[own] ?? baseLabel(col)}
                      labels={labels}
                      sorted={state.sort?.attr === own ? state.sort.dir : null}
                      onSort={(dir) => { setSort(own, dir); closeMenu(); }}
                      onFilter={filterable.has(col.key) && !asText ? () => focusFilter(col.key) : undefined}
                      onHide={col.pinned ? undefined : () => hideColumn(own)}
                      renamed={layout.labels?.[own] !== undefined}
                      onRename={(text) => renameColumn(own, text)}
                      onWiden={(delta) => widen(own, col.width, delta)}
                      onMove={movable ? (delta) => setLayout({ ...layout, order: moveTo(order, own, at + delta) }) : undefined}
                      canMoveLeft={movable && at > firstMovable}
                      canMoveRight={movable && at < order.length - 1}
                      onClose={closeMenu}
                      details={
                        <>
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
                        </>
                      }
                    />
                  )}
                  {own !== null && (
                    // The edge a pointer drags; a keyboard has Narrower and Wider in the menu.
                    <span className="jc-grid-resize" aria-hidden="true" onPointerDown={(e) => startResize(e, own)} />
                  )}
                </th>
                );
              })}
            </tr>
            {filterRow && filterable.size > 0 && (
              <tr className="jc-grid-filter-row" aria-label={labels.filterRow}>
                {rowNumbers && <td className="jc-grid-rownum" />}
                {columns.map((col) => {
                  const column = filterable.get(col.key);
                  const className = `jc-grid-filter${col.pinned ? " jc-grid-pinned" : ""}`;
                  // A column the endpoint cannot be asked about has no filter, and an empty
                  // header cell is a header that names nothing to a screen reader.
                  if (!column || asText) return <td key={`filter-${col.key}`} className={className} />;
                  return (
                    <th key={`filter-${col.key}`} className={className} data-filter-for={col.key}>
                      <FilterCell
                        column={column}
                        label={col.label}
                        labels={labels}
                        filter={state.filters[col.key]}
                        onChange={(next) => setFilter(col.key, next)}
                      />
                    </th>
                  );
                })}
              </tr>
            )}
          </thead>
          <tbody className={`jc-grid-tbody${classNames?.row ? ` ${classNames.row}` : ""}`}>
            {spacerAbove > 0 && (
              <tr className="jc-grid-spacer" aria-hidden="true">
                <td colSpan={columns.length + lead} style={{ height: spacerAbove }} />
              </tr>
            )}
            {shownRows.map((row, shownIndex) => {
              const rowIndex = shownFrom + shownIndex;
              const tone = rowTone?.(row);
              return (
              <React.Fragment key={row.id}>
              {groupsBefore(row, rowIndex).map((group) => {
                const column = columns.find((col) => col.attr === group.attr && col.meta === null);
                const text = cellText(row.cells[group.attr]);
                return (
                  <tr key={`group-${group.level}`} className="jc-grid-group" data-level={group.level}>
                    <th scope="colgroup" colSpan={columns.length + lead} style={{ paddingInlineStart: `${0.75 + group.level * 1.25}rem` }}>
                      <span className="jc-grid-group-name">{column?.label ?? group.attr}</span>{" "}
                      <span className="jc-grid-group-value">{text === "" ? labels.groupNoValue : text}</span>
                      {groupHeader ? <span className="jc-grid-group-extra">{groupHeader(group)}</span> : null}
                    </th>
                  </tr>
                );
              })}
              <tr
                className={`jc-grid-tr${tone ? ` jc-grid-tr--${tone.tone}` : ""}${classNames?.row ? ` ${classNames.row}` : ""}`}
                // A refused update stays visible on its own row, not only in the panel the person
                // may have closed: the value there is still theirs and still unapplied.
                data-refused={refusedOf.has(row.id) ? "true" : undefined}
                data-mark={marks?.rows?.[row.id] ? "row" : undefined}
                title={marks?.rows?.[row.id] ?? rowTitle(row.id)}
                {...getRowProps(row, rowIndex)}
                aria-selected={rowNumbers ? selected.includes(row.id) : undefined}
              >
                {rowNumbers && (
                  <td className="jc-grid-rownum">
                    <span className="jc-grid-rownum-n" aria-hidden="true">{rowIndex + 1 + (virtual ? 0 : state.offset)}</span>
                    {/* A tap beside the box ticks it and does not open the row. */}
                    <label className="jc-grid-check" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`${rowNumbers.selectRow}: ${rowName(row)}`}
                        checked={selected.includes(row.id)}
                        disabled={!onSelectedChange}
                        onClick={(e) => {
                          e.stopPropagation();
                          checkRow(rowIndex, row.id, e.shiftKey);
                        }}
                        onChange={() => undefined}
                      />
                    </label>
                    {/* A pointer's shortcut: the row's name is the same button for a keyboard and a screen reader. */}
                    <button
                      type="button"
                      className="jc-grid-expand"
                      tabIndex={-1}
                      aria-hidden="true"
                      title={labels.openRow}
                      onClick={(e) => {
                        e.stopPropagation();
                        openDetail(row);
                      }}
                    >
                      ⤢
                    </button>
                  </td>
                )}
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
                    {colIndex === 0 && tone ? (
                      <span className={`jc-grid-tone jc-grid-tone--${tone.tone}`} role="img" aria-label={tone.label} title={tone.label} />
                    ) : null}
                    {/* At most three lines at the column's widest (T-5192): a dragged width replaces
                        the cap, the full value stays in the row's detail. */}
                    <div className="jc-grid-cell" data-format={col.attr ? formatOf.get(col.attr) : undefined} style={col.width ? { maxWidth: "none" } : undefined}>
                      {renderCellContent(row, col)}
                    </div>
                  </td>
                ))}
              </tr>
              </React.Fragment>
              );
            })}
            {spacerBelow > 0 && (
              <tr className="jc-grid-spacer" aria-hidden="true">
                <td colSpan={columns.length + lead} style={{ height: spacerBelow }} />
              </tr>
            )}
          </tbody>
          {footer && rows.length > 0 && (
            <tfoot className="jc-grid-tfoot">
              <tr>
                {rowNumbers && <td className="jc-grid-rownum" />}
                {columns.map((col) => (
                  <td key={`foot-${col.key}`} className={`jc-grid-foot${col.pinned ? " jc-grid-pinned" : ""}`}>
                    {footer(col)}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
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
            } else if (selection.inShell) {
              // A shape from a tile whose row is on no loaded page: its detail is read by the URN.
              selection.select({ id, type: hookOptions.config.type });
            } else {
              setDetailId(id);
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
          tiles={tileTemplate ? { template: tileTemplate, layer: hookOptions.config.type } : null}
          basemap={basemap}
          engine={mapEngine}
          geoLabels={geoLabels}
          position={mapPosition}
        />
      )}

      {!loading && rows.length === 0 && !error && (
        <div className="jc-grid-empty">{emptySlot ?? labels.empty}</div>
      )}

      {loading && (
        <div className="jc-grid-loading" role="status">
          {rows.length > 0 && grid.narrowed ? labels.filtering : labels.loading}
        </div>
      )}

      {error && (
        <div className="jc-grid-error">
          {labels.error}: {error}
          {grid.errorDetail && (
            <details className="jc-grid-error-detail">
              <summary>{labels.errorDetail}</summary>
              <p>{grid.errorDetail}</p>
            </details>
          )}
        </div>
      )}

      {detailRow && (
        <RowDetail
          row={detailRow}
          name={rowName(detailRow)}
          columns={columns}
          renderValue={detailValue}
          labels={{
            rowDetail: labels.rowDetail,
            close: labels.close,
            rowFields: labels.rowFields,
            rowHistory: labels.history,
            historyAttr: labels.attribute,
            rowMetadata: labels.metadata,
            copyId: labels.rowCopyId,
            copied: labels.copied,
          }}
          history={
            historyOn
              ? (attr, label) => (
                  <EntityHistory
                    source={hookOptions.source}
                    id={detailRow.id}
                    attr={attr}
                    heading={`${hookOptions.labels?.historyLabels?.title ?? labels.history}: ${label}`}
                    maxPoints={hookOptions.config.history.maxPoints}
                    labels={hookOptions.labels?.historyLabels}
                    versions
                  />
                )
              : undefined
          }
          // Created and changed come with the row; who wrote it needs the history the config allows.
          metadata={(attr) => (
            <AttributeMetadata
              source={historyOn ? hookOptions.source : {}}
              id={detailRow.id}
              attr={attr}
              cell={detailRow.cells[attr]}
              locale={where}
              labels={hookOptions.labels?.metadataLabels}
            />
          )}
          tabs={detailTabs?.(detailRow)}
          place={detailPlace}
          onPlace={onDetailPlace}
          onClose={() => {
            setDetailId(null);
            tableRef.current?.focus();
          }}
        >
          {pendingBar(true)}
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
          <label className="jc-grid-reason">
            <span>{labels.reason}</span>
            <input
              required
              maxLength={MAX_REASON}
              value={reasonText}
              aria-invalid={reasonOk(reasonText) ? undefined : true}
              aria-describedby={reasonOk(reasonText) ? undefined : reasonHintId}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {!reasonOk(reasonText) && (
            <p id={reasonHintId} className="jc-grid-error">
              {labels.reasonNeeded}
            </p>
          )}
          <button
            type="button"
            disabled={applying || pendingChanges.length > MAX_ENTITIES || !reasonOk(reasonText)}
            onClick={() => void apply()}
          >
            {applying ? labels.applying : labels.apply}
          </button>
        </section>
      )}

      {queryBox && filterable.size > 0 && (
        <div className="jc-grid-query">
          <label className="jc-grid-query-text">
            <span className="jc-grid-query-label">{labels.query}</span>
            {asText ? (
              // The person owns the query from here: the row cannot show every `q` NGSI-LD allows
              // (a `|`, a bracket), so taking it over is how those are written at all.
              <input
                className="jc-grid-query-input"
                aria-describedby={queryHintId}
                value={state.filterText ?? ""}
                onChange={(e) => setFilterText(e.target.value)}
              />
            ) : (
              <output className="jc-grid-query-value">{queryText(askedQuery) || labels.queryAll}</output>
            )}
          </label>
          <span className="jc-grid-query-actions">
            {/* Nothing to copy while every row is asked for: the line says "all records" instead. */}
            {queryText(askedQuery) !== "" && (
              <button
                type="button"
                className="jc-grid-query-copy"
                onClick={() => {
                  void navigator.clipboard?.writeText(queryText(askedQuery)).then(() => setCopied(true), () => setCopied(false));
                }}
              >
                {copied ? labels.copied : labels.copyQuery}
              </button>
            )}
            <label className="jc-grid-query-switch">
              <input
                type="checkbox"
                aria-describedby={queryHintId}
                checked={asText}
                onChange={(e) => setFilterText(e.target.checked ? (askedQuery.q ?? "") : null)}
              />
              <span>{labels.editAsText}</span>
            </label>
          </span>
          <span className="jc-grid-sr-only" role="status">{copied ? labels.copied : ""}</span>
          {/* The example names this type's own attribute and the first row's value (T-5415). */}
          <span id={queryHintId} className="jc-grid-query-hint">
            {labels.editAsTextHint}
            {example ? <>{`, ${labels.exampleLead} `}<code>{example}</code></> : null}.
          </span>
        </div>
      )}

      {virtual ? (
        <div className={`jc-grid-pager${classNames?.pager ? ` ${classNames.pager}` : ""}`} role="status">
          {/* The total is the endpoint's own count, from the same answer as the rows (T-4885): an
              answer the gateway narrowed carries none (R22), and the footer says so in words. */}
          <span className="jc-grid-total">
            {grid.loading && rows.length === 0
              ? labels.loading
              : grid.total !== undefined
                ? `${rows.length} ${labels.of} ${grid.total} ${labels.loaded}`
                : `${rows.length} ${labels.loaded} · ${labels.noTotal}`}
          </span>
          {grid.loadingMore && <span className="jc-grid-loading-more">{labels.loading}</span>}
        </div>
      ) : (
      <div className={`jc-grid-pager${classNames?.pager ? ` ${classNames.pager}` : ""}`}>
        <button
          type="button"
          disabled={state.offset === 0}
          className="jc-grid-pager-step"
          onClick={() => setOffset(Math.max(0, state.offset - hookOptions.config.pageSize))}
        >
          {/* On a phone only the arrow shows; the word stays for a screen reader (T-5415). */}
          <span aria-hidden="true">‹</span> <span className="jc-grid-pager-word">{labels.previous}</span>
        </button>
        <span className="jc-grid-page-info">
          {`${labels.page} ${currentPage}`}
          {totalPages !== undefined && <span className="jc-grid-page-count">{` / ${totalPages}`}</span>}
        </span>
        {/* Numbered pages as a DataTables pager (T-5196): the first, the last and the two around this one. */}
        {totalPages !== undefined && totalPages > 1 && (
          <span className="jc-grid-pages">
            {pageNumbers(currentPage, totalPages).map((page, at) =>
              page === null ? (
                <span key={`gap-${at}`} aria-hidden="true">…</span>
              ) : (
                <button
                  key={page}
                  type="button"
                  aria-label={`${labels.page} ${page}`}
                  aria-current={page === currentPage ? "page" : undefined}
                  onClick={() => setOffset((page - 1) * hookOptions.config.pageSize)}
                >
                  {page}
                </button>
              ),
            )}
          </span>
        )}
        {/* The endpoint's own count, not the page's: an answer the gateway narrowed carries none,
            and then the footer says nothing rather than a number it guessed (R22). */}
        {grid.total !== undefined && (
          <span className="jc-grid-total">{`${grid.total} ${labels.matching}`}</span>
        )}
        <button
          type="button"
          disabled={totalPages !== undefined ? currentPage >= totalPages : rows.length < hookOptions.config.pageSize}
          className="jc-grid-pager-step"
          onClick={() => setOffset(state.offset + hookOptions.config.pageSize)}
        >
          <span className="jc-grid-pager-word">{labels.next}</span> <span aria-hidden="true">›</span>
        </button>
      </div>
      )}
    </div>
  );
}

/** The page buttons a pager shows: 1, the pages beside the current one and the last, `null` for a gap. */
export function pageNumbers(current: number, total: number): (number | null)[] {
  const kept = [...new Set([1, current - 1, current, current + 1, total])].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  return kept.flatMap((page, at) => (at > 0 && page - (kept[at - 1] ?? page) > 1 ? [null, page] : [page]));
}

/** A row's height until one is measured, and the rows drawn when the box has no height yet. */
const FALLBACK_ROW_HEIGHT = 36;
const FALLBACK_VIEWPORT_ROWS = 30;
/** Rows drawn beyond the window on each side, so a scroll shows rows rather than blank space. */
const OVERSCAN = 10;
/** The share of the loaded rows the window's end passes before the next page is asked for. */
const PREFETCH_AT = 0.6;

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

type FilterCellLabels = Pick<
  GridLabelsAll,
  "filter" | "value" | "upperValue" | "noFilter" | "unit" | "filterHintText" | "filterHintNumber" | "filterHintDate" | "filterHintEnum" | "filterHintOther"
> & { ops: Record<string, string> };

/**
 * The one line under a column's filter (UI-16), from the attribute's model: what to type for its
 * kind, the unit of a number and the allowed values of an enum (T-4949).
 */
function filterHint(column: FilterColumn, labels: FilterCellLabels): string {
  switch (column.kind) {
    case "number":
      return column.unit ? `${labels.filterHintNumber} ${labels.unit}: ${column.unit}.` : labels.filterHintNumber;
    case "date":
      return labels.filterHintDate;
    case "enum":
      return `${labels.filterHintEnum} ${(column.options ?? []).map(optionLabel).join(", ")}.`;
    case "text":
    case "id":
    case "relationship":
    case "untyped":
      return labels.filterHintText;
    default:
      return labels.filterHintOther;
  }
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
  labels: FilterCellLabels;
  filter: ColumnFilter | undefined;
  onChange: (next: ColumnFilter | undefined) => void;
}): React.JSX.Element {
  const hintId = React.useId();
  const hint = filterHint(column, labels);
  const ops = opsForKind(column.kind);
  const op = filter?.op ?? ops[0];
  const needed = valuesNeeded(op);
  const type = column.kind === "number" ? "number" : column.kind === "date" ? "date" : "text";
  // An enum's values are picked, several at once: the query asks for any of them (UI-86).
  const picking = column.kind === "enum" && op === "anyOf";
  return (
    <div className="jc-grid-filter-cell">
      <span id={hintId} className="jc-grid-sr-only">
        {hint}
      </span>
      <select
        aria-label={`${labels.filter}: ${label}`}
        aria-describedby={hintId}
        title={hint}
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
        <option value="">{labels.noFilter}</option>
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
/** A cell's stored value as its text box shows it: the value, not the unit beside it. */
function storedText(cell: RichCell | RichCell[] | undefined): string {
  const one = Array.isArray(cell) ? cell[0] : cell;
  const own = one?.kind === "relationship" ? one.object : one?.value;
  return own === undefined || own === null ? "" : String(own);
}

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

/**
 * "Hidden fields (2)" above the rows (T-5620): the fields hidden from the header menu, each with
 * "Show field", and "Show all" for more than one. Focus stays on the count while fields remain.
 */
function HiddenFields({ attrs, labels, labelOf, onShow }: { attrs: readonly string[]; labels: GridLabelsAll; labelOf: (attr: string) => string; onShow: (attrs: readonly string[]) => void }) {
  const [open, setOpen] = useState(false);
  const listId = React.useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const show = (which: readonly string[]) => {
    onShow(which);
    toggleRef.current?.focus();
  };
  return (
    <div className="jc-grid-hidden">
      <button ref={toggleRef} type="button" className="jc-grid-filter-toggle jc-grid-hidden-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((was) => !was)}>
        {`${labels.hiddenFields} (${attrs.length})`}
      </button>
      {open && (
        <ul id={listId} className="jc-grid-hidden-list" aria-label={labels.hiddenFields}>
          {attrs.map((attr) => (
            <li key={attr}>
              <span>{labelOf(attr)}</span>
              <button type="button" aria-label={`${labels.showColumn}: ${labelOf(attr)}`} onClick={() => show([attr])}>
                {labels.showColumn}
              </button>
            </li>
          ))}
          {attrs.length > 1 && (
            <li>
              <button type="button" onClick={() => show(attrs)}>
                {labels.showAllColumns}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
