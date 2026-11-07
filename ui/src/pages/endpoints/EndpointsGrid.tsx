/**
 * The Endpoints list on the SDK grid over the project's OData service (T-6645): the same grid as
 * every data list of the Portal, its rows, filters, sort, paging and count from
 * `/api/v1/projects/{p}/odata/Endpoints`, which holds the project's own Endpoints, those other
 * projects share with it and its references whose Endpoint went away (T-6169), each after the read
 * check of the project it lives in. The cells and the row menu are the page's own renderers.
 */
import { useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "@tanstack/react-router";
import { parseGridConfig, searchQuery } from "@joinedcontext/sdk/grid";
import type { GridColumn, GridLabels, RichRow } from "@joinedcontext/sdk/grid";
import type { Manifest } from "../../api/manifest";
import { localized } from "../../api/manifest";
import { PortalEntityGrid } from "../../components/entities/PortalEntityGrid";
import { LifecycleBadge } from "../../components/status/LifecycleBadge";
import { RepresentationSummary, servedRepresentations } from "../../components/endpoints/links";
import { SharedWithBadge } from "../../components/endpoints/sharing";
import { Badge } from "../../components/ui";
import { RowDetails } from "../../components/ui/RowActions";
import type { EndpointRow } from "./endpointRows";

/** The properties the grid edits in place: what the OData set's PATCH changes (src/api/odata.rs EDITABLE). */
export const EDITABLE = ["contextSpace", "audience", "mcp"] as const;

/** The searched text columns: an Endpoint's name and its title. */
const SEARCHED = [
  { key: "title", attr: "title", kind: "text" as const },
  { key: "name", attr: "name", kind: "text" as const },
];

/** What an OData row of the set holds (src/api/odata.rs PROPERTIES). */
export interface ODataEndpoint {
  id: string;
  name: string;
  title?: string | null;
  source?: string | null;
  kind: "own" | "shared" | "gone";
  reference?: string | null;
  phase?: string | null;
}

function rowOf(row: RichRow): ODataEndpoint {
  const raw = row.raw as Partial<ODataEndpoint>;
  return {
    id: row.id,
    name: typeof raw.name === "string" ? raw.name : row.id,
    title: raw.title ?? null,
    source: raw.source ?? null,
    kind: raw.kind === "shared" || raw.kind === "gone" ? raw.kind : "own",
    reference: raw.reference ?? null,
    phase: raw.phase ?? null,
  };
}

/** The manifests behind a row, read from the page's own lists: what the row menu acts on. */
export interface EndpointManifests {
  own: ReadonlyMap<string, Manifest>;
  /** By `{source}/{name}`, the OData key of a shared row. */
  shared: ReadonlyMap<string, Manifest>;
  references: ReadonlyMap<string, Manifest>;
}

/** The page's row (endpointRows.tsx) for an OData row, so the menus stay the ones the page had. */
export function pageRow(project: string, row: ODataEndpoint, manifests: EndpointManifests): EndpointRow {
  const reference = row.reference ? (manifests.references.get(row.reference) ?? null) : null;
  if (row.kind === "own") {
    return { key: `${project}/${row.name}`, source: project, own: true, endpoint: manifests.own.get(row.name) ?? null, reference: null };
  }
  if (row.kind === "shared") {
    return { key: row.id, source: row.source ?? null, own: false, endpoint: manifests.shared.get(row.id) ?? null, reference };
  }
  return { key: `gone/${row.name}`, source: null, own: false, endpoint: null, reference: manifests.references.get(row.name) ?? null };
}

export function EndpointsGrid({
  project,
  search,
  manifests,
  label,
  actions,
  calls,
  reloadKey,
  empty,
}: {
  project: string;
  /** The header's search: a name or a title, in any case. */
  search: string;
  manifests: EndpointManifests;
  /** The name a person reads for a row: its title in their language, else its name. */
  label: (row: EndpointRow) => string;
  /** The row menu, by the page's row. */
  actions: (row: EndpointRow, label: string) => ReactNode;
  /** The calls cell of an own Endpoint by name; shared rows are counted by their owner. */
  calls: (name: string | null) => ReactNode;
  reloadKey: number;
  empty: ReactNode;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "sk";
  const navigate = useNavigate();
  // The row whose fields the grid's detail shows: Details in the row menu opens it.
  const [detail, setDetail] = useState<string | null>(null);
  // A click on a plain cell opens the Endpoint's own page, as every list of the Portal does
  // (T-2875); a reference whose Endpoint went away has no page and opens its fields instead.
  const openRow = (id: string | null): void => {
    if (id === null || id.startsWith("reference:")) {
      setDetail(id);
      return;
    }
    const slash = id.indexOf("/");
    const [owner, name] = slash < 0 ? [project, id] : [id.slice(0, slash), id.slice(slash + 1)];
    void navigate({ to: "/projects/$project/$plural/$name", params: { project: owner, plural: "endpoints", name } });
  };
  const config = useMemo(() => {
    const columns: GridColumn[] = [
      { attr: "source", label: t("endpoints.source.label") },
      { attr: "contextSpace", label: t("grid.field.space") },
      { attr: "audience", label: t("endpoints.field.audience") },
      { attr: "representations", label: t("endpoints.field.representations") },
      { attr: "calls7d", label: t("endpoints.calls.label"), format: "number" },
      { attr: "phase", label: t("endpoints.field.phase") },
      { attr: "mcp", label: t("grid.field.mcp") },
    ];
    return parseGridConfig({
      source: { kind: "odata", url: `/api/v1/projects/${encodeURIComponent(project)}/odata`, entitySet: "Endpoints" },
      type: "Endpoint",
      columns,
      mode: "edit",
      editableAttrs: [...EDITABLE],
    }).config;
  }, [project, t]);
  // Asked once the typing pauses, not per key.
  const [asked, setAsked] = useState(search);
  useEffect(() => {
    const wait = setTimeout(() => setAsked(search), 300);
    return () => clearTimeout(wait);
  }, [search]);
  const query = useMemo(() => {
    const q = searchQuery(asked, SEARCHED);
    return q ? { q } : undefined;
  }, [asked]);
  // The grid's words for a list of Endpoints: its filter examples and its empty answer name
  // Endpoints, and a change is a proposal that waits for approval, not a saved value.
  const labels = useMemo<Partial<GridLabels>>(
    () => ({
      empty: t("endpoints.grid.empty"),
      filterExampleText: t("endpoints.grid.filterExampleText"),
      filterExampleId: t("endpoints.grid.filterExampleId"),
      editAsTextHint: t("endpoints.grid.editAsTextHint"),
      saved: t("endpoints.grid.proposed"),
    }),
    [t],
  );
  if (!config) {
    return <></>;
  }
  const manifestOf = (row: RichRow): Manifest | null => pageRow(project, rowOf(row), manifests).endpoint;
  const renderers: Record<string, (cell: unknown, row: RichRow) => ReactNode> = {
    // The name opens the Endpoint's own page (T-2281), and the row menu sits beside it.
    id: (_cell, rich) => {
      const row = rowOf(rich);
      const page = pageRow(project, row, manifests);
      const name = page.endpoint ? localized(page.endpoint.metadata.title, locale, row.name) : label(page) || row.title || row.name;
      return (
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 max-w-60 items-baseline gap-2 whitespace-nowrap">
            {row.kind === "gone" ? (
              <>
                <span className="truncate font-mono">{name}</span>
                <Badge tone="warning">{t("endpoints.shared.gone")}</Badge>
              </>
            ) : (
              <>
                <Link
                  data-row-link=""
                  to="/projects/$project/$plural/$name"
                  params={{ plural: "endpoints", project: row.source ?? project, name: row.name }}
                  className="focus-ring max-w-full shrink-0 truncate rounded-sm text-fg hover:text-primary-soft-fg"
                >
                  {name}
                </Link>
                {/* Below `sm` a row is the title, the state and the action (UI-27, T-4214); the
                    manifest name waits for a wide screen (2xl, T-6169). */}
                {page.endpoint?.metadata.title ? (
                  <span className="hidden truncate font-mono text-caption font-normal text-fg-subtle 2xl:inline">{row.name}</span>
                ) : null}
                {page.endpoint?.metadata.annotations?.["joinedcontext.com/generated-by"] === "portal/app-reconciler" ? (
                  <span className="hidden truncate text-caption font-normal text-fg-subtle sm:inline">
                    {t("endpoints.ofApp", { app: row.name.replace(/^app-/, "") })}
                  </span>
                ) : null}
                {row.kind === "shared" && row.reference ? <Badge tone="success">{t("endpoints.shared.referenced")}</Badge> : null}
              </>
            )}
          </div>
          <RowDetails.Provider value={{ label: t("grid.details"), onSelect: () => setDetail(row.id) }}>
            {actions(page, row.kind === "shared" && row.source ? `${row.source}/${name}` : name)}
          </RowDetails.Provider>
        </div>
      );
    },
    source: (_cell, rich) => {
      const row = rowOf(rich);
      if (row.kind === "own") return <span className="text-fg-muted">{t("endpoints.source.own")}</span>;
      if (row.kind === "shared" && row.source) {
        return (
          <Badge tone="info" className="whitespace-nowrap" data-source={row.source}>
            {t("endpoints.source.shared", { project: row.source })}
          </Badge>
        );
      }
      return <span className="text-fg-muted">{t("endpoints.shared.goneSource")}</span>;
    },
    audience: (_cell, rich) => {
      const endpoint = manifestOf(rich);
      return endpoint ? <SharedWithBadge endpoint={endpoint} /> : "—";
    },
    representations: (_cell, rich) => {
      const endpoint = manifestOf(rich);
      return endpoint ? <RepresentationSummary served={servedRepresentations(endpoint.spec as { enabledRepresentations?: string[] })} /> : "—";
    },
    calls7d: (_cell, rich) => {
      const row = rowOf(rich);
      return calls(row.kind === "own" ? row.name : null);
    },
    phase: (_cell, rich) => {
      const row = rowOf(rich);
      return row.kind === "own" ? <LifecycleBadge kind="phase" value={row.phase ?? undefined} /> : "—";
    },
  };
  return (
    <PortalEntityGrid
      project={project}
      config={config}
      query={query}
      hidden={["entity:type"]}
      renderers={renderers}
      labels={labels}
      reloadKey={reloadKey}
      empty={empty}
      locale={locale}
      ariaLabel={t("endpoints.title")}
      openRow={detail}
      onOpenRow={openRow}
    />
  );
}
