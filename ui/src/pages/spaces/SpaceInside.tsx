import { AlertDialog } from "../../components/AlertDialog";
import { useCallback, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { attributesOf, matchesQ, originTransport, parseGridConfig, sourceFor } from "@joinedcontext/sdk";
import type { GridState, RichRow } from "@joinedcontext/sdk";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, ApiError, queryKeys, unwrap } from "../../api/client";
import { spaceUsageQuery, usageRefusal } from "../../api/spaceUsage";
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
import { SharedWithBadge, admitsPerson } from "../../components/endpoints/sharing";
import { useIdentity } from "../../auth/AuthProvider";
import { PortalEntityGrid } from "../../components/entities/PortalEntityGrid";
import { EntityFilters } from "../../components/entities/EntityFilters";
import { enumsOfModel, filterSlotsOf, relationsOfModel, rulesOfModel, useModelSource } from "../../components/entities/filters";
import { AddFieldDialog } from "../../components/entities/AddFieldDialog";
import { ViewBar } from "../../components/entities/ViewBar";
import { GroupCounts, groupTerm, ViewOptions } from "../../components/entities/ViewOptions";
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
import { CommentsPanel } from "./Comments";
import { importSlotsOf } from "./importRows";
import { useOrgDomain } from "../../api/projects";
import { FormSettingsEditor, FormSharePanel, FormView } from "./FormView";
import type { FormSettings } from "./formView";
import { AiFieldPanel } from "./AiField";
import { SpaceQuality } from "./SpaceQuality";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  PageFailed,
  PageHeader,
  PageLoading,
  Select,
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
import { ResourcePageFailed } from "../../components/ui/PageState";
import { useUrlParam } from "../../navigation/urlState";

const SPACE_LABEL = "joinedcontext.com/space";
const RESULTS_COUNT_HEADER = "NGSILD-Results-Count";
const SAMPLE_LIMIT = 3;

/** The space a manifest belongs to: `spec.contextSpaceRef` first, the space label second. */
/**
 * The DataModels of a space: the one its optional `dataModelRef` names first, then every model
 * whose required `contextSpaceRef` names the space (T-2450). The list and the space's own page
 * both read it, so the list no longer says "—" where the page says "helsinki" (T-2760).
 */
export function modelsOfSpace(space: Manifest, models: Manifest[]): Manifest[] {
  const pointer = refName(space.spec.dataModelRef);
  const primary = models.find((m) => m.metadata.name === pointer);
  const owned = models.filter((m) => m !== primary && spaceOf(m) === space.metadata.name);
  return [...(primary ? [primary] : []), ...owned];
}

export function spaceOf(manifest: Manifest): string | undefined {
  return (
    (refName(manifest.spec.contextSpaceRef) || undefined) ??
    (manifest.metadata.labels as Record<string, string> | null | undefined)?.[SPACE_LABEL]
  );
}

/**
 * The endpoint the portal reads a space through: one without a policy narrows nothing, so it
 * shows everything the space holds; failing that the first public one is at least readable.
 * Given the person's `groups`, only an endpoint whose audience admits them is picked, and `null`
 * (the identity not known yet) picks none: a page does not fetch what the gateway will refuse
 * (T-2631).
 */
export function pickReadEndpoint(
  endpoints: Manifest[],
  groups?: readonly string[] | null,
  project = "",
): Manifest | undefined {
  if (groups === null) {
    return undefined;
  }
  const readable = groups === undefined ? endpoints : endpoints.filter((endpoint) => admitsPerson(endpoint, groups, project));
  return (
    readable.find((endpoint) => endpoint.spec.policyRef === undefined) ??
    readable.find((endpoint) => endpoint.spec.audience === "public")
  );
}

/**
 * The entity types a DataModel defines: `spec.classes` when the manifest lists them, else the
 * class names of an inline LinkML source (`spec.linkml` carrying a document, not a path).
 */
export function entityTypesOf(model: Manifest): string[] {
  const classes = model.spec.classes;
  if (Array.isArray(classes)) {
    return classes.filter((c): c is string => typeof c === "string");
  }
  return [];
}

/** The `NGSILD-Results-Count` header as a number; `undefined` when absent or not a number. */
export function parseResultsCount(headers: Headers): number | undefined {
  const raw = headers.get(RESULTS_COUNT_HEADER);
  if (raw === null) {
    return undefined;
  }
  const count = Number.parseInt(raw.trim(), 10);
  return Number.isNaN(count) || count < 0 ? undefined : count;
}

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
}: {
  project: string;
  space: string;
  slug?: string;
  type: string;
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
      <TableCell>
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
function SpaceData({
  project,
  space,
  types,
  endpoints,
  model,
}: {
  project: string;
  space: string;
  types: string[];
  endpoints: Manifest[];
  /** The space's DataModel: its enum slots are filtered by picking (UI-86). */
  model?: Manifest;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const [chosen, setChosen] = useState("");
  // The type's alerts are being chosen (T-3261).
  const [alertingType, setAlertingType] = useState(false);
  const type = types.includes(chosen) ? chosen : (types[0] ?? "");
  const modelSource = useModelSource(project, model);
  const enums = useMemo(
    () => enumsOfModel(modelSource, type, i18n.language),
    [modelSource, type, i18n.language],
  );
  const relations = useMemo(() => relationsOfModel(modelSource, type), [modelSource, type]);
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
  const [extras, setExtras] = useState<ViewExtras>({});
  const [group, setGroup] = useState<string | null>(null);
  const [seen, setSeen] = useState<string[]>([]);
  // A form view's fields, conditions and prefill (T-3103, API/01 §30): its `settings`.
  const [formSettings, setFormSettings] = useState<FormSettings>({});
  const applyView = useCallback((next: SavedView | null) => {
    setSaved(next);
    // A saved view opens as the kind it was saved as, with its filter for the views beside the grid.
    if (next && (DATA_VIEWS as readonly string[]).includes(next.kind)) setView(next.kind as DataView);
    setQ(next?.config.q ?? undefined);
    setExtras({ hidden: next?.config.hidden, colour: next?.config.colour, group: next?.config.group });
    setFormSettings(next?.kind === "form" ? ((next.config.settings ?? {}) as FormSettings) : {});
    setGroup(null);
    const first = next?.config.sort?.[0];
    setGridView({
      filterText: next?.config.q ?? null,
      sort: first ? { attr: first.attr, dir: first.desc ? "desc" : "asc" } : null,
    });
  }, [setView]);
  const onGridState = useCallback((next: GridState) => {
    setGridView((before) =>
      before.filterText === next.filterText && before.sort?.attr === next.sort?.attr && before.sort?.dir === next.sort?.dir
        ? before
        : { filterText: next.filterText, sort: next.sort },
    );
  }, []);
  const current = useMemo<ViewConfig>(
    () => ({
      ...(saved?.config ?? {}),
      ...extras,
      q: view === "grid" ? asked.q : q,
      sort: gridView.sort ? [{ attr: gridView.sort.attr, desc: gridView.sort.dir === "desc" }] : [],
      ...(view === "form" ? { settings: formSettings as Record<string, never> } : {}),
    }),
    [saved, extras, view, asked.q, q, gridView.sort, formSettings],
  );
  // The attributes a view can hide: the model's slots of the type and whatever the rows carry.
  const onRows = useCallback((rows: RichRow[]) => {
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
  const attributes = useMemo(() => {
    const cls = modelSource === undefined ? undefined : parseModel(modelSource).classes.find((c) => c.name === type);
    const declared = cls && modelSource !== undefined ? classSlots(parseModel(modelSource), cls).map((slot) => slot.name) : [];
    return [...new Set([...declared, ...seen])].sort();
  }, [modelSource, type, seen]);
  // The first colour rule a row matches marks it, with the rule as the reason a screen reader hears.
  const rowTone = useCallback(
    (row: RichRow) => {
      const rule = (extras.colour ?? []).find((each) => each.when.trim() !== "" && matchesQ(row, each.when) === true);
      return rule ? { tone: rule.colour, label: t("spaces.saved.toneLabel", { when: rule.when }) } : undefined;
    },
    [extras.colour, t],
  );
  const groupQuery = useMemo(
    () => (extras.group && group !== null ? { q: groupTerm(extras.group, group) } : undefined),
    [extras.group, group],
  );
  const source = useMemo(
    () => sourceFor({ kind: "space", space }, originTransport(), i18n.language),
    [space, i18n.language],
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

  const config = useMemo(() => {
    if (type === "") {
      return null;
    }
    return (
      parseGridConfig({
        source: { kind: "space", space },
        type,
        pageSize: 100,
        mode: "view",
        history: { enabled: true },
      }).config ?? null
    );
  }, [space, type]);

  if (types.length === 0) {
    return <p className="text-body text-fg-muted">{t("spaces.inside.dataNoTypes")}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-body text-fg-muted">{t("spaces.inside.dataLead")}</p>
      <Field id="space-inside-type" label={t("spaces.inside.dataType")} className="w-fit">
        <Select
          id="space-inside-type"
          value={type}
          onChange={(event) => {
            setChosen(event.target.value);
            applyView(null);
            setSeen([]);
          }}
        >
          {types.map((each) => (
            <option key={each} value={each}>
              {each}
            </option>
          ))}
        </Select>
      </Field>
      {model && modelSource !== undefined && ownClass ? (
        <div className="flex flex-col gap-2">
          <PermissionGuard project={project} kind="DataModel" verb="propose">
            <Button className="w-fit" onClick={() => setAdding(true)}>
              {t("spaces.fields.add")}
            </Button>
          </PermissionGuard>
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
        <div className="flex flex-wrap items-end gap-3">
          {importSlots.length > 0 ? (
            <Button variant="secondary" onClick={() => setImporting(true)}>
              {t("spaces.import.open")}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => setAlertingType(true)}>
            {t("alerts.forType", { type })}
          </Button>
          {alertingType ? (
            <AlertDialog
              project={project}
              scope="type"
              target={`${space}/${type}`}
              label={type}
              onClose={() => setAlertingType(false)}
            />
          ) : null}
          <ExportLinks
            endpoints={endpoints}
            type={type}
            q={view === "grid" ? undefined : q}
            attrs={slots.map((slot) => slot.name)}
          />
          <ImportRowsDialog
            open={importing}
            onOpenChange={setImporting}
            target={{ type, orgDomain, space }}
            slots={importSlots}
            send={originTransport()}
            onImported={() => {
              setImported((n) => n + 1);
              void queryClient.invalidateQueries({ queryKey: ["space-view-rows", space] });
            }}
          />
        </div>
      ) : null}
      {probe.isSuccess ? (
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
      {probe.isSuccess && config && view !== "api" ? (
        <ViewBar
          project={project}
          space={space}
          type={type}
          kind={view}
          selected={saved}
          onSelect={applyView}
          current={current}
          unsaved={view === "grid" && asked.idPattern ? t("spaces.saved.idNotKept") : undefined}
        />
      ) : null}
      {probe.isSuccess && config && view === "grid" ? (
        <ViewOptions attributes={attributes} enums={enums} value={extras} onChange={setExtras} />
      ) : null}
      {probe.isSuccess && config && view === "grid" && extras.group && enums[extras.group] ? (
        <GroupCounts
          source={source}
          type={type}
          attr={extras.group}
          options={enums[extras.group]}
          q={asked.q}
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
          <FormView space={space} type={type} slots={typeSlots} enums={enums} settings={formSettings} />
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
      {probe.isSuccess && config && view === "grid" ? (
        <PortalEntityGrid
          // A new key after an import, or a view applied, reads the type again: nothing typed under
          // the last one carries over.
          key={`${space}-${type}-${saved?.id ?? ""}-${imported}`}
          detailExtra={(row) => <CommentsPanel project={project} space={space} urn={row.id} />}
          project={project}
          config={config}
          source={source}
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
          rowTone={rowTone}
          query={groupQuery}
          empty={<p className="text-body text-fg-muted">{t("spaces.inside.dataEmpty")}</p>}
        />
      ) : null}
    </div>
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
      <AiFieldPanel space={space} type={type} endpoints={endpoints} rows={shown} />
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
  // What the whole space holds, the broker's count (T-2889); the table below breaks it down by
  // type through the person's own endpoint.
  const usage = useQuery(spaceUsageQuery(project, name));

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
            description={<span className="font-mono">{manifest.metadata.name}</span>}
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

      <Section title={t("spaces.inside.model")}>
        <SpaceModel project={project} space={name} model={model} models={models} />
      </Section>

      <Section title={<Term name="entityType">{t("spaces.inside.types")}</Term>}>
        {usage.data !== undefined ? (
          <p className="mb-3 text-body text-fg" data-testid="space-total">
            {t("spaces.inside.total", { count: usage.data.entities })}
          </p>
        ) : usage.isError ? (
          <p className="mb-3 text-body text-fg-muted" data-testid="space-total">
            {t("spaces.entitiesUnknown", { reason: usageRefusal(usage.error) })}
          </p>
        ) : null}
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
                <TableHeaderCell>{t("spaces.inside.samples")}</TableHeaderCell>
              </TableHead>
              <TableBody>
                {types.map((type) => (
                  <TypeRow key={type} project={project} space={name} slug={slug} type={type} />
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Section>

      <Section title={t("spaces.inside.data")}>
        <SpaceData project={project} space={name} types={types} endpoints={spaceEndpoints} model={model} />
      </Section>

      <Section title={t("spaces.quality.title")}>
        <SpaceQuality project={project} space={name} />
      </Section>

      <Section title={t("drift.section.title")}>
        <SpaceDrift project={project} space={name} />
      </Section>

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

      <Section title={<Term name="policy">{t("spaces.inside.policies")}</Term>}>
        {spacePolicies.length === 0 ? (
          <SectionState query={policies} empty={t("spaces.inside.noPolicies")} />
        ) : (
          <Table caption={t("spaces.inside.policies")}>
            <TableHead>
              <TableHeaderCell>{t("spaces.field.name")}</TableHeaderCell>
              <TableHeaderCell>{t("spaces.inside.assignee")}</TableHeaderCell>
              <TableHeaderCell>{t("spaces.inside.operations")}</TableHeaderCell>
              <TableHeaderCell>{t("spaces.inside.type")}</TableHeaderCell>
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
                    <TableCell className="font-mono text-caption">
                      {(spec.operations ?? []).join(", ") || "—"}
                    </TableCell>
                    <TableCell className="font-mono text-caption">
                      {policyTypes.join(", ") || "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title={t("activity.panelTitle")}>
        <ActivityFeed project={project} compact fixed={{ space: name }} limit={10} />
      </Section>
    </div>
  );
}
