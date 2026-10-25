/**
 * The SDK's entity grid inside the Portal (T-1439; UI-71, SDK-29): one component, linked and not
 * copied, with everything a host owes it supplied here.
 *
 * The grid itself knows nothing about the Portal: it takes its strings, its source and its state
 * from whoever renders it. This adapter is that whoever — the Portal's i18n for every label, the
 * Portal's own origin transport (so the person's session and CSRF header travel as with every other
 * Portal call, and the Endpoint's Policy decides each read), and the column layout a person set
 * kept per project and per type. Every Portal place that shows entities renders this, so a change
 * to the grid reaches all of them and none of them forks it.
 */
import { useCallback, useMemo, useState } from "react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { EntityGrid, DEFAULT_LABELS, originTransport, sourceFor } from "@joinedcontext/sdk";
import type { ColumnLayout, EntityGridProps, GeoLabels, GridLabels, GridMapLabels, GridSource, GridState, ResolvedGridConfig } from "@joinedcontext/sdk";

/** Where the layout a person set is kept, per project and per type. */
function layoutKey(project: string, type: string): string {
  return `jc.grid.${project}.${type}`;
}

/**
 * The parts of the grid's state that belong to the person rather than to the query: which metadata
 * columns are shown and how the page is ordered. The offset, the filters and the pending edits are
 * deliberately not kept: coming back to a page three of a filtered answer that no longer matches is
 * worse than starting at the top, and an unapplied edit must not outlive the page it was typed on.
 */
type Layout = Pick<GridState, "shown" | "sort">;

/**
 * The column order, widths and renames a person set from the header (T-5192), kept per project and
 * type in this browser beside the layout above; a host that keeps its own passes `layout`.
 */
function columnsKey(project: string, type: string): string {
  return `${layoutKey(project, type)}.columns`;
}

function readColumns(project: string, type: string): ColumnLayout {
  try {
    const raw = window.localStorage.getItem(columnsKey(project, type));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as ColumnLayout) : {};
  } catch {
    return {};
  }
}

function writeColumns(project: string, type: string, columns: ColumnLayout): void {
  try {
    window.localStorage.setItem(columnsKey(project, type), JSON.stringify(columns));
  } catch {
    // Kept for this page only: the widths are a convenience, not the data.
  }
}

/** The order this browser remembers for a type's grid, for a host that shows it (T-5188). */
export function rememberedSort(project: string, type: string): GridState["sort"] {
  return readLayout(project, type)?.sort ?? null;
}

function readLayout(project: string, type: string): Layout | null {
  try {
    const raw = window.localStorage.getItem(layoutKey(project, type));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Layout;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    // A private window, blocked site data, or a value another version wrote: the grid opens with
    // its own defaults rather than failing to open.
    return null;
  }
}

function writeLayout(project: string, type: string, layout: Layout): void {
  try {
    window.localStorage.setItem(layoutKey(project, type), JSON.stringify(layout));
  } catch {
    // Nothing else changes: a layout that cannot be kept is a convenience, not the data.
  }
}

/** Every string the grid shows, from the Portal's own catalogue (`entityGrid.*`). */
/** The cell inspector's words (T-5528), each under `entityGrid.inspector`. */
const INSPECTOR_KEYS = [
  "title", "close", "read", "write", "delete", "allowed", "notAllowed", "loading", "failed", "grant", "notInGrant",
  "noGrant", "formula", "prohibited", "prohibitedBy", "prohibitedHidden", "naming", "namingFailed", "askAccess",
] as const satisfies readonly (keyof NonNullable<GridLabels["inspectorLabels"]>)[];

export function gridLabels(t: (key: string, values?: Record<string, string>) => string): GridLabels {
  const ops = DEFAULT_LABELS.ops;
  return {
    id: t("entityGrid.id"),
    type: t("entityGrid.type"),
    createdAt: t("entityGrid.createdAt"),
    modifiedAt: t("entityGrid.modifiedAt"),
    observedAt: t("entityGrid.observedAt"),
    unit: t("entityGrid.unit"),
    datasetId: t("entityGrid.datasetId"),
    empty: t("entityGrid.empty"),
    loading: t("entityGrid.loading"),
    previous: t("entityGrid.previous"),
    next: t("entityGrid.next"),
    page: t("entityGrid.page"),
    showMetadata: t("entityGrid.showMetadata"),
    error: t("entityGrid.error"),
    filter: t("entityGrid.filter"),
    noFilter: t("entityGrid.noFilter"),
    filterHintText: t("entityGrid.hint.filterText"),
    filterHintNumber: t("entityGrid.hint.filterNumber"),
    filterHintDate: t("entityGrid.hint.filterDate"),
    filterHintEnum: t("entityGrid.hint.filterEnum"),
    filterHintOther: t("entityGrid.hint.filterOther"),
    editAsTextHint: t("entityGrid.hint.editAsText"),
    exampleLead: t("entityGrid.exampleLead"),
    queryAll: t("entityGrid.queryAll"),
    copied: t("entityGrid.copied"),
    scrollHint: t("entityGrid.scrollHint"),
    ops: {
      contains: t("entityGrid.ops.contains"),
      equals: t("entityGrid.ops.equals"),
      notEquals: t("entityGrid.ops.notEquals"),
      // The four comparisons are symbols in every language, so the SDK's own are kept.
      gt: ops.gt,
      gte: ops.gte,
      lt: ops.lt,
      lte: ops.lte,
      between: t("entityGrid.ops.between"),
      empty: t("entityGrid.ops.isEmpty"),
      present: t("entityGrid.ops.present"),
      pattern: t("entityGrid.ops.pattern"),
      anyOf: t("entityGrid.ops.anyOf"),
    },
    value: t("entityGrid.value"),
    upperValue: t("entityGrid.upperValue"),
    query: t("entityGrid.query"),
    copyQuery: t("entityGrid.copyQuery"),
    editAsText: t("entityGrid.editAsText"),
    filterRow: t("entityGrid.filterRow"),
    sortPage: t("entityGrid.sortPage"),
    sortAll: t("entityGrid.sortAll"),
    matching: t("entityGrid.matching"),
    noTotal: t("entityGrid.noTotal"),
    history: t("entityGrid.history"),
    historyLabels: {
      title: t("entityGrid.history"),
      window: {
        hour: t("entityGrid.historyWindow.hour"),
        day: t("entityGrid.historyWindow.day"),
        week: t("entityGrid.historyWindow.week"),
        custom: t("entityGrid.historyWindow.custom"),
      },
      from: t("entityGrid.from"),
      to: t("entityGrid.to"),
      at: t("entityGrid.observedAt"),
      value: t("entityGrid.value"),
      unit: t("entityGrid.unit"),
      empty: t("entityGrid.historyEmpty"),
      cut: t("entityGrid.historyCut"),
      copy: t("entityGrid.historyCopy"),
      close: t("entityGrid.close"),
      loading: t("entityGrid.loading"),
      error: t("entityGrid.error"),
      versions: t("entityGrid.historyVersions"),
      versionsRefused: t("entityGrid.historyVersionsRefused"),
      supersededAt: t("entityGrid.historySuperseded"),
      changedBy: t("entityGrid.historyChangedBy"),
      reason: t("entityGrid.historyReason"),
    },
    metadata: t("entityGrid.metadata"),
    metadataLabels: {
      created: t("entityGrid.metaCreated"),
      modified: t("entityGrid.metaModified"),
      changedBy: t("entityGrid.metaChangedBy"),
      organization: t("entityGrid.metaOrganization"),
      channel: t("entityGrid.metaChannel"),
      reason: t("entityGrid.metaReason"),
      hidden: t("entityGrid.metaHidden"),
      hiddenWhy: {
        history: t("entityGrid.metaHiddenHistory"),
        member: t("entityGrid.metaHiddenMember"),
        public: t("entityGrid.metaHiddenPublic"),
      },
      notRecorded: t("entityGrid.metaNotRecorded"),
      noReason: t("entityGrid.metaNoReason"),
      loading: t("entityGrid.loading"),
      error: t("entityGrid.metaError"),
      actorKind: {
        person: t("entityGrid.metaKindPerson"),
        pipeline: t("entityGrid.metaKindPipeline"),
        agent: t("entityGrid.metaKindAgent"),
        serviceAccount: t("entityGrid.metaKindServiceAccount"),
      },
      channels: {
        ui: t("entityGrid.metaChannelUi"),
        api: t("entityGrid.metaChannelApi"),
        pipeline: t("entityGrid.metaChannelPipeline"),
        mqtt: t("entityGrid.metaChannelMqtt"),
        assistant: t("entityGrid.metaChannelAssistant"),
      },
    },
    // The placeholders go through as they are: the inspector fills them with the policy or the reason.
    inspectorLabels: Object.fromEntries(
      INSPECTOR_KEYS.map((key) => [key, t(`entityGrid.inspector.${key}`, { policy: "{policy}", reason: "{reason}" })]),
    ) as Record<(typeof INSPECTOR_KEYS)[number], string>,
    edit: t("entityGrid.edit"),
    pending: t("entityGrid.pending"),
    review: t("entityGrid.review"),
    apply: t("entityGrid.apply"),
    discard: t("entityGrid.discard"),
    attribute: t("entityGrid.attribute"),
    before: t("entityGrid.before"),
    after: t("entityGrid.after"),
    observedKeep: t("entityGrid.observedKeep"),
    observedNow: t("entityGrid.observedNow"),
    applying: t("entityGrid.applying"),
    reason: t("entityGrid.reason"),
    reasonDefault: t("entityGrid.reasonDefault"),
    reasonNeeded: t("entityGrid.reasonNeeded"),
    saved: t("entityGrid.saved"),
    undo: t("entityGrid.undo"),
    undoReason: t("entityGrid.undoReason"),
    undone: t("entityGrid.undone"),
    refusedHere: t("entityGrid.refusedHere"),
    notInList: t("entityGrid.notInList"),
    relationSearch: t("entityGrid.relationSearch"),
    relationNone: t("entityGrid.relationNone"),
    relationRemove: t("entityGrid.relationRemove"),
    relationFailed: t("entityGrid.relationFailed"),
    relationMore: t("entityGrid.relationMore"),
    openRow: t("entityGrid.openRow"),
    groupNoValue: t("entityGrid.groupNoValue"),
    rowDetail: t("entityGrid.rowDetail"),
    rowFields: t("entityGrid.rowFields"),
    close: t("entityGrid.close"),
    pasted: t("entityGrid.pasted"),
    skipped: t("entityGrid.skipped"),
    pasteTooLarge: t("entityGrid.pasteTooLarge"),
    loaded: t("entityGrid.loaded"),
    of: t("entityGrid.of"),
    mustBeInteger: t("entityGrid.mustBeInteger"),
    mustBeNumber: t("entityGrid.mustBeNumber"),
    mustBeBoolean: t("entityGrid.mustBeBoolean"),
    mustBeDate: t("entityGrid.mustBeDate"),
    mustBeUri: t("entityGrid.mustBeUri"),
    atLeast: t("entityGrid.atLeast"),
    atMost: t("entityGrid.atMost"),
    patternMismatch: t("entityGrid.patternMismatch"),
    required: t("entityGrid.required"),
    toCorrect: t("entityGrid.toCorrect"),
    yes: t("entityGrid.yes"),
    no: t("entityGrid.no"),
    columnMenu: t("entityGrid.columnMenu"),
    sortAsc: t("entityGrid.sortAsc"),
    sortDesc: t("entityGrid.sortDesc"),
    filterColumn: t("entityGrid.filterColumn"),
    hideColumn: t("entityGrid.hideColumn"),
    renameColumn: t("entityGrid.renameColumn"),
    renameReset: t("entityGrid.renameReset"),
    columnWidth: t("entityGrid.columnWidth"),
    narrower: t("entityGrid.narrower"),
    wider: t("entityGrid.wider"),
    moveLeft: t("entityGrid.moveLeft"),
    moveRight: t("entityGrid.moveRight"),
    details: t("entityGrid.details"),
    kindText: t("entityGrid.kindText"),
    kindNumber: t("entityGrid.kindNumber"),
    kindBoolean: t("entityGrid.kindBoolean"),
    kindDatetime: t("entityGrid.kindDatetime"),
    kindGeo: t("entityGrid.kindGeo"),
    kindRelationship: t("entityGrid.kindRelationship"),
    kindLanguage: t("entityGrid.kindLanguage"),
    kindStructured: t("entityGrid.kindStructured"),
    kindList: t("entityGrid.kindList"),
    points: t("entityGrid.points"),
    openTarget: t("entityGrid.openTarget"),
  };
}

/** The geometry editor's words, for the editor the map panel opens (UI-72, T-1442). */
export function geoEditorLabels(t: (key: string) => string): GeoLabels {
  return {
    tools: t("entityGrid.geo.tools"),
    select: t("entityGrid.geo.select"),
    undo: t("entityGrid.geo.undo"),
    redo: t("entityGrid.geo.redo"),
    remove: t("entityGrid.geo.remove"),
    removeShape: t("entityGrid.geo.removeShape"),
    point: t("entityGrid.geo.point"),
    longitude: t("entityGrid.geo.longitude"),
    latitude: t("entityGrid.geo.latitude"),
    noGeometry: t("entityGrid.geo.noGeometry"),
    paste: t("entityGrid.geo.paste"),
    take: t("entityGrid.geo.take"),
    upload: t("entityGrid.geo.upload"),
    notJson: t("entityGrid.geo.notJson"),
    tooLarge: t("entityGrid.geo.tooLarge"),
    modes: {
      point: t("entityGrid.geo.modes.point"),
      linestring: t("entityGrid.geo.modes.linestring"),
      polygon: t("entityGrid.geo.modes.polygon"),
      rectangle: t("entityGrid.geo.modes.rectangle"),
      circle: t("entityGrid.geo.modes.circle"),
      freehand: t("entityGrid.geo.modes.freehand"),
    },
  };
}

/** The map panel's words, in the person's language (UI-72). */
export function gridMapLabels(t: (key: string) => string): GridMapLabels {
  return {
    panel: t("entityGrid.map.panel"),
    offTheMap: t("entityGrid.map.offTheMap"),
    drawArea: t("entityGrid.map.drawArea"),
    clearArea: t("entityGrid.map.clearArea"),
    areaAsked: t("entityGrid.map.areaAsked"),
    areaSimplified: t("entityGrid.map.areaSimplified"),
    editGeometry: t("entityGrid.map.editGeometry"),
    moved: t("entityGrid.map.moved"),
    reshaped: t("entityGrid.map.reshaped"),
    replaced: t("entityGrid.map.replaced"),
    noGeometry: t("entityGrid.map.noGeometry"),
    viewerCannotEdit: t("entityGrid.map.viewerCannotEdit"),
  };
}

export interface PortalEntityGridProps extends Omit<EntityGridProps, "labels" | "source" | "state" | "onStateChange"> {
  /** The project whose layout this is, so two projects do not share one person's columns. */
  project: string;
  config: ResolvedGridConfig;
  /** A source to use instead of the one the config names, for a test or a fixture. */
  source?: EntityGridProps["source"];
  /**
   * What a saved view sets (API/01 §30): the typed query and the order, held by the host so a view
   * can be applied and saved. The column layout stays the person's own either way.
   */
  view?: Pick<GridState, "filterText" | "sort"> & Partial<Pick<GridState, "filters">>;
  /** Every change of the grid's state, for the host that holds `view`. */
  onGridState?: (next: GridState) => void;
  /** What an empty answer says instead of "No entities here", e.g. that a filter excluded all. */
  emptyText?: string;
}

/**
 * The grid as the Portal renders it. The source comes from the config — an endpoint's slug or a
 * space's name, never a URL (EP-55) — over the Portal's own origin transport.
 */
export function PortalEntityGrid({ project, config, source, view, onGridState, emptyText, ...rest }: PortalEntityGridProps): JSX.Element {
  const { t, i18n } = useTranslation();
  // `t` changes identity on a language change, which is what rebuilds the labels; the language
  // itself is read below, for the source's own locale.
  const labels = useMemo(() => ({ ...gridLabels(t), ...(emptyText ? { empty: emptyText } : {}) }), [t, emptyText]);
  const mapLabels = useMemo(() => gridMapLabels(t), [t]);
  const geoLabels = useMemo(() => geoEditorLabels(t), [t]);

  const built = useMemo(() => {
    if (source) {
      return source;
    }
    const where = config.source as GridSource;
    if (where.kind === "fixture") {
      throw new Error("a fixture source is for the SDK's own examples; pass `source` instead");
    }
    return sourceFor(where, originTransport(), i18n.language);
  }, [source, config.source, i18n.language]);

  const [layout, setLayout] = useState<Layout>(
    () => readLayout(project, config.type) ?? { shown: {}, sort: null },
  );
  const onStateChange = useCallback(
    (next: GridState) => {
      const kept: Layout = { shown: next.shown, sort: next.sort };
      setLayout(kept);
      writeLayout(project, config.type, kept);
      onGridState?.(next);
    },
    [project, config.type, onGridState],
  );
  const state = useMemo(() => (view ? { ...layout, ...view } : layout), [layout, view]);
  const [columns, setColumns] = useState<ColumnLayout>(() => readColumns(project, config.type));
  const onColumns = useCallback(
    (next: ColumnLayout) => {
      setColumns(next);
      writeColumns(project, config.type, next);
    },
    [project, config.type],
  );

  return (
    <EntityGrid
      {...rest}
      config={config}
      source={built}
      labels={labels}
      // Numbers and dates read in the person's language (T-4827).
      locale={i18n.language}
      // The map's own strings. No `mapEngine`: `GeoEditor`'s own default imports Terra Draw when a
      // map loads, so a page whose config asks for no map never downloads the library at all.
      mapLabels={mapLabels}
      geoLabels={geoLabels}
      // Only the layout is controlled from here: the offset, the filters and the edits stay the
      // grid's own, so nothing a person is in the middle of survives a reload it should not.
      state={state}
      onStateChange={onStateChange}
      layout={rest.layout ?? columns}
      onLayout={rest.onLayout ?? onColumns}
    />
  );
}
