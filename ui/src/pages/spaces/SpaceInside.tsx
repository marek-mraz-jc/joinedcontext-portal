import { AlertDialog } from "../../components/AlertDialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import type { JSX, ReactNode } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { andQ, attributesOf, cellText, endpointSource, matchesQ, originTransport, parseGridConfig, queryFromGroup, searchQuery, sourceFor, targetName } from "@joinedcontext/sdk";
import type { FilterColumn, FilterGroup, GridState, RichRow } from "@joinedcontext/sdk";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap } from "../../api/client";
import { bytesOfType, exactBytes, sizeText, spaceUsageQuery, usageRefusal } from "../../api/spaceUsage";
import type { SpaceUsage } from "../../api/spaceUsage";
import { asManifests, localized, refName } from "../../api/manifest";
import type { Change, Manifest } from "../../api/manifest";
import { ActivityFeed } from "../../components/ActivityFeed";
import { LifecycleBadge } from "../../components/status/LifecycleBadge";
import {
  ENDPOINT_LINKS,
  EndpointLink,
  endpointUrl,
  REPRESENTATION_PATHS,
  representationUrl,
  servedRepresentations,
  useCatalogueLinks,
} from "../../components/endpoints/links";
import { useBranding } from "../../branding";
import { SharedWithBadge } from "../../components/endpoints/sharing";
import { useIdentity } from "../../auth/AuthProvider";
import { accessQuery, deniedAttributes, editableAttributes, mayDelete } from "../../components/entities/AccessPanel";
import type { GrantDocument } from "../../components/entities/AccessPanel";
import { PortalEntityGrid } from "../../components/entities/PortalEntityGrid";
import { EntityFilters } from "../../components/entities/EntityFilters";
import { enumsOfModel, filterSlotsOf, relationsOfModel, rulesOfModel, useModelSource } from "../../components/entities/filters";
import type { FilterSlot } from "../../components/entities/filters";
import { AddFieldDialog } from "../../components/entities/AddFieldDialog";
import { ViewBar } from "../../components/entities/ViewBar";
import { columnLabel, displayOrder } from "../../components/entities/displayOrder";
import { readLayout, writeLayout } from "../../components/entities/viewLayout";
import { dataViewsKey, listViews } from "../../api/dataViews";
import { GroupCounts, groupTerm, ViewOptions } from "../../components/entities/ViewOptions";
import { conditionCount, EMPTY_GROUP, FilterPanel, readGroup } from "../../components/entities/FilterPanel";
import { AGGREGATIONS, FooterAggregate, ROW_SIZES, ToolbarPopover } from "../../components/entities/GridToolbar";
import type { Aggregation, RowSize } from "../../components/entities/GridToolbar";
import type { ViewExtras } from "../../components/entities/ViewOptions";
import type { DataView as SavedView, ViewConfig } from "../../api/dataViews";
import { ChangeNotice } from "../../components/ChangeNotice";
import { PermissionGuard } from "../../components/ui/PermissionGuard";
import { classSlots, parseModel } from "../models/linkml";
import { localId, textOf } from "../apps/QueryResultCard";
import { TypeLink } from "../models/ModelLinks";
import { useSourceOf } from "../models/ModelPage";
import { ModelViews } from "../models/ModelViews";
import { ProposeLink } from "../models/ModelsList";
import {
  CalendarView,
  deleteRow,
  GalleryView,
  KanbanView,
  LiveNotice,
  RowExtra,
  TimelineView,
  TrashPanel,
  trashKey,
  useLive,
  useViewRows,
} from "./DataViews";
import type { LiveChange } from "./DataViews";
import type { EnumChoice } from "./DataViews";
import { SpaceDrift } from "./SpaceDrift";
import { TypeApi } from "./TypeApi";
import { SharePanel } from "./PublicView";
import { ExportLinks, ImportRowsDialog } from "./ImportRows";
import { useWorkspace } from "../../components/layout/WorkspaceContext";
import { CommentsPanel } from "./Comments";
import { importSlotsOf } from "./importRows";
import { useOrgDomain } from "../../api/projects";
import { FormSettingsEditor, FormSharePanel, FormView } from "./FormView";
import type { FormSettings } from "./formView";
import { AiFieldPanel } from "./AiField";
import { SpaceChecks } from "./SpaceChecks";
import { SpaceQuality } from "./SpaceQuality";
import { SpacePersonalData } from "./SpacePersonalData";
import { SpaceRetention } from "./SpaceRetention";
import { SpaceTemporalAudit } from "./SpaceTemporalAudit";
import { rulesOf } from "./retention";
import type { RetentionRule } from "./retention";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Icon,
  PageFailed,
  PageHeader,
  PageLoading,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tabs,
  tabPanelProps,
  Term,
} from "../../components/ui";
import { ConfirmDialog, Input, RadioGroup } from "../../components/ui";
import { ResourcePageFailed } from "../../components/ui/PageState";
import { useUrlParam, useUrlUrn } from "../../navigation/urlState";

const SAMPLE_LIMIT = 3;

import { entityTypesOf, modelsOfSpace, parseResultsCount, pickReadEndpoint, spaceOf } from "./spaceFacts";


type KeyValues = Record<string, unknown> & { id: string };

interface TypeInside {
  count?: number;
  samples: KeyValues[];
}

async function gatewayGet(slug: string, query: URLSearchParams): Promise<Response> {
  // A `Request` rather than a URL string, as `api/client.ts` sends: same origin, default mode.
  const response = await globalThis.fetch(
    new Request(endpointUrl(slug, `/ngsi-ld/v1/entities?${query.toString()}`), {
      headers: { Accept: "application/ld+json" },
    }),
  );
  if (!response.ok) {
    throw new ApiError(response.status, response.statusText || `HTTP ${response.status}`);
  }
  return response;
}

/**
 * The reads of one Endpoint, one after the other (T-3161): a space of fifteen types asked its
 * public Endpoint thirty questions at once, and the Endpoint's rate limit refused some with 429.
 */
const queues = new Map<string, Promise<unknown>>();
export function inTurn<T>(slug: string, read: () => Promise<T>): Promise<T> {
  const turn = (queues.get(slug) ?? Promise.resolve()).then(read, read);
  queues.set(slug, turn.catch(() => undefined));
  return turn;
}

/** What the gateway holds under one type: the live count and a few keyValues samples. */
async function fetchTypeInside(slug: string, type: string): Promise<TypeInside> {
  const counted = await gatewayGet(
    slug,
    new URLSearchParams({ type, limit: "1", count: "true" }),
  );
  const count = parseResultsCount(counted.headers);

  const sampled = await gatewayGet(
    slug,
    new URLSearchParams({ type, limit: String(SAMPLE_LIMIT), options: "keyValues" }),
  );
  const body: unknown = await sampled.json();
  const samples = (Array.isArray(body) ? body : [])
    .filter(
      (item): item is KeyValues =>
        typeof item === "object" && item !== null && typeof (item as KeyValues).id === "string",
    )
    .slice(0, SAMPLE_LIMIT);
  return { count, samples };
}

/**
 * One entity in keyValues form as a single line of values a person reads (T-2760): a place as
 * its position, a name in the reader's language. It printed `location={"coordinates":…}`.
 */
export function summarize(entity: KeyValues, language?: string): string {
  const attributes = Object.entries(entity)
    .filter(([key]) => key !== "id" && key !== "type" && key !== "@context")
    .slice(0, 4)
    .map(([key, value]) => {
      const text = textOf(value, language);
      return `${key}: ${text.length > 40 ? `${text.slice(0, 39)}…` : text}`;
    });
  return attributes.join(" · ");
}

/** The entity's own name, its full id a click away (T-2760): the URN is five segments wide. */
function EntityId({ id }: { id: string }): JSX.Element {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-fg" title={id}>
        {localId(id)}
      </span>
      <Button
        size="sm"
        variant="ghost"
        aria-label={t("spaces.inside.copyId", { id })}
        title={copied ? t("endpoints.copied") : t("spaces.inside.copyId", { id })}
        onClick={() => {
          void navigator.clipboard?.writeText(id).then(() => setCopied(true));
        }}
      >
        <Icon name={copied ? "check" : "copy"} className="size-3.5" />
      </Button>
    </span>
  );
}

function TypeRow({
  project,
  space,
  slug,
  type,
  bytes,
}: {
  project: string;
  space: string;
  slug?: string;
  type: string;
  /** What the type's entities take in the broker's store (T-2890), when it measured them. */
  bytes?: number;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const inside = useQuery({
    queryKey: ["gateway", slug ?? "", "inside", type],
    enabled: slug !== undefined,
    retry: false,
    queryFn: () => inTurn(slug ?? "", () => fetchTypeInside(slug ?? "", type)),
  });

  let count: JSX.Element | string;
  if (slug === undefined) {
    count = <span className="text-fg-subtle">—</span>;
  } else if (inside.isPending) {
    count = <span className="text-fg-subtle">{t("app.loading")}</span>;
  } else if (inside.isError) {
    const status = inside.error instanceof ApiError ? inside.error.status : undefined;
    count =
      status === 429 ? (
        // The Endpoint's own rate limit, not a refusal: said, with the read one press away.
        <span className="inline-flex flex-wrap items-center gap-2 text-fg-muted">
          {t("spaces.inside.tooMany")}
          <Button size="sm" variant="ghost" onClick={() => void inside.refetch()}>
            {t("app.error.retry")}
          </Button>
        </span>
      ) : (
        <span className="text-fg-muted">
          {status === 403 || status === 404 || status === 401
            ? t("spaces.inside.notReadable")
            : t("app.error.generic")}
        </span>
      );
  } else {
    count = inside.data.count === undefined ? "—" : String(inside.data.count);
  }

  return (
    <TableRow>
      <TableCell className="font-mono">
        <TypeLink project={project} type={type} space={space} />
      </TableCell>
      <TableCell align="right" className="font-mono">{count}</TableCell>
      <TableCell align="right" secondary className="tabular-nums">
        {bytes === undefined ? (
          <span className="text-fg-subtle">—</span>
        ) : (
          <span title={exactBytes(bytes, i18n.language)}>{sizeText(bytes, i18n.language)}</span>
        )}
      </TableCell>
      <TableCell secondary>
        {inside.isSuccess && inside.data.samples.length > 0 ? (
          <ul className="space-y-1">
            {inside.data.samples.map((entity) => (
              <li key={entity.id} className="text-caption">
                <EntityId id={entity.id} />
                {summarize(entity, i18n.language) ? (
                  <span className="ml-2 text-fg-subtle">{summarize(entity, i18n.language)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : inside.isSuccess ? (
          <span className="text-caption text-fg-subtle">{t("spaces.inside.noEntities")}</span>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function useProjectList(project: string, plural: string) {
  return useQuery({
    queryKey: queryKeys.list(project, plural),
    retry: false,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project, plural } },
        }),
      ),
  });
}

/**
 * The whole space in the grid (T-1434; SP-04, SP-06): the space surface answers by the caller's own
 * grants, so this is what this person may read of the space, not one endpoint's view of it.
 *
 * A read is tried for the chosen type before the grid is built, because the surface answers a
 * caller with no grant with a 404 that says nothing about whether the space exists (SP-06) — and
 * then the page says where this person can see it instead. View only: a space surface publishes no
 * grant document (only `/api/endpoint/{slug}/access` does), and a cell that takes a value the
 * gateway will refuse loses the person's typing (UI-44).
 */
/** The space's endpoints whose grants are read for a writer: a space rarely has more. */
const MAX_ACCESS_READS = 10;

/** Each endpoint's grant document, as one value `useQueries` keeps while none of them changes. */
function grantsOf(results: UseQueryResult<GrantDocument>[]): (GrantDocument | undefined)[] {
  return results.map((result) => result.data);
}

/** The first endpoint whose grant lets the person correct attributes of `type`, with those attributes. */
function writerOf(
  grants: (GrantDocument | undefined)[],
  endpoints: Manifest[],
  type: string,
  slots: FilterSlot[],
  t: (key: string) => string,
): { slug: string; attrs: string[] } | null {
  for (const [at, doc] of grants.entries()) {
    const slug = slugOf(endpoints[at]);
    const attrs = editableAttributes(doc, type, slots, deniedAttributes(doc, type, slots, t));
    if (slug && attrs.length > 0) return { slug, attrs };
  }
  return null;
}

/** An endpoint's slug, which its gateway path is named by (EP-55). */
function slugOf(endpoint: Manifest | undefined): string | undefined {
  return typeof endpoint?.spec.slug === "string" ? endpoint.spec.slug : undefined;
}

function SpaceData({
  project,
  space,
  types,
  endpoints,
  model,
  retention,
}: {
  project: string;
  space: string;
  types: string[];
  endpoints: Manifest[];
  /** The space's DataModel: its enum slots are filtered by picking (UI-86). */
  model?: Manifest;
  /** The space's retention rules, which the import names for the imported rows (T-4822). */
  retention?: RetentionRule[];
}): JSX.Element {
  const { t, i18n } = useTranslation();
  // The type is in the address like the view, so back, reload and a sent link open it (T-4825).
  const [type, setType] = useUrlParam<string>("type", types[0] ?? "", types);
  // The open row is in the address too, so a link opens it in its dialog (T-4828).
  const [openRow, setOpenRow] = useUrlUrn("row");
  // "+ Row": the type's form in a dialog, creating through the space surface (T-4828).
  const [creating, setCreating] = useState(false);
  // The type's alerts are being chosen (T-3261).
  const [alertingType, setAlertingType] = useState(false);
  const modelSource = useModelSource(project, model);
  const enums = useMemo(
    () => enumsOfModel(modelSource, type, i18n.language),
    [modelSource, type, i18n.language],
  );
  const modelRelations = useMemo(() => relationsOfModel(modelSource, type), [modelSource, type]);
  const rules = useMemo(() => rulesOfModel(modelSource, type), [modelSource, type]);
  const slots = useMemo(() => filterSlotsOf(modelSource, type), [modelSource, type]);
  // The grid, or a view over the same rows (ADR-N-042 §3.2): the other views share one filter.
  // The view is in the address, so back, reload and a sent link open it (T-3239).
  const [view, setView] = useUrlParam<DataView>("view", "grid", DATA_VIEWS);
  const [q, setQ] = useState<string | undefined>(undefined);
  // A field is a slot of the type's class: offered only when the space's model declares the type.
  const ownClass = useMemo(
    () => modelSource !== undefined && parseModel(modelSource).classes.some((c) => c.name === type),
    [modelSource, type],
  );
  const [adding, setAdding] = useState(false);
  // Every Change the field dialog proposed: a formula field is two (DM-80).
  const [proposed, setProposed] = useState<Change[]>([]);
  // Import and export of the type (T-3109): rows created through the gateway with this session.
  const orgDomain = useOrgDomain(project);
  const importSlots = useMemo(() => importSlotsOf(modelSource, type), [modelSource, type]);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(0);
  const queryClient = useQueryClient();

  // The saved view applied, and what of the grid a view keeps: the typed query and the order
  // (API/01 §30). The filter row's query arrives through `onQuery`.
  const [saved, setSaved] = useState<SavedView | null>(null);
  const [gridView, setGridView] = useState<Pick<GridState, "filterText" | "sort">>({ filterText: null, sort: null });
  const [asked, setAsked] = useState<{ q?: string; idPattern?: string }>({});
  // What the view hides, colours and groups by (T-3099), and the group the grid is narrowed to.
  const [extras, setExtras] = useState<ViewExtras>(() => readLayout(project, space, type) ?? {});
  const [group, setGroup] = useState<string | null>(null);
  const [seen, setSeen] = useState<string[]>([]);
  // A form view's fields, conditions and prefill (T-3103, API/01 §30): its `settings`.
  const [formSettings, setFormSettings] = useState<FormSettings>({});
  // The grid's toolbar (T-4883): the filter panel's conditions, the search, the row size and each
  // column's footer, all but the search kept in the view's settings.
  const [filters, setFilters] = useState<FilterGroup>(EMPTY_GROUP);
  const [filterColumns, setFilterColumns] = useState<FilterColumn[]>([]);
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [rowSize, setRowSize] = useState<RowSize>("small");
  const [aggregations, setAggregations] = useState<Record<string, Aggregation>>({});
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [loadedRows, setLoadedRows] = useState<RichRow[]>([]);
  const applyView = useCallback((next: SavedView | null, forType: string = type) => {
    setSaved(next);
    const settings = (next?.kind === "grid" ? next.config.settings : undefined) as Record<string, unknown> | undefined;
    const tree = readGroup(settings?.filters);
    setFilters(tree ?? EMPTY_GROUP);
    setRowSize((ROW_SIZES as readonly unknown[]).includes(settings?.rowSize) ? (settings?.rowSize as RowSize) : "small");
    setAggregations(readAggregations(settings?.aggregations));
    setSearchText("");
    setSearch("");
    setSelectedRows([]);
    // A saved view opens as the kind it was saved as, with its filter for the views beside the grid.
    if (next && (DATA_VIEWS as readonly string[]).includes(next.kind)) setView(next.kind as DataView);
    setQ(next?.config.q ?? undefined);
    // "All rows" keeps the person's own columns in this browser; a saved view brings its own.
    const kept = next ? undefined : readLayout(project, space, forType);
    setExtras({
      hidden: next ? next.config.hidden : kept?.hidden,
      colour: next?.config.colour,
      group: next?.config.group,
      width: next ? next.config.width : kept?.width,
      order: next ? next.config.order : kept?.order,
      labels: next ? next.config.labels : kept?.labels,
    });
    setFormSettings(next?.kind === "form" ? ((next.config.settings ?? {}) as FormSettings) : {});
    setGroup(null);
    const first = next?.config.sort?.[0];
    setGridView({
      // A view saved with the filter panel holds its conditions; its `q` is their translation.
      filterText: tree ? null : (next?.config.q ?? null),
      sort: first ? { attr: first.attr, dir: first.desc ? "desc" : "asc" } : null,
    });
  }, [setView, project, space, type]);
  const onGridState = useCallback((next: GridState) => {
    setGridView((before) =>
      before.filterText === next.filterText && before.sort?.attr === next.sort?.attr && before.sort?.dir === next.sort?.dir
        ? before
        : { filterText: next.filterText, sort: next.sort },
    );
  }, []);
  useEffect(() => {
    const wait = setTimeout(() => setSearch(searchText), 400);
    return () => clearTimeout(wait);
  }, [searchText]);
  const panelQ = useMemo(() => queryFromGroup(filterColumns, filters), [filterColumns, filters]);
  // The search asks the type's text fields at the endpoint, at most eight of them per query.
  const searchQ = useMemo(
    () => searchQuery(search, filterColumns.filter((c) => c.kind === "text" && c.attr && !c.meta).slice(0, 8).map((c) => c.attr!)),
    [search, filterColumns],
  );
  const onFilterColumns = useCallback(
    (next: FilterColumn[]) => setFilterColumns((before) => (JSON.stringify(before) === JSON.stringify(next) ? before : next)),
    [],
  );
  const current = useMemo<ViewConfig>(
    () => ({
      ...(saved?.config ?? {}),
      ...extras,
      q: view === "grid" ? andQ(asked.q, panelQ) : q,
      sort: gridView.sort ? [{ attr: gridView.sort.attr, desc: gridView.sort.dir === "desc" }] : [],
      ...(view === "form" ? { settings: formSettings as Record<string, never> } : {}),
      ...(view === "grid"
        ? { settings: { filters, rowSize, aggregations } as unknown as Record<string, never> }
        : {}),
    }),
    [saved, extras, view, asked.q, panelQ, q, gridView.sort, formSettings, filters, rowSize, aggregations],
  );
  // The attributes a view can hide: the model's slots of the type and whatever the rows carry.
  const onRows = useCallback((rows: RichRow[]) => {
    setLoadedRows(rows);
    setSeen((before) => {
      const next = [...new Set([...before, ...attributesOf(rows)])];
      return next.length === before.length ? before : next;
    });
  }, []);
  // The slots of the type's class, in the model's order: what a form asks for (T-3103).
  const typeSlots = useMemo(() => {
    if (modelSource === undefined) return [];
    const parsed = parseModel(modelSource);
    const cls = parsed.classes.find((c) => c.name === type);
    return cls ? classSlots(parsed, cls) : [];
  }, [modelSource, type]);
  // The columns in the model's display order (DM-98), of what the person's own answer carries
  // (DM-102): a slot their grant leaves out never becomes a column, a label or a chip's end.
  const attributes = useMemo(() => displayOrder(typeSlots, seen), [typeSlots, seen]);
  const relations = useMemo(
    () => Object.fromEntries(Object.entries(modelRelations).filter(([attr]) => seen.includes(attr))),
    [modelRelations, seen],
  );
  // The first colour rule a row matches marks it, with the rule as the reason a screen reader hears.
  const rowTone = useCallback(
    (row: RichRow) => {
      const rule = (extras.colour ?? []).find((each) => each.when.trim() !== "" && matchesQ(row, each.when) === true);
      return rule ? { tone: rule.colour, label: t("spaces.saved.toneLabel", { when: rule.when }) } : undefined;
    },
    [extras.colour, t],
  );
  // What the grid asks beyond its own query: the panel, the search and the chosen group (T-4883).
  const gridQuery = useMemo(() => {
    const asked = andQ(panelQ, searchQ, extras.group && group !== null ? groupTerm(extras.group, group) : undefined);
    return asked ? { q: asked } : undefined;
  }, [panelQ, searchQ, extras.group, group]);
  const source = useMemo(
    () => sourceFor({ kind: "space", space }, originTransport(), i18n.language),
    [space, i18n.language],
  );
  // Where a correction is written: the first of the space's endpoints whose grant, asked of the
  // gateway once per endpoint, names a write on this type (T-4826). The grid reads the space and
  // writes through that endpoint with the person's session, so its Policy decides every value
  // (EP-55, UI-67); a person no endpoint lets write, a viewer, gets no editor at all.
  const grants = useQueries({
    queries: endpoints.slice(0, MAX_ACCESS_READS).map((endpoint) => accessQuery(slugOf(endpoint))),
    combine: grantsOf,
  });
  // Entities are not part of a copy (T-4868): inside one the grid reads the live space, so it
  // offers no write at all; the copy's own data lives in its preview (Try it).
  const { name: copy } = useWorkspace();
  const writer = useMemo(
    () => (copy ? null : writerOf(grants, endpoints, type, slots, t)),
    [copy, grants, endpoints, type, slots, t],
  );
  const gridSource = useMemo(
    () => (writer ? { ...source, patch: endpointSource(writer.slug, originTransport(), i18n.language).patch } : source),
    [writer, source, i18n.language],
  );

  const probe = useQuery({
    queryKey: ["space-surface", space, type],
    enabled: type !== "",
    retry: false,
    queryFn: async () => {
      await source.query({ type }, { offset: 0, limit: 1 });
      return true;
    },
  });

  // The type and its attributes as the model titles them, the key where it gives no title; an
  // entity is led by its name, its URN the open button's tooltip (T-4264, T-4160 #6).
  const titleOf = useCallback(
    (name: string) => {
      const cls = modelSource === undefined ? undefined : parseModel(modelSource).classes.find((c) => c.name === name);
      return localized(cls?.title, i18n.language, name);
    },
    [modelSource, i18n.language],
  );
  const typeTitle = titleOf(type);
  const columns = useMemo(() => {
    const titled = (attr: string) => columnLabel(typeSlots.find((slot) => slot.name === attr), attr, i18n.language);
    const named = attributes.includes("name");
    if (attributes.length === 0) return undefined;
    return [
      ...(named ? [{ attr: "name", pinned: true, label: titled("name") }] : []),
      ...attributes.filter((attr) => attr !== "name").map((attr) => ({ attr, label: titled(attr) })),
    ];
  }, [attributes, typeSlots, i18n.language]);
  // What the header menu changed, as the view keeps it (T-4827): on "All rows" in this browser too.
  const layout = useMemo(() => ({ order: extras.order, width: extras.width, labels: extras.labels }), [extras.order, extras.width, extras.labels]);
  const onLayout = useCallback(
    (next: { order?: readonly string[]; width?: Readonly<Record<string, number>>; labels?: Readonly<Record<string, string>> }) =>
      setExtras((before) => ({ ...before, order: next.order ? [...next.order] : before.order, width: next.width ? { ...next.width } : before.width, labels: next.labels ? { ...next.labels } : before.labels })),
    [],
  );
  const onHide = useCallback((attr: string) => setExtras((before) => ({ ...before, hidden: [...new Set([...(before.hidden ?? []), attr])] })), []);
  // The kept layout is read for each type before anything is written for it: the type can arrive
  // after the first render (the model loads), and writing first would store an empty layout. The
  // read happens while rendering, React's way to follow a changed input without an extra pass.
  const layoutKey = `${project}\u0000${space}\u0000${type}`;
  const [loadedFor, setLoadedFor] = useState(type === "" ? null : layoutKey);
  if (saved === null && type !== "" && loadedFor !== layoutKey) {
    setLoadedFor(layoutKey);
    const kept = readLayout(project, space, type);
    if (kept) setExtras((before) => ({ ...before, ...kept }));
  }
  useEffect(() => {
    if (saved !== null || type === "" || loadedFor !== layoutKey) return;
    writeLayout(project, space, type, { hidden: extras.hidden, width: extras.width, order: extras.order, labels: extras.labels });
  }, [saved, loadedFor, layoutKey, project, space, type, extras.hidden, extras.width, extras.order, extras.labels]);
  // A chip opens its target in the explorer, read through the person's own grant (T-4827).
  const navigate = useNavigate();
  const openTarget = useCallback(
    (urn: string) => void navigate({ to: "/projects/$project/explore", params: { project }, search: { space, type: targetName(urn).type, entityId: urn } }),
    [navigate, project, space],
  );

  const config = useMemo(() => {
    if (type === "") {
      return null;
    }
    return (
      parseGridConfig({
        source: { kind: "space", space },
        type,
        ...(columns ? { columns } : {}),
        pageSize: 100,
        ...(writer ? { mode: "edit" as const, editableAttrs: writer.attrs } : { mode: "view" as const }),
        history: { enabled: true },
      }).config ?? null
    );
  }, [space, type, columns, writer]);

  // The toolbar's actions, in its row for the other views and under "More" for the grid (T-4883).
  const addField =
    model && modelSource !== undefined && ownClass ? (
      <PermissionGuard project={project} kind="DataModel" verb="propose">
        <Button className="w-fit" onClick={() => setAdding(true)}>
          {t("spaces.fields.add")}
        </Button>
      </PermissionGuard>
    ) : null;
  const addRow =
    view === "grid" && typeSlots.length > 0 ? (
      // The same right as Import beside it; the space's Policy decides the write itself.
      <PermissionGuard project={project} kind="ContextSpace" verb="propose">
        <Button size="sm" onClick={() => setCreating(true)} disabled={!!copy} disabledReason={t("spaces.inside.copyLive")}>
          {t("spaces.inside.addRow")}
        </Button>
      </PermissionGuard>
    ) : null;
  const importButton =
    importSlots.length > 0 ? (
      // The same right as the upload link: the space has no grant document of its own (T-4263).
      <PermissionGuard project={project} kind="ContextSpace" verb="propose">
        <Button variant="secondary" onClick={() => setImporting(true)} disabled={!!copy} disabledReason={t("spaces.inside.copyLive")}>
          {t("spaces.import.open")}
        </Button>
      </PermissionGuard>
    ) : null;
  const alertsButton = (
    <Button variant="ghost" onClick={() => setAlertingType(true)}>
      {t("alerts.forType", { type: typeTitle })}
    </Button>
  );
  const filterTitle = (column: FilterColumn) => {
    const title = columnLabel(typeSlots.find((slot) => slot.name === column.attr), column.attr ?? column.key, i18n.language);
    return column.meta ? `${title} · ${t(`entityGrid.${column.meta}`)}` : title;
  };
  const rowNumberLabels = { selectRow: t("spaces.toolbar.selectRow"), selectAll: t("spaces.toolbar.selectAll") };

  if (types.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-body text-fg-muted">{t("spaces.inside.dataNoTypes")}</p>
        {/* A space with no type yet takes its first rows from a CSV (DM-81). */}
        <PermissionGuard project={project} kind="ContextSpace" verb="propose">
          <Link to="/projects/$project/spaces/upload" params={{ project }} search={{ space }} className="focus-ring w-fit text-body text-primary-soft-fg underline-offset-2 hover:underline">
            {t("spaces.upload.open")}
          </Link>
        </PermissionGuard>
      </div>
    );
  }
  return (
    // Baserow's shape (T-4825): the types and their saved views on the left, the rows beside them.
    <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <TypeList
        project={project}
        space={space}
        types={types}
        type={type}
        titleOf={titleOf}
        selected={saved}
        onType={(next) => {
          if (next === type) return;
          setType(next);
          applyView(null, next);
          setSeen([]);
        }}
        onView={applyView}
      />
      <div className="flex min-w-0 flex-col gap-3">
      {copy ? (
        <Alert tone="info" role="status" title={t("spaces.inside.copyLive")}>
          {t("spaces.inside.copyLiveHint")}{" "}
          <Link
            to="/projects/$project/workspaces/$name/try-it"
            params={{ project, name: copy }}
            className="focus-ring underline hover:no-underline"
          >
            {t("workspaces.bar.tryIt")}
          </Link>
        </Alert>
      ) : null}
      {model && modelSource !== undefined && ownClass ? (
        <div className="flex flex-col gap-2">
          <AddFieldDialog
            project={project}
            modelName={model.metadata.name}
            source={modelSource}
            type={type}
            open={adding}
            onOpenChange={(next) => {
              if (next) setProposed([]);
              setAdding(next);
            }}
            onProposed={(change) => setProposed((before) => [...before, change])}
            space={space}
            endpoints={endpoints}
            orgDomain={orgDomain}
          />
          {proposed.map((change) => (
            <ChangeNotice key={change.metadata.name} change={change} project={project} />
          ))}
        </div>
      ) : null}

      {probe.isPending ? <p role="status">{t("app.loading")}</p> : null}
      {probe.isError ? (
        <div className="text-body text-fg-muted">
          <p>{t("spaces.inside.dataThroughEndpoints")}</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {endpoints.map((endpoint) => {
              const slug = (endpoint.spec as { slug?: string }).slug ?? "";
              return (
                <li key={endpoint.metadata.name}>
                  {slug ? (
                    <EndpointLink href={endpointUrl(slug, "")}>{endpoint.metadata.name}</EndpointLink>
                  ) : (
                    <Badge mono>{endpoint.metadata.name}</Badge>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {probe.isSuccess ? (
        <Tabs
          id="space-data-view"
          label={t("spaces.views.label")}
          variant="pill"
          tabs={DATA_VIEWS.map((value) => ({ value, label: t(`spaces.views.kind.${value}`) }))}
          value={view}
          onChange={setView}
        />
      ) : null}
      {probe.isSuccess && view !== "api" ? (
        <>
          <Dialog
            open={creating}
            onOpenChange={setCreating}
            title={t("spaces.inside.addRowTitle", { type: typeTitle })}
            closeLabel={t("app.close")}
            size="lg"
          >
            <FormView
              space={space}
              type={type}
              slots={typeSlots}
              enums={enums}
              settings={formSettings}
              search={new URLSearchParams()}
              onCreated={() => setImported((n) => n + 1)}
            />
          </Dialog>
          {alertingType ? (
            <AlertDialog
              project={project}
              scope="type"
              target={`${space}/${type}`}
              label={type}
              onClose={() => setAlertingType(false)}
            />
          ) : null}
          <ImportRowsDialog
            open={importing}
            onOpenChange={setImporting}
            target={{ type, orgDomain, space }}
            slots={importSlots}
            send={originTransport()}
            retention={retention}
            onImported={() => {
              setImported((n) => n + 1);
              void queryClient.invalidateQueries({ queryKey: ["space-view-rows", space] });
            }}
          />
          {view === "grid" ? null : (
            <div className="flex flex-wrap items-end gap-3">
              {addField}
              {importButton}
              {alertsButton}
          <ExportLinks
            endpoints={endpoints}
            type={type}
            q={q}
            attrs={slots.map((slot) => slot.name)}
          />
            </div>
          )}
        </>
      ) : null}
      {probe.isSuccess && !copy ? (
        <TrashPanel
          project={project}
          space={space}
          restore={async (entity) => {
            const answer = await originTransport()({
              method: "POST",
              path: `/cs/${encodeURIComponent(space)}/ngsi-ld/v1/entities`,
              body: entity,
            });
            if (answer.status < 200 || answer.status >= 300) {
              const detail = (answer.body as { detail?: unknown; title?: unknown } | undefined) ?? {};
              throw new Error(String(detail.detail ?? detail.title ?? `HTTP ${answer.status}`));
            }
          }}
        />
      ) : null}
      {probe.isSuccess && config && view !== "api" && view !== "grid" ? (
        <ViewBar
          project={project}
          space={space}
          type={type}
          kind={view}
          selected={saved}
          onSelect={applyView}
          current={current}
        />
      ) : null}
      {probe.isSuccess && config && view === "grid" ? (
        <div className="flex flex-wrap items-center gap-1 border-b border-border pb-2" data-testid="grid-toolbar">
          <span className="mr-2 max-w-48 truncate text-body font-semibold" title={saved?.title}>
            {saved?.title ?? t("spaces.inside.allRows")}
          </span>
          <ToolbarPopover label={t("spaces.toolbar.filter")} count={conditionCount(filters)} wide>
            <FilterPanel columns={filterColumns} titleOf={filterTitle} value={filters} onChange={setFilters} />
          </ToolbarPopover>
          <ToolbarPopover label={t("spaces.toolbar.hide")} count={extras.hidden?.length}>
            <ViewOptions part="fields" attributes={attributes} enums={enums} value={extras} onChange={setExtras} />
          </ToolbarPopover>
          <ToolbarPopover label={t("spaces.toolbar.group")} count={extras.group ? 1 : 0}>
            <ViewOptions part="group" attributes={attributes} enums={enums} value={extras} onChange={setExtras} />
          </ToolbarPopover>
          <ToolbarPopover label={t("spaces.toolbar.colour")} count={extras.colour?.length} wide>
            <ViewOptions part="colours" attributes={attributes} enums={enums} value={extras} onChange={setExtras} />
          </ToolbarPopover>
          <ToolbarPopover label={t("spaces.toolbar.rowSize")}>
            <RadioGroup
              name="grid-row-size"
              legend={t("spaces.toolbar.rowSize")}
              value={rowSize}
              options={ROW_SIZES.map((size) => ({ value: size, label: t(`spaces.toolbar.rowSizes.${size}`) }))}
              onChange={setRowSize}
            />
          </ToolbarPopover>
          <Input
            type="search"
            aria-label={t("spaces.toolbar.search")}
            placeholder={t("spaces.toolbar.searchPlaceholder")}
            className="h-8 w-full sm:w-48"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
          <div className="ml-auto flex items-center gap-1">
            {addRow}
            <ToolbarPopover label={t("spaces.toolbar.more")} wide end>
              <div className="flex flex-col gap-3">
                <ViewBar
                  project={project}
                  space={space}
                  type={type}
                  kind={view}
                  selected={saved}
                  onSelect={applyView}
                  current={current}
                  unsaved={asked.idPattern ? t("spaces.saved.idNotKept") : undefined}
                />
                <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
                  {addField}
                  {importButton}
                  {alertsButton}
                  <ExportLinks endpoints={endpoints} type={type} q={andQ(asked.q, gridQuery?.q)} attrs={slots.map((slot) => slot.name)} />
                </div>
              </div>
            </ToolbarPopover>
          </div>
        </div>
      ) : null}
      {probe.isSuccess && config && view === "grid" && selectedRows.length > 0 ? (
        <BulkBar
          project={project}
          space={space}
          source={source}
          count={selectedRows.length}
          rows={loadedRows.filter((row) => selectedRows.includes(row.id))}
          canDelete={grants.some((doc) => mayDelete(doc, type))}
          onClear={() => setSelectedRows([])}
          onDeleted={(kept) => {
            // The refused rows stay checked, so the bar keeps naming them and they can be tried again.
            setSelectedRows(kept);
            setImported((n) => n + 1);
          }}
        />
      ) : null}
      {probe.isSuccess && config && view === "grid" && extras.group && enums[extras.group] ? (
        <GroupCounts
          source={source}
          type={type}
          attr={extras.group}
          options={enums[extras.group]}
          q={andQ(asked.q, panelQ, searchQ)}
          chosen={group}
          onChoose={setGroup}
        />
      ) : null}
      {probe.isSuccess && view === "api" ? (
        <div {...tabPanelProps("space-data-view", view)}>
          <TypeApi project={project} space={space} type={type} endpoints={endpoints} />
          <SharePanel key={type} project={project} space={space} type={type} attributes={slots.map((slot) => slot.name)} />
        </div>
      ) : null}
      {probe.isSuccess && view === "form" ? (
        <div {...tabPanelProps("space-data-view", view)} className="flex flex-col gap-3">
          <FormSettingsEditor slots={typeSlots} value={formSettings} onChange={setFormSettings} />
          {copy ? null : <FormView space={space} type={type} slots={typeSlots} enums={enums} settings={formSettings} />}
          <FormSharePanel
            key={type}
            project={project}
            space={space}
            type={type}
            attributes={attributes}
            asked={(formSettings.fields?.length ? formSettings.fields.map((field) => field.attr) : typeSlots.map((slot) => slot.name))}
            relationships={typeSlots.filter((slot) => slot.kind === "Relationship").map((slot) => slot.name)}
          />
        </div>
      ) : null}
      {probe.isSuccess && view !== "grid" && view !== "api" && view !== "form" ? (
        <div {...tabPanelProps("space-data-view", view)} className="flex flex-col gap-3">
          <EntityFilters
            id="space-view-filter"
            types={[type]}
            slots={slots}
            value={{ type, q }}
            onChange={(next) => setQ(next.q)}
          />
          <OtherView
            project={project}
            source={source}
            space={space}
            type={type}
            q={q}
            view={view}
            enums={enums}
            endpoints={endpoints.map((endpoint) => endpoint.metadata.name)}
          />
        </div>
      ) : null}
      {/* The grid is a view like the others: its tab names this panel (axe aria-valid-attr-value, T-3851). */}
      {probe.isSuccess && config && view === "grid" ? (
        <div {...tabPanelProps("space-data-view", view)}>
        <PortalEntityGrid
          // A new key after an import, or a view applied, reads the type again: nothing typed under
          // the last one carries over.
          key={`${space}-${type}-${saved?.id ?? ""}-${imported}`}
          detailTabs={(row) => [
            { id: "comments", label: t("spaces.comments.title"), content: <CommentsPanel project={project} space={space} urn={row.id} /> },
          ]}
          openRow={openRow}
          onOpenRow={setOpenRow}
          project={project}
          config={config}
          source={gridSource}
          // The whole type by scrolling, a window drawn at a time (T-3097).
          virtual
          enums={enums}
          relations={relations}
          rules={rules}
          // Without a saved view the grid keeps the person's own remembered order.
          view={saved ? gridView : undefined}
          onGridState={onGridState}
          onQuery={setAsked}
          onRows={onRows}
          hidden={extras.hidden}
          onHide={onHide}
          layout={layout}
          onLayout={onLayout}
          onOpenRelationship={openTarget}
          rowTone={rowTone}
          query={gridQuery}
          filterRow={false}
          onFilterColumns={onFilterColumns}
          rowNumbers={rowNumberLabels}
          selected={selectedRows}
          onSelectedChange={setSelectedRows}
          rowSize={rowSize}
          footer={(column) =>
            column.attr && !column.meta ? (
              <FooterAggregate
                source={source}
                type={type}
                attr={column.attr}
                label={column.label}
                q={andQ(asked.q, gridQuery?.q)}
                value={aggregations[column.attr] ?? "none"}
                onChange={(next) => setAggregations((before) => ({ ...before, [column.attr!]: next }))}
              />
            ) : null
          }
          empty={<p className="text-body text-fg-muted">{t("spaces.inside.dataEmpty")}</p>}
        />
        </div>
      ) : null}
      </div>
    </div>
  );
}

/** The footer's aggregations a saved view holds, only the ones the toolbar knows. */
function readAggregations(raw: unknown): Record<string, Aggregation> {
  if (typeof raw !== "object" || raw === null) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, Aggregation] => (AGGREGATIONS as readonly unknown[]).includes(entry[1])),
  );
}

/**
 * What a person does with the rows they checked (T-4883): delete them, each a write through the
 * space surface with their session, so the Policy decides every one; each deleted row keeps the
 * person's copy in the trash first (T-3107). A refused row stays, named with the reason.
 */
function BulkBar({
  project,
  space,
  source,
  count,
  rows,
  canDelete,
  onClear,
  onDeleted,
}: {
  project: string;
  space: string;
  source: ReturnType<typeof sourceFor>;
  /** How many rows are checked; `rows` holds those of them the grid has loaded. */
  count: number;
  rows: RichRow[];
  canDelete: boolean;
  onClear: () => void;
  onDeleted: (kept: string[]) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [refused, setRefused] = useState<{ name: string; reason: string }[]>([]);
  const remove = async () => {
    setRunning(true);
    const failed: { id: string; name: string; reason: string }[] = [];
    for (const row of rows) {
      try {
        await deleteRow(project, space, source, row);
      } catch (error) {
        failed.push({ id: row.id, name: cellText(row.cells.name) || row.id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    setRunning(false);
    setConfirming(false);
    setRefused(failed);
    await queryClient.invalidateQueries({ queryKey: trashKey(project, space) });
    if (failed.length < rows.length) onDeleted(failed.map((each) => each.id));
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-primary-soft px-3 py-2" role="region" aria-label={t("spaces.toolbar.selection")}>
        <span className="text-body font-medium">{t("spaces.toolbar.selected", { n: count })}</span>
        <Button
          size="sm"
          variant="danger"
          disabled={!canDelete || rows.length === 0}
          disabledReason={t("spaces.toolbar.deleteNotGranted")}
          onClick={() => setConfirming(true)}
        >
          {t("spaces.toolbar.deleteSelected")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClear}>
          {t("spaces.toolbar.clearSelection")}
        </Button>
      </div>
      {refused.length > 0 ? (
        <Alert tone="danger" title={t("spaces.toolbar.deleteRefused", { n: refused.length })}>
          <ul className="list-disc pl-5">
            {refused.map((each) => (
              <li key={each.name}>{`${each.name}: ${each.reason}`}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("spaces.toolbar.deleteTitle", { n: rows.length })}
        description={t("spaces.toolbar.deleteBody")}
        confirmLabel={t("spaces.toolbar.deleteSelected")}
        tone="danger"
        pending={running}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

/**
 * The space's entity types, each a button that opens it, and under the open one its saved views
 * (API/01 §30): the left list of the data workspace (T-4825). The views come from the same query
 * the view bar reads, so a view saved there appears here at once.
 */
function TypeList({
  project,
  space,
  types,
  type,
  titleOf,
  selected,
  onType,
  onView,
}: {
  project: string;
  space: string;
  types: string[];
  type: string;
  titleOf: (type: string) => string;
  selected: SavedView | null;
  onType: (type: string) => void;
  onView: (view: SavedView | null) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const views = useQuery({
    queryKey: dataViewsKey(project, space),
    retry: false,
    queryFn: () => listViews(project, space),
  });
  const ofType = (views.data ?? []).filter((view) => view.type === type);
  const item = (current: boolean) =>
    clsx("w-full justify-start truncate text-left text-body", current && "bg-primary-soft font-medium text-primary-soft-fg");
  return (
    <nav aria-label={t("spaces.inside.types")} className="lg:border-r lg:border-border lg:pr-3">
      <ul className="flex flex-col gap-0.5">
        {types.map((each) => (
          <li key={each}>
            <Button
              variant="ghost"
              size="sm"
              className={item(each === type)}
              aria-current={each === type ? "true" : undefined}
              title={each}
              onClick={() => onType(each)}
            >
              {titleOf(each)}
            </Button>
            {each === type ? (
              <ul aria-label={t("spaces.inside.savedViews")} className="ml-3 mt-0.5 flex flex-col gap-0.5 border-l border-border pl-2">
                <li>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={item(selected === null)}
                    aria-current={selected === null ? "true" : undefined}
                    onClick={() => onView(null)}
                  >
                    {t("spaces.inside.allRows")}
                  </Button>
                </li>
                {ofType.map((view) => (
                  <li key={view.id}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={item(selected?.id === view.id)}
                      aria-current={selected?.id === view.id ? "true" : undefined}
                      onClick={() => onView(view)}
                    >
                      {view.title}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The views of a space's entities (ADR-N-042 §3.2); the grid is the first. */
const DATA_VIEWS = ["grid", "gallery", "kanban", "calendar", "timeline", "form", "api"] as const;
type DataView = (typeof DATA_VIEWS)[number];

/** One view other than the grid, over one page of the filtered type. */
function OtherView({
  project,
  source,
  space,
  type,
  q,
  view,
  enums,
  endpoints,
}: {
  project: string;
  source: ReturnType<typeof sourceFor>;
  space: string;
  type: string;
  q: string | undefined;
  view: Exclude<DataView, "grid" | "api" | "form">;
  /** The enum slots of the type, by attribute, titled in the page's language (UI-86). */
  enums: Record<string, EnumChoice[]>;
  /** The names of the space's Endpoints, which the AI field writes through. */
  endpoints: string[];
}): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const rows = useViewRows(source, space, type, q);
  // Someone changed rows of this type, anywhere: the page is read again with this session (T-3105).
  const [live, setLive] = useState<LiveChange | null>(null);
  useLive(project, space, type, (change) => {
    setLive(change);
    void queryClient.invalidateQueries({ queryKey: ["space-view-rows", space, type] });
  });
  // A delete keeps the person's copy, then reads the page and the trash again (T-3107).
  const onDelete = async (row: RichRow) => {
    await deleteRow(project, space, source, row);
    await queryClient.invalidateQueries({ queryKey: ["space-view-rows", space] });
    await queryClient.invalidateQueries({ queryKey: trashKey(project, space) });
  };
  if (rows.isPending) return <p role="status">{t("app.loading")}</p>;
  if (rows.isError) {
    return (
      <PageFailed error={rows.error} onRetry={() => void rows.refetch()} />
    );
  }
  if (rows.data.rows.length === 0) {
    return <p className="text-body text-fg-muted">{t("spaces.inside.dataEmpty")}</p>;
  }
  const shown = rows.data.rows;
  return (
    <RowExtra.Provider value={(row) => <CommentsPanel project={project} space={space} urn={row.id} />}>
      <LiveNotice change={live} />
      {view === "gallery" ? <GalleryView rows={shown} source={source} onDelete={onDelete} /> : null}
      {view === "kanban" ? <KanbanView rows={shown} source={source} enums={enums} onDelete={onDelete} /> : null}
      {view === "calendar" ? <CalendarView rows={shown} source={source} onDelete={onDelete} /> : null}
      {view === "timeline" ? <TimelineView rows={shown} source={source} onDelete={onDelete} /> : null}
      <AiFieldPanel project={project} space={space} type={type} endpoints={endpoints} rows={shown} />
    </RowExtra.Provider>
  );
}

/**
 * What one endpoint answers, folded into one line (T-2280, UI-26, EP-51).
 *
 * Every representation on its own line made two endpoints fill the screen, and a column that tall
 * cannot be read down — which is the only reason to put audience and state in a table at all. The
 * summary names the first two and counts the rest; opening it shows each representation where it can
 * be clicked, and the documents that belong to the endpoint beside them. `<details>` rather than a
 * menu of our own, because the browser already gives it a keyboard, a role and a state a screen
 * reader announces.
 */
function Representations({
  slug,
  representations,
}: {
  slug: string;
  representations: string[];
}): JSX.Element {
  const { t } = useTranslation();
  const { domain } = useBranding();
  const named = representations.slice(0, 2);
  const rest = representations.length - named.length;
  const link = (rep: string) =>
    slug && REPRESENTATION_PATHS[rep] ? (
      <EndpointLink href={representationUrl(slug, rep, domain)}>{rep}</EndpointLink>
    ) : (
      <Badge mono>{rep}</Badge>
    );

  if (representations.length === 0 && !slug) {
    return <span className="text-body text-fg-subtle">{t("endpoints.field.noRepresentations")}</span>;
  }

  return (
    <details className="group">
      <summary className="focus-ring cursor-pointer list-none text-body">
        <span className="font-mono">{named.join(", ")}</span>
        {rest > 0 ? (
          <span className="ml-1 text-fg-muted">{t("endpoints.field.more", { count: rest })}</span>
        ) : null}
      </summary>
      <ul className="mt-1 flex flex-wrap gap-1">
        {representations.map((rep) => (
          <li key={rep}>{link(rep)}</li>
        ))}
      </ul>
      {slug ? (
        <ul className="mt-1 flex flex-wrap gap-1">
          {ENDPOINT_LINKS.map((entry) => (
            <li key={entry.key}>
              <EndpointLink href={endpointUrl(slug, entry.path)}>
                {t(`endpoints.link.${entry.key}`)}
              </EndpointLink>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

/**
 * What a section shows in place of its table: the wait, the failure, or the words for empty.
 *
 * The three sections below each wrote `query.isPending ? loading : "there are none"`, so a
 * list that came back 403 or never came back at all said "this space has no endpoints" — the
 * most reassuring possible rendering of a failed read (UI-15, T-1854).
 */
function SectionState({
  query,
  empty,
}: {
  query: Pick<UseQueryResult, "isPending" | "isError" | "error" | "refetch">;
  empty: ReactNode;
}): JSX.Element {
  const { t } = useTranslation();
  if (query.isPending) {
    return (
      <p role="status" className="text-body text-fg-muted">
        {t("app.loading")}
      </p>
    );
  }
  if (query.isError) {
    return (
      <PageFailed
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  return <p className="text-body text-fg-muted">{empty}</p>;
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-2">
      <h2 className="text-title font-semibold text-fg">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The space's data model, one click from the space (T-2762; DM-61, DM-62): its title and
 * version, a link to its own page, Edit for a person who may propose it, and the diagram, form
 * and YAML views read-only. A space without one offers Create and Import, prefilled for it.
 */
function SpaceModel({
  project,
  space,
  model,
  models,
}: {
  project: string;
  space: string;
  model: Manifest | undefined;
  models: Pick<UseQueryResult, "isPending" | "isError" | "error" | "refetch">;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const source = useSourceOf(project, model);
  if (model === undefined) {
    if (models.isPending || models.isError) {
      return <SectionState query={models} empty={null} />;
    }
    return (
      <EmptyState
        icon="models"
        title={t("spaces.inside.modelEmpty")}
        description={t("spaces.inside.modelEmptyLead")}
        action={
          <div className="flex flex-wrap gap-2">
            <ProposeLink project={project} search={{ new: "blank", space }} variant="primary">
              {t("spaces.inside.modelCreate")}
            </ProposeLink>
            <ProposeLink project={project} search={{ new: "sdm", space }}>
              {t("spaces.inside.modelImport")}
            </ProposeLink>
          </div>
        }
      />
    );
  }
  const name = model.metadata.name;
  const title = localized(model.metadata.title, i18n.language, name);
  const version = typeof model.spec.version === "string" ? model.spec.version : undefined;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-2 text-body">
          <Link
            to="/projects/$project/models/$name"
            params={{ project, name }}
            className="focus-ring font-medium text-primary-soft-fg underline-offset-2 hover:underline"
          >
            {title}
          </Link>
          {title !== name ? <span className="font-mono text-caption text-fg-muted">{name}</span> : null}
          {version ? <span className="font-mono text-caption text-fg-muted">v{version}</span> : null}
        </p>
        <ProposeLink project={project} search={{ edit: name }}>
          {t("models.page.edit")}
        </ProposeLink>
      </div>
      {source.isError ? (
        <Alert tone="danger" role="alert">
          <p>{t("models.page.sourceFailed", { reason: source.error instanceof Error ? source.error.message : "" })}</p>
          <Button size="sm" className="mt-2" onClick={() => void source.refetch()}>
            {t("app.error.retry")}
          </Button>
        </Alert>
      ) : source.data === undefined ? (
        <p role="status" className="text-body text-fg-muted">
          {t("models.source.loading")}
        </p>
      ) : (
        <ModelViews project={project} source={source.data} name={name} id="space-model-views" />
      )}
    </div>
  );
}

/** What a Context Space holds: its entity types with live counts, its endpoints and policies. */
export function SpaceInside({ project, name }: { project: string; name: string }): JSX.Element {
  const { t, i18n } = useTranslation();
  const identity = useIdentity();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "sk";
  // The space's alerts are being chosen (T-3261).
  const [alerting, setAlerting] = useState(false);
  // The page opens on the rows; the model, quality, retention, endpoints and policies are tabs
  // beside them, kept in the address (T-4825: the whole model came before the grid, 14,515 px).
  const [tab, setTab] = useUrlParam<SpaceTab>("tab", "data", SPACE_TABS);
  // What the whole space holds, the broker's count (T-2889), asked only on the model tab beside
  // the types counted through the person's own endpoint. The data tab counts only through the
  // grid's own answer (T-4885): this whole-tenant scan took longer than the page waits on
  // helsinki and put "the count did not come" under a grid that had its count.
  const usage = useQuery({ ...spaceUsageQuery(project, name), enabled: tab === "model" });

  const space = useQuery({
    queryKey: queryKeys.resource(project, "spaces", name),
    retry: false,
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}/{name}", {
          params: { path: { project, plural: "spaces", name } },
        }),
      ),
  });
  const models = useProjectList(project, "datamodels");
  const endpoints = useProjectList(project, "endpoints");
  const policies = useProjectList(project, "policies");
  const catalogueLink = useCatalogueLinks([project]);

  if (space.isPending) {
    return <PageLoading label={t("app.loading")} />;
  }
  if (space.isError) {
    return (
      <ResourcePageFailed
        title={name}
        description={t("spaces.lead")}
        error={space.error}
        onRetry={() => {
          void space.refetch();
        }}
        back={
          <Link
            to="/projects/$project/$plural"
            params={{ project, plural: "spaces" }}
            className="focus-ring text-body text-primary-soft-fg underline hover:no-underline"
          >
            {t("spaces.inside.back")}
          </Link>
        }
      />
    );
  }

  const manifest = space.data as Manifest;
  // Every DataModel that names this space, not only the one the space names back. A model's
  // `contextSpaceRef` is required and a space's `dataModelRef` is an optional pointer at the
  // primary one (kinds: `DataModelSpec`, `SpaceSpec`), and no seeded space sets it — so reading
  // the pointer alone left this table empty for every space on dev, Helsinki's included, while
  // the space held hundreds of entities (T-2450). The pointer still decides which model is
  // first, and so which type the grid below opens on.
  const named = modelsOfSpace(manifest, asManifests(models.data?.items ?? []));
  const model = named[0];
  const types = [...new Set(named.flatMap(entityTypesOf))];
  const spaceEndpoints = asManifests(endpoints.data?.items ?? []).filter(
    (endpoint) => spaceOf(endpoint) === name,
  );
  const readEndpoint = pickReadEndpoint(spaceEndpoints, identity ? (identity.groups ?? []) : null, project);
  const slug =
    typeof readEndpoint?.spec.slug === "string" ? (readEndpoint.spec.slug as string) : undefined;
  const spacePolicies = asManifests(policies.data?.items ?? []).filter(
    (policy) => spaceOf(policy) === name,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            to="/projects/$project/$plural"
            params={{ project, plural: "spaces" }}
            className="focus-ring text-body text-primary-soft-fg underline hover:no-underline"
          >
            {t("spaces.inside.back")}
          </Link>
          <PageHeader
            title={localized(manifest.metadata.title, locale, manifest.metadata.name)}
            description={
              <>
                {/* What the space is for comes first; its name is the identifier beside it (T-3851). */}
                {localized(manifest.metadata.description, locale, "") || t("spaces.inside.lead")}{" "}
                <span className="font-mono">{manifest.metadata.name}</span>
              </>
            }
          />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setAlerting(true)}>
            {t("alerts.forSpace")}
          </Button>
          <LifecycleBadge kind="phase" value={manifest.status?.phase} />
        </div>
      </div>
      {alerting ? (
        <AlertDialog
          project={project}
          scope="space"
          target={manifest.metadata.name}
          label={localized(manifest.metadata.title, locale, manifest.metadata.name)}
          onClose={() => setAlerting(false)}
        />
      ) : null}

      <Tabs
        id="space-inside"
        label={t("spaces.inside.sections")}
        tabs={SPACE_TABS.map((value) => ({ value, label: t(TAB_LABELS[value]) }))}
        value={tab}
        onChange={setTab}
      />

      {tab === "data" ? (
        <div {...tabPanelProps("space-inside", tab)}>
          <SpaceData
            project={project}
            space={name}
            types={types}
            endpoints={spaceEndpoints}
            model={model}
            retention={rulesOf(manifest)}
          />
        </div>
      ) : null}

      {tab === "model" ? (
        <div {...tabPanelProps("space-inside", tab)} className="space-y-6">
      <Section title={t("spaces.inside.model")}>
        <SpaceModel project={project} space={name} model={model} models={models} />
      </Section>

      <Section title={<Term name="entityType">{t("spaces.inside.types")}</Term>}>
        {model === undefined ? (
          <SectionState query={models} empty={t("spaces.inside.noModel")} />
        ) : types.length === 0 ? (
          <p className="text-body text-fg-muted">
            {t("spaces.inside.noTypes", { model: model.metadata.name })}
          </p>
        ) : (
          <>
            <p className="text-body text-fg-muted">
              {t("spaces.field.dataModel")}:{" "}
              <Link
                to="/projects/$project/models/$name"
                params={{ project, name: model.metadata.name }}
                className="focus-ring font-mono text-primary-soft-fg underline-offset-2 hover:underline"
              >
                {model.metadata.name}
              </Link>
              {readEndpoint ? (
                <>
                  {" · "}
                  {t("spaces.inside.readThrough", { endpoint: readEndpoint.metadata.name })}
                </>
              ) : (
                <>
                  {" · "}
                  {endpoints.isPending
                    ? t("app.loading")
                    : endpoints.isError
                      ? t("app.error.generic")
                      : t("spaces.inside.noEndpoint")}
                </>
              )}
            </p>
            <Table caption={t("spaces.inside.types")}>
              <TableHead>
                <TableHeaderCell>{t("spaces.inside.type")}</TableHeaderCell>
                <TableHeaderCell align="right">{t("spaces.inside.count")}</TableHeaderCell>
                <TableHeaderCell align="right" secondary>{t("spaces.inside.size")}</TableHeaderCell>
                {/* A phone keeps the type and its count (UI-27): the samples squeezed to a letter
                    a line ran 800 px down the page (T-4265, photo audit T-4160 #5). */}
                <TableHeaderCell secondary>{t("spaces.inside.samples")}</TableHeaderCell>
              </TableHead>
              <TableBody>
                {types.map((type) => (
                  <TypeRow
                    key={type}
                    project={project}
                    space={name}
                    slug={slug}
                    type={type}
                    bytes={bytesOfType(usage.data?.bytes?.byType, type)}
                  />
                ))}
              </TableBody>
            </Table>
            <SpaceTotal usage={usage} />
          </>
        )}
      </Section>

        </div>
      ) : null}

      {tab === "quality" ? (
        <div {...tabPanelProps("space-inside", tab)} className="space-y-6">
          <div className="space-y-4">
            <SpaceQuality project={project} space={name} />
            <SpaceChecks project={project} space={name} />
          </div>
          <Section title={t("drift.section.title")}>
            <SpaceDrift project={project} space={name} />
          </Section>
        </div>
      ) : null}

      {tab === "retention" ? (
        <div {...tabPanelProps("space-inside", tab)}>
          <SpaceRetention project={project} space={name} manifest={manifest} types={types} />
          <div className="mt-6">
            <Section title={t("spaces.temporal.title")}>
              <SpaceTemporalAudit project={project} space={name} />
            </Section>
          </div>
          <div className="mt-6">
            <Section title={t("spaces.personal.title")}>
              <SpacePersonalData project={project} space={name} />
            </Section>
          </div>
        </div>
      ) : null}

      {tab === "endpoints" ? (
      <div {...tabPanelProps("space-inside", tab)}>
      <Section title={<Term name="endpoint">{t("endpoints.title")}</Term>}>
        {spaceEndpoints.length === 0 ? (
          <SectionState query={endpoints} empty={t("spaces.inside.noEndpoints")} />
        ) : (
          <Table caption={t("endpoints.title")}>
            <TableHead>
              <TableHeaderCell>{t("endpoints.field.name")}</TableHeaderCell>
              <TableHeaderCell>{t("endpoints.field.audience")}</TableHeaderCell>
              <TableHeaderCell>{t("endpoints.field.representations")}</TableHeaderCell>
              <TableHeaderCell>{t("spaces.inside.catalogue")}</TableHeaderCell>
            </TableHead>
            <TableBody>
              {spaceEndpoints.map((endpoint) => {
                const spec = endpoint.spec as {
                  slug?: string;
                  audience?: string;
                  enabledRepresentations?: string[];
                  policyRef?: string;
                };
                const endpointSlug = spec.slug ?? "";
                const catalogue = catalogueLink(project, endpoint);
                return (
                  <TableRow key={endpoint.metadata.name}>
                    <TableCell>
                      <div className="font-medium">
                        {localized(endpoint.metadata.title, locale, endpoint.metadata.name)}
                      </div>
                      <div className="font-mono text-caption text-fg-subtle">
                        {endpoint.metadata.title ? endpoint.metadata.name : null}
                        {spec.policyRef
                          ? `${endpoint.metadata.title ? " · " : ""}${refName(spec.policyRef)}`
                          : ""}
                      </div>
                    </TableCell>
                    <TableCell>
                      <SharedWithBadge endpoint={endpoint} />
                    </TableCell>
                    <TableCell>
                      <Representations
                        slug={endpointSlug}
                        representations={servedRepresentations(spec)}
                      />
                    </TableCell>
                    <TableCell>
                      {catalogue ? (
                        <EndpointLink href={catalogue}>{t("spaces.inside.catalogueLink")}</EndpointLink>
                      ) : (
                        <span className="text-fg-subtle">{t("spaces.inside.notPublished")}</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>
      </div>
      ) : null}

      {tab === "policies" ? (
      <div {...tabPanelProps("space-inside", tab)}>
      <Section title={<Term name="policy">{t("spaces.inside.policies")}</Term>}>
        {spacePolicies.length === 0 ? (
          <SectionState query={policies} empty={t("spaces.inside.noPolicies")} />
        ) : (
          <Table caption={t("spaces.inside.policies")}>
            <TableHead>
              <TableHeaderCell>{t("spaces.field.name")}</TableHeaderCell>
              <TableHeaderCell>{t("spaces.inside.assignee")}</TableHeaderCell>
              <TableHeaderCell secondary>{t("spaces.inside.operations")}</TableHeaderCell>
              <TableHeaderCell secondary>{t("spaces.inside.type")}</TableHeaderCell>
            </TableHead>
            <TableBody>
              {spacePolicies.map((policy) => {
                const spec = policy.spec as {
                  assignee?: { kind?: string; id?: string };
                  operations?: string[];
                  information?: Array<{ entities?: Array<{ type?: string }> }>;
                };
                const policyTypes = (spec.information ?? [])
                  .flatMap((info) => info.entities ?? [])
                  .map((entity) => entity.type)
                  .filter((type): type is string => typeof type === "string");
                return (
                  <TableRow key={policy.metadata.name}>
                    <TableCell>
                      <div className="font-medium">
                        {localized(policy.metadata.title, locale, policy.metadata.name)}
                      </div>
                      {policy.metadata.title ? (
                        <div className="font-mono text-caption text-fg-subtle">
                          {policy.metadata.name}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-caption">
                      {spec.assignee
                        ? `${spec.assignee.kind ?? ""}${spec.assignee.kind ? ":" : ""}${spec.assignee.id ?? ""}`
                        : "—"}
                    </TableCell>
                    <TableCell secondary className="font-mono text-caption">
                      {(spec.operations ?? []).join(", ") || "—"}
                    </TableCell>
                    <TableCell secondary className="font-mono text-caption">
                      {policyTypes.join(", ") || "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>
      </div>
      ) : null}

      {tab === "activity" ? (
        <div {...tabPanelProps("space-inside", tab)}>
          <ActivityFeed project={project} compact fixed={{ space: name }} limit={10} />
        </div>
      ) : null}
    </div>
  );
}

const SPACE_TABS = ["data", "model", "quality", "retention", "endpoints", "policies", "activity"] as const;
type SpaceTab = (typeof SPACE_TABS)[number];
const TAB_LABELS: Record<SpaceTab, string> = {
  data: "spaces.inside.data",
  model: "spaces.inside.model",
  quality: "spaces.quality.title",
  retention: "spaces.retention.title",
  endpoints: "endpoints.title",
  policies: "spaces.inside.policies",
  activity: "activity.panelTitle",
};

/**
 * What the whole space holds, the broker's count (T-2889), under the types table: counting, the
 * count with its size and broker, or why there is none (T-4825).
 */
function SpaceTotal({ usage }: { usage: UseQueryResult<SpaceUsage> }): JSX.Element {
  const { t, i18n } = useTranslation();
  if (usage.data !== undefined) {
    const { bytes } = usage.data;
    return (
      <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2 text-caption text-fg-muted">
        <span className="text-body text-fg" data-testid="space-total">
          {t("spaces.inside.total", { count: usage.data.entities })}
        </span>
        {bytes ? (
          <span data-testid="space-size" title={exactBytes(bytes.entities + bytes.attrInstances, i18n.language)}>
            {t("spaces.inside.totalSize", {
              size: sizeText(bytes.entities + bytes.attrInstances, i18n.language),
              history: sizeText(bytes.attrInstances, i18n.language),
            })}
          </span>
        ) : null}
        <span data-testid="space-broker">{t("spaces.inside.broker", { broker: usage.data.broker })}</span>
      </footer>
    );
  }
  return (
    <footer className="border-t border-border pt-2 text-body text-fg-muted" data-testid="space-total" role="status">
      {usage.isError ? t("spaces.entitiesUnknown", { reason: usageRefusal(usage.error) }) : t("spaces.inside.counting")}
    </footer>
  );
}
