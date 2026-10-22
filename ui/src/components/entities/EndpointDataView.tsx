/**
 * What one Endpoint answers (T-1433; UI-69, EP-07): the grid, read only, over the endpoint itself.
 *
 * The types and their attributes come from the endpoint's own published schema rather than from the
 * DataModel, because the schema is already projected to the policy: what it lists is what this
 * endpoint may publish at all (EP-46, EP-61). An attribute the steward hides is left out of the
 * columns here too, so the effect of a tick in the form is visible as data and not only as a name.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { EntityCompare, enumsOf, originTransport, parseGridConfig, relationsOf, sourceFor } from "@joinedcontext/sdk";
import { fetchJson, publishedTypes } from "../../pages/endpoints/SchemaProjectionPanel";
import { Button, Field, InlineError, Select, safeHref } from "../ui";
import { gridLabels, PortalEntityGrid } from "./PortalEntityGrid";

interface SchemaIndex {
  models?: { name?: string; version?: number }[];
}

/** What a link to this view holds (T-5082): the type, the query as typed, and the order. */
export interface DataLink {
  type?: string;
  q?: string;
  /** `attr` or `attr;desc`, as `orderBy` takes it (CIM 009 4.23). */
  sort?: string;
}

type Sort = { attr: string; dir: "asc" | "desc" } | null;

/** A link's order, kept only when it names a column of the type: nothing else reaches `orderBy`. */
export function sortOfLink(raw: string | undefined, attributes: string[]): Sort {
  const [attr, dir, ...rest] = (raw ?? "").split(";");
  if (rest.length > 0 || (dir !== undefined && dir !== "asc" && dir !== "desc")) return null;
  return attr === "id" || attributes.includes(attr) ? { attr, dir: dir === "desc" ? "desc" : "asc" } : null;
}

/** One row of the Fields table: an attribute, its type and its description in the schema. */
export interface FieldRow {
  name: string;
  kind: string;
  description: string;
}

/** The Fields of one type from the endpoint's JSON Schema, in the column order. */
export function fieldsOf(definition: unknown, attributes: string[]): FieldRow[] {
  const properties = ((definition ?? {}) as { properties?: Record<string, unknown> }).properties ?? {};
  return attributes.map((name) => {
    const property = (properties[name] ?? {}) as { type?: unknown; format?: unknown; $ref?: unknown; description?: unknown; anyOf?: unknown };
    const branch = Array.isArray(property.anyOf) ? ((property.anyOf.find((each) => each && typeof each === "object") ?? {}) as typeof property) : property;
    const ref = typeof branch.$ref === "string" ? branch.$ref.split("/").pop() : undefined;
    const kind = typeof branch.format === "string" ? branch.format : typeof branch.type === "string" ? branch.type : ref ?? "";
    return { name, kind, description: typeof property.description === "string" ? property.description : "" };
  });
}

/** The definitions of an endpoint's JSON Schema, `$defs` and `definitions` alike. */
function definitionsOf(schema: unknown): Record<string, unknown> {
  const document = (schema ?? {}) as { definitions?: Record<string, unknown>; $defs?: Record<string, unknown> };
  return { ...document.$defs, ...document.definitions };
}

/** The download of exactly the rows the grid asked: the endpoint's `file.csv` with its type, query and order. */
function csvHref(origin: string | undefined, slug: string, type: string, q: string | undefined, orderBy: string | undefined): string | undefined {
  const query = new URLSearchParams({ type, ...(q ? { q } : {}), ...(orderBy ? { orderBy } : {}) });
  return safeHref(`${origin ?? ""}/api/endpoint/${encodeURIComponent(slug)}/file.csv?${query.toString()}`);
}

/** The attributes of the type as a list rather than a table: three columns do not fit a phone, one entry a line does. */
function FieldList({ fields }: { fields: FieldRow[] }): JSX.Element {
  const { t } = useTranslation();
  return (
    <details className="rounded border border-border p-2">
      <summary className="cursor-pointer text-body font-medium text-fg">{t("endpoints.data.fields")}</summary>
      <ul className="mt-2 divide-y divide-border" aria-label={t("endpoints.data.fields")}>
        {fields.map((field) => (
          <li key={field.name} className="flex flex-col gap-0.5 py-2">
            <span className="text-body">
              <span className="font-mono">{field.name}</span>
              <span className="text-caption text-fg-muted">
                {" · "}
                {t("endpoints.data.fieldType")}: {field.kind || "—"}
              </span>
            </span>
            <span className="text-caption text-fg-muted">{field.description || t("endpoints.data.noDescription")}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The view's actions: compare with the space (only when the endpoint serves one, T-1435), the full
 * window, and the CSV download of the current query.
 */
function DataActions({
  space,
  comparing,
  onCompare,
  full,
  onFull,
  csv,
}: {
  space?: string;
  comparing: boolean;
  onCompare: () => void;
  full: boolean;
  onFull: () => void;
  csv?: string;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {space ? (
          <Button size="sm" variant="secondary" onClick={onCompare}>
            {comparing ? t("endpoints.data.compareClose") : t("endpoints.data.compare")}
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" aria-pressed={full} onClick={onFull}>
          {full ? t("endpoints.data.fullLeave") : t("endpoints.data.full")}
        </Button>
        {csv ? (
          <a className="focus-ring rounded-sm text-caption text-primary-soft-fg underline hover:no-underline" href={csv} download>
            {t("endpoints.data.csv")}
          </a>
        ) : null}
      </div>
      {csv ? <p className="text-caption text-fg-muted">{t("endpoints.data.csvHelp")}</p> : null}
    </>
  );
}

export interface EndpointDataViewProps {
  project: string;
  /** The endpoint's slug: the grid reads through it, never through a URL of its own (EP-55). */
  slug: string;
  /** `spec.projection.hiddenAttributes`, including what the open form has ticked but not saved. */
  hidden?: string[];
  /**
   * The space this endpoint serves (`spec.contextSpaceRef`), for the comparison of T-1435. Without
   * one there is nothing to compare against and the button is absent.
   */
  space?: string;
  /** Where the view opens: a shared link's type, query and order (T-5082). */
  link?: DataLink;
  /** Every change of type, query or order, for a host that writes them into its address. */
  onLink?: (next: DataLink) => void;
  /** The endpoint serves `file.csv`, so the current query can be downloaded as a table. */
  csv?: boolean;
  /**
   * Where `/api/endpoint/{slug}` answers: the Portal's own origin with the person's session
   * (default), or the catalogue's `https://api.{domain}`, read without a cookie or token (T-5082).
   */
  origin?: string;
}

export function EndpointDataView({
  project,
  slug,
  hidden = [],
  space,
  link,
  onLink,
  csv = false,
  origin,
}: EndpointDataViewProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const [chosen, setChosen] = useState<string>(link?.type ?? "");
  const [full, setFull] = useState(false);
  // The query the grid last asked, for the link and the download of exactly these rows.
  const [asked, setAsked] = useState<string | undefined>(link?.q);
  const [comparing, setComparing] = useState(false);
  const root = origin ?? window.location.origin;
  const base = `${root}/api/endpoint/${slug}/schema`;
  // Another origin is read anonymously: a cross-origin fetch with `same-origin` credentials sends no cookie.
  const source = useMemo(
    () => (origin ? sourceFor({ kind: "endpoint", slug }, originTransport((path, init) => fetch(origin + String(path), init)), i18n.language) : undefined),
    [origin, slug, i18n.language],
  );

  const index = useQuery({
    queryKey: ["endpoint-schema-index", slug],
    retry: false,
    queryFn: () => fetchJson(`${base}/index.json`) as Promise<SchemaIndex>,
  });
  const version = index.data?.models?.[0]?.version ?? 1;
  const schema = useQuery({
    queryKey: ["endpoint-schema-artifact", slug, version, "json-schema"],
    enabled: index.isSuccess,
    retry: false,
    queryFn: () => fetchJson(`${base}/v${version}/json-schema`),
  });

  const types = useMemo(() => publishedTypes(schema.data), [schema.data]);
  const type = types.find((each) => each.name === chosen) ?? types[0];
  const columns = useMemo(() => (type ? type.attributes.filter((attribute) => !hidden.includes(attribute)) : []), [type, hidden]);
  // The order and the typed query the grid opens with; the grid holds them from then on.
  const [view, setView] = useState<{ filterText: string | null; sort: Sort } | null>(null);
  const opened = view ?? { filterText: link?.q ?? null, sort: sortOfLink(link?.sort, columns) };
  const sortText = opened.sort ? `${opened.sort.attr}${opened.sort.dir === "desc" ? ";desc" : ""}` : undefined;
  useEffect(() => {
    if (type) onLink?.({ type: type.name, q: asked || undefined, sort: sortText });
  }, [type, asked, sortText, onLink]);
  const onQuery = useCallback((query: { q?: string }) => setAsked(query.q), []);

  // Escape leaves the full window, as it closes a dialog.
  useEffect(() => {
    if (!full) return;
    const leave = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [full]);
  // The endpoint's own schema names its enums: such a column is filtered by picking (UI-86).
  const defs = useMemo(() => definitionsOf(schema.data), [schema.data]);
  const enums = useMemo(() => (type ? enumsOf(defs[type.name], defs, i18n.language) : {}), [defs, type, i18n.language]);
  // Its relationship ends are columns picked from the target's entities (UI-84).
  const relations = useMemo(() => (type ? relationsOf(defs[type.name]) : {}), [defs, type]);

  const config = useMemo(() => {
    if (!type) {
      return null;
    }
    const shown = columns
      // `name` is the label attribute of the Smart Data Models: the primary field, first and pinned,
      // and what opens a row (T-3097).
      .map((attribute) => ({ attr: attribute, ...(attribute === "name" ? { pinned: true } : {}) }));
    return (
      parseGridConfig({
        source: { kind: "endpoint", slug },
        type: type.name,
        columns: shown,
        pageSize: 25,
        // Read only here: a value is corrected in the explorer, where the person chose the endpoint
        // for that purpose.
        mode: "view",
        history: { enabled: true },
      }).config ?? null
    );
  }, [slug, type, columns]);

  const compareLabels = useMemo(
    () => ({
      left: t("endpoints.data.spaceSide"),
      right: t("endpoints.data.endpointSide"),
      missingRow: t("endpoints.data.missingRow"),
      hiddenColumn: t("endpoints.data.hiddenColumn"),
      lead: t("endpoints.data.compareLead"),
      same: t("endpoints.data.same"),
      loading: t("app.loading"),
      error: t("app.error.generic"),
      leftRefused: t("endpoints.data.spaceRefused"),
      previous: t("entityGrid.previous"),
      next: t("entityGrid.next"),
      page: t("entityGrid.page"),
    }),
    [t],
  );
  const labels = useMemo(() => gridLabels(t), [t]);
  const fields = useMemo(() => (type ? fieldsOf(defs[type.name], columns) : []), [defs, type, columns]);

  // A refused or failed schema read says why, in the surface's own sentence (a 403 names the grant).
  const failed = index.error ?? schema.error;
  if (failed) {
    return <InlineError>{failed.message}</InlineError>;
  }
  if (index.isPending || schema.isPending) {
    return <p role="status">{t("endpoints.projection.loading")}</p>;
  }
  if (!type || !config) {
    return <p className="text-caption text-fg-muted">{t("endpoints.data.noSchema")}</p>;
  }

  return (
    <div
      className={full ? "fixed inset-0 z-50 flex flex-col gap-3 overflow-auto bg-bg p-4" : "flex flex-col gap-3"}
      role={full ? "dialog" : undefined}
      aria-modal={full ? true : undefined}
      aria-label={full ? t("endpoints.data.title") : undefined}
    >
      <Field id={`endpoint-data-type-${slug}`} label={t("endpoints.data.type")} description={t("endpoints.data.typeHelp")}>
        <Select
          id={`endpoint-data-type-${slug}`}
          value={type.name}
          onChange={(event) => {
            setChosen(event.target.value);
            // Another type has other columns: its query and order start empty.
            setView({ filterText: null, sort: null });
            setAsked(undefined);
          }}
        >
          {types.map((each) => (
            <option key={each.name} value={each.name}>
              {each.name}
            </option>
          ))}
        </Select>
      </Field>
      {/* Two doors on the same page of entities: what this endpoint's filter and projection leave
          out is marked on the space's side (T-1435). The CSV is the whole answer of this query as
          one table, built by the endpoint under its own limits and read with the person's own
          session, as the rows are (EP-08, EP-44). */}
      <DataActions
        space={space}
        comparing={comparing}
        onCompare={() => setComparing((each) => !each)}
        full={full}
        onFull={() => setFull((each) => !each)}
        csv={csv ? csvHref(origin, slug, type.name, asked, sortText) : undefined}
      />
      <FieldList fields={fields} />

      {comparing && space ? (
        <EntityCompare
          key={`${slug}-${type.name}-${space}`}
          config={config}
          left={sourceFor({ kind: "space", space }, originTransport(), i18n.language)}
          right={sourceFor({ kind: "endpoint", slug }, originTransport(), i18n.language)}
          labels={compareLabels}
          gridLabels={labels}
        />
      ) : (
        <PortalEntityGrid
          key={`${slug}-${type.name}`}
          project={project}
          config={config}
          source={source}
          enums={enums}
          relations={relations}
          view={opened}
          onGridState={(next) => setView({ filterText: next.filterText ?? null, sort: next.sort ?? null })}
          onQuery={onQuery}
        />
      )}
    </div>
  );
}
