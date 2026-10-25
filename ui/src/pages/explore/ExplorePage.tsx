import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListFailed, reasonOf } from "../../components/forms/widgets/ListFailed";
import { useTranslation } from "react-i18next";
import { parseGridConfig } from "@joinedcontext/sdk";
import type { GridState, ResolvedGridConfig, RichRow } from "@joinedcontext/sdk";
import { api, queryKeys, unwrap } from "../../api/client";
import { asManifests, localized, refName } from "../../api/manifest";
import type { Manifest } from "../../api/manifest";
import { AccessPanel, useAccess } from "../../components/entities/AccessPanel";
import { deniedOf, explainAttribute, useAttributeAccess, writableOf } from "../../api/access";
import { EntityFilters } from "../../components/entities/EntityFilters";
import { PortalEntityGrid } from "../../components/entities/PortalEntityGrid";
import { enumsOfModel, fetchEntity, filterSlotsOf, qProblem, relationsOfModel, rulesOfModel, useModelSource } from "../../components/entities/filters";
import type { EntityQuery } from "../../components/entities/filters";
import { Alert, Button, EmptyState, Field, PageHeader, Select, Tabs, tabPanelProps } from "../../components/ui";
import { TypeQuality } from "./TypeQuality";
import { TypeLink } from "../models/ModelLinks";
import { ExportView } from "./ExportView";
import { ExploreRowActions } from "./ExploreRowActions";
import { UseThisData } from "./UseThisData";
import { ChartFromView } from "./ChartFromView";
import { ExploreMap, isLocated } from "./ExploreMap";
import { andQ } from "./exportView";
import type { ViewSort } from "./exportView";
import { entityTypesOf, isAppEndpoint, pickReadEndpoint, spaceOf } from "../spaces/spaceFacts";
import { useIdentity } from "../../auth/AuthProvider";
import { replaceOwnSearch } from "../../assistant/HandOff";

const PAGE_SIZE = 50;

function useProjectList(project: string, plural: string) {
  return useQuery({
    queryKey: queryKeys.list(project, plural),
    // The key is shared with every other page that lists this kind, so the cache holds the
    // list as the API answers it, whichever page asked first; the manifests are read off it
    // here (T-0625).
    queryFn: async () =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/{plural}", {
          params: { path: { project, plural } },
        }),
      ),
    select: (list) => asManifests(list.items ?? []),
  });
}

/**
 * The data explorer (UI-33, UI-64): a space, one of its endpoints, filters generated from the
 * space's DataModel, and the entities the endpoint returns for the signed-in user, shown in the
 * one entity grid of the product. The page owns what is a page's business — the space and the
 * endpoint, the type and its filters, the export of what is on screen, and the removal of one
 * entity (UI-60) — and the grid owns the table: the columns, the metadata a person opens, the
 * paging, the per-column filter row and the correction of a value where the grant allows one.
 */
export function ExplorePage({
  project,
  initialSpace,
  initialEndpoint,
  initialEntityId,
  initialType,
  initialQ,
}: {
  project: string;
  /** Chosen on arrival, the way a catalog card opens the page (UI-46). */
  initialSpace?: string;
  initialEndpoint?: string;
  /** One entity of the endpoint, opened on its detail as the page mounts (UI-46, T-1017). */
  initialEntityId?: string;
  /**
   * The type and the filter the grid opens narrowed by (UI-64, UI-67): the assistant's `entities`
   * hand-off carries the question's own filter, so nobody types it again.
   */
  initialType?: string;
  initialQ?: string;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const identity = useIdentity();
  const locale = i18n.language;
  const spaces = useProjectList(project, "spaces");
  const endpoints = useProjectList(project, "endpoints");
  const models = useProjectList(project, "datamodels");

  // `null` is "nobody has chosen a space yet", which is not the same as the empty choice: a person
  // who picks "—" keeps it, while an arrival that named only an endpoint takes that endpoint's own
  // space below.
  const [chosenSpace, setSpace] = useState<string | null>(initialSpace ?? null);
  const [endpointChoice, setEndpointChoice] = useState<string>(initialEndpoint ?? "");
  const [askedQuery, setQuery] = useState<EntityQuery>(
    initialType ? { type: initialType, q: initialQ } : {},
  );
  const [selected, setSelected] = useState<string | null>(initialEntityId ?? null);
  // The type's entities, or its data-quality report (T-3252).
  const [view, setView] = useState<"entities" | "quality" | "map">("entities");
  /** What the grid's filter row asks and its order, for the export of the whole view (T-3253). */
  const [gridAsk, setGridAsk] = useState<{ q?: string; idPattern?: string }>({});
  const [gridSort, setGridSort] = useState<ViewSort | null>(null);
  /** Bumped when an entity is removed, so the grid reads the endpoint again. */
  const [generation, setGeneration] = useState(0);

  /**
   * The `entities` hand-off names the endpoint and not its space (UI-59), and the page reads an
   * endpoint only inside a space: without this the grid would open on nothing. The endpoint's own
   * space is known once the endpoints have loaded, so it is derived rather than assigned.
   */
  const handedSpace = (endpoints.data ?? []).find(
    (e) => e.metadata.name === initialEndpoint,
  );
  const space = chosenSpace ?? (handedSpace ? spaceOf(handedSpace) : "");
  const spaceEndpoints = (endpoints.data ?? []).filter((e) => spaceOf(e) === space);
  const chosenEndpoint = spaceEndpoints.find((e) => e.metadata.name === endpointChoice);
  // A link that names an Endpoint this person is not shown in the space reads through nothing
  // and says so, rather than through another Endpoint with another Policy (T-5604).
  const unshownEndpoint =
    endpointChoice !== "" && endpoints.data !== undefined && chosenEndpoint === undefined ? endpointChoice : undefined;
  const endpoint =
    unshownEndpoint !== undefined
      ? undefined
      : (chosenEndpoint ?? pickReadEndpoint(spaceEndpoints, identity ? (identity.groups ?? []) : null, project));
  const endpointName = endpoint?.metadata.name;

  const slug = typeof endpoint?.spec.slug === "string" ? String(endpoint.spec.slug) : undefined;
  // A link naming an entity and not its type (the command palette's "Open entity") reads the entity
  // once through the endpoint to learn its type, so the grid opens on it and shows its detail.
  const linkedType = useQuery({
    queryKey: ["explore-entity", slug, selected],
    queryFn: () => fetchEntity(slug!, selected!),
    enabled: Boolean(slug && selected && !askedQuery.type),
  });
  const typeOfLink = askedQuery.type ? undefined : linkedType.data?.type;
  const query: EntityQuery = useMemo(
    () => (typeof typeOfLink === "string" ? { ...askedQuery, type: typeOfLink } : askedQuery),
    [askedQuery, typeOfLink],
  );

  // What is chosen stands in the address as it changes (UI-89, T-3239): a reload or a link sent
  // to a colleague opens the same space, endpoint, type, search and entity. `space` and
  // `endpoint` are also the assistant's hand-off; written as the page's own, they mount nothing
  // afresh. Replaced, not pushed: each pick is not a step back needs to retrace. The endpoint
  // written is the one read, picked by hand or for the person, so a colleague opening the link
  // reads through the same one or is told why not (T-5604).
  useEffect(() => {
    const address = new URLSearchParams(window.location.search);
    const put = (key: string, value: string | null | undefined) => {
      if (value) address.set(key, value);
      else address.delete(key);
    };
    if (chosenSpace !== null) put("space", chosenSpace);
    put("endpoint", endpointChoice || endpointName);
    put("type", query.type);
    put("q", query.q);
    put("entityId", selected);
    replaceOwnSearch(address);
  }, [chosenSpace, endpointChoice, endpointName, query.type, query.q, selected]);
  const spaceManifest = (spaces.data ?? []).find((s) => s.metadata.name === space);
  const model = (models.data ?? []).find(
    (m) => m.metadata.name === refName(spaceManifest?.spec.dataModelRef),
  );
  const types = model ? entityTypesOf(model) : [];
  // Only the model's own types make an address's type unknown: the broker's list is the person's
  // readable types, so a type missing there may exist and be refused (T-5622).
  const knownTypes = types.length > 0 ? types : undefined;
  /** The space's model is not known yet: the space or the model list is still on its way. */
  const modelPending = spaces.isPending || models.isPending;
  const unknownType =
    query.type !== undefined && knownTypes !== undefined && !knownTypes.includes(query.type) ? query.type : undefined;
  // The slots and the denied list are memoized because the grid's config is built from them: a new
  // array on every render would make the grid rebuild its source and read the endpoint again, on
  // and on. It also stops the LinkML being parsed once per render.
  const modelSource = useModelSource(project, model);
  const slots = useMemo(() => filterSlotsOf(modelSource, query.type), [modelSource, query.type]);
  const located = isLocated(slots);
  const geoAttrs = useMemo(() => {
    // The model's GeoProperties, `location` first; a model that marks none still has `location`.
    const named = slots.filter((slot) => slot.kind === "GeoProperty").map((slot) => slot.name);
    return named.length === 0 ? ["location"] : [...named].sort((a, b) => Number(b === "location") - Number(a === "location"));
  }, [slots]);
  const popupColumns = useMemo(() => {
    const plain = slots.filter((slot) => slot.kind !== "GeoProperty" && slot.kind !== "Relationship").map((slot) => slot.name);
    const chosen = (query.attrs ?? []).filter((attr) => plain.includes(attr));
    return [...new Set(["name", ...chosen, ...plain])].filter((attr) => plain.includes(attr));
  }, [slots, query.attrs]);
  // An enum slot is edited and filtered in the grid by picking its values (UI-86).
  const enums = useMemo(() => enumsOfModel(modelSource, query.type, locale), [modelSource, query.type, locale]);
  const rules = useMemo(() => rulesOfModel(modelSource, query.type), [modelSource, query.type]);
  // A relationship end is picked from the target's entities the person can read (UI-84).
  const relations = useMemo(() => relationsOfModel(modelSource, query.type), [modelSource, query.type]);
  const access = useAccess(slug);
  // The types this endpoint lets the person read (T-3218): a grant without a type covers every
  // one, and an access document not read yet says nothing, so the list then stays as it is.
  const readable = useMemo(() => {
    const grants = (access.data?.permissions ?? []).filter((entry) =>
      (entry.actions ?? []).some((action) => action.startsWith("query") || action.startsWith("retrieve")),
    );
    if (access.data === undefined || grants.some((entry) => !entry.resource?.type || entry.resource.type === "*")) {
      return undefined;
    }
    return [...new Set(grants.map((entry) => entry.resource?.type).filter((type): type is string => Boolean(type)))];
  }, [access.data]);
  // What the person may do with each attribute, as the endpoint decides it (T-5528): the grid's
  // editors, the filters' hidden marks and the cell inspector all render this one answer.
  const attributeAccess = useAttributeAccess(slug, query.type);
  const denied = useMemo(() => deniedOf(attributeAccess.data, t), [attributeAccess.data, t]);
  // UI-44, EP-55: a control the grant denies stays visible and says why, rather than working
  // until the gateway refuses it. The grant is the endpoint's own `/access` document, already
  // read above for the attributes it hides (T-1021).
  const mayDelete = (type: string) =>
    access.data === undefined ||
    (access.data.permissions ?? []).some(
      (entry) =>
        (entry.resource?.type === undefined || entry.resource.type === type) &&
        (entry.actions ?? []).some((action) => action === "deleteEntity" || action === "deleteBatch"),
    );
  // The attributes this person may correct in place, by the endpoint's own grant (UI-67).
  // A formula field is its pipeline's to write (DM-80): shown, never edited in place.
  const editableAttrs = useMemo(
    () => writableOf(attributeAccess.data).filter((attr) => slots.some((slot) => slot.name === attr && !slot.formula)),
    [attributeAccess.data, slots],
  );
  const explainAccess = (attribute: string, action: "read" | "write" | "delete") =>
    explainAttribute(project, endpointName ?? "", query.type ?? "", attribute, action);

  /**
   * What the grid is told to show. The endpoint is a slug and never a URL (EP-55), and the filters
   * the page composed from the DataModel arrive as the grid's preset, so the grid's own filter row
   * narrows what the page already asked for rather than replacing it.
   */
  const config: ResolvedGridConfig | null = useMemo(() => {
    // A q the broker would refuse is not sent: the field says how to fix it (T-4264, T-4160 #22).
    // Nor is a type read before the model says whether the space has it (T-5622).
    if (!slug || !query.type || modelPending || unknownType !== undefined || qProblem(query.q)) {
      return null;
    }
    const parsed = parseGridConfig({
      source: { kind: "endpoint", slug },
      type: query.type,
      // `name`, the Smart Data Models label, is the primary field: first, pinned, opening the row.
      columns: (query.attrs ?? []).map((attr) => ({ attr, ...(attr === "name" ? { pinned: true } : {}) })),
      filters: { preset: { q: query.q, attrs: query.attrs, scopeQ: query.scopeQ } },
      pageSize: PAGE_SIZE,
      history: { enabled: true },
      ...(editableAttrs.length > 0 ? { mode: "edit" as const, editableAttrs } : {}),
    });
    return parsed.config ?? null;
  }, [slug, query.type, modelPending, unknownType, query.q, query.attrs, query.scopeQ, editableAttrs]);

  // A stable callback and the same object back when nothing moved: the grid hands its page over
  // from an effect, so a new function or a new object on every render would read and re-render
  // without end.
  const onQuery = useCallback((asked: { q?: string; idPattern?: string }) => {
    setGridAsk((previous) => (previous.q === asked.q && previous.idPattern === asked.idPattern ? previous : asked));
  }, []);
  const onGridState = useCallback((next: GridState) => {
    setGridSort((previous) =>
      previous?.attr === next.sort?.attr && previous?.dir === next.sort?.dir ? previous : next.sort,
    );
  }, []);
  // A row opens in the grid's own detail (T-5619): its fields as the grid draws them, its history,
  // and under them what the page adds, the removal of UI-60 and the entity as the endpoint holds it.
  const detailExtra = (row: RichRow) =>
    slug ? (
      <ExploreRowActions
        key={row.id}
        slug={slug}
        id={row.id}
        deniedReason={mayDelete(row.type) ? undefined : t("explore.deleteDenied", { type: row.type })}
        onDeleted={() => {
          setSelected(null);
          // The grid holds a page that still lists the entity; a new key makes it read the endpoint
          // again rather than show a row that is gone.
          setGeneration((each) => each + 1);
        }}
      />
    ) : null;

  function changeQuery(next: EntityQuery) {
    setQuery(next);
    setSelected(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("explore.title")} description={t("explore.description")} />
      {/* Two pickers, not a row of the whole screen: at 2560 px each select was 1100 px wide
          (T-2755). The grid below takes the width. */}
      <div className="grid max-w-5xl gap-3 sm:grid-cols-2">
        <Field id="explore-space" label={t("explore.space")}>
          <Select
            id="explore-space"
            value={space}
            onChange={(event) => {
              setSpace(event.target.value);
              setEndpointChoice("");
              changeQuery({});
            }}
          >
            <option value="">—</option>
            {(spaces.data ?? []).map((s) => (
              <option key={s.metadata.name} value={s.metadata.name}>
                {localized(s.metadata.title, locale, s.metadata.name)}
              </option>
            ))}
          </Select>
          {/* Without this a failed `/spaces` left the picker at "—" and the page read like a
              project with no spaces at all (T-1768). */}
          {spaces.isError ? (
            <ListFailed
              what={t("nav.spaces")}
              reason={reasonOf(spaces.error, t("explore.loadFailed"))}
              onRetry={() => void spaces.refetch()}
            />
          ) : null}
        </Field>
        <Field
          id="explore-endpoint"
          label={t("explore.endpoint")}
          description={
            space && spaceEndpoints.length === 0 && !endpoints.isError
              ? t("explore.noEndpoint")
              : t("explore.hint.endpoint")
          }
        >
          <Select
            id="explore-endpoint"
            // Named by hand: the failure note beside it makes two children, which the Field does
            // not wire (T-5622).
            aria-describedby="explore-endpoint__description"
            value={endpoint?.metadata.name ?? ""}
            disabled={!space}
            title={!space ? t("explore.pickSpaceFirst") : undefined}
            onChange={(event) => {
              setEndpointChoice(event.target.value);
              setSelected(null);
            }}
          >
            <option value="">—</option>
            {/* The space's own Endpoints first, an App's under "Applications": the group tells a
                space's Endpoint from an App's of one title, where a slug in brackets did (T-5622). */}
            {endpointOptions(spaceEndpoints.filter((e) => !isAppEndpoint(e)), locale)}
            {spaceEndpoints.some(isAppEndpoint) ? (
              <optgroup label={t("explore.endpointApps")}>{endpointOptions(spaceEndpoints.filter(isAppEndpoint), locale)}</optgroup>
            ) : null}
          </Select>
          {endpoints.isError ? (
            <ListFailed
              what={t("nav.endpoints")}
              reason={reasonOf(endpoints.error, t("explore.loadFailed"))}
              onRetry={() => void endpoints.refetch()}
            />
          ) : null}
        </Field>
      </div>
      {unshownEndpoint !== undefined ? (
        <Alert tone="warning" title={t("explore.endpointUnshown", { name: unshownEndpoint })}>
          {t("explore.endpointUnshownPick", { name: unshownEndpoint })}
        </Alert>
      ) : null}

      {space ? (
        <EntityFilters
          id="explore"
          types={types}
          space={space || undefined}
          slots={slots}
          value={query}
          onChange={changeQuery}
          denied={denied}
          readable={readable}
        />
      ) : null}
      {space && query.type && unknownType === undefined ? (
        <p className="text-caption text-fg-muted">
          {t("explore.typeInModel")} <TypeLink project={project} type={query.type} space={space} className="font-mono" />
          {endpointName ? (
            <>
              {" · "}
              {t("explore.readThrough")} {endpoint ? endpointTitle(endpoint, locale) : endpointName}
            </>
          ) : null}
        </p>
      ) : null}
      {space ? <AccessPanel slug={slug} type={unknownType === undefined ? query.type : undefined} access={access} /> : null}

      {config && space && query.type ? (
        <Tabs
          id="explore-view"
          label={t("explore.views")}
          tabs={[
            { value: "entities", label: t("explore.entities") },
            // A type with a place opens on the map too (T-3256).
            ...(located ? [{ value: "map" as const, label: t("explore.map.tab") }] : []),
            { value: "quality", label: t("explore.quality.tab") },
          ]}
          value={view}
          onChange={setView}
        />
      ) : null}
      {config && space && query.type && view === "quality" ? (
        <div {...tabPanelProps("explore-view", "quality")}>
          <TypeQuality project={project} space={space} type={query.type} />
        </div>
      ) : null}
      {config && space && query.type && slug && located && view === "map" ? (
        <div {...tabPanelProps("explore-view", "map")}>
          <ExploreMap
            project={project}
            slug={slug}
            query={{ ...query, q: andQ(query.q, gridAsk.q), idPattern: gridAsk.idPattern }}
            columns={popupColumns}
            geo={geoAttrs}
            onOpen={setSelected}
          />
        </div>
      ) : null}
      {config ? (
        // The table stays mounted under the other views: its filter row is the map's filter too,
        // and coming back finds it as it was left (T-3256).
        <div hidden={Boolean(space && query.type) && view !== "entities"} {...(space && query.type ? tabPanelProps("explore-view", "entities") : {})}>
          <PortalEntityGrid
            key={`${slug}-${query.type}-${generation}`}
            project={project}
            config={config}
            // Scroll through every matching entity, a window drawn at a time (T-3097).
            virtual
            enums={enums}
            relations={relations}
            rules={rules}
            onOpenRelationship={setSelected}
            onQuery={onQuery}
            onGridState={onGridState}
            // A filter that excludes everything says so, and how to get rows back (T-4160 #22).
            emptyText={query.q ? t("explore.noMatch") : undefined}
            openRow={selected}
            onOpenRow={setSelected}
            detailExtra={detailExtra}
            access={attributeAccess.isError ? null : attributeAccess.data}
            explainAccess={endpointName ? explainAccess : undefined}
            accessRequestHref={`/projects/${encodeURIComponent(project)}/access`}
            toolbar={
              slug ? (
                <div className="flex flex-wrap items-center gap-2">
                  <ExportView slug={slug} query={query} grid={gridAsk} sort={gridSort} />
                  <UseThisData
                    project={project}
                    slug={slug}
                    query={{ ...query, q: andQ(query.q, gridAsk.q), idPattern: gridAsk.idPattern }}
                    open={endpoint?.spec.audience === "public"}
                  />
                  {endpoint && query.type ? (
                    <ChartFromView
                      project={project}
                      endpoint={endpoint.metadata.name}
                      slug={slug}
                      type={query.type}
                      q={andQ(query.q, gridAsk.q)}
                      slots={slots}
                    />
                  ) : null}
                </div>
              ) : null
            }
          />
        </div>
      ) : space && models.isError ? (
        <ListFailed
          what={t("nav.models")}
          reason={reasonOf(models.error, t("explore.loadFailed"))}
          onRetry={() => void models.refetch()}
        />
      ) : unshownEndpoint !== undefined || (query.type && modelPending) ? null : space && unknownType !== undefined ? (
        // An address naming a type the space has none of says so, rather than an empty grid that
        // reads like a type with nothing in it yet (T-5622).
        <EmptyState
          title={t("explore.unknownType", { type: unknownType })}
          description={(knownTypes ?? []).length > 0 ? t("explore.unknownTypeHint") : t("entities.noTypes")}
          icon="explore"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {(knownTypes ?? []).map((type) => (
                <Button key={type} size="sm" variant="secondary" onClick={() => changeQuery({ type, scopeQ: query.scopeQ })}>
                  {type}
                </Button>
              ))}
            </div>
          }
        />
      ) : space ? (
        // A linked Endpoint this person is not shown has its own warning above.
        <EmptyState
          title={t("explore.noType")}
          description={t("explore.noTypeHint")}
          icon="explore"
        />
      ) : (spaces.data ?? []).length > 0 ? (
        // The first pick, one click away: an empty page under two empty selects said nothing
        // about where to start (T-2755).
        <EmptyState
          title={t("explore.noSpace")}
          description={t("explore.noSpaceHint")}
          icon="explore"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {(spaces.data ?? []).map((s) => (
                <Button
                  key={s.metadata.name}
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setSpace(s.metadata.name);
                    setEndpointChoice("");
                    changeQuery({});
                  }}
                >
                  {localized(s.metadata.title, locale, s.metadata.name)}
                </Button>
              ))}
            </div>
          }
        />
      ) : null}

    </div>
  );
}

/** An Endpoint as a person reads it: its title, else the App it serves or its own name. */
function endpointTitle(endpoint: Manifest, locale: string): string {
  const name = endpoint.metadata.name;
  return localized(endpoint.metadata.title, locale, isAppEndpoint(endpoint) ? name.replace(/^app-/, "") : name);
}

/** One group's options; two of one title in a group are told apart by their names (T-3218). */
function endpointOptions(group: Manifest[], locale: string): JSX.Element[] {
  return group.map((e) => {
    const title = endpointTitle(e, locale);
    const twin = group.some((other) => other !== e && endpointTitle(other, locale) === title);
    return (
      <option key={e.metadata.name} value={e.metadata.name}>
        {twin ? `${title} (${e.metadata.name})` : title}
      </option>
    );
  });
}
